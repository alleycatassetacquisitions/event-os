"""Registration â€” player HTTP client for Home Assistant.

Talks to whoever is in `base_url` (Rust stub now, Rust Central later).
Panels call websocket commands / services; this component owns aiohttp.
"""
from __future__ import annotations

import asyncio
import logging
from typing import Any
from urllib.parse import urlparse

import aiohttp
import voluptuous as vol

from homeassistant.config_entries import SOURCE_IMPORT, ConfigEntry
from homeassistant.const import Platform
from homeassistant.core import HomeAssistant, ServiceCall, SupportsResponse
from homeassistant.helpers import config_validation as cv
from homeassistant.helpers.aiohttp_client import async_get_clientsession
from homeassistant.components import websocket_api
from homeassistant.helpers.typing import ConfigType

from .const import (
    CONF_API_TOKEN,
    CONF_BASE_URL,
    CONF_FALLBACK_URL,
    CONF_MODE,
    DEFAULT_BASE_URL,
    DEFAULT_FALLBACK_URL,
    DOMAIN,
    MODE_LOCAL,
    MODE_ONLINE,
    SERVICE_CHECK_NAME,
    SERVICE_LIST_PLAYERS,
    SERVICE_REFRESH_PLAYERS,
    SERVICE_REGISTER_PLAYER,
)

_LOGGER = logging.getLogger(__name__)

PLATFORMS: list[Platform] = [Platform.SENSOR]

CONFIG_SCHEMA = vol.Schema(
    {
        vol.Optional(DOMAIN): vol.Schema(
            {
                vol.Optional(CONF_BASE_URL, default=DEFAULT_BASE_URL): cv.string,
                vol.Optional(CONF_FALLBACK_URL, default=DEFAULT_FALLBACK_URL): cv.string,
                vol.Optional(CONF_API_TOKEN, default=""): cv.string,
            },
            extra=vol.ALLOW_EXTRA,
        )
    },
    extra=vol.ALLOW_EXTRA,
)


class PlayerApi:
    """Thin aiohttp client for the player API.

    Mode is explicit: MODE_ONLINE uses the DigitalOcean URL, MODE_LOCAL uses
    the LAN URL. No automatic fallback — operators switch modes intentionally
    via the panel settings box.
    """

    def __init__(
        self,
        hass: HomeAssistant,
        online_url: str,
        token: str = "",
        local_url: str = "",
        mode: str = MODE_ONLINE,
    ) -> None:
        self._hass = hass
        self.base_url = online_url.rstrip("/")    # online (DO) URL — never changes
        self._local_url = local_url.rstrip("/") if local_url else ""
        self._token = token
        self._mode = mode
        self.players: list[dict[str, Any]] = []

    @property
    def active_url(self) -> str:
        """The URL currently in use based on the selected mode."""
        if self._mode == MODE_LOCAL and self._local_url:
            return self._local_url
        return self.base_url

    def set_mode(
        self,
        mode: str,
        online_url: str | None = None,
        local_url: str | None = None,
    ) -> None:
        """Switch mode and optionally update URLs at runtime (no HA restart needed)."""
        self._mode = mode if mode in (MODE_ONLINE, MODE_LOCAL) else MODE_ONLINE
        if online_url:
            self.base_url = online_url.rstrip("/")
        if local_url is not None:
            self._local_url = local_url.rstrip("/")
        _LOGGER.info("Registration: mode=%s active_url=%s", self._mode, self.active_url)

    def _headers(self) -> dict[str, str]:
        headers = {"Accept": "application/json"}
        if self._token:
            headers["Authorization"] = f"Bearer {self._token}"
        return headers

    def _bind_url_error(self, url: str) -> str | None:
        host = (urlparse(url).hostname or "").lower()
        if host in ("0.0.0.0", "::", "[::]"):
            return (
                "0.0.0.0 is the bind address, not a URL Home Assistant can reach. "
                "Set the URL to the LAN IP (example http://192.168.1.234:8090)."
            )
        return None

    async def _request(
        self,
        method: str,
        path: str,
        *,
        json_body: dict | None = None,
        form_body: dict | None = None,
        params: dict | None = None,
    ) -> tuple[int, Any]:
        url = f"{self.active_url}{path}"
        bind_err = self._bind_url_error(self.active_url)
        if bind_err:
            return 0, {"error": bind_err}
        session = async_get_clientsession(self._hass)
        timeout = aiohttp.ClientTimeout(total=15)
        try:
            async with session.request(
                method,
                url,
                headers=self._headers(),
                json=json_body,
                data=form_body,
                params=params,
                timeout=timeout,
            ) as resp:
                status = resp.status
                try:
                    payload = await resp.json(content_type=None)
                except Exception:  # noqa: BLE001
                    payload = await resp.text()
                return status, payload
        except (aiohttp.ClientConnectorError, asyncio.TimeoutError, aiohttp.ServerTimeoutError):
            return 0, {"error": f"Cannot reach {url}"}
        except Exception as err:  # noqa: BLE001
            return 0, {"error": f"{type(err).__name__}: {err}"}

    async def health(self) -> dict[str, Any]:
        status, payload = await self._request("GET", "/health")
        return {"status": status, "content": payload}

    async def list_players(self, rows: int = 100, page: int = 1) -> dict[str, Any]:
        status, payload = await self._request(
            "GET", "/players", params={"rows": rows, "page": page}
        )
        if status == 200 and isinstance(payload, dict):
            self.players = list(payload.get("players") or [])
            self._hass.bus.async_fire(
                f"{DOMAIN}_players_updated", {"count": len(self.players)}
            )
        return {"status": status, "content": payload}

    async def check_name(self, name: str) -> dict[str, Any]:
        """Name uniqueness check — not yet implemented on the live server."""
        return {"status": 0, "content": {"available": None, "message": "Name check not available yet"}}

    async def register_player(
        self,
        name: str,
        allegiance: str = "",
        role: str = "hunter",
        faction: str = "",
        neo_id: str = "",
        hunter: int | None = None,
        email: str = "",
    ) -> dict[str, Any]:
        status, payload = await self._request(
            "POST",
            "/players",
            form_body={
                "name": name,
                "email": email,
            },
        )
        if status == 200 and isinstance(payload, dict):
            await self.list_players()
        return {"status": status, "content": payload}

    async def update_player(
        self,
        player_id: str,
        name: str,
        role: str = "hunter",
        allegiance: str = "",
        faction: str = "",
        neo_id: str = "",
    ) -> dict[str, Any]:
        role_to_hunter = {"hunter": 1, "bounty": 2}
        status, payload = await self._request(
            "PUT",
            f"/players/{player_id}",
            json_body={
                "name": name,
                "role": role,
                "hunter": role_to_hunter.get(role, 1),
                "allegiance": allegiance,
                "faction": faction,
                "neo_id": neo_id,
            },
        )
        if status == 200 and isinstance(payload, dict):
            await self.list_players()
        return {"status": status, "content": payload}


