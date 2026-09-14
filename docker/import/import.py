#!/usr/bin/env python3
"""
Runs one import job: extracts a playlist/video via yt-dlp, skips songs
already known to the Worker (checked once up front over plain HTTP), sends
a preview of what's left to download over a WebSocket connection to the
Worker (via the per-user Import Progress Durable Object) purely for the UI
to show, then immediately starts downloading/transcoding/uploading each
new song — there's no confirmation gate blocking the run, only a
mid-run cancellation check over that same connection.

GitHub Actions runners have no public inbound address, so this process
connects OUT to the Worker's WebSocket endpoint rather than the Worker
connecting to it — the DO tags this connection `ci:{job_id}` so a browser's
cancel decision (sent over its own connection to the same DO) gets routed
back here specifically.

All yt-dlp network egress goes through the official Cloudflare WARP
client's own SOCKS5 proxy mode (`warp-cli mode proxy`), which start.sh
brings up before this script runs — see that file for why (every
third-party WireGuard-credential tool available at the time this was
built was rate-limited or otherwise unreachable, which is why the client
registers and manages its own keys internally rather than this script
being handed raw WireGuard parameters). The WebSocket connection,
known-video-ids lookup, and S3 upload go direct, not through the proxy.

ffmpeg, boto3, websockets, and the WARP client are all baked into the
prebuilt image (see the Dockerfile) — none of that is installed at job
start. yt-dlp is the one deliberate exception: it's installed fresh by
import.yml on the *host* runner (not baked into the image, not installed
inside this container) since it breaks constantly as YouTube changes its
frontend, and reaches this process via PYTHONPATH pointing at the
host-mounted install directory rather than a normal `pip install` here.
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


class QuotaExceededError(Exception):
    """Raised when a batch's estimated total size exceeds the user's remaining storage quota."""


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
            # Cloudflare's edge blocks the default Python-urllib/x.y User-Agent
            # as a bot signature (error 1010) even against our own Worker —
            # this isn't app-level auth, so a real UA string is enough.
            "User-Agent": "cf-music-import-job/1.0",
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


def estimate_song_size_bytes(entry: dict) -> int:
    """Resolves the same format download_song will actually fetch
    (bestaudio/best) without downloading it, to get its real size —
    extract_flat's entries carry no size info at all, only duration, and a
    duration-based estimate would be too rough to enforce a quota against.
    A song that can't be resolved here (unavailable, network hiccup, no
    size reported by either the server or yt-dlp's own estimate) counts as
    0 toward the quota check rather than aborting the whole batch — it'll
    fail again (and be reported as such) when download_song actually gets
    to it, so there's no need to treat that failure twice."""
    try:
        options = {"format": "bestaudio/best", "quiet": True, "proxy": SOCKS5_PROXY}
        video_id_url = entry.get("url") or entry.get("webpage_url") or entry["id"]
        with yt_dlp.YoutubeDL(options) as ydl:
            info = ydl.extract_info(video_id_url, download=False)
        # filesize is exact (from the server's Content-Length);
        # filesize_approx is yt-dlp's own estimate from bitrate * duration
        # when the server didn't report one.
        return info.get("filesize") or info.get("filesize_approx") or 0
    except Exception as exc:  # noqa: BLE001 - one unresolvable song must not abort the quota check
        print(f"Could not estimate size for {entry.get('id')}: {exc}", file=sys.stderr)
        return 0


def resolve_batch(source_url: str) -> tuple[list[dict], list[dict], int]:
    """Extracts the playlist, drops songs already owned by someone, and
    sums the real download size of what's left — everything this touches
    (yt-dlp, urllib) is synchronous/blocking, so this whole function is
    meant to be run via asyncio.to_thread from run(), not awaited directly;
    see the comment at that call site for why that matters here
    specifically (a long-running sync call on the event loop starves
    websockets' own keepalive pings)."""
    entries = extract_playlist_entries(source_url)
    video_ids = [e["id"] for e in entries]
    known_video_ids = fetch_known_video_ids(video_ids)
    pending_entries = [e for e in entries if e["id"] not in known_video_ids]
    estimated_total_bytes = sum(estimate_song_size_bytes(e) for e in pending_entries)
    return entries, pending_entries, estimated_total_bytes


