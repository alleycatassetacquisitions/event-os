"""Proxmox VE API client for Bug Buster LXC inventory and console tickets."""
from __future__ import annotations

import json
import logging
import re
from typing import Any
from urllib.parse import quote, urlparse

import aiohttp

from .const import CONFIG_CACHE_TTL

_LOGGER = logging.getLogger(__name__)

_IP_RE = re.compile(r"(?:^|,)ip=([^,]+)")
_PLACEHOLDER_SECRETS = frozenset({
    "",
    "replace-me",
    "changeme",
    "change-me",
    "your-token-here",
    "secret",
})


def format_http_error(method: str, path: str, status: int, body: Any) -> str:
    if status in (401, 403):
        return (
            "Proxmox rejected the API token "
            f"(HTTP {status}). Set bugbuster_token_id and bugbuster_token_secret "
            "in secrets.yaml to a token from Datacenter → Permissions → API Tokens "
            "(id looks like root@pam!bugbuster)."
        )
    snippet = body
    if isinstance(body, (bytes, bytearray)):
        snippet = bytes(body)[:200]
    text = str(snippet)[:300] if snippet is not None else ""
    return f"Proxmox {method} {path} failed ({status}): {text or 'no body'}"


def error_kind(err: BaseException | str) -> str:
    text = str(err).lower()
    if "401" in text or "403" in text or "api token" in text or "placeholder" in text:
        return "auth"
    if "connect" in text or "timeout" in text or "ssl" in text or "unreachable" in text:
        return "connect"
    return "other"


def normalize_proxmox_url(raw: str) -> str:
    text = (raw or "").strip()
    if not text:
        raise ValueError("Proxmox URL is empty")
    if "://" not in text:
        text = "https://" + text
    parsed = urlparse(text)
    host = parsed.hostname
    if not host:
        raise ValueError("Invalid Proxmox host")
    scheme = parsed.scheme or "https"
    port = parsed.port or 8006
    netloc = f"[{host}]:{port}" if ":" in host else f"{host}:{port}"
    return f"{scheme}://{netloc}"


class ProxmoxError(Exception):
    """Raised when a Proxmox API call fails."""


