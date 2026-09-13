"""Bug Buster — Mission Control debug console.

Polls Proxmox for LXC status, spies on MQTT, and bridges container consoles
through Home Assistant websockets into the Bug Buster panel.

Proxmox host and node come from Core Configurator (`alleycat_directory`).
API tokens stay in this integration's secrets / config entry.
"""
from __future__ import annotations

import base64
import logging
import time

import voluptuous as vol

from homeassistant.config_entries import SOURCE_IMPORT, ConfigEntry
from homeassistant.const import Platform
from homeassistant.core import HomeAssistant, callback
from homeassistant.helpers import config_validation as cv
from homeassistant.helpers.aiohttp_client import async_get_clientsession
from homeassistant.helpers.dispatcher import async_dispatcher_send
from homeassistant.helpers.update_coordinator import DataUpdateCoordinator
from homeassistant.components import websocket_api

from .const import (
    CONF_MQTT_TOPIC,
    CONF_TOKEN_ID,
    CONF_TOKEN_SECRET,
    CONF_VERIFY_SSL,
    DEFAULT_MQTT_TOPIC,
    DEFAULT_VERIFY_SSL,
    DOMAIN,
    EVENT_HOSTS_UPDATE,
    POLL_INTERVAL,
    SIGNAL_NEW_HOST,
    SIGNAL_UPDATE,
)
from .mqtt_spy import MqttSpy
from .proxmox import ProxmoxClient, ProxmoxError, error_kind, normalize_proxmox_url
from .term_bridge import TermBridge

_LOGGER = logging.getLogger(__name__)

PLATFORMS = [Platform.BINARY_SENSOR, Platform.SENSOR]

CONFIG_SCHEMA = vol.Schema(
    {
        vol.Optional(DOMAIN): vol.Schema(
            {
                vol.Required(CONF_TOKEN_ID): cv.string,
                vol.Required(CONF_TOKEN_SECRET): cv.string,
                vol.Optional(CONF_VERIFY_SSL, default=DEFAULT_VERIFY_SSL): cv.boolean,
                vol.Optional(CONF_MQTT_TOPIC, default=DEFAULT_MQTT_TOPIC): cv.string,
            },
            extra=vol.ALLOW_EXTRA,
        )
    },
    extra=vol.ALLOW_EXTRA,
)


def _domain(hass: HomeAssistant) -> dict:
    return hass.data.setdefault(
        DOMAIN,
        {
            "hosts": {},
            "polled_at": None,
            "proxmox_error": None,
            "proxmox_error_kind": None,
            "client": None,
            "mqtt_spy": None,
            "term_bridge": None,
            "coordinator": None,
        },
    )


def _dir_proxmox(hass: HomeAssistant) -> tuple[str, str]:
    """Proxmox URL + node from Core Configurator, with safe fallbacks."""
    try:
        from custom_components.alleycat_directory.helpers import get_extra, get_url

        url = get_url(hass, "proxmox", "")
        node = get_extra(hass, "proxmox", "node", "")
        if url:
            return url, node
    except Exception:  # noqa: BLE001
        pass
    block = (hass.data.get("alleycat_directory") or {}).get("services") or {}
    rec = block.get("proxmox") or {}
    url = str(rec.get("url") or "").rstrip("/")
    extra = rec.get("extra") or {}
    node = str(extra.get("node") or "")
    return url, node


def _dir_tokens(hass: HomeAssistant) -> tuple[str, str]:
    try:
        from custom_components.alleycat_directory.helpers import get_extra

        return (
            get_extra(hass, "proxmox", "token_id", ""),
            get_extra(hass, "proxmox", "token_secret", ""),
        )
    except Exception:  # noqa: BLE001
        rec = ((hass.data.get("alleycat_directory") or {}).get("services") or {}).get("proxmox") or {}
        extra = rec.get("extra") or {}
        return str(extra.get("token_id") or ""), str(extra.get("token_secret") or "")


def _apply_proxmox_to_client(hass: HomeAssistant) -> tuple[str, str]:
    data = _domain(hass)
    url, node = _dir_proxmox(hass)
    client: ProxmoxClient | None = data.get("client")
    if not client:
        return url, node
    if url:
        try:
            client.set_base_url(url)
        except ValueError:
            client._base = url.rstrip("/")  # noqa: SLF001
    client.set_node(node)
    token_id, token_secret = _dir_tokens(hass)
    if token_id or token_secret:
        client.set_token(token_id or client._token_id, token_secret or client._token_secret)
    return client.base_url, client.default_node


