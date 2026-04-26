# Minimal sandbox image for pi-container-sandbox
#
# Goals:
#   - small, predictable surface area
#   - tools the agent typically needs to read/edit/grep/build code
#   - non-root user `pi` (uid/gid 1000) — agent never runs as root
#   - no SSH, no sudo, no setuid binaries beyond what debian-slim ships
#
# Built with either:
#   docker build -t pi-sandbox:latest -f docker/Dockerfile docker
#   container build -t pi-sandbox:latest -f docker/Dockerfile docker
FROM debian:bookworm-slim

ARG DEBIAN_FRONTEND=noninteractive

RUN apt-get update \
 && apt-get install -y --no-install-recommends \
        bash \
        ca-certificates \
        coreutils \
        curl \
        file \
        findutils \
        git \
        grep \
        jq \
        less \
        make \
        nodejs \
        npm \
        python3 \
        python3-pip \
        python3-venv \
        ripgrep \
        sed \
        tar \
        tini \
        unzip \
        xz-utils \
 && apt-get clean \
 && rm -rf /var/lib/apt/lists/*

# Non-root user. uid 1000 keeps file ownership predictable when the
# host cwd is bind-mounted into /workspace.
RUN groupadd -g 1000 pi \
 && useradd  -m -u 1000 -g 1000 -s /bin/bash pi \
 && mkdir -p /workspace \
 && chown -R pi:pi /workspace /home/pi

USER pi
WORKDIR /workspace

# tini reaps zombies so long-running agent shells stay tidy
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["sleep", "infinity"]
