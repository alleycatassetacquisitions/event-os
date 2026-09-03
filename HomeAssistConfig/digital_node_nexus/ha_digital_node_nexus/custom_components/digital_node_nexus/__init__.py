"""Digital Node Nexus - Home Assistant Custom Integration.

Bridges Home Assistant to ESP32 devices via MQTT.
Payloads are Protocol Buffers (protobuf) binary â€” NOT JSON.
Schema: proto/digital_node_nexus.proto â†’ digital_node_nexus_pb2.py (generated, do not edit).
"""
from __future__ import annotations

import logging
from typing import Any

import voluptuous as vol

from homeassistant.config_entries import SOURCE_IMPORT, ConfigEntry
from homeassistant.const import Platform
from homeassistant.core import HomeAssistant, ServiceCall
from homeassistant.helpers import area_registry as ar
from homeassistant.helpers import config_validation as cv
from homeassistant.helpers import device_registry as dr
from homeassistant.helpers.dispatcher import async_dispatcher_send
from homeassistant.helpers.storage import Store
from homeassistant.components import mqtt, websocket_api
import aiohttp
from homeassistant.helpers.aiohttp_client import async_get_clientsession

from .digital_node_nexus_pb2 import MessageCmd, LedCmd, HapticCmd, RawCmd, StatusMsg

_LOGGER = logging.getLogger(__name__)

DOMAIN = "digital_node_nexus"
PLATFORMS: list[Platform] = [Platform.LIGHT, Platform.BINARY_SENSOR, Platform.SENSOR]
SIGNAL_NEW_DEVICE = f"{DOMAIN}_new_device"
SIGNAL_UPDATE = f"{DOMAIN}_update"
STORAGE_VERSION = 1
STORAGE_KEY = f"{DOMAIN}_device_meta"
SERVICE_SET_PLACEMENT = "set_placement"

CONFIG_SCHEMA = vol.Schema(
    {vol.Optional(DOMAIN): vol.Schema({}, extra=vol.ALLOW_EXTRA)},
    extra=vol.ALLOW_EXTRA,
)

# MQTT topic structure:
#   Commands TO device:   esp32/{device_id}/cmd/{action}
#   Status FROM device:   esp32/{device_id}/status
TOPIC_CMD = "esp32/{device_id}/cmd/{action}"
TOPIC_STATUS = "esp32/{device_id}/status"
TOPIC_STATUS_ALL = "esp32/+/status"

# Service names
SERVICE_SEND_MESSAGE = "send_message"
SERVICE_SET_LED = "set_led"
SERVICE_TRIGGER_HAPTIC = "trigger_haptic"
SERVICE_SEND_RAW = "send_raw"

# Service schemas
SERVICE_SEND_MESSAGE_SCHEMA = vol.Schema({
    vol.Required("device_id"): cv.string,
    vol.Required("message"): cv.string,
    vol.Optional("duration", default=5): vol.All(int, vol.Range(min=1, max=60)),
    vol.Optional("scroll", default=False): cv.boolean,
})

SERVICE_SET_LED_SCHEMA = vol.Schema({
    vol.Required("device_id"): cv.string,
    vol.Required("state"): cv.boolean,
    vol.Optional("brightness", default=255): vol.All(int, vol.Range(min=0, max=255)),
    vol.Optional("red", default=255): vol.All(int, vol.Range(min=0, max=255)),
    vol.Optional("green", default=255): vol.All(int, vol.Range(min=0, max=255)),
    vol.Optional("blue", default=255): vol.All(int, vol.Range(min=0, max=255)),
    vol.Optional("effect", default="solid"): vol.In(["solid", "blink", "pulse", "rainbow"]),
})

SERVICE_TRIGGER_HAPTIC_SCHEMA = vol.Schema({
    vol.Required("device_id"): cv.string,
    vol.Required("pattern"): vol.In(["short", "long", "double", "sos", "custom"]),
    vol.Optional("intensity", default=255): vol.All(int, vol.Range(min=0, max=255)),
    vol.Optional("duration_ms", default=200): vol.All(int, vol.Range(min=10, max=5000)),
    vol.Optional("repeat", default=1): vol.All(int, vol.Range(min=1, max=10)),
})

