"""Shared device helpers for Digital Node Nexus entity platforms."""
from __future__ import annotations

from homeassistant.helpers.device_registry import DeviceInfo

DOMAIN = "digital_node_nexus"


def device_info(device_id: str, data: dict | None = None) -> DeviceInfo:
    data = data or {}
    return DeviceInfo(
        identifiers={(DOMAIN, device_id)},
        name=device_id,
        manufacturer="Alleycat",
        model="Digital Node Nexus",
        sw_version=data.get("firmware") or "unknown",
        configuration_url=None,
    )


def device_data(hass, device_id: str) -> dict:
    return hass.data.get(DOMAIN, {}).get("devices", {}).get(device_id, {})


def device_meta(hass, device_id: str) -> dict:
    return hass.data.get(DOMAIN, {}).get("device_meta", {}).get(device_id, {})
