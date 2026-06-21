"""Config flow for ESP32 Commander."""
from __future__ import annotations

import voluptuous as vol
from homeassistant import config_entries
from homeassistant.data_entry_flow import FlowResult

from . import DOMAIN


class ESP32CommanderConfigFlow(config_entries.ConfigFlow, domain=DOMAIN):
    """Handle the config flow for ESP32 Commander."""

    VERSION = 1

    async def async_step_user(self, user_input=None) -> FlowResult:
        """Handle initial setup step."""
        if self._async_current_entries():
            return self.async_abort(reason="single_instance_allowed")

        if user_input is not None:
            return self.async_create_entry(
                title="ESP32 Commander",
                data=user_input,
            )

        return self.async_show_form(
            step_id="user",
            data_schema=vol.Schema({
                vol.Optional(
                    "topic_prefix",
                    default="esp32"
                ): str,
            }),
            description_placeholders={
                "mqtt_info": "Ensure the MQTT integration is configured before proceeding."
            },
        )
