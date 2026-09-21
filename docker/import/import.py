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
import shutil
import subprocess
import sys
import tempfile
import threading
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
# Size probing is a metadata lookup, not a transfer: it resolves one format
# and reads its reported size, holding no bandwidth while it waits. It can
# therefore run far wider than downloads do, and on a large playlist the
# probing phase is otherwise the longest part of the whole import — 2000
# songs at 3 at a time is 667 sequential round-trips.
PROBE_CONCURRENCY = 12
# Upper bound on how many songs one import may take on. Enforced during
# playlist extraction (see extract_playlist_entries), so an oversized
# playlist is cut down before anything is probed or downloaded rather than
# discovered to be too big halfway through.
MAX_IMPORT_ENTRIES = 1000
# Bitrate assumed when sizing a song from its duration alone, for the
# cheap up-front quota estimate (see estimate_sizes_from_duration).
#
# Measured over the 370 songs already in the library: mean 139.3 kbps,
# p50 137.3, p90 147.8, and only 7 of 370 above 160. Downloads are
# bestaudio, which on YouTube is almost always ~128-160 kbps Opus, so the
# spread is narrow by construction.
#
# 160 rather than the mean because this estimate has to err high: it is
# used to decide the batch *fits*, so under-estimating would wave through
# an import that then runs out of quota partway. At 160 the estimate runs
# ~15% above reality for a typical library while still covering 98% of
# real songs outright.
ESTIMATE_BITRATE_KBPS = 160
# How close to the quota limit the duration-based estimate may come before
# each song gets probed for its real size instead.
#
# Below this, the estimate's error (~15% high, and biased toward
# over-estimating) is nowhere near enough to turn a fitting import into an
# overflowing one, so the probing phase — by far the longest part of a
# large import, at ~2.6s per song — is skipped entirely. Above it, the
# margin no longer covers the error and real sizes are worth the wait.
PROBE_THRESHOLD_FRACTION = 0.8

# Netscape-format cookies.txt for a real (secondary/throwaway) YouTube
# account, manually uploaded to MinIO out-of-band — this script never
# generates or refreshes it. Authenticated requests are less likely to hit
# the "Sign in to confirm you're not a bot" wall in the first place (see
# _is_bot_check_error) than the anonymous requests every yt-dlp call used
# to make; this doesn't replace the WARP proxy or the bot-check retry
# ladder, both of which stay in place for whenever this account also gets
# walled. Object key deliberately outside audio/covers/ so it's never
# swept up by the S3 bucket's own song-key orphan scan.
YT_COOKIES_OBJECT_KEY = "ci-state/www.youtube.com_cookies.txt"
# Set once by fetch_cookies_file() in __main__, before run() starts — every
# yt_dlp_options() call reads this module global rather than having it
# threaded through as a parameter.
YT_DLP_COOKIES_PATH: str | None = None
# Per-thread copies of that file, keyed by nothing but the thread itself —
# see _worker_cookies_copy for why the original can't be shared.
_COOKIE_COPIES = threading.local()

YT_DLP_MAX_RETRIES = 4
YT_DLP_RETRY_BASE_DELAY_SECONDS = 5  # doubles each retry, plus jitter — see with_retry

# A 429 that escalates into YouTube's bot-check page is a harder, longer-lived
# block than plain rate-limiting, so it gets its own (much longer) backoff
# ladder rather than reusing YT_DLP_RETRY_BASE_DELAY_SECONDS — the job-level
# timeout-minutes: 60 in import.yml is the actual backstop against this ladder
# still not being enough.
#
# Linear, not exponential, growth: at MAX_RETRIES=10 an exponential ladder's
# last delay alone would run ~6.4 hours (45 * 2^9), guaranteeing the 60-minute
# job timeout kills the run long before attempt 10 — making the configured
# retry count a lie. This schedule (45, 75, 105, ... +30s per attempt) sums to
# 1800s (30min) worst case across all 10 attempts, leaving the other 30
# minutes of the job timeout for the retries' own download work.
# "Video unavailable" is ambiguous (see _is_maybe_throttled_error), so it
# gets a deliberately short ladder: 5s, 10s. Long enough to survive a
# brief throttle, short enough that a batch full of genuinely-removed
# videos costs ~15s each rather than the rate-limit ladder's ~75s.
YT_DLP_MAYBE_THROTTLED_MAX_RETRIES = 2

