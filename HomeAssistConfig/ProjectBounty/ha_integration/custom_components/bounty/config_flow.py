"""Config flow for ProjectBounty."""
from __future__ import annotations

import aiohttp
import voluptuous as vol

from homeassistant import config_entries
from homeassistant.core import HomeAssistant
from homeassistant.data_entry_flow import FlowResult
from homeassistant.helpers.aiohttp_client import async_get_clientsession

from .const import CONF_SERVER_URL, DEFAULT_SERVER_URL, DOMAIN


async def _probe(hass: HomeAssistant, server_url: str) -> str | None:
    session = async_get_clientsession(hass)
    try:
        async with session.get(
            f"{server_url.rstrip('/')}/health",
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


class BountyConfigFlow(config_entries.ConfigFlow, domain=DOMAIN):
    VERSION = 1

    async def async_step_user(self, user_input=None) -> FlowResult:
        if self._async_current_entries():
            return self.async_abort(reason="single_instance_allowed")

        errors: dict[str, str] = {}
        if user_input is not None:
            base = user_input[CONF_SERVER_URL].rstrip("/")
            # Advisory health check — allow saving offline for event staging.
            err = await _probe(self.hass, base)
            if err:
                errors["base"] = err
            if not errors:
                await self.async_set_unique_id(DOMAIN)
                return self.async_create_entry(
                    title="Galactic Bounty Network",
                    data={CONF_SERVER_URL: base},
                )

        return self.async_show_form(
            step_id="user",
            data_schema=vol.Schema(
                {
                    vol.Required(CONF_SERVER_URL, default=DEFAULT_SERVER_URL): str,
                }
            ),
            errors=errors,
        )

    async def async_step_import(self, user_input: dict) -> FlowResult:
        if self._async_current_entries():
            return self.async_abort(reason="single_instance_allowed")
        base = (user_input.get(CONF_SERVER_URL) or DEFAULT_SERVER_URL).rstrip("/")
        await self.async_set_unique_id(DOMAIN)
        return self.async_create_entry(
            title="Galactic Bounty Network",
            data={CONF_SERVER_URL: base},
        )
