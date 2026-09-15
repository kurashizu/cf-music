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
import random
import subprocess
import sys
import tempfile
import time
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
DOWNLOAD_CONCURRENCY = 3  # sequential downloads were the bottleneck on large playlists

YT_DLP_MAX_RETRIES = 4
YT_DLP_RETRY_BASE_DELAY_SECONDS = 5  # doubles each retry, plus jitter — see with_retry


class QuotaExceededError(Exception):
    """Raised when a batch's estimated total size exceeds the user's remaining storage quota."""


def _is_rate_limit_error(exc: Exception) -> bool:
    """True for yt-dlp's own HTTP 429 (a DownloadError wrapping urllib's
    HTTPError) as well as its "Too Many Requests" text form for extractors
    that surface it as a plain error message instead — the WARP proxy's
    IP is shared across every concurrent download in this job (and any
    other job running at the same time), so a 429 here is almost always
    transient rate-limiting, not "this video is broken"."""
    message = str(exc)
    return "429" in message or "Too Many Requests" in message


def with_retry(fn, *args, description: str, **kwargs):
    """Runs a blocking yt-dlp call, retrying on rate-limit errors with
    exponential backoff + jitter (the jitter matters here specifically:
    DOWNLOAD_CONCURRENCY songs hitting a 429 around the same moment and
    retrying on the exact same fixed schedule would just recreate the
    same burst against the same shared proxy IP). Non-rate-limit failures
    (age-gated video, region-blocked, genuinely removed) are raised
    immediately — retrying those would only waste the job's time budget
    on something no amount of waiting fixes."""
    last_exc: Exception | None = None
    for attempt in range(YT_DLP_MAX_RETRIES + 1):
        try:
            return fn(*args, **kwargs)
        except Exception as exc:  # noqa: BLE001 - re-raised below if not retried
            last_exc = exc
            if not _is_rate_limit_error(exc) or attempt == YT_DLP_MAX_RETRIES:
                raise
            delay = YT_DLP_RETRY_BASE_DELAY_SECONDS * (2**attempt) + random.uniform(0, 3)
            print(
                f"{description}: rate limited (attempt {attempt + 1}/{YT_DLP_MAX_RETRIES + 1}), "
                f"retrying in {delay:.1f}s",
                file=sys.stderr,
            )
            time.sleep(delay)
    raise last_exc  # unreachable, but satisfies type checkers


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

    def _extract():
        with yt_dlp.YoutubeDL(options) as ydl:
            return ydl.extract_info(source_url, download=False)

    info = with_retry(_extract, description="playlist extraction")
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

        def _extract():
            with yt_dlp.YoutubeDL(options) as ydl:
                return ydl.extract_info(video_id_url, download=False)

        info = with_retry(_extract, description=f"size probe {entry.get('id')}")
        # filesize is exact (from the server's Content-Length);
        # filesize_approx is yt-dlp's own estimate from bitrate * duration
        # when the server didn't report one.
        return info.get("filesize") or info.get("filesize_approx") or 0
    except Exception as exc:  # noqa: BLE001 - one unresolvable song must not abort the quota check
        print(f"Could not estimate size for {entry.get('id')}: {exc}", file=sys.stderr)
        return 0


def extract_and_filter(source_url: str) -> tuple[list[dict], list[dict], set[str]]:
    """Extracts the playlist and splits out songs already owned by someone —
    everything this touches (yt-dlp, urllib) is synchronous/blocking, so
    this is meant to be run via asyncio.to_thread from run(), not awaited
    directly. Deliberately does NOT also do the per-song size probing that
    resolve_batch used to do in one shot: that loop can take many minutes
    on a large playlist, and a single to_thread call that long sends zero
    real WebSocket traffic for its whole duration — ping/pong keepalive
    frames alone don't prevent Cloudflare's edge from silently dropping an
    idle connection (this was the actual cause of a real incident: the
    process's own ping_interval/ping_timeout were already set correctly,
    but the connection still died mid-batch because nothing but pings
    crossed the wire for 17 minutes). The size probing loop now lives in
    run() itself, one to_thread call per song, so a real progress event
    can go out after each one.

    known_video_ids is returned (not just used to filter) so run() can send
    a song_known event for each one — without that, a song already in the
    library was skipped here (correctly: no need to re-download it) but
    then never linked into this job's target playlist either, silently
    dropped from an import that named it."""
    entries = extract_playlist_entries(source_url)
    video_ids = [e["id"] for e in entries]
    known_video_ids = fetch_known_video_ids(video_ids)
    pending_entries = [e for e in entries if e["id"] not in known_video_ids]
    return entries, pending_entries, known_video_ids


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