SERVICE_SEND_RAW_SCHEMA = vol.Schema({
    vol.Required("device_id"): cv.string,
    vol.Required("action"): cv.string,
    vol.Required("payload"): dict,
})

SERVICE_SET_PLACEMENT_SCHEMA = vol.Schema({
    vol.Required("device_id"): cv.string,
    vol.Optional("area_id"): cv.string,
    vol.Optional("broadcast_zone"): cv.string,
})


def _to_bytes(payload: Any) -> bytes:
    """Normalise an MQTT payload to bytes regardless of how HA delivers it."""
    if isinstance(payload, (bytes, bytearray)):
        return bytes(payload)
    if isinstance(payload, str):
        # HA may decode binary content as a Latin-1 string to preserve all byte values.
        return payload.encode("latin-1")
    return bytes(payload)


@websocket_api.websocket_command({
    vol.Required("type"): f"{DOMAIN}/list_devices",
})
@websocket_api.async_response
async def websocket_list_devices(hass: HomeAssistant, connection, msg) -> None:
    """Return the list of known ESP32 devices stored in hass.data."""
    devices = hass.data.get(DOMAIN, {}).get("devices", {})
    meta = hass.data.get(DOMAIN, {}).get("device_meta", {})
    out = []
    for d in devices.values():
        item = dict(d)
        item["broadcast_zone"] = meta.get(d.get("device_id"), {}).get("broadcast_zone", "")
        item["area_id"] = meta.get(d.get("device_id"), {}).get("area_id", "")
        out.append(item)
    connection.send_result(msg["id"], {"devices": out})


@websocket_api.websocket_command({vol.Required("type"): f"{DOMAIN}/list_areas"})
@websocket_api.async_response
async def websocket_list_areas(hass: HomeAssistant, connection, msg) -> None:
    registry = ar.async_get(hass)
    areas = [
        {"area_id": a.id, "name": a.name}
        for a in registry.async_list_areas()
    ]
    connection.send_result(msg["id"], {"areas": areas})


@websocket_api.websocket_command({vol.Required("type"): f"{DOMAIN}/list_broadcast_zones"})
@websocket_api.async_response
async def websocket_list_broadcast_zones(hass: HomeAssistant, connection, msg) -> None:
    zones = await _fetch_alleycattv_zones(hass)
    connection.send_result(msg["id"], {"zones": zones})


@websocket_api.websocket_command({
    vol.Required("type"): f"{DOMAIN}/set_placement",
    vol.Required("device_id"): str,
    vol.Optional("area_id"): str,
    vol.Optional("broadcast_zone"): str,
})
@websocket_api.async_response
async def websocket_set_placement(hass: HomeAssistant, connection, msg) -> None:
    await _set_placement(
        hass,
        msg["device_id"],
        msg.get("area_id"),
        msg.get("broadcast_zone"),
    )
    connection.send_result(msg["id"], {"ok": True})


async def _fetch_alleycattv_zones(hass: HomeAssistant) -> list[dict]:
    """Live zone list from AlleycatTV â€” never a hardcoded name enum."""
    server_url = None
    for entry in hass.config_entries.async_entries("alleycattv"):
        server_url = entry.data.get("server_url") or entry.options.get("server_url")
        if server_url:
            break
    if not server_url:
        server_url = "http://192.168.1.144"
    try:
        session = async_get_clientsession(hass)
        timeout = aiohttp.ClientTimeout(total=8)
        async with session.get(
            f"{server_url.rstrip('/')}/api/zones/", timeout=timeout
        ) as resp:
            if resp.status != 200:
                async with session.get(
                    f"{server_url.rstrip('/')}/api/zones", timeout=timeout
                ) as resp2:
                    data = await resp2.json(content_type=None)
            else:
                data = await resp.json(content_type=None)
        if isinstance(data, list):
            return [
                {"zone_id": z.get("zone_id"), "name": z.get("name") or z.get("zone_id")}
                for z in data
                if z.get("zone_id")
            ]
    except Exception as err:  # noqa: BLE001
        _LOGGER.debug("Could not fetch AlleycatTV zones: %s", err)
    return []


