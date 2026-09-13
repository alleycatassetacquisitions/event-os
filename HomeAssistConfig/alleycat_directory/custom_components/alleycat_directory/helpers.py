"""Lookup helpers for Alleycat Service Directory.

Other integrations should treat this as the authority for service URLs
(P2 prefer authority, P8 reusable primitive). Safe to call when Directory
is not loaded — returns default.
"""
from __future__ import annotations

from typing import Any

from .const import DEFAULTS, DOMAIN, EVENT_UPDATED, SERVICE_CATALOG


def get_services(hass) -> dict[str, dict[str, Any]]:
    data = hass.data.get(DOMAIN) or {}
    return dict(data.get("services") or {})


def get_url(hass, key: str, default: str | None = None) -> str:
    services = get_services(hass)
    url = str((services.get(key) or {}).get("url") or "").strip().rstrip("/")
    if url:
        return url
    if default is not None:
        return str(default).rstrip("/")
    return str(DEFAULTS.get(key) or "").rstrip("/")


def get_extra(hass, key: str, field: str, default: str = "") -> str:
    services = get_services(hass)
    extra = (services.get(key) or {}).get("extra") or {}
    value = extra.get(field)
    if value is None or value == "":
        return default
    return str(value)


def _secret_fields(key: str) -> set[str]:
    for spec in SERVICE_CATALOG:
        if spec["key"] != key:
            continue
        return {str(f["key"]) for f in spec.get("extra_fields") or () if f.get("secret")}
    return set()


def merge_extra(key: str, current: dict | None, incoming: dict | None) -> dict[str, Any]:
    """Merge extra fields. Blank secret values keep the stored secret."""
    merged = dict(current or {})
    secrets = _secret_fields(key)
    for raw_k, raw_v in dict(incoming or {}).items():
        field = str(raw_k)
        if field.endswith("_set"):
            continue
        value = "" if raw_v is None else str(raw_v).strip()
        if field in secrets and not value:
            continue
        merged[field] = value
    return merged


def public_extra(key: str, extra: dict | None) -> dict[str, Any]:
    """Copy extra for the frontend; never echo secret values."""
    out = dict(extra or {})
    for field in _secret_fields(key):
        present = bool(str(out.get(field) or "").strip())
        out[field] = ""
        out[f"{field}_set"] = present
    return out


def catalog_public(hass) -> list[dict[str, Any]]:
    stored = get_services(hass)
    out = []
    for spec in SERVICE_CATALOG:
        item = dict(spec)
        extra_fields = item.pop("extra_fields", ())
        saved = stored.get(spec["key"]) or {}
        item["url"] = str(saved.get("url") or DEFAULTS.get(spec["key"]) or "").rstrip("/")
        item["extra"] = public_extra(spec["key"], saved.get("extra") or {})
        item["extra_fields"] = [dict(f) for f in extra_fields]
        out.append(item)
    return out


def save_services(hass, services: dict[str, dict[str, Any]], *, changed_key: str | None = None) -> None:
    data = hass.data.setdefault(DOMAIN, {"services": {}, "entry_id": None})
    data["services"] = services
    entry_id = data.get("entry_id")
    if entry_id:
        entry = hass.config_entries.async_get_entry(entry_id)
        if entry:
            hass.config_entries.async_update_entry(entry, data={"services": services})
    hass.bus.async_fire(EVENT_UPDATED, {"key": changed_key, "services": catalog_public(hass)})


def apply_service(hass, key: str, *, url: str | None = None, extra: dict | None = None) -> bool:
    """Write one service from another integration. No-op if Directory is not set up."""
    if DOMAIN not in hass.data:
        return False
    from .urlutil import normalize_url

    services = get_services(hass)
    current = dict(services.get(key) or {"url": "", "extra": {}})
    if url is not None:
        current["url"] = normalize_url(str(url), key=key)
    if extra is not None:
        current["extra"] = merge_extra(key, current.get("extra") or {}, extra)
    services[key] = current
    save_services(hass, services, changed_key=key)
    return True
