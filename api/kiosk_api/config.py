import json

from pydantic_settings import BaseSettings


class Settings(BaseSettings):
    papyrus_url: str = "http://papyrus:8000"
    papyrus_token: str = ""
    labelmaker_url: str = "http://labelmaker:8000"
    labelmaker_token: str = ""
    idle_minutes: int = 5
    backlight_path: str = "/sys/class/backlight"
    static_dir: str = "/app/static"
    scan_paperless: bool = True
    scan_smb_share_id: str = ""
    scan_smb_path: str = ""
    scan_cloud_provider_id: str = ""
    scan_email_to: str = ""
    papyrus_public_url: str = ""
    unlock_idle_s: int = 120
    unlock_max_s: int = 900
    kiosk_contacts: str = ""  # JSON: [{"id","name","email"}]
    kiosk_presets: str = ""  # JSON: [{"id","label","icon","scan":{},"post":{},"targets":[]}]
    mqtt_host: str = ""
    mqtt_port: int = 1883
    mqtt_username: str = ""
    mqtt_password: str = ""
    mqtt_tls: bool = False
    mqtt_ca_file: str = ""  # optional CA bundle for the broker cert
    mqtt_tls_insecure: bool = False  # skip hostname check (not recommended)
    mqtt_discovery_prefix: str = "homeassistant"
    kiosk_id: str = "kiosk"
    kiosk_name: str = "Pi Kiosk"
    stats_interval: int = 30
    admin_port: int = 8443
    admin_host: str = "0.0.0.0"  # in-container listen address; the host side is ADMIN_BIND
    admin_tls: str = "on"  # "off" behind a reverse proxy that terminates TLS
    admin_cookie_secure: bool = True  # false only for plain-HTTP LAN use without a TLS proxy
    admin_trusted_proxies: str = ""  # comma-separated proxy IPs allowed to set X-Forwarded-For
    admin_san_ip: str = ""  # host LAN IP for the certificate (compose passes ADMIN_BIND)
    admin_san_hosts: str = ""  # extra comma-separated DNS names for the certificate
    admin_cert_dir: str = "/var/lib/pi-kiosk"
    settings_path: str = "/var/lib/pi-kiosk/settings.json"
    # Set from the stored settings (not env): None/empty means "use the env values".
    contacts_override: list[dict] | None = None
    presets_override: list[dict] | None = None
    shares: list[dict] = []
    mqtt_ca_pem: str = ""
    run_dir: str = "/run/pi-kiosk"
    hostfs: str = "/hostfs"
    proc_root: str = "/proc"
    sys_root: str = "/sys"
    print_max_bytes: int = 100 * 1024 * 1024
    spool_dir: str = "/var/tmp"  # disk-backed, not tmpfs /tmp

    def _json_list(self, raw: str) -> list[dict]:
        try:
            d = json.loads(raw) if raw.strip() else []
        except ValueError:
            return []
        return [x for x in d if isinstance(x, dict)] if isinstance(d, list) else []

    def contacts(self) -> list[dict]:
        if self.contacts_override is not None:
            return self.contacts_override
        return [c for c in self._json_list(self.kiosk_contacts)
                if c.get("id") and c.get("email")]

    def presets(self) -> list[dict]:
        if self.presets_override is not None:
            out = [dict(p) for p in self.presets_override]
            for p in out:
                p["needs_unlock"] = bool(p.get("targets"))
            return out
        out = [p for p in self._json_list(self.kiosk_presets) if p.get("id")]
        if not any(p["id"] == "default" for p in out):
            targets = []
            if self.scan_paperless:
                targets.append({"type": "paperless"})
            if self.scan_smb_share_id:
                targets.append({"type": "smb", "share_id": self.scan_smb_share_id,
                                "path": self.scan_smb_path})
            if self.scan_cloud_provider_id:
                targets.append({"type": "cloud", "provider_id": self.scan_cloud_provider_id})
            c = next((c for c in self.contacts() if c["email"] == self.scan_email_to), None)
            if c:
                targets.append({"type": "email", "contact_id": c["id"]})
            out.insert(0, {"id": "default", "label": "Scan", "icon": "scan",
                           "scan": {}, "post": {}, "targets": targets})
        for p in out:
            p["needs_unlock"] = bool(p.get("targets"))
        return out