def get_api(hass: HomeAssistant) -> PlayerApi | None:
    return hass.data.get(DOMAIN, {}).get("api")


def _api_err(result: dict[str, Any]) -> str:
    content = result.get("content")
    if isinstance(content, dict) and content.get("error"):
        return str(content["error"])
    if isinstance(content, str) and content:
        return content
    return f"Player API returned HTTP {result.get('status')}"


@websocket_api.websocket_command(
    {
        vol.Required("type"): f"{DOMAIN}/list_players",
        vol.Optional("rows", default=100): int,
        vol.Optional("page", default=1): int,
        vol.Optional("refresh", default=True): bool,
    }
)
@websocket_api.async_response
async def ws_list_players(hass: HomeAssistant, connection, msg) -> None:
    api = get_api(hass)
    if not api:
        connection.send_error(msg["id"], "not_ready", "Registration API not configured")
        return
    if msg.get("refresh", True):
        result = await api.list_players(msg.get("rows", 100), msg.get("page", 1))
        if result["status"] != 200:
            connection.send_error(msg["id"], "http_error", _api_err(result))
            return
        connection.send_result(msg["id"], result["content"])
        return
    connection.send_result(msg["id"], {"players": api.players})


@websocket_api.websocket_command(
    {vol.Required("type"): f"{DOMAIN}/check_name", vol.Required("name"): str}
)
@websocket_api.async_response
async def ws_check_name(hass: HomeAssistant, connection, msg) -> None:
    api = get_api(hass)
    if not api:
        connection.send_error(msg["id"], "not_ready", "Registration API not configured")
        return
    result = await api.check_name(msg["name"])
    # check_name returns status 0 when the endpoint isn't implemented yet —
    # send a graceful result so the panel can degrade without showing an error.
    connection.send_result(msg["id"], result)


@websocket_api.websocket_command(
    {
        vol.Required("type"): f"{DOMAIN}/register_player",
        vol.Required("name"): str,
        vol.Optional("role", default="hunter"): str,
        vol.Optional("allegiance", default=""): str,
        vol.Optional("faction", default=""): str,
        vol.Optional("neo_id", default=""): str,
        vol.Optional("hunter"): int,
    }
)
@websocket_api.async_response
async def ws_register_player(hass: HomeAssistant, connection, msg) -> None:
    api = get_api(hass)
    if not api:
        connection.send_error(msg["id"], "not_ready", "Registration API not configured")
        return
    result = await api.register_player(
        name=msg["name"],
        role=msg.get("role", "hunter"),
        allegiance=msg.get("allegiance", ""),
        faction=msg.get("faction", ""),
        neo_id=msg.get("neo_id", ""),
        hunter=msg.get("hunter"),
    )
    if result["status"] not in (200, 409):
        connection.send_error(msg["id"], "http_error", _api_err(result))
        return
    connection.send_result(msg["id"], result)


