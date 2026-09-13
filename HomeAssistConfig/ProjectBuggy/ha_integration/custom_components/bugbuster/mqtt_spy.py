"""In-memory MQTT spy for Bug Buster."""
from __future__ import annotations

import json
import logging
import time
from collections import deque
from typing import Any, Callable

from homeassistant.components import mqtt
from homeassistant.core import HomeAssistant, callback

from .const import EVENT_MQTT_MESSAGE, MQTT_BUFFER_SIZE, MQTT_HEX_BYTES, MQTT_PREVIEW_CHARS

_LOGGER = logging.getLogger(__name__)


def _to_bytes(payload: Any) -> bytes:
    if payload is None:
        return b""
    if isinstance(payload, (bytes, bytearray)):
        return bytes(payload)
    if isinstance(payload, str):
        return payload.encode("latin-1")
    return bytes(payload)


def preview_payload(raw: bytes) -> dict[str, Any]:
    size = len(raw)
    hexpart = raw[:MQTT_HEX_BYTES].hex()
    try:
        text = raw.decode("utf-8")
    except UnicodeDecodeError:
        return {"kind": "binary", "size": size, "text": f"<binary {size} bytes>", "hex": hexpart}
    if not text:
        return {"kind": "empty", "size": 0, "text": "", "hex": ""}
    try:
        parsed = json.loads(text)
        pretty = json.dumps(parsed, indent=2)[:MQTT_PREVIEW_CHARS]
        return {"kind": "json", "size": size, "text": pretty, "hex": ""}
    except (json.JSONDecodeError, TypeError, ValueError):
        pass
    printable = sum(1 for ch in text if ch.isprintable() or ch in "\r\n\t")
    if printable / max(len(text), 1) < 0.85:
        return {"kind": "binary", "size": size, "text": f"<binary {size} bytes>", "hex": hexpart}
    return {"kind": "text", "size": size, "text": text[:MQTT_PREVIEW_CHARS], "hex": ""}


class MqttSpy:
    def __init__(self, hass: HomeAssistant, topic: str) -> None:
        self.hass = hass
        self.topic = topic or "#"
        self.buffer: deque[dict[str, Any]] = deque(maxlen=MQTT_BUFFER_SIZE)
        self._unsub: Callable[[], None] | None = None
        self.received = 0

    async def start(self) -> None:
        if self._unsub is not None:
            return

        @callback
        def _on_message(msg) -> None:
            preview = preview_payload(_to_bytes(msg.payload))
            item = {
                "ts": time.time(),
                "topic": msg.topic,
                "qos": getattr(msg, "qos", 0),
                "retain": bool(getattr(msg, "retain", False)),
                **preview,
            }
            self.buffer.append(item)
            self.received += 1
            self.hass.bus.async_fire(EVENT_MQTT_MESSAGE, item)

        try:
            self._unsub = await mqtt.async_subscribe(self.hass, self.topic, _on_message, encoding=None)
            _LOGGER.info("Bug Buster MQTT spy subscribed to %s", self.topic)
        except Exception as err:  # noqa: BLE001
            _LOGGER.error("Bug Buster MQTT spy failed to subscribe: %s", err)

    def stop(self) -> None:
        if self._unsub:
            self._unsub()
            self._unsub = None

    def snapshot(self) -> list[dict[str, Any]]:
        return list(self.buffer)