# A dropped connection usually comes back within seconds, so this ladder is
# short-delay but generous in attempts: 3s, 6s, 12s, 24s, 48s. On the
# 820-song import one video failed 4 times in a row to "Host unreachable",
# which the ~75s rate-limit ladder wasn't enough to ride out.
YT_DLP_NETWORK_MAX_RETRIES = 5
YT_DLP_NETWORK_BASE_DELAY_SECONDS = 3

# How long one import may run before it gives up and says so. Generous
# because a throttled job legitimately spends long stretches asleep (see
# ThrottleGate.MAX_DELAY_SECONDS), and stopping a job that is merely
# waiting out a block would throw away the work already done. The
# workflow's own timeout-minutes sits a little above this so that this
# limit — the one that reports back to the user — is the one that fires.
JOB_TIMEOUT_SECONDS = 3 * 60 * 60

YT_DLP_BOT_CHECK_MAX_RETRIES = 10
YT_DLP_BOT_CHECK_BASE_DELAY_SECONDS = 45
YT_DLP_BOT_CHECK_DELAY_STEP_SECONDS = 30


class ThrottleGate:
    """Shared brake every yt-dlp worker checks before making a request.

    Retrying alone does not fix throttling: the retry goes to the same
    session that just said no, and DOWNLOAD_CONCURRENCY/PROBE_CONCURRENCY
    workers retrying together recreate exactly the burst that caused it.
    yt-dlp's own advice for this error is to put a delay between video
    requests, which is what this does — but only once YouTube has actually
    pushed back, so an import that is not being throttled runs at full
    speed.

    Each throttle response widens the gap between requests (0s, 2s, 4s,
    8s, capped), and a run of clean responses narrows it again. The state
    is process-wide rather than per-worker because the thing being
    rate-limited is the session, not any one worker.

    Deliberately not a semaphore resize: the workers are already in
    flight, and slowing each request down is both simpler and
    better-matched to what YouTube measures.
    """

    # Ceiling on the gap between requests. Thirty minutes is deliberately
    # far past the "up to an hour" YouTube quotes for a throttled session:
    # a job that has been told to back off that hard is better off waiting
    # than burning its budget confirming it is still blocked. The job's own
    # three-hour timeout (see JOB_TIMEOUT_SECONDS) is what stops this
    # waiting forever.
    MAX_DELAY_SECONDS = 1800.0
    # Where the ladder starts, then doubling: 2, 4, 8, ... up to the cap.
    INITIAL_DELAY_SECONDS = 2.0
    # Clean responses needed before easing off. Higher than 1 so a single
    # lucky request doesn't undo a backoff that is still needed.
    RECOVERY_THRESHOLD = 10

    def __init__(self) -> None:
        self._delay = 0.0
        self._clean_streak = 0
        self._lock = threading.Lock()

    def before_request(self) -> None:
        """Waits out the current delay, if any. Called on the worker thread."""
        with self._lock:
            delay = self._delay
        if delay > 0:
            # Jittered so concurrent workers spread out instead of
            # resuming in lockstep and re-bursting. Capped in absolute
            # terms rather than scaled with the delay: at the 30-minute
            # ceiling a proportional jitter would add a further quarter
            # hour for no extra spreading benefit.
            time.sleep(delay + random.uniform(0, min(delay / 2, 5.0)))

    def record_throttled(self) -> None:
        with self._lock:
            self._clean_streak = 0
            previous = self._delay
            self._delay = min(
                self.MAX_DELAY_SECONDS,
                self.INITIAL_DELAY_SECONDS if self._delay == 0 else self._delay * 2
            )
            if self._delay != previous:
                print(
                    f"throttled by YouTube; spacing requests {self._delay:.1f}s apart",
                    file=sys.stderr,
                )

    def record_success(self) -> None:
        with self._lock:
            if self._delay == 0:
                return
            self._clean_streak += 1
            if self._clean_streak >= self.RECOVERY_THRESHOLD:
                self._clean_streak = 0
                self._delay = 0.0 if self._delay <= self.INITIAL_DELAY_SECONDS else self._delay / 2
                print(f"recovered; request spacing now {self._delay:.1f}s", file=sys.stderr)


THROTTLE_GATE = ThrottleGate()


