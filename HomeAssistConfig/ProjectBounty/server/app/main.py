"""ProjectBounty Server — FastAPI entry point.

Serves:
  /api/*       — posters, flavor, intake
  /poster/{id} — animated 16:9 bounty poster page
  /media/*     — uploaded capture videos
  /health      — liveness probe
"""
from __future__ import annotations

import logging
import time
from pathlib import Path

from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles

from app.config import (
    API_HOST,
    API_PORT,
    DATA_DIR,
    MEDIA_BASE,
    MEDIA_SUBDIRS,
    POSTERS_FILE,
    STATIC_DIR,
)
from app.models import ActivePlayersState
from app.routers import active_players, flavor, intake, posters
from app.store import PosterStore

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(name)s: %(message)s",
)
_LOGGER = logging.getLogger(__name__)

app = FastAPI(
    title="ProjectBounty Server",
    version="1.0.0",
    description="Cyberpunk bounty poster capture and display for Alleycat",
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.middleware("http")
async def log_requests(request: Request, call_next):
    start = time.perf_counter()
    response = await call_next(request)
    path = request.url.path
    if path.startswith("/api/"):
        response.headers["Cache-Control"] = "no-store, no-cache, must-be-revalidate"
        response.headers["Pragma"] = "no-cache"
        ms = (time.perf_counter() - start) * 1000
        _LOGGER.info("%s %s -> %s (%.0fms)", request.method, path, response.status_code, ms)
    return response


app.include_router(posters.router)
app.include_router(active_players.router)
app.include_router(flavor.router)
app.include_router(intake.router)


@app.on_event("startup")
async def startup() -> None:
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    for sub in MEDIA_SUBDIRS:
        Path(MEDIA_BASE, sub).mkdir(parents=True, exist_ok=True)
    STATIC_DIR.mkdir(parents=True, exist_ok=True)
    app.state.poster_store = PosterStore(POSTERS_FILE)
    app.state.active_playlist = ActivePlayersState()
    _LOGGER.info("ProjectBounty started. Media: %s Posters: %s", MEDIA_BASE, POSTERS_FILE)


@app.get("/health")
async def health():
    return {"status": "ok", "service": "projectbounty"}


app.mount("/media", StaticFiles(directory=str(MEDIA_BASE)), name="media")
app.mount("/static", StaticFiles(directory=str(STATIC_DIR)), name="static")


if __name__ == "__main__":
    import uvicorn

    uvicorn.run("app.main:app", host=API_HOST, port=API_PORT, reload=True)
