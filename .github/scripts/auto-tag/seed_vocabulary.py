#!/usr/bin/env python3
"""
One-off (but safely repeatable) job: embeds every tag in the fixed
zero-shot classification vocabulary as plain text via gemini-embedding-2,
then posts the whole batch to the Worker in a single HMAC-signed request,
which upserts them into tag_vectors. Manually triggered via
workflow_dispatch — the vocabulary changes rarely, so there's no cron.

The vocabulary below is a duplicate of TAG_VOCABULARY in
src/lib/shared/tag-vocabulary.ts (Python and TypeScript can't share a
single source file) — if you edit one, edit the other and re-run this
job to pick up the change. Kept in sync by convention, not by tooling.

Unlike embed.py, this is one embedding per tag, not one call for the
whole batch: a list of `contents`/`parts` aggregates into a SINGLE
embedding server-side (confirmed live for both audio Parts in embed.py
and, separately, for a list of text strings here) — the opposite of what
independent per-tag vectors need, so each tag gets its own request.
"""

import hashlib
import hmac
import json
import os
import sys
import urllib.error
import urllib.request

from google import genai
from google.genai import types

WORKER_BASE_URL = os.environ["WORKER_BASE_URL"]
EMBEDDING_WEBHOOK_SECRET = os.environ["EMBEDDING_WEBHOOK_SECRET"]
# GEMINI_API_KEY is read implicitly by genai.Client() from the environment.

MODEL_NAME = "gemini-embedding-2"
OUTPUT_DIMENSIONALITY = 768  # must match tag_vectors' expected dimension (same as the song embeddings' own Vectorize index)

TAG_VOCABULARY = {
    "genre": [
        "jazz", "classical", "hip hop", "rock", "metal", "pop", "electronic",
        "house", "techno", "ambient", "folk", "country", "blues", "funk",
        "soul", "reggae", "latin", "city pop", "j-pop", "k-pop", "anime song",
        "vocaloid", "soundtrack",
    ],
    "mood": [
        "energetic", "chill", "upbeat", "melancholic", "dark", "dreamy",
        "romantic", "nostalgic", "aggressive", "triumphant", "playful",
        "sensual", "tense", "ethereal", "groovy", "introspective",
    ],
    "instrumentation": [
        "instrumental", "vocal-driven", "acoustic", "orchestral",
        "synth-heavy", "piano-led", "guitar-driven", "a cappella",
        "falsetto", "female vocal", "male vocal", "choral", "lo-fi",
        "beat-driven",
    ],
}


def sign(message: bytes) -> str:
    return hmac.new(EMBEDDING_WEBHOOK_SECRET.encode(), message, hashlib.sha256).hexdigest()


def post_seed_request(tags: list[dict]) -> dict:
    payload = json.dumps({"tags": tags}).encode()
    request = urllib.request.Request(
        f"{WORKER_BASE_URL}/api/tag-vectors/seed",
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
        print(f"seed request failed: {exc.code} {exc.read()[:500]!r}", file=sys.stderr)
        raise


def embed_tag(client: genai.Client, tag: str) -> list[float]:
    result = client.models.embed_content(
        model=MODEL_NAME,
        contents=[tag],
        config=types.EmbedContentConfig(output_dimensionality=OUTPUT_DIMENSIONALITY),
    )
    return list(result.embeddings[0].values)


def main() -> None:
    client = genai.Client()

    all_tags = [(facet, tag) for facet, tags in TAG_VOCABULARY.items() for tag in tags]
    print(f"Embedding {len(all_tags)} tags...", file=sys.stderr)

    entries = []
    for i, (facet, tag) in enumerate(all_tags):
        embedding = embed_tag(client, tag)
        entries.append({"tag": tag, "facet": facet, "embedding": embedding})
        print(f"  [{i + 1}/{len(all_tags)}] embedded {tag!r} ({facet})", file=sys.stderr)

    result = post_seed_request(entries)
    print(f"Seeded {result['seededCount']} tag vectors")


if __name__ == "__main__":
    main()