async def _set_placement(
    hass: HomeAssistant,
    device_id: str,
    area_id: str | None,
    broadcast_zone: str | None,
) -> None:
    meta = hass.data[DOMAIN].setdefault("device_meta", {})
    current = dict(meta.get(device_id, {}))
    if area_id is not None:
        current["area_id"] = area_id
        registry = dr.async_get(hass)
        device = registry.async_get_device(identifiers={(DOMAIN, device_id)})
        if device:
            registry.async_update_device(device.id, area_id=area_id or None)
    if broadcast_zone is not None:
        current["broadcast_zone"] = broadcast_zone
    meta[device_id] = current
    store: Store | None = hass.data[DOMAIN].get("store")
    if store:
        await store.async_save(meta)
    async_dispatcher_send(hass, SIGNAL_UPDATE, device_id)
    hass.bus.async_fire(f"{DOMAIN}_device_update", {
        "device_id": device_id,
        **hass.data[DOMAIN]["devices"].get(device_id, {}),
        "broadcast_zone": current.get("broadcast_zone", ""),
        "area_id": current.get("area_id", ""),
    })


def _upsert_device_registry(hass: HomeAssistant, device_id: str, data: dict) -> None:
    registry = dr.async_get(hass)
    meta = hass.data[DOMAIN].get("device_meta", {}).get(device_id, {})
    registry.async_get_or_create(
        config_entry_id=hass.data[DOMAIN].get("entry_id"),
        identifiers={(DOMAIN, device_id)},
        manufacturer="Alleycat",
        model="Digital Node Nexus",
        name=device_id,
        sw_version=data.get("firmware") or "unknown",
        suggested_area=None,
    )
    device = registry.async_get_device(identifiers={(DOMAIN, device_id)})
    if device and meta.get("area_id") and device.area_id != meta.get("area_id"):
        registry.async_update_device(device.id, area_id=meta["area_id"] or None)


async def async_setup(hass: HomeAssistant, config: dict) -> bool:
    """Set up the Digital Node Nexus component from configuration.yaml."""
    _LOGGER.warning("Digital Node Nexus: async_setup START")

    hass.data.setdefault(DOMAIN, {"devices": {}, "subscriptions": [], "device_meta": {}})
    store = Store(hass, STORAGE_VERSION, STORAGE_KEY)
    hass.data[DOMAIN]["store"] = store
    hass.data[DOMAIN]["device_meta"] = await store.async_load() or {}

    yaml_conf = config.get(DOMAIN)
    if yaml_conf is not None and not hass.config_entries.async_entries(DOMAIN):
        hass.async_create_task(
            hass.config_entries.flow.async_init(
                DOMAIN, context={"source": SOURCE_IMPORT}, data=yaml_conf or {}
            )
        )

    await _setup_integration(hass)

    _LOGGER.warning("Digital Node Nexus: async_setup COMPLETE")
    return True


async def async_setup_entry(hass: HomeAssistant, entry: ConfigEntry) -> bool:
    """Set up Digital Node Nexus from a config entry (UI flow)."""
    _LOGGER.warning("Digital Node Nexus: async_setup_entry START")

    hass.data.setdefault(DOMAIN, {"devices": {}, "subscriptions": [], "device_meta": {}})
    hass.data[DOMAIN]["entry_id"] = entry.entry_id
    if "store" not in hass.data[DOMAIN]:
        store = Store(hass, STORAGE_VERSION, STORAGE_KEY)
        hass.data[DOMAIN]["store"] = store
        hass.data[DOMAIN]["device_meta"] = await store.async_load() or {}

    await _setup_integration(hass)
    await hass.config_entries.async_forward_entry_setups(entry, PLATFORMS)

    _LOGGER.warning("Digital Node Nexus: async_setup_entry COMPLETE")
    return True


