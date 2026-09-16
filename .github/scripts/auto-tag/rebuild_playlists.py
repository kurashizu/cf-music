#!/usr/bin/env python3
"""
Stage two of the auto-tag pipeline: turns songs.autoTags (stage one's
output, see tag_songs.py) into each user's own "Auto-tagged" playlists.
Loops over every user one at a time, fetches that user's library
songs with their autoTags, computes a z-score per (song, tag) pair
relative to that song's OWN mean/stdev across all tags (see the module
docstring in tag_songs.py's sibling design discussion — the raw cosine
similarity from this text-embedding model has too high and narrow a
baseline for a fixed absolute threshold to mean anything; z-score
against the song's own distribution is scale-invariant to that), keeps
only tags where z >= Z_THRESHOLD, groups songs by tag, drops any tag
with fewer than MIN_SONGS_PER_TAG songs (an empty-feeling category is
worse than no category), and posts the whole result to be wholesale-
written as that user's new auto_tag playlists — replacing whatever
that user had from the previous run entirely, not diffed against it.
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

# Calibrated against the real production library (92 songs, see the
# design discussion this threshold came out of): z >= 1.25 averaged ~5.8
# tags/song and produced a reasonable number of >=3-song categories
# without either flooding every song into nearly every tag (too low a
# threshold) or leaving almost nothing tagged (too high one).
Z_THRESHOLD = 1.25
MIN_SONGS_PER_TAG = 3


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


def list_user_ids() -> list[str]:
    return _post("/api/auto-tag-jobs/users", {})["userIds"]


def get_tag_facets() -> dict[str, str]:
    """tag -> facet, from the same claim endpoint stage one's tag_songs.py
    uses (it also returns videoIds/songEmbeddings for stage one's own
    purposes, both ignored here) — see the design discussion in
    getAllTagVectors for why this reuses that endpoint rather than a
    dedicated one."""
    claimed = _post("/api/auto-tag-jobs/claim", {})
    return {tv["tag"]: tv["facet"] for tv in claimed["tagVectors"]}


def get_user_library(user_id: str) -> list[dict]:
    return _post(f"/api/auto-tag-jobs/library/{user_id}", {})["songs"]


def rebuild_user_playlists(user_id: str, playlists: list[dict]) -> dict:
    return _post(f"/api/auto-tag-jobs/playlists/{user_id}", {"playlists": playlists})


def hit_tags(auto_tags: dict) -> list[str]:
    """Which tags this one song "hits", by z-score against its own mean/stdev across all its scores — see the module docstring for why this, not a fixed absolute threshold."""
    scores = list(auto_tags.values())
    if len(scores) < 2:
        return []
    mean = sum(scores) / len(scores)
    variance = sum((s - mean) ** 2 for s in scores) / (len(scores) - 1)
    stdev = math.sqrt(variance)
    if stdev == 0:
        return []
    return [tag for tag, score in auto_tags.items() if (score - mean) / stdev >= Z_THRESHOLD]


def build_playlists_for_user(library_songs: list[dict], tag_to_facet: dict[str, str]) -> list[dict]:
    songs_by_tag: dict[str, list[str]] = {}
    for song in library_songs:
        auto_tags = song.get("autoTags")
        if auto_tags is None:
            continue  # not auto-tagged yet (stage one hasn't reached it) — skip, not an error
        for tag in hit_tags(auto_tags):
            songs_by_tag.setdefault(tag, []).append(song["videoId"])

    return [
        {"tag": tag, "facet": tag_to_facet.get(tag, "unknown"), "videoIds": video_ids}
        for tag, video_ids in songs_by_tag.items()
        if len(video_ids) >= MIN_SONGS_PER_TAG
    ]


def main() -> None:
    tag_to_facet = get_tag_facets()
    user_ids = list_user_ids()
    print(f"Rebuilding auto-tag playlists for {len(user_ids)} user(s)", file=sys.stderr)

    for user_id in user_ids:
        library_songs = get_user_library(user_id)
        playlists = build_playlists_for_user(library_songs, tag_to_facet)
        result = rebuild_user_playlists(user_id, playlists)
        print(f"  {user_id}: {result['playlistCount']} playlist(s)", file=sys.stderr)


if __name__ == "__main__":
    main()