def _status_payload(hass: HomeAssistant) -> dict:
    data = _domain(hass)
    client: ProxmoxClient | None = data.get("client")
    return {
        "hosts": list(data.get("hosts", {}).values()),
        "polled_at": data.get("polled_at"),
        "proxmox_error": data.get("proxmox_error"),
        "proxmox_error_kind": data.get("proxmox_error_kind"),
        "mqtt_count": getattr(data.get("mqtt_spy"), "received", 0),
        "proxmox_url": getattr(client, "base_url", "") or "",
        "proxmox_node": getattr(client, "default_node", "") or "",
        "inventory": data.get("inventory") or {},
        "term": {
            "connected": bool(getattr(data.get("term_bridge"), "connected", False)),
            "vmid": getattr(data.get("term_bridge"), "vmid", None),
        },
    }


def _require_admin(connection, msg) -> bool:
    if getattr(connection.user, "is_admin", False):
        return True
    connection.send_error(msg["id"], "unauthorized", "Admin required")
    return False


def _credentials(hass: HomeAssistant, entry: ConfigEntry) -> tuple[str, str, bool, str]:
    yaml_conf = (_domain(hass).get("_yaml") or {})
    token_id = str(yaml_conf.get(CONF_TOKEN_ID) or entry.data.get(CONF_TOKEN_ID) or "").strip()
    token_secret = str(yaml_conf.get(CONF_TOKEN_SECRET) or entry.data.get(CONF_TOKEN_SECRET) or "").strip()
    dir_id, dir_secret = _dir_tokens(hass)
    if dir_id:
        token_id = dir_id
    if dir_secret:
        token_secret = dir_secret
    verify_ssl = bool(yaml_conf.get(CONF_VERIFY_SSL, entry.data.get(CONF_VERIFY_SSL, DEFAULT_VERIFY_SSL)))
    topic = str(yaml_conf.get(CONF_MQTT_TOPIC) or entry.data.get(CONF_MQTT_TOPIC) or DEFAULT_MQTT_TOPIC)
    return token_id, token_secret, verify_ssl, topic


async def async_setup(hass: HomeAssistant, config: dict) -> bool:
    data = _domain(hass)
    conf = config.get(DOMAIN)
    if conf is not None:
        data["_yaml"] = dict(conf)
        if not hass.config_entries.async_entries(DOMAIN):
            hass.async_create_task(
                hass.config_entries.flow.async_init(
                    DOMAIN, context={"source": SOURCE_IMPORT}, data=dict(conf)
                )
            )

    websocket_api.async_register_command(hass, ws_list_hosts)
    websocket_api.async_register_command(hass, ws_mqtt_snapshot)
    websocket_api.async_register_command(hass, ws_get_settings)
    websocket_api.async_register_command(hass, ws_set_proxmox)
    websocket_api.async_register_command(hass, ws_term_open)
    websocket_api.async_register_command(hass, ws_term_data)
    websocket_api.async_register_command(hass, ws_term_resize)
    websocket_api.async_register_command(hass, ws_term_close)
    return True