def reserve_quota(job_id: str, video_id: str, estimated_bytes: int) -> bool:
    """Atomically claims estimated_bytes of this user's quota for one song,
    right before its download starts — the upfront fetch_remaining_quota_bytes
    check (once per whole batch) only catches "this batch obviously can't
    fit"; it reads usage once and never re-checks per song, so two
    concurrent imports for the same user can each pass that check against
    the same stale figure and, together, exceed quota. This call is what
    actually prevents that: the Worker's reserveQuota does the check and
    the write as one atomic statement (see
    src/lib/server/import/quota-reservations.ts), so it's safe to call
    from multiple concurrent downloads (this process's own
    DOWNLOAD_CONCURRENCY as well as a second concurrent import job)
    without a race."""
    body = json.dumps(
        {"userId": USER_ID, "jobId": job_id, "videoId": video_id, "estimatedBytes": estimated_bytes}
    ).encode()
    request = urllib.request.Request(
        f"{WORKER_BASE_URL}/api/import/reserve-quota",
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
        print(f"reserve-quota call failed: {exc.code} {exc.read()[:500]!r}", file=sys.stderr)
        raise
    return result["reserved"]


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

    def _download():
        with yt_dlp.YoutubeDL(options) as ydl:
            return ydl.extract_info(video_id_url, download=True)

    info = with_retry(_download, description=f"download {video_id_url}")

    with yt_dlp.YoutubeDL(options) as ydl:
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


# boto3's upload_file has no built-in content-type guessing of its own —
# left unset, MinIO stores the object as application/octet-stream (or
# whatever binary/octet-stream default it falls back to). A browser's
# <audio>/<img> element uses this header, not the actual bytes, to decide
# whether a resource is even playable/renderable at all: a real fetch()
# against such an object succeeds fine (it doesn't care about content-type),
# but an <audio> tag pointed at the same URL silently sits at
# readyState=HAVE_NOTHING forever, no error event, because the browser
# never considered it a decodable audio source in the first place. This
# is keyed by container (the actual probed ffprobe value, not the source
# extension) since that's what ends up in the object key/audio_key.
CONTENT_TYPES = {
    "webm": "audio/webm",
    "m4a": "audio/mp4",
    "mp3": "audio/mpeg",
    "opus": "audio/opus",
    "ogg": "audio/ogg",
    "avif": "image/avif",
}


def upload_to_minio(s3_client, local_path: Path, object_key: str) -> None:
    content_type = CONTENT_TYPES.get(local_path.suffix.lstrip("."), "application/octet-stream")
    s3_client.upload_file(
        str(local_path), MINIO_BUCKET, object_key, ExtraArgs={"ContentType": content_type}
    )


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

        # Classification metadata is opportunistic, not guaranteed: yt-dlp
        # only sets artist/album/track/genre for extractors that expose
        # dedicated music metadata (e.g. SoundCloud, Bandcamp) - plain
        # YouTube uploads almost never do, so uploader/channel is the
        # fallback for "artist" there (a channel name, not necessarily a
        # performer, but better signal than nothing for auto-classification).
        tags = list(info.get("tags") or []) + list(info.get("categories") or [])

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
            "artist": info.get("artist") or info.get("uploader") or info.get("channel"),
            "album": info.get("album"),
            "genre": info.get("genre"),
            "releaseYear": info.get("release_year"),
            "tags": tags or None,
        }


