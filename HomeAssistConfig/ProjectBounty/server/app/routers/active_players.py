"""Active player playlist for kiosk / game server driven rotation."""
from __future__ import annotations

import json
import logging
from datetime import datetime, timezone

from fastapi import APIRouter, Header, HTTPException, Request
from fastapi.templating import Jinja2Templates

from app.config import ACTIVE_PLAYERS_SECRET, PUBLIC_BASE, TEMPLATES_DIR
from app.models import ActivePlayersRequest, ActivePlayersState

_LOGGER = logging.getLogger(__name__)

router = APIRouter(tags=["active-players"])
templates = Jinja2Templates(directory=str(TEMPLATES_DIR))


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _playlist(request: Request) -> ActivePlayersState:
    return request.app.state.active_playlist


def _check_secret(authorization: str | None) -> None:
    if not ACTIVE_PLAYERS_SECRET:
        return
    token = (authorization or "").removeprefix("Bearer ").strip()
    if token != ACTIVE_PLAYERS_SECRET:
        raise HTTPException(status_code=401, detail="Invalid active-players token")


@router.get("/api/active-players", response_model=ActivePlayersState)
async def get_active_players(request: Request) -> ActivePlayersState:
    return _playlist(request)


@router.post("/api/active-players", response_model=ActivePlayersState)
async def set_active_players(
    body: ActivePlayersRequest,
    request: Request,
    authorization: str | None = Header(default=None),
) -> ActivePlayersState:
    _check_secret(authorization)
    ids = [str(pid).strip() for pid in body.player_ids if str(pid).strip()]
    state = ActivePlayersState(
        player_ids=ids,
        interval_sec=body.interval_sec,
        updated_at=_now(),
    )
    request.app.state.active_playlist = state
    _LOGGER.info("Active playlist set: %d player(s), %ss interval", len(ids), body.interval_sec)
    return state


@router.get("/active-players")
async def active_players_page(request: Request):
    state = _playlist(request)
    return templates.TemplateResponse(
        request,
        "active-players.html",
        {
            "public_base": PUBLIC_BASE,
            "player_ids_json": json.dumps(state.player_ids),
            "interval_sec": state.interval_sec,
        },
    )
