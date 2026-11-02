# The processing program for Cloudflare Containers (`ra container`): verifies and unpacks uploads, makes
# the files for playing and previewing, fingerprints audio and runs the nightly encrypted backup.
# Built by `wrangler deploy` (see site/wrangler.jsonc); secrets never enter the image (.dockerignore).
FROM python:3.12-slim-trixie

# ffmpeg: specs, transcoding, Chromaprint · flac: seek tables · 7-Zip with its RAR codec (non-free) ·
# rclone: the backup · tini: PID 1, so the stop signal reaches the program (PID 1 ignores SIGTERM).
# The upgrade brings Debian's security fixes since the base image was made (ca-certificates among them).
RUN sed -i 's/^Components: main$/Components: main non-free/' /etc/apt/sources.list.d/debian.sources \
 && apt-get update \
 && apt-get upgrade -y \
 && apt-get install -y --no-install-recommends ffmpeg flac 7zip 7zip-rar rclone ca-certificates tini \
 && rm -rf /var/lib/apt/lists/*

COPY --from=ghcr.io/astral-sh/uv:0.13 /uv /usr/local/bin/uv
ENV UV_COMPILE_BYTECODE=1 UV_LINK_MODE=copy UV_PYTHON_DOWNLOADS=never PYTHONUNBUFFERED=1
WORKDIR /app
COPY pyproject.toml uv.lock ./
RUN uv sync --frozen --no-dev --no-install-project
COPY src ./src
RUN uv sync --frozen --no-dev
ENV PATH=/app/.venv/bin:$PATH

EXPOSE 8080
ENTRYPOINT ["tini", "--", "ra", "container", "--port", "8080"]
