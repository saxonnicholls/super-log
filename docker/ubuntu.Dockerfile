# Ubuntu build + smoke of everything headless: the hub, the C++ SDK compile
# test, and the demo clock client - both logging paths, against the pinned
# third_party spdlog+fmt. `docker build` IS this repo's Linux CI until a
# remote exists: scripts/smoke.sh runs inside the build, so an image that
# exists is an image that passed on gcc/libstdc++/epoll, not just on the
# Mac's clang/libc++/kqueue.
#
# The runtime stage doubles as a Linux producer for the bench:
#
#   docker compose -f docker/compose.yml up --build    # -> cpp.linux.* streams
#
# Build context is the repo root (see .dockerignore):
#
#   docker build -f docker/ubuntu.Dockerfile .

FROM ubuntu:24.04 AS build
RUN apt-get update && apt-get install -y --no-install-recommends \
        build-essential cmake git ca-certificates curl \
    && rm -rf /var/lib/apt/lists/*

# ts-moveables, pinned to the SHA the scaffold was built against. Bump the
# ARG deliberately; an image must not change because another repo's HEAD did.
ARG TS_MOVEABLES_TAG=f9f25875b5508bdf660fe51d852d0d7e973a782f
RUN git clone https://github.com/saxonnicholls/ts-moveables.git /opt/TSMoveables \
    && git -C /opt/TSMoveables checkout --quiet "$TS_MOVEABLES_TAG"

COPY . /src
RUN cmake -S /src -B /build -DCMAKE_BUILD_TYPE=Release \
        -DTS_MOVEABLES_DIR=/opt/TSMoveables \
        -DSUPER_LOG_BUILD_IMGUI_VIEWER=OFF \
    && cmake --build /build -j "$(nproc)"

# The gate: no green smoke, no image.
RUN BUILD_DIR=/build /src/scripts/smoke.sh

# Runtime: the clock plus a real journald (started by entry.sh, no systemd
# PID 1) and the os-linux tailer, so the container is both an app producer
# (cpp.linux.*) and an OS-log producer (os.<hostname>).
FROM ubuntu:24.04
RUN apt-get update && apt-get install -y --no-install-recommends \
        nodejs systemd \
    && rm -rf /var/lib/apt/lists/*
COPY --from=build /build/hub/superlogd \
                  /build/demo/cpp/superlog_clock_cpp /usr/local/bin/
COPY tailers/bin /opt/superlog/tailers/bin
COPY docker/entry.sh /usr/local/bin/superlog-entry
# Default role: a producer on the host's bench. host.docker.internal is
# built in on Docker Desktop; compose.yml adds the host-gateway mapping so
# the same image works from a Linux host too.
ENV SUPER_LOG_HOST=host.docker.internal \
    SUPER_LOG_TOPIC_NS=cpp.linux
CMD ["superlog-entry"]