class QuotaExceededError(Exception):
    """Raised when a batch's estimated total size exceeds the user's remaining storage quota."""


def _is_rate_limit_error(exc: Exception) -> bool:
    """True for yt-dlp's own HTTP 429 (a DownloadError wrapping urllib's
    HTTPError) as well as its "Too Many Requests" text form for extractors
    that surface it as a plain error message instead — the WARP proxy's
    IP is shared across every concurrent download in this job (and any
    other job running at the same time), so a 429 here is almost always
    transient rate-limiting, not "this video is broken".

    Also matches YouTube's softer phrasing of the same thing. A throttled
    session is told "This content isn't available, try again later", and
    — confirmed on a 976-song import where 535 songs failed — plain
    "Video unavailable" for most of the rest. Neither says 429 and
    neither was retried, so a throttled run recorded hundreds of
    permanent failures for videos that were fine: every sampled id
    resolved anonymously, first try, once the session had cooled down.
    """
    message = str(exc)
    return "429" in message or "Too Many Requests" in message or "try again later" in message


def _is_maybe_throttled_error(exc: Exception) -> bool:
    """True for "Video unavailable", which is genuinely ambiguous.

    A throttled session is handed it for videos that are perfectly fine —
    on the 976-song import that failed 535 of them, every sampled id
    resolved anonymously on the first try once the session cooled down.
    But it is also what YouTube says about a video that really was
    deleted or made private, and no amount of retrying fixes that.

    So it retries, but on its own short ladder rather than the rate-limit
    one: enough to ride out a throttle, cheap enough that a playlist full
    of genuinely dead videos doesn't spend the job's whole time budget
    waiting. At MAYBE_THROTTLED_MAX_RETRIES=2 the worst case is ~15s per
    dead video, against ~75s on the full rate-limit ladder — which, at
    fifty dead videos in a batch, is the difference between one extra
    minute and over an hour.
    """
    return "Video unavailable" in str(exc)


def _is_transient_network_error(exc: Exception) -> bool:
    """True for a connection that never reached YouTube at all.

    The proxy hop drops out mid-job: "<urlopen error [Errno 4] Host
    unreachable>", connection resets, timeouts, DNS failures. On an
    820-song import these were 11 of the 13 failures, across 7 videos --
    one of them recorded 4 times, so the song was being retried and the
    network simply hadn't come back within the ~75s the rate-limit ladder
    allows.

    Worth separating from throttling because the right response is the
    opposite one: throttling means back off hard and stay off, whereas a
    dropped route is usually back in seconds and nothing is gained by
    spacing requests out process-wide. This also must not feed
    THROTTLE_GATE -- a flaky link would otherwise slow every other worker
    down for a problem that isn't YouTube's doing.
    """
    message = str(exc)
    return any(
        marker in message
        for marker in (
            "Host unreachable",
            "Network is unreachable",
            "Connection reset",
            "Connection refused",
            "Temporary failure in name resolution",
            "timed out",
            "Remote end closed connection",
            "urlopen error",
        )
    )


def _is_bot_check_error(exc: Exception) -> bool:
    """True for YouTube's "Sign in to confirm you're not a bot" wall, which
    yt-dlp raises as a plain ExtractorError/DownloadError with no distinct
    exception type. This tends to follow a burst of 429s on the same proxy
    IP (seen in production: dozens of 429s in a row, then every subsequent
    video on that IP hits this instead) — it's a harsher, longer block than
    a plain 429, but still transient once the IP cools down, so it's worth
    retrying with a longer delay rather than failing the song immediately."""
    message = str(exc)
    return "Sign in to confirm you" in message and "bot" in message


