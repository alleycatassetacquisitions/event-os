"""LED light entities for Digital Node Nexus devices."""
from __future__ import annotations

from homeassistant.components.light import ColorMode, LightEntity
from homeassistant.config_entries import ConfigEntry
from homeassistant.core import HomeAssistant, callback
from homeassistant.helpers.dispatcher import async_dispatcher_connect
from homeassistant.helpers.entity_platform import AddEntitiesCallback

from . import DOMAIN, SERVICE_SET_LED
from .device import device_data, device_info, device_meta

SIGNAL_NEW = f"{DOMAIN}_new_device"
SIGNAL_UPDATE = f"{DOMAIN}_update"


async def async_setup_entry(
    hass: HomeAssistant, entry: ConfigEntry, async_add_entities: AddEntitiesCallback
) -> None:
    known: set[str] = set()

    @callback
    def _add(device_id: str) -> None:
        if device_id in known:
            return
        known.add(device_id)
        async_add_entities([Esp32LedLight(hass, device_id)])

    entry.async_on_unload(async_dispatcher_connect(hass, SIGNAL_NEW, _add))
    for device_id in list(hass.data.get(DOMAIN, {}).get("devices", {})):
        _add(device_id)


class Esp32LedLight(LightEntity):
    _attr_has_entity_name = True
    _attr_name = "LED"
    _attr_supported_color_modes = {ColorMode.RGB}
    _attr_color_mode = ColorMode.RGB
    _attr_should_poll = False

    def __init__(self, hass: HomeAssistant, device_id: str) -> None:
        self.hass = hass
        self._device_id = device_id
        self._attr_unique_id = f"{DOMAIN}_{device_id}_led"
        self._unsub = None

    async def async_added_to_hass(self) -> None:
        self._unsub = async_dispatcher_connect(
            self.hass, SIGNAL_UPDATE, self._handle_update
        )

    async def async_will_remove_from_hass(self) -> None:
        if self._unsub:
            self._unsub()

    @callback
    def _handle_update(self, device_id: str) -> None:
        if device_id == self._device_id:
            self.async_write_ha_state()

    @property
    def device_info(self):
        return device_info(self._device_id, device_data(self.hass, self._device_id))

    @property
    def available(self) -> bool:
        return device_data(self.hass, self._device_id).get("online", False)

    @property
    def is_on(self) -> bool:
        return bool(device_data(self.hass, self._device_id).get("led_state"))

    @property
    def brightness(self) -> int | None:
        return 255 if self.is_on else 0

    @property
    def rgb_color(self) -> tuple[int, int, int] | None:
        return (255, 255, 255)

    @property
    def extra_state_attributes(self) -> dict:
        meta = device_meta(self.hass, self._device_id)
        data = device_data(self.hass, self._device_id)
        return {
            "broadcast_zone": meta.get("broadcast_zone") or "",
            "device_id": self._device_id,
            "ip": data.get("ip"),
        }

    async def async_turn_on(self, **kwargs) -> None:
        rgb = kwargs.get("rgb_color") or self.rgb_color or (255, 255, 255)
        brightness = int(kwargs.get("brightness", 255))
        await self.hass.services.async_call(
            DOMAIN,
            SERVICE_SET_LED,
            {
                "device_id": self._device_id,
                "state": True,
                "brightness": brightness,
                "red": int(rgb[0]),
                "green": int(rgb[1]),
                "blue": int(rgb[2]),
                "effect": "solid",
            },
            blocking=True,
        )

    async def async_turn_off(self, **kwargs) -> None:
        await self.hass.services.async_call(
            DOMAIN,
            SERVICE_SET_LED,
            {
                "device_id": self._device_id,
                "state": False,
                "brightness": 0,
                "red": 0,
                "green": 0,
                "blue": 0,
                "effect": "solid",
            },
            blocking=True,
        )
