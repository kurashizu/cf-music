#!/usr/bin/env python3
"""
Runs one import job: extracts a playlist/video via yt-dlp, skips songs
already known to the Worker (checked once up front over plain HTTP), sends
a preview of what's left to download over a WebSocket connection to the
Worker (via the per-user Import Progress Durable Object) and waits for the
user to confirm or cancel, then downloads/transcodes/uploads each new song,
reporting progress and checking for a mid-run cancellation over that same
connection the whole time.

GitHub Actions runners have no public inbound address, so this process
connects OUT to the Worker's WebSocket endpoint rather than the Worker
connecting to it — the DO tags this connection `ci:{job_id}` so a browser's
confirm/cancel decision (sent over its own connection to the same DO) gets
routed back here specifically.

All yt-dlp network egress goes through the official Cloudflare WARP
client's own SOCKS5 proxy mode (`warp-cli mode proxy`), which start.sh
brings up before this script runs — see that file for why (WARP has no
musl/Alpine build, and every third-party WireGuard-credential tool
available at the time this was built was rate-limited or otherwise
unreachable, which is why the client registers and manages its own keys
internally rather than this script being handed raw WireGuard
parameters). The WebSocket connection, known-video-ids lookup, and S3
upload go direct, not through the proxy. Every external dependency
(yt-dlp, ffmpeg, boto3, websockets) is baked into the container image at
build time — this script does not `pip install` or `apt install` anything
at runtime.
"""

import asyncio
import hashlib
import hmac
import json
import os
import subprocess
import sys
import tempfile
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path

import boto3
import websockets
import yt_dlp

WORKER_BASE_URL = os.environ["WORKER_BASE_URL"]
IMPORT_WEBHOOK_SECRET = os.environ["IMPORT_WEBHOOK_SECRET"]
JOB_ID = os.environ["JOB_ID"]
USER_ID = os.environ["USER_ID"]
SOURCE_URL = os.environ["SOURCE_URL"]

MINIO_ENDPOINT = os.environ["MINIO_ENDPOINT"]
MINIO_BUCKET = os.environ["MINIO_BUCKET"]
MINIO_ACCESS_KEY = os.environ["MINIO_ACCESS_KEY"]
MINIO_SECRET_KEY = os.environ["MINIO_SECRET_KEY"]

SOCKS5_PROXY = "socks5://127.0.0.1:40000"
COVER_CRF = "40"
CONFIRMATION_TIMEOUT_SECONDS = 600


def sign(message: str) -> str:
    return hmac.new(IMPORT_WEBHOOK_SECRET.encode(), message.encode(), hashlib.sha256).hexdigest()


def fetch_known_video_ids(video_ids: list[str]) -> set[str]:
    """One-shot HTTP lookup (request/response, not a progress event) — no
    need to route this through the WebSocket connection."""
    if not video_ids:
        return set()

    body = json.dumps({"videoIds": video_ids}).encode()
    request = urllib.request.Request(
        f"{WORKER_BASE_URL}/api/import/known-video-ids",
        data=body,
        method="POST",
        headers={
            "Content-Type": "application/json",
            "X-Signature-256": f"sha256={sign(body.decode())}",
        },
    )
    try:
        with urllib.request.urlopen(request, timeout=30) as response:
            result = json.loads(response.read())
    except urllib.error.HTTPError as exc:
        print(f"known-video-ids lookup failed: {exc.code} {exc.read()[:500]!r}", file=sys.stderr)
        raise
    return set(result["knownVideoIds"])


def websocket_url() -> str:
    base = WORKER_BASE_URL.replace("https://", "wss://").replace("http://", "ws://")
    query = urllib.parse.urlencode({"role": "ci", "jobId": JOB_ID, "signature": sign(JOB_ID)})
    return f"{base}/api/import/ws?{query}"


def extract_playlist_entries(source_url: str) -> list[dict]:
    options = {"extract_flat": "in_playlist", "quiet": True, "proxy": SOCKS5_PROXY}
    with yt_dlp.YoutubeDL(options) as ydl:
        info = ydl.extract_info(source_url, download=False)
    entries = info.get("entries") or [info]
    return [e for e in entries if e is not None]


def download_song(video_id_url: str, workdir: Path) -> dict:
    audio_template = str(workdir / "%(id)s.%(ext)s")
    options = {
        "format": "bestaudio/best",
        "outtmpl": audio_template,
        "writethumbnail": True,
        "quiet": True,
        "proxy": SOCKS5_PROXY,
        "noplaylist": True,
    }
    with yt_dlp.YoutubeDL(options) as ydl:
        info = ydl.extract_info(video_id_url, download=True)

    audio_path = Path(ydl.prepare_filename(info))
    return {"info": info, "audio_path": audio_path}


def probe_audio(audio_path: Path) -> dict:
    result = subprocess.run(
        ["ffprobe", "-v", "quiet", "-print_format", "json", "-show_format", "-show_streams", str(audio_path)],
        capture_output=True,
        check=True,
        text=True,
    )
    data = json.loads(result.stdout)
    audio_stream = next(s for s in data["streams"] if s["codec_type"] == "audio")
    return {
        "codec": audio_stream["codec_name"],
        "container": audio_path.suffix.lstrip("."),
        "bitrate_kbps": (
            round(int(data["format"]["bit_rate"]) / 1000) if data["format"].get("bit_rate") else None
        ),
        "sample_rate": int(audio_stream["sample_rate"]) if audio_stream.get("sample_rate") else None,
        "file_size_bytes": audio_path.stat().st_size,
    }


