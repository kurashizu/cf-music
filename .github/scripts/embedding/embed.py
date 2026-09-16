#!/usr/bin/env python3
"""
Runs one batch of the audio-embedding pipeline: claims a batch of pending
`embedding_jobs` from the Worker, and for each one downloads its audio (via
a presigned MinIO URL the Worker hands back — this script never sees MinIO
credentials at all), extracts one representative segment, embeds it with
Gemini, and reports the resulting vector (or a failure) back to the Worker.
The Worker is the only thing that ever writes to Vectorize or D1 directly;
this script only talks to the Worker's own HTTP API, HMAC-signed the same
way the import pipeline's callbacks are (see webhook-auth.ts).

Segment choice: gemini-embedding-2 caps audio input at 180 seconds per
request, and the model's overall 8192-token budget (shared across every
part in a request) doesn't comfortably fit more than one near-max-length
audio chunk anyway — so this deliberately does NOT chunk a long song into
several segments pooled together. Instead it extracts a single
representative segment well under the cap (see MAX_SEGMENT_SECONDS),
skipping a fraction of the intro so the segment is more likely to land in
a song's main/chorus material rather than a cold open or fade-in. For a
personal-library recommendation feature this is judged good enough; revisit
with true multi-segment pooling only if similarity quality turns out to
need it.
"""

import hashlib
import hmac
import json
import os
import random
import subprocess
import sys
import tempfile
import urllib.error
import urllib.request
from pathlib import Path

from google import genai
from google.genai import types
from google.genai.errors import APIError

WORKER_BASE_URL = os.environ["WORKER_BASE_URL"]
EMBEDDING_WEBHOOK_SECRET = os.environ["EMBEDDING_WEBHOOK_SECRET"]
# GEMINI_API_KEY is read implicitly by genai.Client() from the environment
# (not read directly here) — unused entirely when DRY_RUN is set.

# Skips the real Gemini API call, returning a deterministic fake vector
# instead (see embed_segment) — for exercising the rest of the pipeline
# (claim/download/ffmpeg/complete/Vectorize) without spending API quota.
DRY_RUN = os.environ.get("EMBEDDING_DRY_RUN") == "1"

CLAIM_LIMIT = 50  # server clamps to its own MAX_CLAIM_LIMIT regardless

MODEL_NAME = "gemini-embedding-2"
OUTPUT_DIMENSIONALITY = 768  # must match the Vectorize index's configured dimensions

# Comfortably under Gemini's 180s audio cap, leaving headroom against the
# cap being a hard boundary rather than a soft one.
MAX_SEGMENT_SECONDS = 150
# Skip this fraction of the song before starting the segment, so short
# intros/cold opens are less likely to dominate the embedded material.
SEGMENT_START_FRACTION = 0.15


class NonRetryableError(Exception):
    """Raised for failures retrying can never fix (corrupt audio, unsupported format, deleted job)."""


def sign(message: bytes) -> str:
    return hmac.new(EMBEDDING_WEBHOOK_SECRET.encode(), message, hashlib.sha256).hexdigest()


def _post(path: str, body: dict) -> dict:
    payload = json.dumps(body).encode()
    request = urllib.request.Request(
        f"{WORKER_BASE_URL}{path}",
        data=payload,
        method="POST",
        headers={
            "Content-Type": "application/json",
            "X-Signature-256": f"sha256={sign(payload)}",
            # Cloudflare's edge blocks the default Python-urllib User-Agent
            # as a bot signature even against our own Worker — see the same
            # workaround in docker/import/import.py.
            "User-Agent": "cf-music-embedding-job/1.0",
        },
    )
    try:
        with urllib.request.urlopen(request, timeout=30) as response:
            return json.loads(response.read())
    except urllib.error.HTTPError as exc:
        print(f"{path} failed: {exc.code} {exc.read()[:500]!r}", file=sys.stderr)
        raise


def claim_jobs() -> list[dict]:
    return _post("/api/embedding-jobs/claim", {"limit": CLAIM_LIMIT})["jobs"]


def complete_job(job_id: str, video_id: str, embedding: list[float]) -> None:
    _post("/api/embedding-jobs/complete", {"jobId": job_id, "videoId": video_id, "embedding": embedding})


def fail_job(job_id: str, error: str, retryable: bool) -> None:
    _post("/api/embedding-jobs/fail", {"jobId": job_id, "error": error, "retryable": retryable})


def download_audio(url: str, dest_path: Path) -> None:
    request = urllib.request.Request(url, headers={"User-Agent": "cf-music-embedding-job/1.0"})
    try:
        with urllib.request.urlopen(request, timeout=120) as response, open(dest_path, "wb") as f:
            f.write(response.read())
    except urllib.error.HTTPError as exc:
        raise NonRetryableError(f"Failed to download audio: {exc.code}") from exc


