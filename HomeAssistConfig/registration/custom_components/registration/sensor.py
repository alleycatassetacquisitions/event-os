"""Player roster sensor — count in state, rows in attributes."""
from __future__ import annotations

from homeassistant.components.sensor import SensorEntity
from homeassistant.config_entries import ConfigEntry
from homeassistant.core import HomeAssistant, callback
from homeassistant.helpers.entity_platform import AddEntitiesCallback

from .const import DOMAIN
from . import get_api


async def async_setup_entry(
    hass: HomeAssistant, entry: ConfigEntry, async_add_entities: AddEntitiesCallback
) -> None:
    async_add_entities([PlayerRosterSensor(hass, entry)])


class PlayerRosterSensor(SensorEntity):
    _attr_has_entity_name = True
    _attr_name = "Player roster"
    _attr_icon = "mdi:account-group"

    def __init__(self, hass: HomeAssistant, entry: ConfigEntry) -> None:
        self.hass = hass
        self._entry = entry
        self._attr_unique_id = f"{entry.entry_id}_player_roster"
        self._unsub = None

    async def async_added_to_hass(self) -> None:
        self._unsub = self.hass.bus.async_listen(
            f"{DOMAIN}_players_updated", self._on_update
        )
        await self.async_update()

    async def async_will_remove_from_hass(self) -> None:
        if self._unsub:
            self._unsub()
            self._unsub = None

    @callback
    def _on_update(self, _event) -> None:
        api = get_api(self.hass)
        self._attr_native_value = len(api.players) if api else 0
        self.async_write_ha_state()

    async def async_update(self) -> None:
        api = get_api(self.hass)
        if api is None:
            return
        self._attr_native_value = len(api.players)

    @property
    def extra_state_attributes(self) -> dict:
        api = get_api(self.hass)
        players = api.players if api else []
        return {
            "data": players,
            "base_url": api.base_url if api else None,
        }