async def _setup_integration(hass: HomeAssistant) -> None:
    """Register services, websocket command, and MQTT subscription.

    Called from both async_setup (YAML) and async_setup_entry (UI config flow)
    so the integration is fully operational regardless of how HA loaded it.
    Idempotent â€” skips re-registration if already set up.
    """
    # â”€â”€ 1. Register services â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
    if not hass.services.has_service(DOMAIN, SERVICE_SEND_MESSAGE):
        await _register_services(hass)
        _LOGGER.warning("Digital Node Nexus: services registered")
    else:
        _LOGGER.debug("Digital Node Nexus: services already registered, skipping")

    # â”€â”€ 2. Register websocket command â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
    try:
        websocket_api.async_register_command(hass, websocket_list_devices)
        websocket_api.async_register_command(hass, websocket_list_areas)
        websocket_api.async_register_command(hass, websocket_list_broadcast_zones)
        websocket_api.async_register_command(hass, websocket_set_placement)
        _LOGGER.warning("Digital Node Nexus: websocket command registered")
    except Exception as err:  # noqa: BLE001
        _LOGGER.debug("Digital Node Nexus: websocket command already registered or failed: %s", err)

    # â”€â”€ 3. Subscribe to MQTT (skip if already subscribed) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
    if hass.data[DOMAIN].get("subscriptions"):
        _LOGGER.debug("Digital Node Nexus: MQTT already subscribed, skipping")
        return

    async def handle_status_message(msg) -> None:
        """Decode an incoming protobuf StatusMsg from an ESP32 device."""
        _LOGGER.warning("Digital Node Nexus: status message received on %s (%d bytes, type=%s)",
                        msg.topic, len(msg.payload) if msg.payload else 0, type(msg.payload).__name__)
        try:
            topic_parts = msg.topic.split("/")
            if len(topic_parts) < 3:
                _LOGGER.warning("Digital Node Nexus: unexpected topic format: %s", msg.topic)
                return

            device_id = topic_parts[1]
            raw = _to_bytes(msg.payload)
            _LOGGER.warning("Digital Node Nexus: raw bytes length=%d for device %s", len(raw), device_id)

            # An empty payload is the LWT â€” device went offline.
            if len(raw) == 0:
                if device_id in hass.data[DOMAIN]["devices"]:
                    hass.data[DOMAIN]["devices"][device_id]["online"] = False
                    async_dispatcher_send(hass, SIGNAL_UPDATE, device_id)
                    hass.bus.async_fire(f"{DOMAIN}_device_update", {
                        "device_id": device_id, "online": False
                    })
                _LOGGER.info("ESP32 [%s] went offline (LWT received)", device_id)
                return

            status = StatusMsg.FromString(raw)
            _LOGGER.warning("Digital Node Nexus: decoded StatusMsg device_id=%r online=%s rssi=%d",
                            status.device_id, status.online, status.rssi)

            # A payload where online=False and device_id is empty is also a LWT.
            if not status.online and not status.device_id:
                if device_id in hass.data[DOMAIN]["devices"]:
                    hass.data[DOMAIN]["devices"][device_id]["online"] = False
                    async_dispatcher_send(hass, SIGNAL_UPDATE, device_id)
                    hass.bus.async_fire(f"{DOMAIN}_device_update", {
                        "device_id": device_id, "online": False
                    })
                return

            hass.data[DOMAIN]["devices"][device_id] = {
                "device_id": device_id,
                "last_seen": status.timestamp,
                "rssi": status.rssi,
                "uptime": status.uptime,
                "led_state": status.led_state,
                "free_heap": status.free_heap,
                "ip": status.ip,
                "firmware": status.firmware or "unknown",
                "online": True,
            }
            _upsert_device_registry(hass, device_id, hass.data[DOMAIN]["devices"][device_id])
            async_dispatcher_send(hass, SIGNAL_NEW_DEVICE, device_id)
            async_dispatcher_send(hass, SIGNAL_UPDATE, device_id)
            meta = hass.data[DOMAIN].get("device_meta", {}).get(device_id, {})
            hass.bus.async_fire(f"{DOMAIN}_device_update", {
                "device_id": device_id,
                **hass.data[DOMAIN]["devices"][device_id],
                "broadcast_zone": meta.get("broadcast_zone", ""),
                "area_id": meta.get("area_id", ""),
            })
            _LOGGER.warning("Digital Node Nexus: device %s registered/updated in hass.data. Total devices: %d",
                            device_id, len(hass.data[DOMAIN]["devices"]))

        except Exception as err:  # noqa: BLE001
            _LOGGER.warning("Failed to parse ESP32 status from [%s]: %s",
                            msg.topic, err)

    try:
        unsub = await mqtt.async_subscribe(
            hass, TOPIC_STATUS_ALL, handle_status_message, encoding=None
        )
        hass.data[DOMAIN]["subscriptions"].append(unsub)
        _LOGGER.warning("Digital Node Nexus: MQTT subscription active on %s", TOPIC_STATUS_ALL)
    except Exception as err:  # noqa: BLE001
        _LOGGER.error("Digital Node Nexus: MQTT subscription failed: %s", err)


