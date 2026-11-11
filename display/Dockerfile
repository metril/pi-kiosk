FROM debian:bookworm-slim
ENV DEBIAN_FRONTEND=noninteractive
RUN apt-get update && apt-get install -y --no-install-recommends \
      cage seatd chromium curl ca-certificates \
      fonts-noto-core fonts-noto-color-emoji fonts-dejavu-core \
      libgl1-mesa-dri mesa-vulkan-drivers xwayland \
    && rm -rf /var/lib/apt/lists/*
RUN useradd -r -u 10002 -m -d /home/kiosk kiosk
COPY entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh
ENTRYPOINT ["/entrypoint.sh"]
