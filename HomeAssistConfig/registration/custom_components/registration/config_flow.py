"""Config flow for Registration (player HTTP API)."""
from __future__ import annotations

import aiohttp
import voluptuous as vol

from homeassistant import config_entries
from homeassistant.core import HomeAssistant
from homeassistant.data_entry_flow import FlowResult
from homeassistant.helpers.aiohttp_client import async_get_clientsession

from .const import (
    CONF_API_TOKEN,
    CONF_BASE_URL,
    CONF_FALLBACK_URL,
    CONF_MODE,
    DEFAULT_BASE_URL,
    DEFAULT_FALLBACK_URL,
    DOMAIN,
    MODE_ONLINE,
)


async def _probe(hass: HomeAssistant, base_url: str, token: str | None) -> str | None:
    """Return error key or None if /health is ok."""
    session = async_get_clientsession(hass)
    headers = {}
    if token:
        headers["Authorization"] = f"Bearer {token}"
    try:
        async with session.get(
            f"{base_url.rstrip('/')}/health",
            headers=headers,
            timeout=aiohttp.ClientTimeout(total=8),
        ) as resp:
            if resp.status != 200:
                return "cannot_connect"
            data = await resp.json(content_type=None)
            if isinstance(data, dict) and data.get("status") not in (None, "ok"):
                return "cannot_connect"
    except Exception:  # noqa: BLE001
        return "cannot_connect"
    return None


class MissionControlConfigFlow(config_entries.ConfigFlow, domain=DOMAIN):
    """Set base_url for the player API (stub now, Central later)."""

    VERSION = 1

    async def async_step_user(self, user_input=None) -> FlowResult:
        if self._async_current_entries():
            return self.async_abort(reason="single_instance_allowed")

        errors: dict[str, str] = {}
        if user_input is not None:
            base = user_input[CONF_BASE_URL].rstrip("/")
            fallback = (user_input.get(CONF_FALLBACK_URL) or DEFAULT_FALLBACK_URL).rstrip("/")
            token = (user_input.get(CONF_API_TOKEN) or "").strip() or None
            # Health check is advisory only — allow saving even if server is offline.
            # The integration will retry when the API comes online.
            await _probe(self.hass, base, token)
            return self.async_create_entry(
                title="Registration",
                data={
                    CONF_BASE_URL: base,
                    CONF_FALLBACK_URL: fallback,
                    CONF_API_TOKEN: token or "",
                    CONF_MODE: MODE_ONLINE,
                },
            )

        return self.async_show_form(
            step_id="user",
            data_schema=vol.Schema(
                {
                    vol.Required(CONF_BASE_URL, default=DEFAULT_BASE_URL): str,
                    vol.Optional(CONF_FALLBACK_URL, default=DEFAULT_FALLBACK_URL): str,
                    vol.Optional(CONF_API_TOKEN, default=""): str,
                }
            ),
            errors=errors,
        )

    async def async_step_import(self, user_input=None) -> FlowResult:
        if self._async_current_entries():
            return self.async_abort(reason="single_instance_allowed")
        base = (user_input or {}).get(CONF_BASE_URL, DEFAULT_BASE_URL)
        fallback = (user_input or {}).get(CONF_FALLBACK_URL, DEFAULT_FALLBACK_URL)
        return self.async_create_entry(
            title="Registration",
            data={
                CONF_BASE_URL: str(base).rstrip("/"),
                CONF_FALLBACK_URL: str(fallback).rstrip("/"),
                CONF_API_TOKEN: "",
                CONF_MODE: MODE_ONLINE,
            },
        )