async def run() -> None:
    # Same reasoning as fetch_known_video_ids' explicit User-Agent: avoid
    # whatever default header value might read as a bot signature to
    # Cloudflare's edge in front of our own Worker.
    #
    # ping_interval/ping_timeout are set explicitly (not left at whatever
    # this library version defaults to), though see extract_and_filter's
    # docstring for why they alone don't keep a long-idle connection alive
    # against Cloudflare's edge — the real fix there is sending genuine
    # application data regularly (probing_progress events), not just
    # relying on these.
    ws_options = dict(
        additional_headers={"User-Agent": "cf-music-import-job/1.0"},
        ping_interval=20,
        ping_timeout=20,
    )

    async with websockets.connect(websocket_url(), **ws_options) as ws_initial:
        # Boxed in a single-item list (not a plain variable) so send_event's
        # reconnect-and-retry below can replace the active connection out
        # from under watch_for_cancel and every download_one call, all of
        # which only ever hold a reference to this list, not to the socket
        # object itself.
        ws_box = [ws_initial]

        # websockets' own docs call concurrent send() calls from multiple
        # coroutines unsafe (interleaved writes can corrupt frames) — held
        # here since both the size-probing and download phases run
        # DOWNLOAD_CONCURRENCY tasks at once, each reporting its own event.
        # Also doubles as the reconnect lock (see reconnect() below): without
        # sharing it, a drop discovered by send_event and one discovered by
        # watch_for_cancel at the same moment could each open their own
        # replacement connection, silently leaking/orphaning whichever one
        # loses the race to be stored in ws_box.
        send_lock = asyncio.Lock()

        async def reconnect() -> None:
            async with send_lock:
                print("WebSocket connection dropped; reconnecting once", file=sys.stderr)
                ws_box[0] = await websockets.connect(websocket_url(), **ws_options)

        async def send_event(event: dict) -> None:
            payload = json.dumps({"jobId": JOB_ID, "event": event})
            async with send_lock:
                try:
                    await ws_box[0].send(payload)
                    return
                except websockets.exceptions.ConnectionClosed:
                    pass
            # A single dropped connection (Cloudflare edge hiccup, transient
            # network blip — pings alone don't prevent this, see the module
            # docstring) used to crash the whole job here even though every
            # song's download/upload had already succeeded by this point;
            # only the progress report was lost. One reconnect attempt,
            # re-registering as this same job's `ci:{id}` connection (a
            # fresh connection to the same URL does that on its own — the
            # tag isn't tied to the old socket), covers that case without a
            # full rewrite of this function's single `async with` scope.
            await reconnect()
            async with send_lock:
                await ws_box[0].send(payload)

        # Cancellation is checked for the entire job lifetime (probing and
        # downloading both watch `cancelled`), not just once downloading
        # starts — a cancel decision arriving during the (now potentially
        # multi-minute, on a huge playlist) probing phase should stop the
        # job just as promptly as one arriving mid-download. In-flight
        # work (a probe or a download already running) still finishes —
        # there's no point discarding a nearly-done call — but nothing new
        # starts once cancelled is set.
        cancelled = False

        async def watch_for_cancel() -> None:
            nonlocal cancelled
            while not cancelled:
                try:
                    cancel_message = await ws_box[0].recv()
                except websockets.exceptions.ConnectionClosed:
                    # Same connection-drop tolerance as send_event: a stale
                    # reference here would otherwise leave cancellation
                    # silently dead for the rest of the job the moment the
                    # very first blip happens, even though send_event's own
                    # reconnect keeps everything else working fine. Routed
                    # through the same reconnect() (and its shared lock) as
                    # send_event so a drop noticed by both at once doesn't
                    # open two replacement connections.
                    try:
                        await reconnect()
                        continue
                    except OSError:
                        return
                decision = json.loads(cancel_message)
                if decision.get("action") == "cancel":
                    print("Import was cancelled mid-run", file=sys.stderr)
                    cancelled = True
                    return

        watcher = asyncio.create_task(watch_for_cancel())

        # Anything raised here happens before the per-song loop even starts
        # (source extraction, the known-video-ids lookup), so there's no
        # song to attribute a song_failed event to and no way to tell the
        # Worker what happened except this: without it, the job is stuck at
        # whatever status it already had, forever — the process just exits
        # non-zero and the WebSocket connection drops with no explanation.
        try:
            # Every yt-dlp/urllib call here is a *synchronous*, blocking
            # call — run entirely in a worker thread via asyncio.to_thread,
            # so this doesn't block the event loop while it runs (a fast
            # call anyway: extraction + the known-video-ids lookup, not the
            # per-song size probing below).
            entries, pending_entries, known_video_ids = await asyncio.to_thread(extract_and_filter, SOURCE_URL)

            # Probes each pending song's real download size concurrently
            # (DOWNLOAD_CONCURRENCY at once, same as the download loop
            # below), sending a probing_progress event after each one
            # completes — deliberately real WebSocket traffic, not just
            # ping/pong, on every song rather than one big to_thread call
            # for the whole batch. That single-call version is what
            # actually caused a real incident on a 183-song playlist: with
            # ping_interval/ping_timeout already set correctly, the
            # connection still died because Cloudflare's edge silently
            # drops a connection that's carried nothing but protocol-level
            # ping/pong frames for several minutes — pings alone don't
            # count as "the connection is in use" there. A per-song event
            # is frequent enough that no gap should ever get remotely
            # close to that.
            probe_semaphore = asyncio.Semaphore(DOWNLOAD_CONCURRENCY)
            sizes = [0] * len(pending_entries)
            probed_count = 0
            probe_lock = asyncio.Lock()

            async def probe_one(index: int, entry: dict) -> None:
                nonlocal probed_count
                if cancelled:
                    return
                async with probe_semaphore:
                    if cancelled:
                        return
                    sizes[index] = await asyncio.to_thread(estimate_song_size_bytes, entry)
                    async with probe_lock:
                        probed_count += 1
                        await send_event(
                            {
                                "type": "probing_progress",
                                "checked": probed_count,
                                "total": len(pending_entries),
                            }
                        )

            await asyncio.gather(*(probe_one(i, e) for i, e in enumerate(pending_entries)))
            if cancelled:
                watcher.cancel()
                return
            estimated_total_bytes = sum(sizes)

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
        #
        # totalCount is len(pending_entries) + len(known_video_ids), not
        # len(entries): entries is the whole source playlist as extracted,
        # before yt-dlp's own dedup/availability quirks are accounted for,
        # but pending_entries + known_video_ids is exactly the set of songs
        # this job will actually report progress for — every one of them
        # gets either a song_success/song_failed event (pending) or a
        # song_known event (already owned), and nothing else ever
        # increments completedCount. Using entries here previously made the
        # progress bar's denominator permanently larger than anything that
        # could complete it (a 98-song playlist with 86 already-owned songs
        # showed "12/98" forever).
        await send_event(
            {"type": "start", "totalCount": len(pending_entries) + len(known_video_ids)}
        )

        # Each already-owned song just needs linking into this job's target
        # playlist (see recordKnownSongLinked) — it was correctly never
        # downloaded, but was silently dropped from the import's result
        # entirely before this existed, since nothing else in the job ever
        # reported it at all.
        for video_id in known_video_ids:
            await send_event({"type": "song_known", "videoId": video_id})

        s3_client = boto3.client(
            "s3",
            endpoint_url=MINIO_ENDPOINT,
            aws_access_key_id=MINIO_ACCESS_KEY,
            aws_secret_access_key=MINIO_SECRET_KEY,
        )

        # DOWNLOAD_CONCURRENCY songs in flight at once — sequential
        # download/transcode/upload was the bottleneck on large playlists
        # (each song is mostly waiting on network/ffmpeg, not CPU, so this
        # is safe to parallelize). Shares the same `cancelled` flag and
        # `watcher` task started at the top of run() (covering the probing
        # phase above too), rather than a `return` from inside the loop
        # body, since multiple worker tasks check it concurrently; once
        # set, in-flight downloads still finish (no point discarding a
        # nearly-done download) but no new ones start.
        download_semaphore = asyncio.Semaphore(DOWNLOAD_CONCURRENCY)

        async def download_one(index: int, entry: dict) -> None:
            if cancelled:
                return
            async with download_semaphore:
                if cancelled:
                    return
                try:
                    # Claims this song's estimated size right before its
                    # own download starts — see reserve_quota's own
                    # docstring for why this (not just the one upfront
                    # fetch_remaining_quota_bytes check above) is what
                    # actually closes the race between two concurrent
                    # imports for the same user. A failed reservation is
                    # reported the same way any other per-song failure is,
                    # not a fatal_error: the rest of the batch (songs that
                    # do fit) should still proceed.
                    reserved = await asyncio.to_thread(reserve_quota, JOB_ID, entry["id"], sizes[index])
                    if not reserved:
                        await send_event(
                            {
                                "type": "song_failed",
                                "failure": {
                                    "videoId": entry["id"],
                                    "reason": "Storage quota exceeded (concurrent import may have used remaining space)",
                                },
                            }
                        )
                        return

                    # Same reasoning as probe_one above: download/transcode/
                    # upload is synchronous and can run long on a large file
                    # or slow network, so it goes through to_thread rather
                    # than blocking the loop directly.
                    song = await asyncio.to_thread(download_and_upload_song, entry, s3_client)
                    await send_event({"type": "song_success", "song": song})
                except Exception as exc:  # noqa: BLE001 - one failed song must not abort the batch
                    await send_event(
                        {"type": "song_failed", "failure": {"videoId": entry["id"], "reason": str(exc)[:500]}}
                    )

        await asyncio.gather(*(download_one(i, entry) for i, entry in enumerate(pending_entries)))
        was_cancelled = cancelled
        cancelled = True  # stop the watcher even if no cancel decision ever arrived
        watcher.cancel()

        if was_cancelled:
            return

        await send_event({"type": "complete"})


if __name__ == "__main__":
    try:
        asyncio.run(run())
    except Exception:  # noqa: BLE001 - surface a non-zero exit for the workflow's own logs
        print("Import job failed", file=sys.stderr)
        raise
