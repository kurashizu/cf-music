# Debian, not Alpine: the official Cloudflare WARP client (warp-cli/warp-svc)
# only ships glibc packages, no musl/Alpine build — this is why the project
# initially reached for wireproxy on Alpine instead, and why that approach
# was abandoned (no way to obtain raw WireGuard keys without either an
# undocumented reverse-engineered registration tool that Cloudflare rate
# limits aggressively, or a paid Zero Trust device enrollment flow that
# doesn't expose them either). warp-cli registers and manages its own keys
# internally — nothing needs to be extracted or handed to this image.
FROM debian:bookworm-slim

RUN apt-get update \
	&& apt-get install -y --no-install-recommends \
		curl gnupg lsb-release dbus python3 python3-pip python3-venv ffmpeg ca-certificates unzip \
	&& curl -fsSL https://pkg.cloudflareclient.com/pubkey.gpg \
		| gpg --yes --dearmor --output /usr/share/keyrings/cloudflare-warp-archive-keyring.gpg \
	&& echo "deb [signed-by=/usr/share/keyrings/cloudflare-warp-archive-keyring.gpg] https://pkg.cloudflareclient.com/ $(lsb_release -cs) main" \
		> /etc/apt/sources.list.d/cloudflare-client.list \
	&& apt-get update \
	&& apt-get install -y --no-install-recommends cloudflare-warp \
	&& apt-get clean \
	&& rm -rf /var/lib/apt/lists/*

# yt-dlp's youtube extractor increasingly needs a real JS runtime to solve
# the PO token / player signature challenge — without one it falls back to
# a degraded extraction path (missing formats, more retries, and by report
# a higher chance of hitting 429s under this job's concurrent downloads).
# Deno is what yt-dlp probes for and prefers by default (see its own
# --js-runtimes flag), and unlike Node it ships as a single static binary
# with no separate package manager/install step.
RUN curl -fsSL https://deno.land/install.sh | DENO_INSTALL=/usr/local sh -s -- --no-modify-path \
	&& deno --version

RUN python3 -m venv /opt/venv
ENV PATH="/opt/venv/bin:${PATH}"
# yt-dlp is deliberately NOT installed into this image — it breaks
# constantly as YouTube changes its frontend, so baking a version in here
# would go stale between image rebuilds and silently start failing every
# import job. It's installed fresh on the *host* runner instead (see
# import.yml), where actions/cache can persist pip's HTTP cache across
# runs — a Node-less container can't use actions/cache itself (it's a JS
# action), so this had to move outside the image entirely. import.yml
# runs this image via `docker run` (not a job-level `container:`, which
# would force every step including the cache one inside the image too)
# and bind-mounts the host install directory in, with import.py finding
# it via PYTHONPATH.
RUN pip install --no-cache-dir boto3 websockets

WORKDIR /import
COPY import.py warp_identity.py start.sh ./
RUN chmod +x start.sh

ENTRYPOINT ["/import/start.sh"]
