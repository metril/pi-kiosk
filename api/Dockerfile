FROM --platform=$BUILDPLATFORM node:22-alpine AS web
WORKDIR /web
COPY web/ ./
RUN npm ci && npm run build

FROM python:3.12-slim
WORKDIR /app
COPY api/pyproject.toml ./
COPY api/kiosk_api ./kiosk_api
RUN pip install --no-cache-dir . && useradd -r -u 10001 kiosk \
    && mkdir -p /var/lib/pi-kiosk && chown kiosk /var/lib/pi-kiosk
COPY --from=web /web/dist /app/static
USER kiosk
EXPOSE 8090 8443
HEALTHCHECK --interval=30s --timeout=5s CMD python -c "import urllib.request as u;u.urlopen('http://127.0.0.1:8090/kiosk/config',timeout=3)"
CMD ["python", "-m", "kiosk_api.server"]
