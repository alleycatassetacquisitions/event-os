"""Config flow for Alleycat Service Directory."""
from __future__ import annotations

import voluptuous as vol

from homeassistant import config_entries
from homeassistant.data_entry_flow import FlowResult

from .const import (
    DEFAULTS,
    DOMAIN,
    KEY_ALLEYCATTV,
    KEY_BOUNTY,
    KEY_PROXMOX,
    KEY_REGISTRATION_PRIMARY,
    KEY_REGISTRATION_SECONDARY,
)
from .urlutil import services_from_mapping


class AlleycatDirectoryConfigFlow(config_entries.ConfigFlow, domain=DOMAIN):
    VERSION = 1

    async def async_step_user(self, user_input=None) -> FlowResult:
        if self._async_current_entries():
            return self.async_abort(reason="single_instance_allowed")

        if user_input is not None:
            await self.async_set_unique_id(DOMAIN)
            return self.async_create_entry(
                title="Core Configurator",
                data={"services": services_from_mapping(user_input)},
            )

        return self.async_show_form(
            step_id="user",
            data_schema=vol.Schema(
                {
                    vol.Optional(
                        KEY_REGISTRATION_PRIMARY,
                        default=DEFAULTS[KEY_REGISTRATION_PRIMARY],
                    ): str,
                    vol.Optional(
                        KEY_REGISTRATION_SECONDARY,
                        default=DEFAULTS[KEY_REGISTRATION_SECONDARY],
                    ): str,
                    vol.Optional(KEY_ALLEYCATTV, default=DEFAULTS[KEY_ALLEYCATTV]): str,
                    vol.Optional(KEY_BOUNTY, default=DEFAULTS[KEY_BOUNTY]): str,
                    vol.Optional(KEY_PROXMOX, default=DEFAULTS[KEY_PROXMOX]): str,
                    vol.Optional("proxmox_node", default="pve"): str,
                }
            ),
        )

    async def async_step_import(self, user_input: dict | None = None) -> FlowResult:
        if self._async_current_entries():
            return self.async_abort(reason="single_instance_allowed")
        await self.async_set_unique_id(DOMAIN)
        return self.async_create_entry(
            title="Core Configurator",
            data={"services": services_from_mapping(user_input or {})},
        )
