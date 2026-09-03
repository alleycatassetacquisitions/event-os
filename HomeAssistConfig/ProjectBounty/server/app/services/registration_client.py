"""Registration / Central client — player lookup helpers.

Used by intake (MAC later) and poster live overlay (name / NeoCorp / faction / role / status).
"""
from __future__ import annotations

import logging
from typing import Any, Optional

import httpx

from app.config import REGISTRATION_BASE
from app.models import Allegiance, IntakePlayer, PosterStatus, Role

_LOGGER = logging.getLogger(__name__)


def _norm_allegiance(value: Any) -> Allegiance:
    v = str(value or "freelancer").strip().lower()
    if v in ("reboot", "helix", "endline", "freelancer"):
        return v  # type: ignore[return-value]
    return "freelancer"


def _norm_role(raw: dict[str, Any]) -> Role:
    for key in ("mode", "role"):
        v = str(raw.get(key) or "").strip().lower()
        if v in ("hunter", "bounty"):
            return v  # type: ignore[return-value]
    hunter = raw.get("hunter")
    if hunter == 1 or hunter == "1":
        return "hunter"
    if hunter == 2 or hunter == "2":
        return "bounty"
    return "bounty"


def _status_from_dict(raw: dict[str, Any]) -> PosterStatus:
    nested = raw.get("status")
    if isinstance(nested, dict):
        return PosterStatus(
            current_score=str(nested.get("current_score") or nested.get("score") or ""),
            fastest_win=str(nested.get("fastest_win") or nested.get("fastest_time") or ""),
            longest_streak=str(nested.get("longest_streak") or nested.get("streak") or ""),
        )
    return PosterStatus(
        current_score=str(raw.get("current_score") or raw.get("score") or ""),
        fastest_win=str(raw.get("fastest_win") or raw.get("fastest_time") or ""),
        longest_streak=str(raw.get("longest_streak") or raw.get("streak") or ""),
    )


def _player_from_dict(raw: dict[str, Any]) -> IntakePlayer:
    return IntakePlayer(
        player_id=str(raw.get("id") or raw.get("player_id") or ""),
        name=str(raw.get("name") or ""),
        role=_norm_role(raw),
        allegiance=_norm_allegiance(raw.get("allegiance")),
        faction=str(raw.get("faction") or ""),
        status=_status_from_dict(raw),
    )


async def _fetch_player_list() -> list[dict[str, Any]]:
    if not REGISTRATION_BASE:
        return []
    base = REGISTRATION_BASE.rstrip("/")
    paths = (
        f"{base}/players?rows=200&page=1",
        f"{base}/api/players?rows=200&page=1",
    )
    async with httpx.AsyncClient(timeout=8.0) as client:
        for url in paths:
            try:
                resp = await client.get(url)
                if resp.status_code != 200:
                    continue
                data = resp.json()
                if isinstance(data, dict):
                    players = data.get("players") or data.get("data") or []
                    if isinstance(players, list):
                        return [p for p in players if isinstance(p, dict)]
                if isinstance(data, list):
                    return [p for p in data if isinstance(p, dict)]
            except Exception as exc:  # noqa: BLE001
                _LOGGER.debug("Player list fetch failed (%s): %s", url, exc)
    return []


async def lookup_by_id(player_id: str) -> Optional[IntakePlayer]:
    """Resolve a registered player by id from Central / stub list endpoints."""
    pid = (player_id or "").strip()
    if not pid or not REGISTRATION_BASE:
        return None
    players = await _fetch_player_list()
    for raw in players:
        if str(raw.get("id") or "") == pid:
            return _player_from_dict(raw)
    _LOGGER.debug("Player id %s not found on registration base", pid)
    return None


async def lookup_by_mac(mac: str) -> Optional[IntakePlayer]:
    """Resolve a PDN MAC to a registered player (not wired on Central yet)."""
    normalized = (mac or "").strip().lower()
    if not normalized:
        return None

    if not REGISTRATION_BASE:
        _LOGGER.debug("MAC lookup skipped — BOUNTY_REGISTRATION_BASE not set (%s)", normalized)
        return None

    _LOGGER.info(
        "MAC lookup not implemented yet (base=%s mac=%s)",
        REGISTRATION_BASE,
        normalized,
    )
    return None
