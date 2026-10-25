#!/bin/sh
# ViniPlay container entrypoint.
# Runs briefly as root to prepare volumes and GPU access, then drops privileges so
# Node.js and every FFmpeg/ffprobe process it spawns run as an unprivileged user.
#
# Environment:
#   PUID / PGID  UID and GID to run as (default 1000:1000). Match these to the owner
#                of your host data/DVR folders. PUID=0 keeps the old run-as-root behaviour.
set -e

APP_USER=viniplay
PUID="${PUID:-1000}"
PGID="${PGID:-1000}"

# Already started as a non-root user (e.g. `docker run --user` / compose `user:`).
if [ "$(id -u)" != "0" ]; then
    exec "$@"
fi

if [ "$PUID" = "0" ]; then
    echo "[ENTRYPOINT] WARNING: PUID=0, running ViniPlay as root. This is not recommended."
    exec "$@"
fi

# Remap the app user to the requested IDs.
if [ "$(id -g "$APP_USER")" != "$PGID" ]; then
    groupmod -o -g "$PGID" "$APP_USER"
fi
if [ "$(id -u "$APP_USER")" != "$PUID" ]; then
    usermod -o -u "$PUID" "$APP_USER"
fi

# Grant access to mapped GPU render nodes (Intel QSV / VA-API). Their GID comes from
# the host, so add the user to whatever group owns each device node.
for dev in /dev/dri/renderD* /dev/dri/card*; do
    [ -e "$dev" ] || continue
    gid="$(stat -c '%g' "$dev")"
    [ "$gid" = "0" ] && continue
    group="$(getent group "$gid" | cut -d: -f1)"
    if [ -z "$group" ]; then
        group="hostgpu$gid"
        groupadd -g "$gid" "$group"
    fi
    usermod -aG "$group" "$APP_USER"
done

# Existing installs wrote /data and /dvr as root. Hand anything not already owned
# by the app user over to it (only touches mismatched files, so restarts stay fast).
mkdir -p /data /dvr
if ! find /data /dvr \( ! -user "$PUID" -o ! -group "$PGID" \) -exec chown -h "$PUID:$PGID" {} + ; then
    echo "[ENTRYPOINT] WARNING: could not change ownership of every file in /data or /dvr."
    echo "[ENTRYPOINT]          Make sure the host folders are writable by UID $PUID / GID $PGID."
fi

export HOME="/home/$APP_USER"
exec setpriv --reuid="$PUID" --regid="$PGID" --init-groups "$@"