def fetch_remaining_quota_bytes() -> int:
    body = json.dumps({"userId": USER_ID}).encode()
    request = urllib.request.Request(
        f"{WORKER_BASE_URL}/api/import/remaining-quota",
        data=body,
        method="POST",
        headers={
            "Content-Type": "application/json",
            "X-Signature-256": f"sha256={sign(body.decode())}",
            "User-Agent": "cf-music-import-job/1.0",
        },
    )
    try:
        with urllib.request.urlopen(request, timeout=30) as response:
            result = json.loads(response.read())
    except urllib.error.HTTPError as exc:
        print(f"remaining-quota lookup failed: {exc.code} {exc.read()[:500]!r}", file=sys.stderr)
        raise
    return result["remainingBytes"]


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
    # Same reasoning as fetch_known_video_ids' explicit User-Agent: avoid
    # whatever default header value might read as a bot signature to
    # Cloudflare's edge in front of our own Worker.
    #
    # ping_interval/ping_timeout are set explicitly (not left at whatever
    # this library version defaults to) since they're load-bearing here:
    # this connection needs to survive several minutes of a large
    # playlist's per-song size lookups with no application-level messages
    # at all, and the only thing keeping it alive through that is these
    # protocol-level ping/pong frames — see resolve_batch's to_thread usage
    # for the other half of why that alone wasn't enough (the event loop
    # has to actually be free to send them).
    async with websockets.connect(
        websocket_url(),
        additional_headers={"User-Agent": "cf-music-import-job/1.0"},
        ping_interval=20,
        ping_timeout=20,
    ) as ws:

        async def send_event(event: dict) -> None:
            await ws.send(json.dumps({"jobId": JOB_ID, "event": event}))

        # Anything raised here happens before the per-song loop even starts
        # (source extraction, the known-video-ids lookup), so there's no
        # song to attribute a song_failed event to and no way to tell the
        # Worker what happened except this: without it, the job is stuck at
        # whatever status it already had, forever — the process just exits
        # non-zero and the WebSocket connection drops with no explanation.
        try:
            # Every yt-dlp/urllib call here is a *synchronous*, blocking
            # call — run entirely in a worker thread via asyncio.to_thread.
            # A large playlist's extraction + per-song size lookups can take
            # several minutes; running them directly on the event loop
            # blocks it completely, including the websockets library's own
            # background ping/pong keepalive, which needs the loop to
            # actually get scheduled to run. That's exactly what caused a
            # real incident: the WARP/Worker WebSocket got silently killed
            # (connection reset, no close frame) partway through resolving a
            # 183-song playlist, and the except block below couldn't even
            # report it — send_event() itself needs that same dead
            # connection. to_thread keeps the loop free to actually send
            # those keepalive frames while this runs.
            entries, pending_entries, estimated_total_bytes = await asyncio.to_thread(
                resolve_batch, SOURCE_URL
            )
            remaining_bytes = await asyncio.to_thread(fetch_remaining_quota_bytes)
            if estimated_total_bytes > remaining_bytes:
                raise QuotaExceededError(
                    f"This import needs ~{estimated_total_bytes / 1_000_000:.1f} MB but only "
                    f"{remaining_bytes / 1_000_000:.1f} MB of storage quota remains"
                )
        except Exception as exc:  # noqa: BLE001 - must reach fatal_error below, then re-raise
            await send_event({"type": "fatal_error", "reason": str(exc)[:500]})
            raise

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

        # No confirmation gate: the preview above is informational only now.
        # Downloading starts immediately so the job never blocks on a human
        # being present to click a button — a user can still cancel a job
        # already in progress (checked before each song below).
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
                # Same reasoning as resolve_batch above: download/transcode/
                # upload is synchronous and can run long on a large file or
                # slow network, so it goes through to_thread rather than
                # blocking the loop (and this connection's keepalive pings)
                # directly.
                song = await asyncio.to_thread(download_and_upload_song, entry, s3_client)
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
