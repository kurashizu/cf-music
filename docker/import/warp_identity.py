#!/usr/bin/env python3
"""
Persists the WARP client's registered identity (/var/lib/cloudflare-warp/)
across otherwise-stateless import job containers by round-tripping it
through the same MinIO bucket import.py already uses.

Every import job runs in a freshly pulled container with no state from any
prior run, so start.sh would otherwise call `warp-cli registration new`
on every single job — registering a brand new anonymous WARP identity each
time. That's needless churn against Cloudflare's registration endpoint,
and GitHub Actions runners share IP ranges across unrelated jobs/repos, so
a burst of registrations from "the same IP" isn't fully under this
project's control. Reusing one identity across runs (restore before
registering, save only after a fresh registration succeeds) cuts that
down to roughly once, not once per job.

Usage: warp_identity.py restore|save
"""

import io
import os
import sys
import tarfile
from pathlib import Path

import boto3
from botocore.config import Config
from botocore.exceptions import ClientError

MINIO_ENDPOINT = os.environ["MINIO_ENDPOINT"]
MINIO_BUCKET = os.environ["MINIO_BUCKET"]
MINIO_ACCESS_KEY = os.environ["MINIO_ACCESS_KEY"]
MINIO_SECRET_KEY = os.environ["MINIO_SECRET_KEY"]

STATE_DIR = Path("/var/lib/cloudflare-warp")
OBJECT_KEY = "ci-state/warp-identity.tar.gz"

# This runs before any of start.sh's own warp-cli timeouts kick in, so it
# needs its own: a hung MinIO connection here would block the whole job
# before the parts that are already guarded even start.
BOTO_CONFIG = Config(connect_timeout=10, read_timeout=20, retries={"max_attempts": 2})


def s3_client():
    return boto3.client(
        "s3",
        endpoint_url=MINIO_ENDPOINT,
        aws_access_key_id=MINIO_ACCESS_KEY,
        aws_secret_access_key=MINIO_SECRET_KEY,
        config=BOTO_CONFIG,
    )


def restore() -> None:
    """Best-effort: a missing/corrupt cache just means a fresh registration
    happens next, same as if this script didn't exist at all."""
    client = s3_client()
    buffer = io.BytesIO()
    try:
        client.download_fileobj(MINIO_BUCKET, OBJECT_KEY, buffer)
    except ClientError as exc:
        print(f"No cached WARP identity to restore ({exc}); will register fresh", file=sys.stderr)
        return

    buffer.seek(0)
    try:
        with tarfile.open(fileobj=buffer, mode="r:gz") as tar:
            STATE_DIR.mkdir(parents=True, exist_ok=True)
            # Debian bookworm's system python3 (3.11.2) predates the PEP 706
            # `filter` keyword's backport (3.11.4+), so it can't be passed
            # unconditionally — this is our own tar, not an untrusted one,
            # so falling back to the old extractall is an acceptable trade.
            if sys.version_info >= (3, 11, 4):
                tar.extractall(STATE_DIR, filter="data")
            else:
                tar.extractall(STATE_DIR)
        print(f"Restored cached WARP identity into {STATE_DIR}")
    except tarfile.TarError as exc:
        print(f"Cached WARP identity was corrupt ({exc}); will register fresh", file=sys.stderr)


def save() -> None:
    if not STATE_DIR.exists():
        print(f"{STATE_DIR} does not exist, nothing to save", file=sys.stderr)
        return

    buffer = io.BytesIO()
    with tarfile.open(fileobj=buffer, mode="w:gz") as tar:
        tar.add(STATE_DIR, arcname=".")
    buffer.seek(0)

    client = s3_client()
    client.upload_fileobj(buffer, MINIO_BUCKET, OBJECT_KEY)
    print(f"Saved WARP identity from {STATE_DIR}")


if __name__ == "__main__":
    if len(sys.argv) != 2 or sys.argv[1] not in {"restore", "save"}:
        print(__doc__, file=sys.stderr)
        sys.exit(2)
    {"restore": restore, "save": save}[sys.argv[1]]()