async def async_unload_entry(hass: HomeAssistant, entry: ConfigEntry) -> bool:
    """Unload Digital Node Nexus config entry."""
    await hass.config_entries.async_unload_platforms(entry, PLATFORMS)
    for unsub in hass.data[DOMAIN].get("subscriptions", []):
        unsub()
    hass.data[DOMAIN]["subscriptions"].clear()
    return True


async def _register_services(hass: HomeAssistant) -> None:
    """Register all Digital Node Nexus HA services."""

    async def handle_send_message(call: ServiceCall) -> None:
        """Send a text message to an ESP32 display."""
        device_id = call.data["device_id"]
        topic = TOPIC_CMD.format(device_id=device_id, action="message")

        cmd = MessageCmd()
        cmd.text     = call.data["message"]
        cmd.duration = call.data["duration"]
        cmd.scroll   = call.data["scroll"]

        await mqtt.async_publish(hass, topic, cmd.SerializeToString(), qos=1)
        _LOGGER.info("Sent message to ESP32 [%s]: %s", device_id, call.data["message"])

    async def handle_set_led(call: ServiceCall) -> None:
        """Set LED state on an ESP32."""
        device_id = call.data["device_id"]
        topic = TOPIC_CMD.format(device_id=device_id, action="led")

        cmd = LedCmd()
        cmd.state      = call.data["state"]
        cmd.brightness = call.data["brightness"]
        cmd.r          = call.data["red"]
        cmd.g          = call.data["green"]
        cmd.b          = call.data["blue"]
        cmd.effect     = call.data["effect"]

        await mqtt.async_publish(hass, topic, cmd.SerializeToString(), qos=1)
        _LOGGER.info("Set LED on ESP32 [%s]: state=%s", device_id, call.data["state"])

    async def handle_trigger_haptic(call: ServiceCall) -> None:
        """Trigger haptic motor on an ESP32."""
        device_id = call.data["device_id"]
        topic = TOPIC_CMD.format(device_id=device_id, action="haptic")

        cmd = HapticCmd()
        cmd.pattern     = call.data["pattern"]
        cmd.intensity   = call.data["intensity"]
        cmd.duration_ms = call.data["duration_ms"]
        cmd.repeat      = call.data["repeat"]

        await mqtt.async_publish(hass, topic, cmd.SerializeToString(), qos=1)
        _LOGGER.info("Triggered haptic on ESP32 [%s]: %s", device_id, call.data["pattern"])

    async def handle_send_raw(call: ServiceCall) -> None:
        """Send a raw command to an ESP32, wrapping the payload dict as JSON inside RawCmd."""
        import json
        device_id = call.data["device_id"]
        action    = call.data["action"]
        topic = TOPIC_CMD.format(device_id=device_id, action=action)

        cmd = RawCmd()
        cmd.payload_json = json.dumps(call.data["payload"])

        await mqtt.async_publish(hass, topic, cmd.SerializeToString(), qos=1)
        _LOGGER.info("Sent raw command to ESP32 [%s] action=%s", device_id, action)

    hass.services.async_register(
        DOMAIN, SERVICE_SEND_MESSAGE, handle_send_message, schema=SERVICE_SEND_MESSAGE_SCHEMA
    )
    hass.services.async_register(
        DOMAIN, SERVICE_SET_LED, handle_set_led, schema=SERVICE_SET_LED_SCHEMA
    )
    hass.services.async_register(
        DOMAIN, SERVICE_TRIGGER_HAPTIC, handle_trigger_haptic, schema=SERVICE_TRIGGER_HAPTIC_SCHEMA
    )
    hass.services.async_register(
        DOMAIN, SERVICE_SEND_RAW, handle_send_raw, schema=SERVICE_SEND_RAW_SCHEMA
    )

    async def handle_set_placement(call: ServiceCall) -> None:
        await _set_placement(
            hass,
            call.data["device_id"],
            call.data.get("area_id"),
            call.data.get("broadcast_zone"),
        )

    hass.services.async_register(
        DOMAIN, SERVICE_SET_PLACEMENT, handle_set_placement, schema=SERVICE_SET_PLACEMENT_SCHEMA
    )
