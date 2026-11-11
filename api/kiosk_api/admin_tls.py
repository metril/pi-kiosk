"""Self-signed certificate for the admin server, kept in the data volume."""
import datetime as dt
import hashlib
import ipaddress
import logging
import os
import socket
from pathlib import Path

from cryptography import x509
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import ec
from cryptography.x509.oid import NameOID

log = logging.getLogger("kiosk.admin")
DAYS = 825
RENEW_DAYS = 30


def _sans(ip: str, hosts: list[str]) -> tuple[set[str], set[str]]:
    ips = {"127.0.0.1"}
    if ip and ip != "0.0.0.0":
        ips.add(ip)
    names = {"localhost", socket.gethostname(), *[h for h in hosts if h]}
    return ips, names


def fingerprint(cert_pem: bytes) -> str:
    der = x509.load_pem_x509_certificate(cert_pem).public_bytes(serialization.Encoding.DER)
    h = hashlib.sha256(der).hexdigest().upper()
    return ":".join(h[i:i + 2] for i in range(0, len(h), 2))


def _usable(cert_pem: bytes, ips: set[str], names: set[str]) -> bool:
    try:
        c = x509.load_pem_x509_certificate(cert_pem)
        san = c.extensions.get_extension_for_class(x509.SubjectAlternativeName).value
        have_ips = {str(i) for i in san.get_values_for_type(x509.IPAddress)}
        have_names = set(san.get_values_for_type(x509.DNSName))
        left = c.not_valid_after_utc - dt.datetime.now(dt.timezone.utc)
        return ips <= have_ips and names <= have_names and left > dt.timedelta(days=RENEW_DAYS)
    except (ValueError, x509.ExtensionNotFound):
        return False


def ensure_cert(directory: str, ip: str = "", hosts: list[str] | None = None) -> tuple[str, str, str]:
    """Returns (cert_path, key_path, sha256 fingerprint); generates when missing, stale or
    when the SANs no longer cover the bind IP / hostnames."""
    d = Path(directory)
    d.mkdir(parents=True, exist_ok=True)
    cert_p, key_p = d / "admin-cert.pem", d / "admin-key.pem"
    ips, names = _sans(ip, hosts or [])
    if cert_p.is_file() and key_p.is_file() and _usable(cert_p.read_bytes(), ips, names):
        return str(cert_p), str(key_p), fingerprint(cert_p.read_bytes())
    key = ec.generate_private_key(ec.SECP256R1())
    name = x509.Name([x509.NameAttribute(NameOID.COMMON_NAME, "pi-kiosk admin")])
    now = dt.datetime.now(dt.timezone.utc)
    cert = (x509.CertificateBuilder().subject_name(name).issuer_name(name)
            .public_key(key.public_key()).serial_number(x509.random_serial_number())
            .not_valid_before(now - dt.timedelta(minutes=5))
            .not_valid_after(now + dt.timedelta(days=DAYS))
            .add_extension(x509.SubjectAlternativeName(
                [x509.DNSName(n) for n in sorted(names)]
                + [x509.IPAddress(ipaddress.ip_address(i)) for i in sorted(ips)]), False)
            .add_extension(x509.BasicConstraints(ca=False, path_length=None), True)
            .sign(key, hashes.SHA256()))
    pem = cert.public_bytes(serialization.Encoding.PEM)
    for path, data in ((key_p, key.private_bytes(
            serialization.Encoding.PEM, serialization.PrivateFormat.PKCS8,
            serialization.NoEncryption())), (cert_p, pem)):
        tmp = f"{path}.tmp"
        fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
        with os.fdopen(fd, "wb") as f:
            f.write(data)
        os.replace(tmp, path)
    log.info("generated admin certificate for %s", sorted(ips | names))
    return str(cert_p), str(key_p), fingerprint(pem)
