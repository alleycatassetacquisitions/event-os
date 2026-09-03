"""Poster create/list/detail and HTML poster page."""
from __future__ import annotations

import json
import logging
import uuid
from datetime import datetime, timezone
from pathlib import Path
from typing import List, Optional

from fastapi import APIRouter, File, Form, HTTPException, Request, UploadFile
from fastapi.responses import RedirectResponse
from fastapi.templating import Jinja2Templates

from app.config import (
    ALLOWED_VIDEO_EXT,
    MAX_UPLOAD_MB,
    MEDIA_BASE,
    PUBLIC_BASE,
    TEMPLATES_DIR,
)
from app.models import (
    Allegiance,
    PosterPublic,
    PosterRecord,
    PosterStats,
    PosterStatus,
    Role,
)
from app.services.registration_client import lookup_by_id
from app.services.video_paths import find_video_filename, video_filename_for_player
from app.store import PosterStore

_LOGGER = logging.getLogger(__name__)

router = APIRouter(tags=["posters"])
templates = Jinja2Templates(directory=str(TEMPLATES_DIR))


def _store(request: Request) -> PosterStore:
    return request.app.state.poster_store


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _normalize_allegiance(value: str) -> Allegiance:
    v = (value or "freelancer").strip().lower()
    if v in ("reboot", "helix", "endline", "freelancer"):
        return v  # type: ignore[return-value]
    return "freelancer"


def _normalize_role(value: str) -> Role:
    v = (value or "bounty").strip().lower()
    if v in ("hunter", "bounty"):
        return v  # type: ignore[return-value]
    return "bounty"


def _poster_url_for(poster: PosterRecord) -> str:
    if poster.player_id:
        return f"{PUBLIC_BASE}/poster/player/{poster.player_id}"
    return f"{PUBLIC_BASE}/poster/{poster.id}"


def _video_url_for(poster: PosterRecord) -> str:
    filename = find_video_filename(poster.player_id, poster.video_filename)
    if filename:
        return f"{PUBLIC_BASE}/media/videos/{filename}"
    return ""


def _to_public(poster: PosterRecord) -> PosterPublic:
    video_url = _video_url_for(poster)
    return PosterPublic(
        id=poster.id,
        player_id=poster.player_id,
        name=poster.name,
        role=poster.role,
        allegiance=poster.allegiance,
        faction=poster.faction,
        bounty_amount=poster.bounty_amount,
        crimes=poster.crimes,
        stats=poster.stats,
        status=poster.status,
        flavor_text=poster.flavor_text,
        video_url=video_url,
        poster_url=_poster_url_for(poster),
        has_video=bool(video_url),
        created_at=poster.created_at,
        updated_at=poster.updated_at,
    )


def _parse_crimes(raw: str) -> List[str]:
    raw = (raw or "").strip()
    if not raw:
        return []
    try:
        data = json.loads(raw)
        if isinstance(data, list):
            return [str(c).strip() for c in data if str(c).strip()]
    except json.JSONDecodeError:
        pass
    return [line.strip() for line in raw.replace(",", "\n").splitlines() if line.strip()]


def _parse_stats(raw: str) -> PosterStats:
    if not (raw or "").strip():
        return PosterStats()
    try:
        data = json.loads(raw)
        if isinstance(data, dict):
            return PosterStats.model_validate(data)
    except (json.JSONDecodeError, ValueError):
        pass
    return PosterStats()


def _delete_video(filename: str) -> None:
    if not filename:
        return
    path = Path(MEDIA_BASE) / "videos" / filename
    try:
        if path.is_file():
            path.unlink()
    except OSError as exc:
        _LOGGER.warning("Could not delete old video %s: %s", path, exc)


def _delete_legacy_player_videos(player_id: str, keep_filename: str) -> None:
    pid = (player_id or "").strip()
    if not pid:
        return
    videos_dir = Path(MEDIA_BASE) / "videos"
    for ext in ALLOWED_VIDEO_EXT:
        name = f"{pid}{ext}"
        if name != keep_filename:
            _delete_video(name)


async def _apply_live_overlay(display: PosterRecord) -> PosterRecord:
    if not display.player_id:
        return display
    live = await lookup_by_id(display.player_id)
    if not live:
        return display
    if live.name:
        display.name = live.name
    display.role = live.role
    display.allegiance = live.allegiance
    display.faction = live.faction
    if any(
        (
            live.status.current_score,
            live.status.fastest_win,
            live.status.longest_streak,
        )
    ):
        display.status = live.status
    return display


def _poster_context(public: PosterPublic) -> dict:
    is_hunter = public.role == "hunter"
    list_heading = "REASONS TO HIRE" if is_hunter else "WANTED FOR"
    list_empty = "Details pending" if is_hunter else "Charges pending"
    headline_main = "GUN FOR HIRE" if is_hunter else "WANTED"
    headline_sub = "" if is_hunter else "DEAD OR ALIVE"
    neocorp_logo = f"/media/assets/neocorp/{public.allegiance}.svg"
    return {
        "poster": public,
        "bounty_display": f"₩{public.bounty_amount:,}",
        "crimes_json": json.dumps(public.crimes),
        "is_hunter": is_hunter,
        "list_heading": list_heading,
        "list_empty": list_empty,
        "headline_main": headline_main,
        "headline_sub": headline_sub,
        "neocorp_logo": neocorp_logo,
        "status_rows": [
            ("CURRENT SCORE", public.status.current_score or "—"),
            ("FASTEST WIN", public.status.fastest_win or "—"),
            ("LONGEST STREAK", public.status.longest_streak or "—"),
        ],
    }


