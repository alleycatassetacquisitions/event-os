"""Resolve player video files on disk (player_id naming + legacy hex filenames)."""
from __future__ import annotations

from pathlib import Path

from app.config import ALLOWED_VIDEO_EXT, MEDIA_BASE


def video_filename_for_player(player_id: str, ext: str = ".webm") -> str:
    pid = (player_id or "").strip()
    if not pid:
        raise ValueError("player_id required for video filename")
    suffix = ext if ext.startswith(".") else f".{ext}"
    return f"{pid}{suffix}"


def find_video_filename(player_id: str, stored_filename: str = "") -> str:
    """Return best on-disk video filename for a player."""
    pid = (player_id or "").strip()
    if pid:
        for ext in sorted(ALLOWED_VIDEO_EXT):
            name = f"{pid}{ext}"
            if (Path(MEDIA_BASE) / "videos" / name).is_file():
                return name
    if stored_filename and (Path(MEDIA_BASE) / "videos" / stored_filename).is_file():
        return stored_filename
    return stored_filename or ""


def player_has_video(player_id: str, stored_filename: str = "") -> bool:
    return bool(find_video_filename(player_id, stored_filename))
