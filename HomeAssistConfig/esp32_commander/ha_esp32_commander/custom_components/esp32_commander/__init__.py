"""ESP32 Commander - Home Assistant Custom Integration.

Bridges Home Assistant to ESP32 devices via MQTT.
Payloads are Protocol Buffers (protobuf) binary — NOT JSON.
Schema: proto/esp32_commander.proto → esp32_commander_pb2.py (generated, do not edit).
"""
from __future__ import annotations

import logging
from typing import Any

import voluptuous as vol

from homeassistant.config_entries import ConfigEntry
from homeassistant.const import Platform
from homeassistant.core import HomeAssistant, ServiceCall
from homeassistant.helpers import config_validation as cv
from homeassistant.components import mqtt, websocket_api

from .esp32_commander_pb2 import MessageCmd, LedCmd, HapticCmd, RawCmd, StatusMsg

_LOGGER = logging.getLogger(__name__)

DOMAIN = "esp32_commander"
PLATFORMS: list[Platform] = []

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
    connection.send_result(msg["id"], {"devices": list(devices.values())})


async def async_setup(hass: HomeAssistant, config: dict) -> bool:
    """Set up the ESP32 Commander component from configuration.yaml."""
    _LOGGER.warning("ESP32 Commander: async_setup START")

    hass.data.setdefault(DOMAIN, {"devices": {}, "subscriptions": []})

    await _setup_integration(hass)

    _LOGGER.warning("ESP32 Commander: async_setup COMPLETE")
    return True


async def async_setup_entry(hass: HomeAssistant, entry: ConfigEntry) -> bool:
    """Set up ESP32 Commander from a config entry (UI flow)."""
    _LOGGER.warning("ESP32 Commander: async_setup_entry START")

    hass.data.setdefault(DOMAIN, {"devices": {}, "subscriptions": []})

    await _setup_integration(hass)

    _LOGGER.warning("ESP32 Commander: async_setup_entry COMPLETE")
    return True


async def _setup_integration(hass: HomeAssistant) -> None:
    """Register services, websocket command, and MQTT subscription.

    Called from both async_setup (YAML) and async_setup_entry (UI config flow)
    so the integration is fully operational regardless of how HA loaded it.
    Idempotent — skips re-registration if already set up.
    """
    # ── 1. Register services ───────────────────────────────────────────────
    if not hass.services.has_service(DOMAIN, SERVICE_SEND_MESSAGE):
        await _register_services(hass)
        _LOGGER.warning("ESP32 Commander: services registered")
    else:
        _LOGGER.debug("ESP32 Commander: services already registered, skipping")

    # ── 2. Register websocket command ──────────────────────────────────────
    try:
        websocket_api.async_register_command(hass, websocket_list_devices)
        _LOGGER.warning("ESP32 Commander: websocket command registered")
    except Exception as err:  # noqa: BLE001
        _LOGGER.debug("ESP32 Commander: websocket command already registered or failed: %s", err)

    # ── 3. Subscribe to MQTT (skip if already subscribed) ─────────────────
    if hass.data[DOMAIN].get("subscriptions"):
        _LOGGER.debug("ESP32 Commander: MQTT already subscribed, skipping")
        return

    async def handle_status_message(msg) -> None:
        """Decode an incoming protobuf StatusMsg from an ESP32 device."""
        _LOGGER.warning("ESP32 Commander: status message received on %s (%d bytes, type=%s)",
                        msg.topic, len(msg.payload) if msg.payload else 0, type(msg.payload).__name__)
        try:
            topic_parts = msg.topic.split("/")
            if len(topic_parts) < 3:
                _LOGGER.warning("ESP32 Commander: unexpected topic format: %s", msg.topic)
                return

            device_id = topic_parts[1]
            raw = _to_bytes(msg.payload)
            _LOGGER.warning("ESP32 Commander: raw bytes length=%d for device %s", len(raw), device_id)

            # An empty payload is the LWT — device went offline.
            if len(raw) == 0:
                if device_id in hass.data[DOMAIN]["devices"]:
                    hass.data[DOMAIN]["devices"][device_id]["online"] = False
                    hass.bus.async_fire(f"{DOMAIN}_device_update", {
                        "device_id": device_id, "online": False
                    })
                _LOGGER.info("ESP32 [%s] went offline (LWT received)", device_id)
                return

            status = StatusMsg.FromString(raw)
            _LOGGER.warning("ESP32 Commander: decoded StatusMsg device_id=%r online=%s rssi=%d",
                            status.device_id, status.online, status.rssi)

            # A payload where online=False and device_id is empty is also a LWT.
            if not status.online and not status.device_id:
                if device_id in hass.data[DOMAIN]["devices"]:
                    hass.data[DOMAIN]["devices"][device_id]["online"] = False
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
            hass.bus.async_fire(f"{DOMAIN}_device_update", {
                "device_id": device_id,
                **hass.data[DOMAIN]["devices"][device_id],
            })
            _LOGGER.warning("ESP32 Commander: device %s registered/updated in hass.data. Total devices: %d",
                            device_id, len(hass.data[DOMAIN]["devices"]))

        except Exception as err:  # noqa: BLE001
            _LOGGER.warning("Failed to parse ESP32 status from [%s]: %s",
                            msg.topic, err)

    try:
        unsub = await mqtt.async_subscribe(
            hass, TOPIC_STATUS_ALL, handle_status_message, encoding=None
        )
        hass.data[DOMAIN]["subscriptions"].append(unsub)
        _LOGGER.warning("ESP32 Commander: MQTT subscription active on %s", TOPIC_STATUS_ALL)
    except Exception as err:  # noqa: BLE001
        _LOGGER.error("ESP32 Commander: MQTT subscription failed: %s", err)


async def async_unload_entry(hass: HomeAssistant, entry: ConfigEntry) -> bool:
    """Unload ESP32 Commander config entry."""
    for unsub in hass.data[DOMAIN].get("subscriptions", []):
        unsub()
    hass.data[DOMAIN]["subscriptions"].clear()
    return True


async def _register_services(hass: HomeAssistant) -> None:
    """Register all ESP32 Commander HA services."""

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
