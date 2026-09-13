"""Shared device helpers for Bug Buster entity platforms."""
from __future__ import annotations

from homeassistant.helpers.device_registry import DeviceInfo

from .const import DOMAIN


def host_info(vmid: int | str, data: dict | None = None) -> DeviceInfo:
    data = data or {}
    vid = str(vmid)
    return DeviceInfo(
        identifiers={(DOMAIN, vid)},
        name=data.get("name") or f"CT {vid}",
        manufacturer="Proxmox",
        model="LXC",
    )


def host_data(hass, vmid: int | str) -> dict:
    hosts = hass.data.get(DOMAIN, {}).get("hosts", {})
    try:
        key = int(vmid)
    except (TypeError, ValueError):
        return {}
    return hosts.get(key) or {}
