"""One process, two servers: the kiosk API (:8090, loopback on the host) and the admin app
(:8443, LAN, HTTPS by default). Both share the settings store."""
import asyncio
import contextlib
import logging
import signal

import uvicorn

from .admin import create_admin_app
from .admin_tls import ensure_cert
from .config import Settings
from .main import create_app

log = logging.getLogger("kiosk.admin")


def build(base: Settings):
    kiosk = create_app(base)
    admin = create_admin_app(kiosk, tls=base.admin_tls.lower() != "off",
                              cookie_secure=base.admin_cookie_secure)
    kc = uvicorn.Config(kiosk, host="0.0.0.0", port=8090, log_level="info")
    ac = dict(host=base.admin_host, port=base.admin_port, log_level="info")
    if base.admin_trusted_proxies.strip():
        ac.update(proxy_headers=True, forwarded_allow_ips=base.admin_trusted_proxies.strip())
    else:
        ac.update(proxy_headers=False)
    if base.admin_tls.lower() != "off":
        cert, key, fp = ensure_cert(base.admin_cert_dir, base.admin_san_ip,
                                    base.admin_san_hosts.split(","))
        ac.update(ssl_certfile=cert, ssl_keyfile=key)
        log.info("admin UI: https://%s:%s  certificate SHA-256 %s",
                 base.admin_san_ip or "<pi-host>", base.admin_port, fp)
    else:
        log.info("admin UI: plain HTTP on :%s (ADMIN_TLS=off; terminate TLS in front)",
                 base.admin_port)
    return [uvicorn.Server(kc), uvicorn.Server(uvicorn.Config(admin, **ac))]


async def serve(base: Settings | None = None):
    servers = build(base or Settings())
    for s in servers:
        s.capture_signals = contextlib.nullcontext  # we own the signals
        s.install_signal_handlers = lambda: None

    def stop():
        for s in servers:
            s.should_exit = True

    loop = asyncio.get_running_loop()
    for sig in (signal.SIGINT, signal.SIGTERM):
        loop.add_signal_handler(sig, stop)
    try:
        await asyncio.gather(*(s.serve() for s in servers))
    finally:
        stop()


def main():
    logging.basicConfig(level=logging.INFO)
    asyncio.run(serve())


if __name__ == "__main__":
    main()