@websocket_api.websocket_command(
    {
        vol.Required("type"): f"{DOMAIN}/update_player",
        vol.Required("id"): str,
        vol.Required("name"): str,
        vol.Optional("role", default="hunter"): str,
        vol.Optional("allegiance", default=""): str,
        vol.Optional("faction", default=""): str,
        vol.Optional("neo_id", default=""): str,
    }
)
@websocket_api.async_response
async def ws_update_player(hass: HomeAssistant, connection, msg) -> None:
    api = get_api(hass)
    if not api:
        connection.send_error(msg["id"], "not_ready", "Registration API not configured")
        return
    result = await api.update_player(
        player_id=msg["id"],
        name=msg["name"],
        role=msg.get("role", "hunter"),
        allegiance=msg.get("allegiance", ""),
        faction=msg.get("faction", ""),
        neo_id=msg.get("neo_id", ""),
    )
    if result["status"] != 200:
        connection.send_error(msg["id"], "http_error", _api_err(result))
        return
    connection.send_result(msg["id"], result)


@websocket_api.websocket_command({vol.Required("type"): f"{DOMAIN}/get_status"})
@websocket_api.async_response
async def ws_get_status(hass: HomeAssistant, connection, msg) -> None:
    api = get_api(hass)
    if not api:
        connection.send_error(msg["id"], "not_ready", "Registration API not configured")
        return
    connection.send_result(msg["id"], {
        "mode": api._mode,
        "online_url": api.base_url,
        "local_url": api._local_url,
        "active_url": api.active_url,
    })


@websocket_api.websocket_command(
    {
        vol.Required("type"): f"{DOMAIN}/set_server",
        vol.Required("mode"): str,
        vol.Optional("online_url", default=""): str,
        vol.Optional("local_url", default=""): str,
    }
)
@websocket_api.async_response
async def ws_set_server(hass: HomeAssistant, connection, msg) -> None:
    api = get_api(hass)
    if not api:
        connection.send_error(msg["id"], "not_ready", "Registration API not configured")
        return
    online_url = (msg.get("online_url") or "").strip() or None
    local_url = (msg.get("local_url") or "").strip() or None
    api.set_mode(msg["mode"], online_url=online_url, local_url=local_url)

    # Persist mode + URLs to the config entry so they survive HA restarts.
    # Panel settings win over YAML until the user changes them again.
    entry_id = hass.data[DOMAIN].get("entry_id")
    if entry_id:
        entry = hass.config_entries.async_get_entry(entry_id)
        if entry:
            hass.config_entries.async_update_entry(
                entry,
                data={
                    **entry.data,
                    CONF_BASE_URL: api.base_url,
                    CONF_FALLBACK_URL: api._local_url,
                    CONF_MODE: api._mode,
                },
            )

    connection.send_result(msg["id"], {
        "mode": api._mode,
        "online_url": api.base_url,
        "local_url": api._local_url,
        "active_url": api.active_url,
    })


async def async_setup(hass: HomeAssistant, config: ConfigType) -> bool:
    """YAML setup â€” import config entry if present."""
    hass.data.setdefault(DOMAIN, {})
    yaml_conf = config.get(DOMAIN) or {}
    hass.data[DOMAIN]["yaml"] = yaml_conf
    if yaml_conf and not hass.config_entries.async_entries(DOMAIN):
        hass.async_create_task(
            hass.config_entries.flow.async_init(
                DOMAIN, context={"source": SOURCE_IMPORT}, data=yaml_conf
            )
        )
    await _register_ws_and_services(hass)
    return True


