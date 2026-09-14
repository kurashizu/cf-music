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
		curl gnupg lsb-release dbus python3 python3-pip python3-venv ffmpeg ca-certificates \
	&& curl -fsSL https://pkg.cloudflareclient.com/pubkey.gpg \
		| gpg --yes --dearmor --output /usr/share/keyrings/cloudflare-warp-archive-keyring.gpg \
	&& echo "deb [signed-by=/usr/share/keyrings/cloudflare-warp-archive-keyring.gpg] https://pkg.cloudflareclient.com/ $(lsb_release -cs) main" \
		> /etc/apt/sources.list.d/cloudflare-client.list \
	&& apt-get update \
	&& apt-get install -y --no-install-recommends cloudflare-warp \
	&& apt-get clean \
	&& rm -rf /var/lib/apt/lists/*

RUN python3 -m venv /opt/venv
ENV PATH="/opt/venv/bin:${PATH}"
RUN pip install --no-cache-dir yt-dlp boto3 websockets

WORKDIR /import
COPY import.py warp_identity.py start.sh ./
RUN chmod +x start.sh

ENTRYPOINT ["/import/start.sh"]