def probe_duration_seconds(audio_path: Path) -> float | None:
    result = subprocess.run(
        ["ffprobe", "-v", "quiet", "-print_format", "json", "-show_format", str(audio_path)],
        capture_output=True,
        text=True,
    )
    if result.returncode != 0:
        return None
    data = json.loads(result.stdout)
    duration = data.get("format", {}).get("duration")
    return float(duration) if duration is not None else None


def extract_segment(audio_path: Path, output_path: Path) -> None:
    """Transcodes a representative segment to MP3 (Gemini's audio input only
    accepts MP3/WAV, regardless of the source container/codec — so this
    transcode happens unconditionally, not just when a song is over the
    length cap)."""
    duration = probe_duration_seconds(audio_path)

    start_seconds = 0.0
    segment_seconds: float | None = None
    if duration is not None and duration > MAX_SEGMENT_SECONDS:
        start_seconds = min(duration * SEGMENT_START_FRACTION, duration - MAX_SEGMENT_SECONDS)
        segment_seconds = MAX_SEGMENT_SECONDS

    command = ["ffmpeg", "-y", "-v", "error", "-ss", str(start_seconds), "-i", str(audio_path)]
    if segment_seconds is not None:
        command += ["-t", str(segment_seconds)]
    command += ["-vn", "-acodec", "libmp3lame", "-ar", "44100", str(output_path)]

    result = subprocess.run(command, capture_output=True, text=True)
    if result.returncode != 0:
        raise NonRetryableError(f"ffmpeg failed: {result.stderr[:500]}")


def embed_segment(client: genai.Client | None, video_id: str, segment_path: Path) -> list[float]:
    if DRY_RUN:
        # Deterministic per-video pseudo-random vector — exercises every
        # other part of the pipeline (download, ffmpeg, HMAC calls, D1
        # writes, Vectorize upsert) without spending real Gemini quota. Seeded
        # by video_id so re-running the same job produces the same "embedding"
        # rather than a fresh random vector each time.
        rng = random.Random(video_id)
        return [rng.uniform(-1.0, 1.0) for _ in range(OUTPUT_DIMENSIONALITY)]

    with open(segment_path, "rb") as f:
        audio_bytes = f.read()

    result = client.models.embed_content(
        model=MODEL_NAME,
        contents=types.Part.from_bytes(data=audio_bytes, mime_type="audio/mpeg"),
        config=types.EmbedContentConfig(output_dimensionality=OUTPUT_DIMENSIONALITY),
    )
    return list(result.embeddings[0].values)


def is_retryable_api_error(exc: Exception) -> bool:
    """429 (rate limit) and 5xx (service unavailable/internal error) are
    transient — see embedding_jobs' schema.ts comment for why retrying just
    means "picked up again by the next scheduled run" rather than an
    in-process backoff loop. Every other APIError (e.g. 400 bad request) is
    something no amount of retrying fixes."""
    return isinstance(exc, APIError) and (exc.code == 429 or exc.code >= 500)


def process_job(client: genai.Client | None, job: dict) -> None:
    job_id = job["jobId"]
    video_id = job["videoId"]

    with tempfile.TemporaryDirectory() as tmp:
        workdir = Path(tmp)
        audio_path = workdir / "source"
        segment_path = workdir / "segment.mp3"

        try:
            download_audio(job["audioUrl"], audio_path)
            extract_segment(audio_path, segment_path)
            embedding = embed_segment(client, video_id, segment_path)
        except NonRetryableError as exc:
            print(f"{video_id}: non-retryable failure: {exc}", file=sys.stderr)
            fail_job(job_id, str(exc), retryable=False)
            return
        except Exception as exc:  # noqa: BLE001 - one job's failure must not abort the batch
            retryable = is_retryable_api_error(exc)
            print(f"{video_id}: {'retryable' if retryable else 'non-retryable'} failure: {exc}", file=sys.stderr)
            fail_job(job_id, str(exc)[:500], retryable=retryable)
            return

    complete_job(job_id, video_id, embedding)
    print(f"{video_id}: embedded ({len(embedding)} dims)")


def main() -> None:
    if DRY_RUN:
        print("DRY RUN: skipping real Gemini calls, using seeded fake embeddings", file=sys.stderr)

    jobs = claim_jobs()
    print(f"Claimed {len(jobs)} job(s)")
    if not jobs:
        return

    # Constructing genai.Client() reads GEMINI_API_KEY from the environment
    # immediately, even though DRY_RUN never actually calls it — skip
    # constructing it at all so a dry run doesn't need a real key present.
    client = genai.Client() if not DRY_RUN else None
    for job in jobs:
        process_job(client, job)


if __name__ == "__main__":
    main()
