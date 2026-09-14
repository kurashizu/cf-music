# Alpine keeps the pushed image small; everything the import job needs
# (yt-dlp, ffmpeg, wireproxy for the WARP tunnel) is baked in at build time
# so the GitHub Actions run itself never does `apk add`/`pip install` — it
# just pulls this image from GHCR and runs the script.
FROM python:3.13-alpine AS wireproxy-fetch

ARG WIREPROXY_VERSION=1.0.9
# wireproxy has no official musl/Alpine build, so the amd64 Linux release
# binary is fetched here instead of building the official warp-cli (which
# only ships glibc packages) — see the project's import-pipeline design notes.
RUN apk add --no-cache curl \
	&& curl -fsSL -o /tmp/wireproxy.tar.gz \
		"https://github.com/whyvl/wireproxy/releases/download/v${WIREPROXY_VERSION}/wireproxy_linux_amd64.tar.gz" \
	&& tar -xzf /tmp/wireproxy.tar.gz -C /usr/local/bin wireproxy \
	&& chmod +x /usr/local/bin/wireproxy

FROM python:3.13-alpine

RUN apk add --no-cache ffmpeg ca-certificates \
	&& pip install --no-cache-dir --break-system-packages yt-dlp boto3 websockets

COPY --from=wireproxy-fetch /usr/local/bin/wireproxy /usr/local/bin/wireproxy

WORKDIR /import
COPY import.py wireproxy.conf.template ./

ENTRYPOINT ["python", "/import/import.py"]
