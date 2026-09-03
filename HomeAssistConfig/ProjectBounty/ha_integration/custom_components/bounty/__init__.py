"""ProjectBounty — Mission Control bridge for the bounty capture panel.

Stores the Bounty server URL. The panel talks to ProjectBounty over HTTP and
loads the player roster via Registration websocket commands when available.
"""
from __future__ import annotations

import logging
from typing import Any

import voluptuous as vol

from homeassistant.config_entries import SOURCE_IMPORT, ConfigEntry
from homeassistant.core import HomeAssistant
from homeassistant.helpers import config_validation as cv
from homeassistant.helpers.typing import ConfigType

from .const import CONF_SERVER_URL, DEFAULT_SERVER_URL, DOMAIN

_LOGGER = logging.getLogger(__name__)

CONFIG_SCHEMA = vol.Schema(
    {
        vol.Optional(DOMAIN): vol.Schema(
            {
                vol.Optional(CONF_SERVER_URL, default=DEFAULT_SERVER_URL): cv.string,
            },
            extra=vol.ALLOW_EXTRA,
        )
    },
    extra=vol.ALLOW_EXTRA,
)


async def async_setup(hass: HomeAssistant, config: ConfigType) -> bool:
    conf = config.get(DOMAIN)
    if conf is None:
        return True

    hass.async_create_task(
        hass.config_entries.flow.async_init(
            DOMAIN,
            context={"source": SOURCE_IMPORT},
            data={CONF_SERVER_URL: conf.get(CONF_SERVER_URL, DEFAULT_SERVER_URL)},
        )
    )
    return True


async def async_setup_entry(hass: HomeAssistant, entry: ConfigEntry) -> bool:
    server_url = entry.data.get(CONF_SERVER_URL, DEFAULT_SERVER_URL).rstrip("/")
    hass.data.setdefault(DOMAIN, {})
    hass.data[DOMAIN]["server_url"] = server_url
    _LOGGER.info("ProjectBounty configured — server %s", server_url)
    return True


async def async_unload_entry(hass: HomeAssistant, entry: ConfigEntry) -> bool:
    hass.data.pop(DOMAIN, None)
    return True


def get_server_url(hass: HomeAssistant) -> str:
    data: dict[str, Any] = hass.data.get(DOMAIN) or {}
    return str(data.get("server_url") or DEFAULT_SERVER_URL).rstrip("/")