async def async_setup_entry(hass: HomeAssistant, entry: ConfigEntry) -> bool:
    data = _domain(hass)
    token_id, token_secret, verify_ssl, topic = _credentials(hass, entry)
    session = async_get_clientsession(hass, verify_ssl=verify_ssl)

    url, node = _dir_proxmox(hass)
    try:
        proxmox_url = normalize_proxmox_url(url) if url else ""
    except ValueError:
        proxmox_url = (url or "").rstrip("/")

    client = ProxmoxClient(
        session,
        proxmox_url or "https://127.0.0.1:8006",
        token_id,
        token_secret,
        default_node=node,
        verify_ssl=verify_ssl,
    )
    spy = MqttSpy(hass, topic)
    bridge = TermBridge(session, client)

    def _fail(message: str, kind: str | None = None) -> dict:
        data["proxmox_error"] = message
        data["proxmox_error_kind"] = kind or error_kind(message)
        data["polled_at"] = time.time()
        _LOGGER.warning("Bug Buster Proxmox poll failed: %s", message)
        hass.bus.async_fire(EVENT_HOSTS_UPDATE, _status_payload(hass))
        return data.get("hosts") or {}

    async def _async_refresh() -> dict:
        token_id, token_secret, _, _ = _credentials(hass, entry)
        client.set_token(token_id, token_secret)
        if not client.token_ready:
            return _fail(
                "Proxmox API token is not set. Put the token UUID in secrets.yaml "
                "as bugbuster_token_secret (bugbuster_token_id looks like "
                "root@pam!bugbuster), then restart Home Assistant.",
                "auth",
            )
        try:
            items, inventory = await client.list_guests()
        except ProxmoxError as err:
            return _fail(str(err))

        data["inventory"] = inventory
        known = set(data.get("hosts") or {})
        hosts: dict[int, dict] = {}
        for item in items:
            try:
                vmid = int(item.get("vmid") or 0)
            except (TypeError, ValueError):
                continue
            if not vmid:
                continue
            kind = "qemu" if item.get("type") == "qemu" else "lxc"
            node_name = str(item.get("node") or client.default_node)
            ip = ""
            try:
                ip = await client.guest_ip(node_name, vmid, kind)
            except ProxmoxError:
                ip = ""
            snap = client.snapshot_from_resource(item, ip)
            hosts[vmid] = snap
            key = str(vmid)
            if vmid not in known:
                async_dispatcher_send(hass, SIGNAL_NEW_HOST, key)
            async_dispatcher_send(hass, SIGNAL_UPDATE, key)

        data["hosts"] = hosts
        data["polled_at"] = time.time()
        data["proxmox_error"] = None
        data["proxmox_error_kind"] = None
        _LOGGER.info("Bug Buster guests=%s inventory=%s", len(hosts), inventory)
        hass.bus.async_fire(EVENT_HOSTS_UPDATE, _status_payload(hass))
        return hosts

    try:
        coordinator = DataUpdateCoordinator(
            hass,
            _LOGGER,
            config_entry=entry,
            name="Bug Buster Proxmox",
            update_interval=POLL_INTERVAL,
            update_method=_async_refresh,
        )
    except TypeError:
        coordinator = DataUpdateCoordinator(
            hass,
            _LOGGER,
            name="Bug Buster Proxmox",
            update_interval=POLL_INTERVAL,
            update_method=_async_refresh,
        )

    data.update(
        {
            "entry_id": entry.entry_id,
            "client": client,
            "mqtt_spy": spy,
            "term_bridge": bridge,
            "coordinator": coordinator,
            "hosts": {},
            "inventory": {},
            "proxmox_error": None,
            "proxmox_error_kind": None,
        }
    )

    @callback
    def _on_directory(_event=None) -> None:
        _apply_proxmox_to_client(hass)
        hass.async_create_task(coordinator.async_request_refresh())

    data["directory_unsub"] = hass.bus.async_listen(
        "alleycat_directory_updated", _on_directory
    )

    await spy.start()
    await coordinator.async_config_entry_first_refresh()
    await hass.config_entries.async_forward_entry_setups(entry, PLATFORMS)
    _LOGGER.info("Bug Buster ready — Proxmox %s node %s", client.base_url, client.default_node)
    return True


async def async_unload_entry(hass: HomeAssistant, entry: ConfigEntry) -> bool:
    data = hass.data.get(DOMAIN) or {}
    unsub = data.get("directory_unsub")
    if unsub:
        unsub()
    spy: MqttSpy | None = data.get("mqtt_spy")
    if spy:
        spy.stop()
    bridge: TermBridge | None = data.get("term_bridge")
    if bridge:
        await bridge.close()
    unload_ok = await hass.config_entries.async_unload_platforms(entry, PLATFORMS)
    yaml_conf = data.get("_yaml")
    hass.data.pop(DOMAIN, None)
    if yaml_conf:
        hass.data[DOMAIN] = {"_yaml": yaml_conf}
    return unload_ok


@websocket_api.websocket_command({vol.Required("type"): f"{DOMAIN}/list_hosts"})
@websocket_api.async_response
async def ws_list_hosts(hass: HomeAssistant, connection, msg) -> None:
    if not _require_admin(connection, msg):
        return
    connection.send_result(msg["id"], _status_payload(hass))


@websocket_api.websocket_command({vol.Required("type"): f"{DOMAIN}/mqtt_snapshot"})
@websocket_api.async_response
async def ws_mqtt_snapshot(hass: HomeAssistant, connection, msg) -> None:
    if not _require_admin(connection, msg):
        return
    spy: MqttSpy | None = _domain(hass).get("mqtt_spy")
    connection.send_result(
        msg["id"],
        {
            "messages": spy.snapshot() if spy else [],
            "received": getattr(spy, "received", 0),
            "topic": getattr(spy, "topic", "#"),
        },
    )


@websocket_api.websocket_command({vol.Required("type"): f"{DOMAIN}/get_settings"})
@websocket_api.async_response
async def ws_get_settings(hass: HomeAssistant, connection, msg) -> None:
    if not _require_admin(connection, msg):
        return
    payload = _status_payload(hass)
    connection.send_result(
        msg["id"],
        {
            "proxmox_url": payload["proxmox_url"],
            "proxmox_node": payload["proxmox_node"],
        },
    )


