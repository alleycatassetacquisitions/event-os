"""URL normalization for Service Directory entries."""
from __future__ import annotations

from urllib.parse import urlparse

from .const import DEFAULTS, KEY_PROXMOX, SERVICE_CATALOG


def normalize_url(raw: str, *, key: str = "") -> str:
    text = (raw or "").strip()
    if not text:
        return ""
    if "://" not in text:
        if key == KEY_PROXMOX:
            if ":" not in text.split("/")[0]:
                text = f"{text}:8006"
            text = f"https://{text}"
        else:
            text = f"http://{text}"
    parsed = urlparse(text)
    if not parsed.hostname:
        return text.rstrip("/")
    if key == KEY_PROXMOX and parsed.port is None:
        host = parsed.hostname
        netloc = f"[{host}]:8006" if ":" in host else f"{host}:8006"
        return f"{parsed.scheme}://{netloc}"
    return text.rstrip("/")


def empty_services() -> dict:
    out = {}
    for spec in SERVICE_CATALOG:
        item = {"url": DEFAULTS.get(spec["key"], ""), "extra": {}}
        if spec["key"] == KEY_PROXMOX:
            item["extra"] = {"node": "pve", "token_id": "", "token_secret": ""}
        out[spec["key"]] = item
    return out


def services_from_mapping(data: dict) -> dict:
    """Build the stored services dict from YAML / config-flow fields."""
    services = empty_services()
    for spec in SERVICE_CATALOG:
        key = spec["key"]
        if data.get(key):
            services[key]["url"] = normalize_url(str(data[key]), key=key)
    if data.get("proxmox_node") is not None:
        services[KEY_PROXMOX].setdefault("extra", {})["node"] = str(data.get("proxmox_node") or "").strip()
    extra = services[KEY_PROXMOX].setdefault("extra", {})
    if data.get("proxmox_token_id"):
        extra["token_id"] = str(data.get("proxmox_token_id") or "").strip()
    if data.get("proxmox_token_secret"):
        extra["token_secret"] = str(data.get("proxmox_token_secret") or "").strip()
    return services