def with_retry(fn, *args, description: str, **kwargs):
    """Runs a blocking yt-dlp call, retrying anything that looks like
    throttling with exponential backoff + jitter (the jitter matters here
    specifically: DOWNLOAD_CONCURRENCY songs hitting the same error around
    the same moment and retrying on the exact same fixed schedule would
    just recreate the same burst against the same shared proxy IP).

    Four ladders, because the failures cost different amounts to be wrong
    about: the bot-check wall is a long block worth waiting out, a 429 is
    short, "Video unavailable" might not be throttling at all (see
    _is_maybe_throttled_error) so it gets the shortest, and a dropped
    connection (see _is_transient_network_error) gets many short attempts
    since it usually returns within seconds.

    Every attempt also passes through THROTTLE_GATE, which spaces out
    requests process-wide once YouTube pushes back — retrying on its own
    just sends the retry into the same throttled session.

    Other failures (age-gated, region-blocked) are raised immediately;
    retrying those would only waste the job's time budget."""
    last_exc: Exception | None = None
    rate_limit_attempts = 0
    bot_check_attempts = 0
    maybe_throttled_attempts = 0
    network_attempts = 0
    while True:
        try:
            # Waits out any spacing a previous throttle imposed, so the
            # brake applies to first attempts too — not just retries.
            THROTTLE_GATE.before_request()
            result = fn(*args, **kwargs)
            THROTTLE_GATE.record_success()
            return result
        except Exception as exc:  # noqa: BLE001 - re-raised below if not retried
            last_exc = exc
            if not _is_transient_network_error(exc) and (
                _is_rate_limit_error(exc)
                or _is_bot_check_error(exc)
                or _is_maybe_throttled_error(exc)
            ):
                # Widen the gap for every worker, not just this one: the
                # session is what got throttled, so retrying this call
                # alone at full speed would keep the pressure on.
                THROTTLE_GATE.record_throttled()
            if _is_transient_network_error(exc):
                # Checked before the throttle classes: yt-dlp wraps these
                # as plain DownloadErrors whose text can also contain
                # words the throttle matchers look for, and treating a
                # dead route as throttling would back every worker off
                # for something YouTube never said.
                if network_attempts >= YT_DLP_NETWORK_MAX_RETRIES:
                    raise
                delay = YT_DLP_NETWORK_BASE_DELAY_SECONDS * (2**network_attempts) + random.uniform(0, 2)
                network_attempts += 1
                print(
                    f"{description}: network unreachable (attempt {network_attempts}/"
                    f"{YT_DLP_NETWORK_MAX_RETRIES}), retrying in {delay:.1f}s",
                    file=sys.stderr,
                )
            elif _is_bot_check_error(exc):
                if bot_check_attempts >= YT_DLP_BOT_CHECK_MAX_RETRIES:
                    raise
                delay = (
                    YT_DLP_BOT_CHECK_BASE_DELAY_SECONDS
                    + YT_DLP_BOT_CHECK_DELAY_STEP_SECONDS * bot_check_attempts
                    + random.uniform(0, 5)
                )
                bot_check_attempts += 1
                print(
                    f"{description}: bot-check wall (attempt {bot_check_attempts}/"
                    f"{YT_DLP_BOT_CHECK_MAX_RETRIES}), retrying in {delay:.1f}s",
                    file=sys.stderr,
                )
            elif _is_rate_limit_error(exc):
                if rate_limit_attempts >= YT_DLP_MAX_RETRIES:
                    raise
                delay = YT_DLP_RETRY_BASE_DELAY_SECONDS * (2**rate_limit_attempts) + random.uniform(0, 3)
                rate_limit_attempts += 1
                print(
                    f"{description}: rate limited (attempt {rate_limit_attempts}/"
                    f"{YT_DLP_MAX_RETRIES}), retrying in {delay:.1f}s",
                    file=sys.stderr,
                )
            elif _is_maybe_throttled_error(exc):
                if maybe_throttled_attempts >= YT_DLP_MAYBE_THROTTLED_MAX_RETRIES:
                    raise
                delay = YT_DLP_RETRY_BASE_DELAY_SECONDS * (2**maybe_throttled_attempts) + random.uniform(0, 3)
                maybe_throttled_attempts += 1
                print(
                    f"{description}: reported unavailable, which a throttled session also "
                    f"says about working videos (attempt {maybe_throttled_attempts}/"
                    f"{YT_DLP_MAYBE_THROTTLED_MAX_RETRIES}), retrying in {delay:.1f}s",
                    file=sys.stderr,
                )
            else:
                raise
            time.sleep(delay)
    raise last_exc  # unreachable, but satisfies type checkers


def sign(message: str) -> str:
    return hmac.new(IMPORT_WEBHOOK_SECRET.encode(), message.encode(), hashlib.sha256).hexdigest()