async def _render_poster(request: Request, poster: PosterRecord):
    display = await _apply_live_overlay(poster.model_copy(deep=True))
    public = _to_public(display)
    return templates.TemplateResponse(
        request,
        "poster.html",
        _poster_context(public),
    )


def _get_poster_or_404(store: PosterStore, poster_id: str) -> PosterRecord:
    poster = store.get(poster_id)
    if not poster:
        raise HTTPException(status_code=404, detail="Poster not found")
    return poster


@router.get("/api/posters", response_model=List[PosterPublic])
async def list_posters(request: Request) -> List[PosterPublic]:
    return [_to_public(p) for p in _store(request).list()]


@router.get("/api/posters/by-player/{player_id}", response_model=PosterPublic)
async def get_poster_by_player(player_id: str, request: Request) -> PosterPublic:
    poster = _store(request).get_by_player(player_id)
    if not poster:
        raise HTTPException(status_code=404, detail="No poster for player")
    return _to_public(poster)


@router.get("/api/players/{player_id}", response_model=PosterPublic)
async def get_player_profile(player_id: str, request: Request) -> PosterPublic:
    """Player profile summary for Registration and other clients."""
    return await get_poster_by_player(player_id, request)


@router.get("/api/posters/{poster_id}", response_model=PosterPublic)
async def get_poster(poster_id: str, request: Request) -> PosterPublic:
    if poster_id == "by-player":
        raise HTTPException(status_code=404, detail="Poster not found")
    poster = _store(request).get(poster_id)
    if not poster:
        raise HTTPException(status_code=404, detail="Poster not found")
    return _to_public(poster)


@router.post("/api/posters", response_model=PosterPublic)
async def create_poster(
    request: Request,
    name: str = Form(...),
    allegiance: str = Form("freelancer"),
    faction: str = Form(""),
    role: str = Form("bounty"),
    player_id: str = Form(""),
    bounty_amount: int = Form(1_000_000),
    crimes: str = Form("[]"),
    stats: str = Form("{}"),
    flavor_text: str = Form(""),
    video: UploadFile = File(...),
) -> PosterPublic:
    clean_name = name.strip()
    if not clean_name:
        raise HTTPException(status_code=400, detail="name is required")

    pid = player_id.strip()
    if not pid:
        raise HTTPException(status_code=400, detail="player_id is required")

    filename = video.filename or "capture.webm"
    ext = Path(filename).suffix.lower() or ".webm"
    if ext not in ALLOWED_VIDEO_EXT:
        raise HTTPException(
            status_code=400,
            detail=f"Unsupported video type {ext}. Allowed: {sorted(ALLOWED_VIDEO_EXT)}",
        )

    data = await video.read()
    max_bytes = MAX_UPLOAD_MB * 1024 * 1024
    if len(data) > max_bytes:
        raise HTTPException(status_code=400, detail=f"Video exceeds {MAX_UPLOAD_MB}MB limit")
    if not data:
        raise HTTPException(status_code=400, detail="Empty video upload")

    store = _store(request)
    existing = store.get_by_player(pid)

    stamp = _now()
    if existing:
        poster_id = existing.id
        created_at = existing.created_at or stamp
        old_video = existing.video_filename
    else:
        poster_id = pid
        created_at = stamp
        old_video = ""

    video_name = video_filename_for_player(pid, ext)
    dest = Path(MEDIA_BASE) / "videos" / video_name
    dest.parent.mkdir(parents=True, exist_ok=True)
    dest.write_bytes(data)

    if old_video and old_video != video_name:
        _delete_video(old_video)
    _delete_legacy_player_videos(pid, video_name)

    record = PosterRecord(
        id=poster_id,
        player_id=pid,
        name=clean_name,
        role=_normalize_role(role),
        allegiance=_normalize_allegiance(allegiance),
        faction=faction.strip(),
        bounty_amount=max(0, int(bounty_amount)),
        crimes=_parse_crimes(crimes),
        stats=_parse_stats(stats),
        status=existing.status if existing else PosterStatus(),
        flavor_text=flavor_text.strip(),
        video_filename=video_name,
        created_at=created_at,
        updated_at=stamp,
    )
    store.save(record)
    action = "Updated" if existing else "Created"
    _LOGGER.info("%s poster %s for %s (%s/%s)", action, poster_id, clean_name, record.role, record.allegiance)
    return _to_public(record)


@router.get("/poster/player/{player_id}")
async def poster_page_by_player(player_id: str, request: Request):
    poster = _store(request).get_by_player(player_id)
    if not poster:
        raise HTTPException(status_code=404, detail="No poster for player")
    return await _render_poster(request, poster)


@router.get("/poster/{poster_id}")
async def poster_page(poster_id: str, request: Request):
    store = _store(request)
    by_player = store.get_by_player(poster_id)
    if by_player:
        return await _render_poster(request, by_player)

    poster = store.get(poster_id)
    if not poster:
        raise HTTPException(status_code=404, detail="Poster not found")

    if poster.player_id and poster.player_id != poster_id:
        return RedirectResponse(
            url=f"/poster/player/{poster.player_id}",
            status_code=302,
        )

    return await _render_poster(request, poster)