def transcode_cover(thumbnail_path: Path, workdir: Path, video_id: str) -> Path | None:
    if not thumbnail_path.exists():
        return None
    cover_path = workdir / f"{video_id}.avif"
    subprocess.run(
        ["ffmpeg", "-y", "-i", str(thumbnail_path), "-crf", COVER_CRF, str(cover_path)],
        capture_output=True,
        check=True,
    )
    return cover_path


def probe_image_dimensions(image_path: Path) -> tuple[int, int]:
    result = subprocess.run(
        ["ffprobe", "-v", "quiet", "-print_format", "json", "-show_streams", str(image_path)],
        capture_output=True,
        check=True,
        text=True,
    )
    stream = json.loads(result.stdout)["streams"][0]
    return int(stream["width"]), int(stream["height"])


def upload_to_minio(s3_client, local_path: Path, object_key: str) -> None:
    s3_client.upload_file(str(local_path), MINIO_BUCKET, object_key)


def download_and_upload_song(entry: dict, s3_client) -> dict:
    with tempfile.TemporaryDirectory() as tmp:
        workdir = Path(tmp)
        video_id = entry["id"]
        downloaded = download_song(entry.get("url") or entry.get("webpage_url") or video_id, workdir)
        info = downloaded["info"]
        audio_path = downloaded["audio_path"]

        audio_meta = probe_audio(audio_path)
        audio_key = f"audio/{video_id}.{audio_meta['container']}"
        upload_to_minio(s3_client, audio_path, audio_key)

        cover_key = None
        cover_width = None
        cover_height = None
        thumbnail_candidates = list(workdir.glob(f"{video_id}.*"))
        thumbnail_path = next(
            (p for p in thumbnail_candidates if p.suffix not in {".webm", ".m4a", ".opus"}), None
        )
        if thumbnail_path:
            cover_path = transcode_cover(thumbnail_path, workdir, video_id)
            if cover_path:
                cover_width, cover_height = probe_image_dimensions(cover_path)
                cover_key = f"covers/{video_id}.avif"
                upload_to_minio(s3_client, cover_path, cover_key)

        return {
            "videoId": video_id,
            "sourcePlatform": info.get("extractor", "unknown"),
            "sourceUrl": info.get("webpage_url", SOURCE_URL),
            "title": info.get("title", video_id),
            "durationSeconds": round(info["duration"]) if info.get("duration") else None,
            "audioKey": audio_key,
            "codec": audio_meta["codec"],
            "container": audio_meta["container"],
            "bitrateKbps": audio_meta["bitrate_kbps"],
            "sampleRate": audio_meta["sample_rate"],
            "fileSizeBytes": audio_meta["file_size_bytes"],
            "coverKey": cover_key,
            "coverWidth": cover_width,
            "coverHeight": cover_height,
        }


async def run() -> None:
    async with websockets.connect(websocket_url()) as ws:

        async def send_event(event: dict) -> None:
            await ws.send(json.dumps({"jobId": JOB_ID, "event": event}))

        entries = extract_playlist_entries(SOURCE_URL)
        video_ids = [e["id"] for e in entries]
        known_video_ids = fetch_known_video_ids(video_ids)
        pending_entries = [e for e in entries if e["id"] not in known_video_ids]

        await send_event(
            {
                "type": "preview",
                "entries": [
                    {
                        "videoId": e["id"],
                        "title": e.get("title", e["id"]),
                        "durationSeconds": (round(e["duration"]) if e.get("duration") else None),
                    }
                    for e in pending_entries
                ],
            }
        )

        try:
            raw = await asyncio.wait_for(ws.recv(), timeout=CONFIRMATION_TIMEOUT_SECONDS)
        except asyncio.TimeoutError:
            print(f"No confirmation within {CONFIRMATION_TIMEOUT_SECONDS}s, exiting", file=sys.stderr)
            return

        decision = json.loads(raw)
        if decision.get("action") != "confirm" or not decision.get("approved"):
            print("Import was cancelled before starting", file=sys.stderr)
            return

        await send_event({"type": "start", "totalCount": len(entries)})

        s3_client = boto3.client(
            "s3",
            endpoint_url=MINIO_ENDPOINT,
            aws_access_key_id=MINIO_ACCESS_KEY,
            aws_secret_access_key=MINIO_SECRET_KEY,
        )

        for entry in pending_entries:
            try:
                cancel_message = await asyncio.wait_for(ws.recv(), timeout=0.01)
                decision = json.loads(cancel_message)
                if decision.get("action") == "cancel":
                    print("Import was cancelled mid-run", file=sys.stderr)
                    return
            except asyncio.TimeoutError:
                pass

            try:
                song = download_and_upload_song(entry, s3_client)
                await send_event({"type": "song_success", "song": song})
            except Exception as exc:  # noqa: BLE001 - one failed song must not abort the batch
                await send_event(
                    {"type": "song_failed", "failure": {"videoId": entry["id"], "reason": str(exc)[:500]}}
                )

        await send_event({"type": "complete"})


if __name__ == "__main__":
    try:
        asyncio.run(run())
    except Exception:  # noqa: BLE001 - surface a non-zero exit for the workflow's own logs
        print("Import job failed", file=sys.stderr)
        raise