def fetch_cookies_file() -> str | None:
    """Downloads the cookies.txt at YT_COOKIES_OBJECT_KEY into a temp file
    for yt-dlp's own --cookies handling, or returns None if it isn't
    there — cookies are an optional mitigation (see the constant's own
    comment), not a hard requirement, so a missing object shouldn't fail
    every import job outright. Runs once at process start (see __main__
    below), well before run()'s own asyncio.run — this is a single
    blocking network call, not worth threading through to_thread for."""
    s3_client = boto3.client(
        "s3",
        endpoint_url=MINIO_ENDPOINT,
        aws_access_key_id=MINIO_ACCESS_KEY,
        aws_secret_access_key=MINIO_SECRET_KEY,
    )
    dest_path = Path(tempfile.gettempdir()) / "yt-cookies.txt"
    try:
        s3_client.download_file(MINIO_BUCKET, YT_COOKIES_OBJECT_KEY, str(dest_path))
    except Exception as exc:  # noqa: BLE001 - missing/unreadable cookies file falls back to cookie-less
        print(f"No cookies file at {YT_COOKIES_OBJECT_KEY} ({exc}); proceeding without cookies", file=sys.stderr)
        return None

    # Downloading it is not the same as it being usable. A file in the
    # wrong format was previously handed to yt-dlp anyway, which then
    # raised "does not look like a Netscape format cookies file" once per
    # song — surfacing as a pile of per-song failures with nothing
    # pointing at the real cause. Checking here fails the same way every
    # time, loudly, and falls back to the anonymous path that works.
    try:
        first_line = dest_path.read_text(errors="replace").lstrip().split("\n", 1)[0]
    except Exception as exc:  # noqa: BLE001 - unreadable file is the same situation as a missing one
        print(f"Cookies file unreadable ({exc}); proceeding without cookies", file=sys.stderr)
        return None

    # What yt-dlp itself looks for. Both spellings appear in the wild:
    # browsers write the comment header, some exporters write the
    # "#HttpOnly_" prefixed form with no header at all.
    if not (first_line.startswith("# Netscape HTTP Cookie File") or first_line.startswith("# HTTP Cookie File")):
        print(
            f"Cookies file at {YT_COOKIES_OBJECT_KEY} is not in Netscape format "
            f"(first line: {first_line[:80]!r}); proceeding without cookies. "
            "Re-export it from the browser with a cookies.txt extension.",
            file=sys.stderr,
        )
        return None

    return str(dest_path)


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


def _worker_cookies_copy() -> str | None:
    """A per-thread copy of the cookies file, or None if there isn't one.

    yt-dlp writes the cookie jar back to `cookiefile` every time a
    YoutubeDL context closes (YoutubeDL.close -> save_cookies), and that
    write is not atomic: it truncates the file, writes the header, then
    the cookies. With DOWNLOAD_CONCURRENCY/PROBE_CONCURRENCY workers all
    pointed at one path, another worker can open it in that window and see
    a file whose first line isn't the Netscape header yet -- which yt-dlp
    rejects with "does not look like a Netscape format cookies file",
    failing a song for a reason that has nothing to do with that song.

    Giving each thread its own copy removes the sharing rather than
    locking around it: the writes are what races, and nothing needs the
    updated session cookies to be shared back."""
    if not YT_DLP_COOKIES_PATH:
        return None
    existing = getattr(_COOKIE_COPIES, "path", None)
    if existing and Path(existing).exists():
        return existing
    copy_path = Path(tempfile.gettempdir()) / f"yt-cookies-{threading.get_ident()}.txt"
    try:
        shutil.copyfile(YT_DLP_COOKIES_PATH, copy_path)
    except OSError as exc:
        print(f"Could not copy cookies for this worker ({exc}); proceeding without", file=sys.stderr)
        return None
    _COOKIE_COPIES.path = str(copy_path)
    return str(copy_path)


def yt_dlp_options(**overrides) -> dict:
    """Base options every yt_dlp.YoutubeDL(...) call site shares (proxy,
    quiet, and cookies when YT_DLP_COOKIES_PATH was set — see its own
    comment) — cookiefile is simply omitted, not set to None, when there's
    no cookies file, since yt-dlp treats an explicit None the same as
    "don't pass this option" anyway, but omitting it is the less surprising
    of the two to read here."""
    options = {"quiet": True, "proxy": SOCKS5_PROXY}
    cookies = _worker_cookies_copy()
    if cookies:
        options["cookiefile"] = cookies
    options.update(overrides)
    return options


