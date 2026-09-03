"""ProjectBounty server configuration."""
from __future__ import annotations

import os
from pathlib import Path

_APP_DIR = Path(__file__).resolve().parent
_SERVER_DIR = _APP_DIR.parent

DATA_DIR = Path(os.getenv("BOUNTY_DATA", str(_SERVER_DIR / "data")))
MEDIA_BASE = Path(os.getenv("BOUNTY_MEDIA", str(_SERVER_DIR / "media")))
POSTERS_FILE = Path(os.getenv("BOUNTY_POSTERS", str(DATA_DIR / "posters.json")))

API_HOST = os.getenv("BOUNTY_HOST", "0.0.0.0")
API_PORT = int(os.getenv("BOUNTY_PORT", "8100"))

# Public base URL used when building poster links returned to clients.
PUBLIC_BASE = os.getenv("BOUNTY_PUBLIC_BASE", f"http://127.0.0.1:{API_PORT}").rstrip("/")

# Registration / Central base (MAC lookup later). Empty = intake stub only.
REGISTRATION_BASE = os.getenv("BOUNTY_REGISTRATION_BASE", "").rstrip("/")

# Optional shared secret for POST /api/active-players from game server.
ACTIVE_PLAYERS_SECRET = os.getenv("BOUNTY_ACTIVE_PLAYERS_SECRET", "").strip()

ALLOWED_VIDEO_EXT = {".webm", ".mp4", ".mov", ".mkv"}
MAX_UPLOAD_MB = int(os.getenv("BOUNTY_MAX_UPLOAD_MB", "100"))
MEDIA_SUBDIRS = (
    "videos",
    "assets",
    "assets/neocorp",
    "assets/animations",
    "assets/marks",
)

ASSETS_BASE = MEDIA_BASE / "assets"

TEMPLATES_DIR = _APP_DIR / "templates"
STATIC_DIR = _APP_DIR / "static"