@websocket_api.websocket_command(
    {
        vol.Required("type"): f"{DOMAIN}/set_proxmox",
        vol.Required("proxmox_url"): str,
        vol.Optional("proxmox_node"): str,
    }
)
@websocket_api.async_response
async def ws_set_proxmox(hass: HomeAssistant, connection, msg) -> None:
    if not _require_admin(connection, msg):
        return
    data = _domain(hass)
    client: ProxmoxClient | None = data.get("client")
    if client is None:
        connection.send_error(msg["id"], "not_ready", "Bug Buster is not loaded")
        return
    try:
        url = normalize_proxmox_url(msg["proxmox_url"])
    except ValueError as err:
        connection.send_error(msg["id"], "invalid_url", str(err))
        return
    node = str(msg.get("proxmox_node") or "").strip()
    try:
        from custom_components.alleycat_directory.helpers import apply_service

        apply_service(hass, "proxmox", url=url, extra={"node": node})
    except Exception as err:  # noqa: BLE001
        _LOGGER.warning("Bug Buster could not write Core Configurator: %s", err)
    client.set_base_url(url)
    client.set_node(node)
    reachable = False
    error = None
    try:
        await client.version()
        reachable = True
    except ProxmoxError as err:
        error = str(err)
    coordinator = data.get("coordinator")
    if coordinator:
        await coordinator.async_request_refresh()
    connection.send_result(
        msg["id"],
        {
            "proxmox_url": client.base_url,
            "proxmox_node": client.default_node,
            "reachable": reachable,
            "error": error,
        },
    )


@websocket_api.websocket_command(
    {
        vol.Required("type"): f"{DOMAIN}/term_open",
        vol.Required("vmid"): cv.positive_int,
        vol.Optional("node"): cv.string,
        vol.Optional("kind"): cv.string,
        vol.Optional("cols"): cv.positive_int,
        vol.Optional("rows"): cv.positive_int,
    }
)
@websocket_api.async_response
async def ws_term_open(hass: HomeAssistant, connection, msg) -> None:
    if not _require_admin(connection, msg):
        return
    data = _domain(hass)
    bridge: TermBridge | None = data.get("term_bridge")
    if bridge is None:
        connection.send_error(msg["id"], "not_ready", "Bug Buster is not loaded")
        return
    vmid = int(msg["vmid"])
    host = (data.get("hosts") or {}).get(vmid) or {}
    node = str(msg.get("node") or host.get("node") or "")
    kind = str(msg.get("kind") or host.get("kind") or "lxc")
    if not node:
        connection.send_error(msg["id"], "no_node", "Missing Proxmox node")
        return
    cols = int(msg.get("cols") or 80)
    rows = int(msg.get("rows") or 24)

    def _on_data(chunk: bytes) -> None:
        connection.send_message(
            websocket_api.event_message(
                msg["id"],
                {"data_b64": base64.b64encode(chunk).decode("ascii")},
            )
        )

    def _on_close() -> None:
        connection.send_message(websocket_api.event_message(msg["id"], {"closed": True}))

    try:
        await bridge.open(
            vmid=vmid,
            node=node,
            kind=kind,
            cols=cols,
            rows=rows,
            on_data=_on_data,
            on_close=_on_close,
        )
    except Exception as err:  # noqa: BLE001
        connection.send_error(msg["id"], "proxmox_error", str(err))
        return

    def _unsub() -> None:
        hass.async_create_task(bridge.close())

    connection.subscriptions[msg["id"]] = _unsub
    connection.send_result(msg["id"], {"ok": True, "vmid": vmid, "node": node})


@websocket_api.websocket_command(
    {
        vol.Required("type"): f"{DOMAIN}/term_data",
        vol.Required("data"): str,
    }
)
@websocket_api.async_response
async def ws_term_data(hass: HomeAssistant, connection, msg) -> None:
    if not _require_admin(connection, msg):
        return
    bridge: TermBridge | None = _domain(hass).get("term_bridge")
    try:
        if bridge:
            await bridge.send_input(msg["data"])
        connection.send_result(msg["id"])
    except ProxmoxError as err:
        connection.send_error(msg["id"], "console_error", str(err))


@websocket_api.websocket_command(
    {
        vol.Required("type"): f"{DOMAIN}/term_resize",
        vol.Optional("cols"): cv.positive_int,
        vol.Optional("rows"): cv.positive_int,
    }
)
@websocket_api.async_response
async def ws_term_resize(hass: HomeAssistant, connection, msg) -> None:
    if not _require_admin(connection, msg):
        return
    bridge: TermBridge | None = _domain(hass).get("term_bridge")
    if bridge:
        await bridge.resize(int(msg.get("cols") or 80), int(msg.get("rows") or 24))
    connection.send_result(msg["id"])


@websocket_api.websocket_command({vol.Required("type"): f"{DOMAIN}/term_close"})
@websocket_api.async_response
async def ws_term_close(hass: HomeAssistant, connection, msg) -> None:
    if not _require_admin(connection, msg):
        return
    bridge: TermBridge | None = _domain(hass).get("term_bridge")
    if bridge:
        await bridge.close()
    connection.send_result(msg["id"], {"ok": True})