class ProxmoxClient:
    def __init__(
        self,
        session: aiohttp.ClientSession,
        base_url: str,
        token_id: str,
        token_secret: str,
        default_node: str = "",
        verify_ssl: bool = False,
    ) -> None:
        self._session = session
        try:
            self._base = normalize_proxmox_url(base_url)
        except ValueError:
            self._base = (base_url or "").rstrip("/")
        self._token_id = token_id.strip()
        self._token_secret = token_secret.strip()
        self.default_node = (default_node or "").strip()
        self.verify_ssl = verify_ssl
        self._config_cache: dict[str, tuple[float, dict[str, Any]]] = {}

    @property
    def base_url(self) -> str:
        return self._base

    def set_base_url(self, base_url: str) -> None:
        self._base = normalize_proxmox_url(base_url)
        self._config_cache.clear()

    def set_node(self, node: str) -> None:
        self.default_node = (node or "").strip()

    def set_token(self, token_id: str, token_secret: str) -> None:
        self._token_id = (token_id or "").strip()
        self._token_secret = (token_secret or "").strip()

    @property
    def token_ready(self) -> bool:
        secret = self._token_secret.strip().lower()
        return bool(self._token_id) and "!" in self._token_id and secret not in _PLACEHOLDER_SECRETS

    @property
    def auth_header(self) -> dict[str, str]:
        return {"Authorization": f"PVEAPIToken={self._token_id}={self._token_secret}"}

    @property
    def ssl_arg(self) -> bool | None:
        if self.verify_ssl:
            return None
        return False

    def ws_base(self) -> str:
        parsed = urlparse(self._base)
        scheme = "wss" if parsed.scheme == "https" else "ws"
        netloc = parsed.netloc or parsed.path
        return f"{scheme}://{netloc}"

    async def _json(
        self,
        method: str,
        path: str,
        *,
        data: dict | None = None,
        params: dict | None = None,
        timeout: int = 12,
    ) -> Any:
        url = f"{self._base}{path}"
        kwargs: dict[str, Any] = {
            "headers": self.auth_header,
            "timeout": aiohttp.ClientTimeout(total=timeout),
        }
        if self.ssl_arg is not None:
            kwargs["ssl"] = self.ssl_arg
        if data is not None:
            kwargs["data"] = data
        if params is not None:
            kwargs["params"] = params
        try:
            async with self._session.request(method, url, **kwargs) as resp:
                raw = await resp.read()
                body: Any = None
                if raw:
                    try:
                        body = json.loads(raw.decode("utf-8", errors="replace"))
                    except json.JSONDecodeError:
                        body = raw.decode("utf-8", errors="replace")[:300]
                if resp.status >= 400:
                    raise ProxmoxError(format_http_error(method, path, resp.status, body))
                if isinstance(body, dict) and "data" in body:
                    return body["data"]
                return body
        except ProxmoxError:
            raise
        except Exception as err:  # noqa: BLE001
            raise ProxmoxError(f"Proxmox {method} {path} error: {err}") from err

    async def version(self) -> dict[str, Any]:
        data = await self._json("GET", "/api2/json/version")
        return data if isinstance(data, dict) else {}

    async def list_nodes(self) -> list[str]:
        nodes: list[str] = []
        if self.default_node:
            nodes.append(self.default_node)
        try:
            data = await self._json("GET", "/api2/json/nodes", timeout=12)
        except ProxmoxError as err:
            _LOGGER.debug("Bug Buster could not list nodes: %s", err)
            return nodes
        if not isinstance(data, list):
            return nodes
        for item in data:
            name = str((item or {}).get("node") or "")
            if name and name not in nodes:
                nodes.append(name)
        return nodes

    async def list_guests(self) -> tuple[list[dict[str, Any]], dict[str, int]]:
        """Return LXC + QEMU guests and a type histogram of whatever Proxmox returned."""
        resources: list[dict[str, Any]] = []
        data = await self._json("GET", "/api2/json/cluster/resources", timeout=15)
        if isinstance(data, list):
            resources = [item for item in data if isinstance(item, dict)]

        counts: dict[str, int] = {}
        for item in resources:
            key = str(item.get("type") or "unknown")
            counts[key] = counts.get(key, 0) + 1

        guests = [
            item for item in resources
            if item.get("type") in ("lxc", "qemu") and not item.get("template")
        ]
        if guests:
            return guests, counts

        for node in await self.list_nodes():
            for kind in ("lxc", "qemu"):
                try:
                    rows = await self._json("GET", f"/api2/json/nodes/{node}/{kind}", timeout=15)
                except ProxmoxError as err:
                    _LOGGER.debug("Bug Buster node %s %s list failed: %s", node, kind, err)
                    continue
                if not isinstance(rows, list):
                    continue
                counts[kind] = counts.get(kind, 0) + len(rows)
                for row in rows:
                    if not isinstance(row, dict) or row.get("template"):
                        continue
                    item = dict(row)
                    item["type"] = kind
                    item["node"] = node
                    guests.append(item)
        return guests, counts

    async def guest_config(self, node: str, vmid: int, kind: str = "lxc") -> dict[str, Any]:
        import time
        kind = "qemu" if kind == "qemu" else "lxc"
        cache_key = f"{kind}:{vmid}"
        now = time.monotonic()
        cached = self._config_cache.get(cache_key)
        if cached and now - cached[0] < CONFIG_CACHE_TTL.total_seconds():
            return cached[1]
        data = await self._json("GET", f"/api2/json/nodes/{node}/{kind}/{vmid}/config")
        cfg = data if isinstance(data, dict) else {}
        self._config_cache[cache_key] = (now, cfg)
        return cfg

    async def guest_ip(self, node: str, vmid: int, kind: str = "lxc") -> str:
        try:
            cfg = await self.guest_config(node, vmid, kind)
        except ProxmoxError as err:
            _LOGGER.debug("Could not read %s %s config: %s", kind, vmid, err)
            return ""
        for key, value in cfg.items():
            if not str(key).startswith("net") or not isinstance(value, str):
                continue
            match = _IP_RE.search(value)
            if not match:
                continue
            ip = match.group(1).strip()
            if ip.lower() in ("dhcp", "manual", ""):
                continue
            return ip.split("/")[0]
        return ""

    def snapshot_from_resource(self, item: dict[str, Any], ip: str = "") -> dict[str, Any]:
        vmid = int(item.get("vmid") or 0)
        maxcpu = float(item.get("maxcpu") or 1) or 1.0
        cpu = float(item.get("cpu") or 0)
        mem = int(item.get("mem") or 0)
        maxmem = int(item.get("maxmem") or 0)
        status = str(item.get("status") or "unknown")
        kind = "qemu" if item.get("type") == "qemu" else "lxc"
        return {
            "vmid": vmid,
            "kind": kind,
            "name": str(item.get("name") or f"{kind.upper()} {vmid}"),
            "node": str(item.get("node") or self.default_node),
            "status": status,
            "online": status == "running",
            "cpu": cpu,
            "cpu_percent": round((cpu / maxcpu) * 100, 1),
            "mem": mem,
            "maxmem": maxmem,
            "mem_percent": round(mem / maxmem * 100, 1) if maxmem else 0.0,
            "uptime": int(item.get("uptime") or 0),
            "maxcpu": maxcpu,
            "ip": ip,
        }

    async def termproxy(self, node: str, vmid: int, kind: str = "lxc") -> dict[str, Any]:
        kind = "qemu" if kind == "qemu" else "lxc"
        data = await self._json("POST", f"/api2/json/nodes/{node}/{kind}/{vmid}/termproxy", timeout=20)
        if not isinstance(data, dict):
            raise ProxmoxError("termproxy returned no data")
        return data

    def vncwebsocket_url(self, node: str, vmid: int, port: str, ticket: str, kind: str = "lxc") -> str:
        kind = "qemu" if kind == "qemu" else "lxc"
        encoded = quote(ticket, safe="")
        return (
            f"{self.ws_base()}/api2/json/nodes/{node}/{kind}/{vmid}/vncwebsocket"
            f"?port={quote(str(port), safe='')}&vncticket={encoded}"
        )
