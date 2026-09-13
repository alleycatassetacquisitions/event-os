"""Online binary sensor for Bug Buster LXC guests."""
from __future__ import annotations

from homeassistant.components.binary_sensor import BinarySensorDeviceClass, BinarySensorEntity
from homeassistant.config_entries import ConfigEntry
from homeassistant.core import HomeAssistant, callback
from homeassistant.helpers.dispatcher import async_dispatcher_connect
from homeassistant.helpers.entity_platform import AddEntitiesCallback

from .const import DOMAIN, SIGNAL_NEW_HOST, SIGNAL_UPDATE
from .device import host_data, host_info


async def async_setup_entry(
    hass: HomeAssistant, entry: ConfigEntry, async_add_entities: AddEntitiesCallback
) -> None:
    known: set[str] = set()

    @callback
    def _add(vmid: str) -> None:
        if vmid in known:
            return
        known.add(vmid)
        async_add_entities([LxcOnlineSensor(hass, vmid)])

    entry.async_on_unload(async_dispatcher_connect(hass, SIGNAL_NEW_HOST, _add))
    for vmid in list(hass.data.get(DOMAIN, {}).get("hosts", {})):
        _add(str(vmid))


class LxcOnlineSensor(BinarySensorEntity):
    _attr_has_entity_name = True
    _attr_name = "Online"
    _attr_device_class = BinarySensorDeviceClass.CONNECTIVITY
    _attr_should_poll = False

    def __init__(self, hass: HomeAssistant, vmid: str) -> None:
        self.hass = hass
        self._vmid = vmid
        self._attr_unique_id = f"{DOMAIN}_{vmid}_online"
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
    def is_on(self) -> bool:
        return bool(host_data(self.hass, self._vmid).get("online"))

    @property
    def extra_state_attributes(self) -> dict:
        snap = host_data(self.hass, self._vmid)
        return {
            "vmid": snap.get("vmid"),
            "node": snap.get("node"),
            "status": snap.get("status"),
            "ip": snap.get("ip"),
        }
