# syntax=docker/dockerfile:1.7
#
# ViniPlay container image.
#
# Stages:
#   node    - official Node.js image: a toolchain for native addons, and the
#             source of the node binary copied into the runtime image
#   deps    - installs production node_modules (and compiles native addons)
#   runtime - Ubuntu + Jellyfin FFmpeg + node binary + app code
#
# The runtime stays on Ubuntu (not Alpine/Debian slim) because jellyfin-ffmpeg is
# published for Ubuntu, the NVIDIA container toolkit injects glibc-linked CUDA
# libraries, and the entrypoint relies on setpriv/usermod from the base image.
#
# Layers are ordered from least to most frequently changed, so a code-only change
# rebuilds just the final COPY. Cache mounts keep apt/npm downloads out of the
# image and reuse them across local builds.

ARG NODE_VERSION=22
ARG UBUNTU_VERSION=24.04

# The full (non-slim) image already ships python3, make and g++, which node-gyp
# needs for addons without prebuilt binaries (diskusage; sqlite3 and bcrypt fall
# back to it too). None of it reaches the runtime image.
FROM node:${NODE_VERSION}-bookworm AS node

# Drop debug symbols from the node binary (about 90 MB -> 60 MB).
RUN strip --strip-all -o /usr/local/bin/node.stripped /usr/local/bin/node

# ---

FROM node AS deps
ARG TARGETARCH

WORKDIR /usr/src/app
COPY package.json package-lock.json ./
RUN --mount=type=cache,id=npm-${TARGETARCH},target=/root/.npm \
    npm ci --omit=dev --no-audit --no-fund

# ---

FROM ubuntu:${UBUNTU_VERSION} AS runtime
ARG TARGETARCH

# Set environment variables for NVIDIA capabilities
ENV NVIDIA_DRIVER_CAPABILITIES=all
ENV DEBIAN_FRONTEND=noninteractive
ENV LD_LIBRARY_PATH=/usr/lib/jellyfin-ffmpeg/lib
# Heap caps (MB): the server, and the worker thread that parses guides during a refresh. Override for huge libraries.
ENV NODE_OPTIONS=--max-old-space-size=2048
ENV VINIPLAY_EPG_HEAP_MB=2048

# Jellyfin's signing key, ASCII-armored. apt reads .asc keyrings directly, so
# neither curl nor gnupg has to be installed in the image.
ADD --chmod=644 https://repo.jellyfin.org/ubuntu/jellyfin_team.gpg.key /usr/share/keyrings/jellyfin.asc

# Runtime packages: CA certificates for HTTPS from Node.js, mesa VA-API drivers
# for Intel QSV / VA-API, and Jellyfin's FFmpeg build (purpose built for hardware
# transcoding, bundles the Intel QSV libraries). apt lists and .deb downloads live
# in cache mounts, so nothing needs cleaning up afterwards.
RUN rm -f /etc/apt/apt.conf.d/docker-clean && \
    echo 'Binary::apt::APT::Keep-Downloaded-Packages "true";' > /etc/apt/apt.conf.d/keep-cache
RUN --mount=type=cache,id=apt-cache-noble-${TARGETARCH},target=/var/cache/apt,sharing=locked \
    --mount=type=cache,id=apt-lists-noble-${TARGETARCH},target=/var/lib/apt/lists,sharing=locked \
    apt-get update && \
    apt-get install -y --no-install-recommends ca-certificates && \
    echo "deb [arch=${TARGETARCH} signed-by=/usr/share/keyrings/jellyfin.asc] https://repo.jellyfin.org/ubuntu noble main" > /etc/apt/sources.list.d/jellyfin.list && \
    apt-get update && \
    apt-get install -y --no-install-recommends \
    mesa-va-drivers \
    jellyfin-ffmpeg7 && \
    # Symlink Jellyfin's ffmpeg, ffprobe and vainfo for systemwide use
    ln -s /usr/lib/jellyfin-ffmpeg/ffmpeg /usr/bin/ffmpeg && \
    ln -s /usr/lib/jellyfin-ffmpeg/ffprobe /usr/bin/ffprobe && \
    ln -s /usr/lib/jellyfin-ffmpeg/vainfo /usr/bin/vainfo && \
    rm -rf /usr/share/doc/* /usr/share/man/* /usr/share/info/*

# Just the node binary from the official image: no npm, npx, corepack or headers,
# and no NodeSource apt repository.
COPY --from=node /usr/local/bin/node.stripped /usr/local/bin/node

# Create an unprivileged user to run the app (and every FFmpeg/ffprobe child process).
# The base image ships an 'ubuntu' user on UID/GID 1000; replace it so 'viniplay'
# owns the conventional 1000:1000 IDs. PUID/PGID can override these at runtime.
RUN userdel -r ubuntu 2>/dev/null || true && \
    groupadd -g 1000 viniplay && \
    useradd -u 1000 -g viniplay -G video -m -d /home/viniplay -s /usr/sbin/nologin viniplay

COPY --chmod=0755 docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh

# Create and declare volumes for persistent data
RUN mkdir -p /data /dvr && chown viniplay:viniplay /data /dvr
VOLUME /data
VOLUME /dvr

# Create and set the working directory
WORKDIR /usr/src/app

# Dependencies first, application code last: editing the code only invalidates
# the final layer. The code stays root-owned so the app user can read but not
# modify it. .dockerignore keeps docs, screenshots, tests and git data out.
COPY --from=deps /usr/src/app/node_modules ./node_modules
COPY . .

# Expose the application port
EXPOSE 8998

# The entrypoint starts as root only long enough to fix volume ownership and GPU
# device group membership, then drops to the 'viniplay' user before starting Node.
ENTRYPOINT [ "docker-entrypoint.sh" ]
CMD [ "node", "server.js" ]
