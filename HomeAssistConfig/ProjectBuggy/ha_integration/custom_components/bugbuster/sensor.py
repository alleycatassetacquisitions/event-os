"""LXC telemetry sensors for Bug Buster."""
from __future__ import annotations

from homeassistant.components.sensor import SensorDeviceClass, SensorEntity, SensorStateClass
from homeassistant.config_entries import ConfigEntry
from homeassistant.const import PERCENTAGE, UnitOfTime
from homeassistant.core import HomeAssistant, callback
from homeassistant.helpers.dispatcher import async_dispatcher_connect
from homeassistant.helpers.entity_platform import AddEntitiesCallback

from .const import DOMAIN, SIGNAL_NEW_HOST, SIGNAL_UPDATE
from .device import host_data, host_info

SENSORS = (
    ("cpu_percent", "CPU", PERCENTAGE, None, SensorStateClass.MEASUREMENT),
    ("mem_percent", "Memory", PERCENTAGE, None, SensorStateClass.MEASUREMENT),
    ("uptime", "Uptime", UnitOfTime.SECONDS, SensorDeviceClass.DURATION, SensorStateClass.TOTAL_INCREASING),
    ("ip", "IP", None, None, None),
)


async def async_setup_entry(
    hass: HomeAssistant, entry: ConfigEntry, async_add_entities: AddEntitiesCallback
) -> None:
    known: set[str] = set()

    @callback
    def _add(vmid: str) -> None:
        if vmid in known:
            return
        known.add(vmid)
        async_add_entities([LxcAttrSensor(hass, vmid, *spec) for spec in SENSORS])

    entry.async_on_unload(async_dispatcher_connect(hass, SIGNAL_NEW_HOST, _add))
    for vmid in list(hass.data.get(DOMAIN, {}).get("hosts", {})):
        _add(str(vmid))


class LxcAttrSensor(SensorEntity):
    _attr_has_entity_name = True
    _attr_should_poll = False

    def __init__(
        self,
        hass: HomeAssistant,
        vmid: str,
        key: str,
        name: str,
        unit,
        device_class,
        state_class,
    ) -> None:
        self.hass = hass
        self._vmid = vmid
        self._key = key
        self._attr_name = name
        self._attr_unique_id = f"{DOMAIN}_{vmid}_{key}"
        self._attr_native_unit_of_measurement = unit
        self._attr_device_class = device_class
        self._attr_state_class = state_class
        self._unsub = None

    async def async_added_to_hass(self) -> None:
        self._unsub = async_dispatcher_connect(self.hass, SIGNAL_UPDATE, self._handle_update)

    async def async_will_remove_from_hass(self) -> None:
        if self._unsub:
            self._unsub()

    @callback
    def _handle_update(self, vmid: str) -> None:
        if str(vmid) == str(self._vmid):
            self.async_write_ha_state()

    @property
    def device_info(self):
        return host_info(self._vmid, host_data(self.hass, self._vmid))

    @property
    def available(self) -> bool:
        snap = host_data(self.hass, self._vmid)
        if self._key == "ip":
            return bool(snap)
        return bool(snap.get("online"))

    @property
    def native_value(self):
        return host_data(self.hass, self._vmid).get(self._key)