def extract_playlist_entries(source_url: str) -> tuple[list[dict], bool]:
    """Returns the playlist's entries and whether it was truncated.

    playlistend caps this at the yt-dlp layer rather than slicing after the
    fact: yt-dlp stops walking the playlist once it has enough, so a
    10,000-item playlist costs roughly what a 1,000-item one does instead
    of being fully enumerated and then thrown away.

    Asking for one past the limit is what makes truncation detectable —
    with no cheap "how long is this playlist really" call available under
    extract_flat, receiving MAX+1 entries is the signal that there was
    more, and the extra entry is dropped below."""
    options = yt_dlp_options(extract_flat="in_playlist", playlistend=MAX_IMPORT_ENTRIES + 1)

    def _extract():
        with yt_dlp.YoutubeDL(options) as ydl:
            return ydl.extract_info(source_url, download=False)

    info = with_retry(_extract, description="playlist extraction")
    entries = info.get("entries") or [info]
    entries = [e for e in entries if e is not None]
    truncated = len(entries) > MAX_IMPORT_ENTRIES
    if truncated:
        entries = entries[:MAX_IMPORT_ENTRIES]
    return entries, truncated


def estimate_sizes_from_duration(entries: list[dict]) -> list[int]:
    """Sizes every entry from the duration extract_flat already returned,
    at ESTIMATE_BITRATE_KBPS — no network calls at all.

    This exists because the accurate alternative is extraordinarily
    expensive: resolving a song's real size means opening its video page to
    read the format list, ~2.6s each, and no batch form of that call
    exists. Asking yt-dlp to resolve a whole playlist in one go (dropping
    extract_flat) is the same per-video work done serially inside yt-dlp —
    measured slightly *slower* per song, not faster.

    An entry with no duration (a live stream, or a video whose metadata
    didn't come back) sizes as 0 and so contributes nothing to the
    estimate. It is still downloaded and still reserves quota for its real
    size when its turn comes.
    """
    return [int((e.get("duration") or 0) * ESTIMATE_BITRATE_KBPS * 1000 / 8) for e in entries]


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
        options = yt_dlp_options(format="bestaudio/best")
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


