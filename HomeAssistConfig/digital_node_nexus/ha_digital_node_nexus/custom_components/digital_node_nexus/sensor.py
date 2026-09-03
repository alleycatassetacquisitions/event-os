"""Telemetry sensors for Digital Node Nexus devices."""
from __future__ import annotations

from homeassistant.components.sensor import SensorDeviceClass, SensorEntity, SensorStateClass
from homeassistant.config_entries import ConfigEntry
from homeassistant.const import SIGNAL_STRENGTH_DECIBELS_MILLIWATT, UnitOfTime
from homeassistant.core import HomeAssistant, callback
from homeassistant.helpers.dispatcher import async_dispatcher_connect
from homeassistant.helpers.entity_platform import AddEntitiesCallback

from . import DOMAIN
from .device import device_data, device_info, device_meta

SIGNAL_NEW = f"{DOMAIN}_new_device"
SIGNAL_UPDATE = f"{DOMAIN}_update"

SENSORS = (
    ("rssi", "RSSI", SIGNAL_STRENGTH_DECIBELS_MILLIWATT, SensorDeviceClass.SIGNAL_STRENGTH, SensorStateClass.MEASUREMENT),
    ("uptime", "Uptime", UnitOfTime.SECONDS, SensorDeviceClass.DURATION, SensorStateClass.TOTAL_INCREASING),
    ("ip", "IP", None, None, None),
    ("firmware", "Firmware", None, None, None),
    ("free_heap", "Free heap", "B", None, SensorStateClass.MEASUREMENT),
)


async def async_setup_entry(
    hass: HomeAssistant, entry: ConfigEntry, async_add_entities: AddEntitiesCallback
) -> None:
    known: set[str] = set()

    @callback
    def _add(device_id: str) -> None:
        if device_id in known:
            return
        known.add(device_id)
        async_add_entities(
            [Esp32AttrSensor(hass, device_id, *spec) for spec in SENSORS]
        )

    entry.async_on_unload(async_dispatcher_connect(hass, SIGNAL_NEW, _add))
    for device_id in list(hass.data.get(DOMAIN, {}).get("devices", {})):
        _add(device_id)


class Esp32AttrSensor(SensorEntity):
    _attr_has_entity_name = True
    _attr_should_poll = False

    def __init__(
        self,
        hass: HomeAssistant,
        device_id: str,
        key: str,
        name: str,
        unit,
        device_class,
        state_class,
    ) -> None:
        self.hass = hass
        self._device_id = device_id
        self._key = key
        self._attr_name = name
        self._attr_unique_id = f"{DOMAIN}_{device_id}_{key}"
        self._attr_native_unit_of_measurement = unit
        self._attr_device_class = device_class
        self._attr_state_class = state_class
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
        return bool(device_data(self.hass, self._device_id).get("online", False)) or self._key in (
            "ip",
            "firmware",
        )

    @property
    def native_value(self):
        return device_data(self.hass, self._device_id).get(self._key)

    @property
    def extra_state_attributes(self) -> dict:
        meta = device_meta(self.hass, self._device_id)
        return {
            "broadcast_zone": meta.get("broadcast_zone") or "",
            "device_id": self._device_id,
        }
