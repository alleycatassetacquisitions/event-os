"""Bridge a Proxmox LXC termproxy console onto a Home Assistant websocket."""
from __future__ import annotations

import asyncio
import logging
from collections.abc import Callable
from typing import Any

import aiohttp

from .const import TERM_PING_INTERVAL
from .proxmox import ProxmoxClient, ProxmoxError

_LOGGER = logging.getLogger(__name__)


class TermBridge:
    def __init__(self, session: aiohttp.ClientSession, client: ProxmoxClient) -> None:
        self._http = session
        self._client = client
        self._ws: aiohttp.ClientWebSocketResponse | None = None
        self._reader: asyncio.Task | None = None
        self._pinger: asyncio.Task | None = None
        self._on_data: Callable[[bytes], None] | None = None
        self._on_close: Callable[[], None] | None = None
        self.vmid: int | None = None
        self.node: str | None = None
        self.connected = False

    async def open(self, *, vmid: int, node: str, cols: int, rows: int, on_data, on_close, kind: str = "lxc") -> None:
        await self.close()
        ticket_info = await self._client.termproxy(node, vmid, kind)
        port = str(ticket_info.get("port") or "")
        ticket = str(ticket_info.get("ticket") or "")
        user = str(ticket_info.get("user") or "")
        if not port or not ticket or not user:
            raise ProxmoxError("termproxy missing port/ticket/user")
        url = self._client.vncwebsocket_url(node, vmid, port, ticket, kind)
        kwargs: dict[str, Any] = {"headers": self._client.auth_header, "heartbeat": 20}
        if self._client.ssl_arg is not None:
            kwargs["ssl"] = self._client.ssl_arg
        ws = await self._http.ws_connect(url, protocols=["binary"], **kwargs)
        await ws.send_str(f"{user}:{ticket}\n")
        self._ws = ws
        self._on_data = on_data
        self._on_close = on_close
        self.vmid = vmid
        self.node = node
        self.connected = True
        self._reader = asyncio.create_task(self._read_loop())
        self._pinger = asyncio.create_task(self._ping_loop())
        await self.resize(cols, rows)
        _LOGGER.info("Bug Buster console open on %s CT %s", node, vmid)

    async def send_input(self, text: str) -> None:
        if not self._ws or self._ws.closed:
            raise ProxmoxError("console is not connected")
        raw = text.encode("utf-8")
        await self._ws.send_str(f"0:{len(raw)}:{text}")

    async def resize(self, cols: int, rows: int) -> None:
        if not self._ws or self._ws.closed:
            return
        await self._ws.send_str(f"1:{int(cols)}:{int(rows)}:")

    async def close(self) -> None:
        self.connected = False
        for task in (self._pinger, self._reader):
            if task and not task.done():
                task.cancel()
        self._pinger = None
        self._reader = None
        if self._ws is not None and not self._ws.closed:
            try:
                await self._ws.close()
            except Exception:  # noqa: BLE001
                pass
        self._ws = None
        self.vmid = None
        self.node = None

    async def _ping_loop(self) -> None:
        try:
            while self._ws is not None and not self._ws.closed:
                await asyncio.sleep(TERM_PING_INTERVAL)
                if self._ws is not None and not self._ws.closed:
                    await self._ws.send_str("2")
        except asyncio.CancelledError:
            return
        except Exception as err:  # noqa: BLE001
            _LOGGER.debug("Bug Buster console ping ended: %s", err)

    async def _read_loop(self) -> None:
        ws = self._ws
        first = True
        try:
            assert ws is not None
            async for msg in ws:
                if msg.type in (aiohttp.WSMsgType.CLOSE, aiohttp.WSMsgType.CLOSING, aiohttp.WSMsgType.CLOSED, aiohttp.WSMsgType.ERROR):
                    break
                chunk = b""
                if msg.type == aiohttp.WSMsgType.BINARY:
                    chunk = bytes(msg.data)
                elif msg.type == aiohttp.WSMsgType.TEXT:
                    chunk = msg.data.encode("utf-8", errors="replace")
                else:
                    continue
                if first:
                    first = False
                    if chunk.startswith(b"OK"):
                        chunk = chunk[2:]
                    else:
                        _LOGGER.warning("Bug Buster console handshake failed: %r", chunk[:80])
                        break
                if chunk and self._on_data:
                    self._on_data(chunk)
        except asyncio.CancelledError:
            return
        except Exception as err:  # noqa: BLE001
            _LOGGER.warning("Bug Buster console read error: %s", err)
        finally:
            self.connected = False
            on_close = self._on_close
            self._on_close = None
            self._on_data = None
            if on_close:
                on_close()
