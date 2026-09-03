"""JSON-backed poster store."""
from __future__ import annotations

import json
import threading
from pathlib import Path
from typing import List, Optional

from app.models import PosterRecord


class PosterStore:
    def __init__(self, path: Path) -> None:
        self._path = path
        self._lock = threading.Lock()
        self._path.parent.mkdir(parents=True, exist_ok=True)
        if not self._path.exists():
            self._write([])

    def _read(self) -> List[PosterRecord]:
        raw = self._path.read_text(encoding="utf-8")
        data = json.loads(raw or "[]")
        return [PosterRecord.model_validate(item) for item in data]

    def _write(self, posters: List[PosterRecord]) -> None:
        payload = [p.model_dump() for p in posters]
        self._path.write_text(json.dumps(payload, indent=2), encoding="utf-8")

    def list(self) -> List[PosterRecord]:
        with self._lock:
            posters = self._read()
            posters.sort(key=lambda p: p.created_at, reverse=True)
            return posters

    def get(self, poster_id: str) -> Optional[PosterRecord]:
        with self._lock:
            for poster in self._read():
                if poster.id == poster_id:
                    return poster
            return None

    def get_by_player(self, player_id: str) -> Optional[PosterRecord]:
        pid = (player_id or "").strip()
        if not pid:
            return None
        with self._lock:
            matches = [p for p in self._read() if p.player_id == pid]
            if not matches:
                return None
            matches.sort(key=lambda p: p.updated_at or p.created_at, reverse=True)
            return matches[0]

    def save(self, poster: PosterRecord) -> PosterRecord:
        with self._lock:
            posters = self._read()
            for i, existing in enumerate(posters):
                if existing.id == poster.id:
                    posters[i] = poster
                    self._write(posters)
                    return poster
            posters.append(poster)
            self._write(posters)
            return poster
