"""Alleycat Service Directory — single authority for app endpoints.

P2 prefer authority over consensus: every Mission Control app reads URLs here
instead of localStorage, panel_custom config, or per-integration copies.
P8 reusable primitive: websocket + hass.data["alleycat_directory"]["services"].
"""
from __future__ import annotations

import logging

import voluptuous as vol

from homeassistant.config_entries import SOURCE_IMPORT, ConfigEntry
from homeassistant.core import HomeAssistant, callback
from homeassistant.helpers import config_validation as cv
from homeassistant.helpers.typing import ConfigType
from homeassistant.components import websocket_api

from .const import (
    DOMAIN,
    EVENT_UPDATED,
    KEY_PROXMOX,
    YAML_KEYS,
)
from .helpers import catalog_public, get_url, public_extra, save_services, merge_extra
from .urlutil import empty_services, normalize_url, services_from_mapping

_LOGGER = logging.getLogger(__name__)

CONFIG_SCHEMA = vol.Schema(
    {
        vol.Optional(DOMAIN): vol.Schema(
            {vol.Optional(key): cv.string for key in YAML_KEYS},
            extra=vol.ALLOW_EXTRA,
        )
    },
    extra=vol.ALLOW_EXTRA,
)


def _store(hass: HomeAssistant) -> dict:
    return hass.data.setdefault(DOMAIN, {"services": empty_services(), "entry_id": None})


def _persist(hass: HomeAssistant, services: dict) -> None:
    save_services(hass, services)


def _fire(hass: HomeAssistant, key: str | None = None) -> None:
    hass.bus.async_fire(
        EVENT_UPDATED,
        {"key": key, "services": catalog_public(hass)},
    )


@websocket_api.websocket_command({vol.Required("type"): f"{DOMAIN}/get_services"})
@websocket_api.async_response
async def ws_get_services(hass: HomeAssistant, connection, msg) -> None:
    connection.send_result(msg["id"], {"services": catalog_public(hass)})


@websocket_api.websocket_command(
    {
        vol.Required("type"): f"{DOMAIN}/get_url",
        vol.Required("key"): str,
    }
)
@websocket_api.async_response
async def ws_get_url(hass: HomeAssistant, connection, msg) -> None:
    key = msg["key"]
    extra = (_store(hass)["services"].get(key) or {}).get("extra") or {}
    connection.send_result(
        msg["id"],
        {"key": key, "url": get_url(hass, key, ""), "extra": public_extra(key, extra)},
    )


@websocket_api.websocket_command(
    {
        vol.Required("type"): f"{DOMAIN}/set_service",
        vol.Required("key"): str,
        vol.Optional("url"): str,
        vol.Optional("extra"): dict,
    }
)
@websocket_api.async_response
async def ws_set_service(hass: HomeAssistant, connection, msg) -> None:
    if not getattr(connection.user, "is_admin", False):
        connection.send_error(msg["id"], "unauthorized", "Admin required")
        return
    key = msg["key"]
    services = dict(_store(hass)["services"])
    current = dict(services.get(key) or {"url": "", "extra": {}})
    if "url" in msg and msg["url"] is not None:
        current["url"] = normalize_url(str(msg["url"]), key=key)
    if msg.get("extra") is not None:
        extra = merge_extra(key, current.get("extra") or {}, dict(msg["extra"]))
        current["extra"] = extra
    if key == KEY_PROXMOX:
        current.setdefault("extra", {})
    services[key] = current
    _persist(hass, services)
    _LOGGER.info("Service Directory: %s → %s", key, current.get("url"))
    connection.send_result(
        msg["id"],
        {
            "ok": True,
            "key": key,
            "url": current.get("url") or "",
            "extra": public_extra(key, current.get("extra") or {}),
        },
    )


async def async_setup(hass: HomeAssistant, config: ConfigType) -> bool:
    data = _store(hass)
    yaml_conf = config.get(DOMAIN)
    if yaml_conf is not None:
        data["_yaml"] = dict(yaml_conf)
        if not hass.config_entries.async_entries(DOMAIN):
            hass.async_create_task(
                hass.config_entries.flow.async_init(
                    DOMAIN, context={"source": SOURCE_IMPORT}, data=yaml_conf or {}
                )
            )
    _register_ws(hass)
    return True


def _seed_proxmox_tokens(services: dict, yaml_conf: dict | None) -> bool:
    if not yaml_conf:
        return False
    extra = (services.get(KEY_PROXMOX) or {}).setdefault("extra", {})
    changed = False
    token_id = str(yaml_conf.get("proxmox_token_id") or "").strip()
    token_secret = str(yaml_conf.get("proxmox_token_secret") or "").strip()
    if token_id and not str(extra.get("token_id") or "").strip():
        extra["token_id"] = token_id
        changed = True
    if token_secret and not str(extra.get("token_secret") or "").strip():
        extra["token_secret"] = token_secret
        changed = True
    return changed


async def async_setup_entry(hass: HomeAssistant, entry: ConfigEntry) -> bool:
    data = _store(hass)
    services = entry.data.get("services")
    if not isinstance(services, dict) or not services:
        services = services_from_mapping(entry.data)
    data["services"] = services
    data["entry_id"] = entry.entry_id
    if _seed_proxmox_tokens(services, data.get("_yaml")):
        save_services(hass, services, changed_key=KEY_PROXMOX)
        services = data["services"]
    _register_ws(hass)
    hass.bus.async_fire(EVENT_UPDATED, {"key": None, "services": catalog_public(hass)})
    _LOGGER.info("Service Directory ready (%d services)", len(services))
    return True


async def async_unload_entry(hass: HomeAssistant, entry: ConfigEntry) -> bool:
    hass.data.pop(DOMAIN, None)
    return True


@callback
def _register_ws(hass: HomeAssistant) -> None:
    if _store(hass).get("ws_registered"):
        return
    try:
        websocket_api.async_register_command(hass, ws_get_services)
        websocket_api.async_register_command(hass, ws_get_url)
        websocket_api.async_register_command(hass, ws_set_service)
        _store(hass)["ws_registered"] = True
    except Exception as err:  # noqa: BLE001
        _LOGGER.debug("Service Directory websocket already registered: %s", err)
