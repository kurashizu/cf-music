#!/usr/bin/env python3
"""
Runs one batch of the auto-tag pipeline: claims every song that has a
completed embedding but hasn't been auto-tagged yet (songs.autoTags IS
NULL — see claimAutoTagCandidates), computes cosine similarity locally
between each song's own audio embedding and every tag in the fixed
vocabulary, and posts the whole batch of scores back to the Worker in
one request. Pure arithmetic — no Gemini calls here at all, unlike
embed.py and seed_vocabulary.py, since both the song and tag embeddings
already exist by the time this runs; this script only does the
dot-product math GitHub Actions' own CPU handles trivially even for a
library of several thousand songs.
"""

import hashlib
import hmac
import json
import math
import os
import sys
import urllib.error
import urllib.request

WORKER_BASE_URL = os.environ["WORKER_BASE_URL"]
EMBEDDING_WEBHOOK_SECRET = os.environ["EMBEDDING_WEBHOOK_SECRET"]


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
            "User-Agent": "cf-music-auto-tag-job/1.0",
        },
    )
    try:
        with urllib.request.urlopen(request, timeout=30) as response:
            return json.loads(response.read())
    except urllib.error.HTTPError as exc:
        print(f"{path} failed: {exc.code} {exc.read()[:500]!r}", file=sys.stderr)
        raise


def claim() -> dict:
    return _post("/api/auto-tag-jobs/claim", {})


def complete(results: list[dict]) -> dict:
    return _post("/api/auto-tag-jobs/complete", {"results": results})


def cosine_similarity(a: list[float], b: list[float]) -> float:
    dot = sum(x * y for x, y in zip(a, b))
    norm_a = math.sqrt(sum(x * x for x in a))
    norm_b = math.sqrt(sum(y * y for y in b))
    if norm_a == 0 or norm_b == 0:
        return 0.0
    return dot / (norm_a * norm_b)


def main() -> None:
    claimed = claim()
    video_ids = claimed["videoIds"]
    print(f"Claimed {len(video_ids)} song(s)", file=sys.stderr)
    if not video_ids:
        return

    song_embeddings = claimed["songEmbeddings"]
    tag_vectors = claimed["tagVectors"]

    results = []
    skipped = 0
    for video_id in video_ids:
        embedding = song_embeddings.get(video_id)
        if embedding is None:
            # Embedding job says 'done' but Vectorize's own upsert hasn't
            # landed yet (a narrow race, not the common case) — the next
            # run will pick this song up once Vectorize is consistent.
            skipped += 1
            continue
        auto_tags = {tv["tag"]: cosine_similarity(embedding, tv["embedding"]) for tv in tag_vectors}
        results.append({"videoId": video_id, "autoTags": auto_tags})

    if skipped:
        print(f"Skipped {skipped} song(s) with no Vectorize embedding yet", file=sys.stderr)

    if not results:
        return

    response = complete(results)
    print(f"Tagged {response['updatedCount']} song(s)")


if __name__ == "__main__":
    main()