async def async_setup_entry(hass: HomeAssistant, entry: ConfigEntry) -> bool:
    hass.data.setdefault(DOMAIN, {})
    yaml_conf = hass.data[DOMAIN].get("yaml") or {}
    # Config entry (panel Apply) wins over YAML so saved DO/local URLs stick
    # across restarts. YAML is only a seed for missing keys / first install.
    online_url = str(
        entry.data.get(CONF_BASE_URL)
        or yaml_conf.get(CONF_BASE_URL)
        or DEFAULT_BASE_URL
    )
    local_url = str(
        entry.data.get(CONF_FALLBACK_URL)
        or yaml_conf.get(CONF_FALLBACK_URL)
        or DEFAULT_FALLBACK_URL
    )
    token = str(entry.data.get(CONF_API_TOKEN) or yaml_conf.get(CONF_API_TOKEN) or "")
    mode = str(entry.data.get(CONF_MODE) or MODE_ONLINE)
    if mode not in (MODE_ONLINE, MODE_LOCAL):
        mode = MODE_ONLINE
    api = PlayerApi(hass, online_url, token, local_url=local_url, mode=mode)
    hass.data[DOMAIN]["api"] = api
    hass.data[DOMAIN]["entry_id"] = entry.entry_id
    await _register_ws_and_services(hass)
    try:
        await api.list_players()
    except Exception as err:  # noqa: BLE001
        _LOGGER.warning("Registration: initial player fetch failed: %s", err)
    await hass.config_entries.async_forward_entry_setups(entry, PLATFORMS)
    return True


async def async_unload_entry(hass: HomeAssistant, entry: ConfigEntry) -> bool:
    unload_ok = await hass.config_entries.async_unload_platforms(entry, PLATFORMS)
    hass.data.get(DOMAIN, {}).pop("api", None)
    return unload_ok


async def _register_ws_and_services(hass: HomeAssistant) -> None:
    try:
        websocket_api.async_register_command(hass, ws_list_players)
        websocket_api.async_register_command(hass, ws_check_name)
        websocket_api.async_register_command(hass, ws_register_player)
        websocket_api.async_register_command(hass, ws_update_player)
        websocket_api.async_register_command(hass, ws_get_status)
        websocket_api.async_register_command(hass, ws_set_server)
    except Exception as err:  # noqa: BLE001
        _LOGGER.debug("Registration websocket already registered: %s", err)

    if hass.services.has_service(DOMAIN, SERVICE_LIST_PLAYERS):
        return

    async def handle_list(call: ServiceCall) -> dict[str, Any]:
        api = get_api(hass)
        if not api:
            return {"status": 0, "content": {"error": "not_ready"}}
        return await api.list_players(
            int(call.data.get("rows", 100)), int(call.data.get("page", 1))
        )

    async def handle_check(call: ServiceCall) -> dict[str, Any]:
        api = get_api(hass)
        if not api:
            return {"status": 0, "content": {"error": "not_ready"}}
        return await api.check_name(call.data["name"])

    async def handle_register(call: ServiceCall) -> dict[str, Any]:
        api = get_api(hass)
        if not api:
            return {"status": 0, "content": {"error": "not_ready"}}
        return await api.register_player(
            name=call.data["name"],
            role=call.data.get("role", "hunter"),
            allegiance=call.data.get("allegiance", ""),
            faction=call.data.get("faction", ""),
            neo_id=call.data.get("neo_id", ""),
            hunter=int(call.data["hunter"]) if "hunter" in call.data else None,
        )

    async def handle_refresh(call: ServiceCall) -> dict[str, Any]:
        api = get_api(hass)
        if not api:
            return {"status": 0, "content": {"error": "not_ready"}}
        result = await api.list_players()
        hass.bus.async_fire(f"{DOMAIN}_players_updated", {"count": len(api.players)})
        return result

    hass.services.async_register(
        DOMAIN,
        SERVICE_LIST_PLAYERS,
        handle_list,
        schema=vol.Schema(
            {
                vol.Optional("rows", default=100): vol.Coerce(int),
                vol.Optional("page", default=1): vol.Coerce(int),
            }
        ),
        supports_response=SupportsResponse.OPTIONAL,
    )
    hass.services.async_register(
        DOMAIN,
        SERVICE_CHECK_NAME,
        handle_check,
        schema=vol.Schema({vol.Required("name"): cv.string}),
        supports_response=SupportsResponse.OPTIONAL,
    )
    hass.services.async_register(
        DOMAIN,
        SERVICE_REGISTER_PLAYER,
        handle_register,
        schema=vol.Schema(
            {
                vol.Required("name"): cv.string,
                vol.Optional("role", default="hunter"): cv.string,
                vol.Optional("allegiance", default=""): cv.string,
                vol.Optional("faction", default=""): cv.string,
                vol.Optional("neo_id", default=""): cv.string,
                vol.Optional("hunter"): vol.All(vol.Coerce(int), vol.Range(min=0, max=2)),
            }
        ),
        supports_response=SupportsResponse.OPTIONAL,
    )
    hass.services.async_register(
        DOMAIN,
        SERVICE_REFRESH_PLAYERS,
        handle_refresh,
        schema=vol.Schema({}),
        supports_response=SupportsResponse.OPTIONAL,
    )