def extract_and_filter(source_url: str) -> tuple[list[dict], list[dict], set[str], bool]:
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
    entries, truncated = extract_playlist_entries(source_url)
    video_ids = [e["id"] for e in entries]
    known_video_ids = fetch_known_video_ids(video_ids)
    pending_entries = [e for e in entries if e["id"] not in known_video_ids]
    return entries, pending_entries, known_video_ids, truncated


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
    options = yt_dlp_options(
        format="bestaudio/best",
        outtmpl=audio_template,
        writethumbnail=True,
        noplaylist=True,
    )

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

        # Cancellation used to be cooperative: set a flag, let whatever's
        # in flight finish, stop starting new work. That's wrong for a
        # download already running inside asyncio.to_thread — it's a
        # synchronous, blocking call (yt-dlp, including its own
        # with_retry backoff sleep, now up to ~30min worst case across
        # YT_DLP_BOT_CHECK_MAX_RETRIES retries) with no way to interrupt
        # it cooperatively from here; the flag would just sit unread
        # until that thread happens to return on its own. os._exit below
        # kills the whole process immediately instead, which is safe to
        # do the instant this decision arrives: the Worker already
        # flipped the D1 job to 'cancelled' and released its quota
        # reservations before it ever forwarded this message to CI (see
        # handleBrowserControl in import-progress.ts), and
        # disconnectImportJob's own check for an already-terminal status
        # means the resulting WebSocket drop is a no-op on that side too.
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
                    print("Import was cancelled mid-run — killing the process now", file=sys.stderr)
                    cancelled = True
                    # Not sys.exit(): that raises SystemExit, which only
                    # unwinds the current coroutine's stack — every
                    # worker thread blocked in yt-dlp/ffmpeg (exactly the
                    # case this exists for) would keep running regardless,
                    # holding the runner open until they finished on their
                    # own anyway. os._exit(0) terminates the process
                    # immediately, no unwinding, taking every thread down
                    # with it.
                    os._exit(0)

        watcher = asyncio.create_task(watch_for_cancel())

        async def enforce_job_timeout() -> None:
            """Stops the job at JOB_TIMEOUT_SECONDS and says so.

            The workflow's own timeout-minutes would also stop it, but by
            killing the runner — the WebSocket just dies and the job sits
            at `running` until the stale sweep notices, with nothing
            telling the user what happened. Enforcing it here, inside the
            connection, means the timeout is reported like any other fatal
            error and shows up in the UI immediately.

            os._exit for the same reason watch_for_cancel uses it: worker
            threads blocked in yt-dlp (including one asleep on a 30-minute
            throttle backoff) do not unwind, and raising here would leave
            the process alive until they finished on their own.
            """
            await asyncio.sleep(JOB_TIMEOUT_SECONDS)
            hours = JOB_TIMEOUT_SECONDS / 3600
            print(f"Import job exceeded its {hours:.0f}h limit; stopping", file=sys.stderr)
            try:
                await send_event(
                    {
                        "type": "fatal_error",
                        "reason": (
                            f"Import stopped after {hours:.0f} hours. Songs already imported are "
                            "kept — import the rest separately, ideally in a smaller batch."
                        ),
                    }
                )
            except Exception:  # noqa: BLE001 - the exit below matters more than the report
                pass
            os._exit(1)

        timeout_task = asyncio.create_task(enforce_job_timeout())

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
            entries, pending_entries, known_video_ids, truncated = await asyncio.to_thread(
                extract_and_filter, SOURCE_URL
            )

            # Two-stage sizing. The cheap stage first: size every song
            # from the duration extract_flat already returned, costing
            # nothing. Most imports are nowhere near the quota line, and
            # for those this is the only sizing that ever happens — which
            # removes what was the longest phase of a large import
            # (~2.6s/song, so ~43 minutes for 1000 songs even 12-wide).
            remaining_bytes = await asyncio.to_thread(fetch_remaining_quota_bytes)
            sizes = estimate_sizes_from_duration(pending_entries)
            estimated_total_bytes = sum(sizes)

            # Only when the estimate lands close enough to the limit that
            # its error could change the answer is the real thing worth
            # ~2.6s a song. Below the threshold the margin covers the
            # error comfortably; above it, guessing is no longer good
            # enough to decide on.
            if estimated_total_bytes > remaining_bytes * PROBE_THRESHOLD_FRACTION:
                # Probes each pending song's real download size
                # concurrently (PROBE_CONCURRENCY at once — wider than the
                # download loop below, since a probe holds no bandwidth),
                # sending a probing_progress event after each one
                # completes — deliberately real WebSocket traffic, not
                # just ping/pong, on every song rather than one big
                # to_thread call for the whole batch. That single-call
                # version is what actually caused a real incident on a
                # 183-song playlist: with ping_interval/ping_timeout
                # already set correctly, the connection still died because
                # Cloudflare's edge silently drops a connection that's
                # carried nothing but protocol-level ping/pong frames for
                # several minutes — pings alone don't count as "the
                # connection is in use" there. A per-song event is
                # frequent enough that no gap should ever get remotely
                # close to that.
                probe_semaphore = asyncio.Semaphore(PROBE_CONCURRENCY)
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
                    timeout_task.cancel()
                    return
                estimated_total_bytes = sum(sizes)

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
                # The source had more than MAX_IMPORT_ENTRIES; the tail was
                # dropped. Sent so the UI can say so rather than leaving the
                # user to notice the count doesn't match their playlist.
                "truncated": truncated,
                "limit": MAX_IMPORT_ENTRIES,
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
                    #
                    # sizes[index] is the duration-based estimate unless
                    # this import was close enough to quota to probe for
                    # real sizes (see above). That only ever affects the
                    # reservation, which is transient: once the song
                    # lands, recordSongImported releases it and the song's
                    # actual file_size_bytes becomes the usage that counts.
                    # An estimate can make a reservation slightly too big
                    # or small for the minutes it is held, never the
                    # recorded total.
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
        timeout_task.cancel()

        if was_cancelled:
            return

        await send_event({"type": "complete"})


if __name__ == "__main__":
    # Set before run() so every yt_dlp_options() call below (playlist
    # extraction, size probing, download — all of which can hit the
    # bot-check wall, not just the download step) picks it up.
    YT_DLP_COOKIES_PATH = fetch_cookies_file()
    try:
        asyncio.run(run())
    except Exception:  # noqa: BLE001 - surface a non-zero exit for the workflow's own logs
        print("Import job failed", file=sys.stderr)
        raise
