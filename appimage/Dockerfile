# Builds one Claude-Desktop-<arch>.AppImage (+ .zsync) and exports only those
# files (`depot build --output type=local,dest=dist`). ci/appimage.py passes the
# build args; the .deb's URL and sha256 are build args, so a new upstream
# version (or a change under appimage/) is what invalidates the cache.
# Always built for linux/amd64: appimagetool packs aarch64 AppImages too.
FROM ubuntu:24.04 AS build
ARG DEBIAN_FRONTEND=noninteractive
RUN apt-get update -qq \
 && apt-get install -y -qq --no-install-recommends \
      ca-certificates curl python3 binutils file zsync nodejs npm xz-utils zstd >/dev/null \
 && rm -rf /var/lib/apt/lists/*
RUN npm install -g --silent @electron/asar@3.4.1
ENV NODE_PATH=/usr/local/lib/node_modules
# "continuous" briefly loses its assets while it's being rebuilt, hence the retries.
RUN curl -fsSL --retry 6 --retry-delay 20 --retry-all-errors -o /usr/local/bin/appimagetool \
      https://github.com/AppImage/appimagetool/releases/download/continuous/appimagetool-x86_64.AppImage \
 && chmod +x /usr/local/bin/appimagetool
ENV APPIMAGETOOL=/usr/local/bin/appimagetool

ARG ARCH
ARG VERSION
ARG DEB_URL
ARG DEB_SHA256
ARG UPDATE_BASE
WORKDIR /src
COPY appimage/ appimage/
RUN curl -fsSL --retry 5 --retry-all-errors -o /tmp/claude-desktop.deb "$DEB_URL" \
 && echo "$DEB_SHA256  /tmp/claude-desktop.deb" | sha256sum -c - \
 && UPDATE_BASE="$UPDATE_BASE" bash appimage/build.sh /tmp/claude-desktop.deb "$ARCH" "$VERSION" /out \
 && rm /tmp/claude-desktop.deb

FROM scratch
COPY --from=build /out/ /
