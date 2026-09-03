"""Pydantic models for the ProjectBounty API."""
from __future__ import annotations

from typing import List, Literal, Optional

from pydantic import BaseModel, Field

Allegiance = Literal["reboot", "helix", "endline", "freelancer"]
Role = Literal["hunter", "bounty"]


class PosterStats(BaseModel):
    height: str = "5'10\""
    weight: str = "165 LBS"
    age: str = "29"


class PosterStatus(BaseModel):
    current_score: str = ""
    fastest_win: str = ""
    longest_streak: str = ""


class PosterRecord(BaseModel):
    id: str
    player_id: str = ""
    name: str
    role: Role = "bounty"
    allegiance: Allegiance = "freelancer"
    faction: str = ""
    bounty_amount: int = Field(default=1_000_000, ge=0)
    crimes: List[str] = Field(default_factory=list)
    stats: PosterStats = Field(default_factory=PosterStats)
    status: PosterStatus = Field(default_factory=PosterStatus)
    flavor_text: str = ""
    video_filename: str = ""
    created_at: str = ""
    updated_at: str = ""


class PosterPublic(BaseModel):
    """Poster payload returned by the API (includes public URLs)."""

    id: str
    player_id: str = ""
    name: str
    role: Role = "bounty"
    allegiance: Allegiance = "freelancer"
    faction: str = ""
    bounty_amount: int
    crimes: List[str]
    stats: PosterStats
    status: PosterStatus = Field(default_factory=PosterStatus)
    flavor_text: str
    video_url: str = ""
    poster_url: str = ""
    has_video: bool = False
    created_at: str = ""
    updated_at: str = ""


class FlavorRequest(BaseModel):
    name: str
    allegiance: Allegiance = "freelancer"
    role: Role = "bounty"


class FlavorResponse(BaseModel):
    bounty_amount: int
    crimes: List[str]
    stats: PosterStats
    flavor_text: str
    source: str = "templates"  # later: "local_llm"


class IntakeRequest(BaseModel):
    mac: str


class IntakePlayer(BaseModel):
    player_id: str
    name: str
    role: Role = "bounty"
    allegiance: Allegiance = "freelancer"
    faction: str = ""
    status: PosterStatus = Field(default_factory=PosterStatus)


class IntakeResponse(BaseModel):
    ok: bool
    mac: str
    reason: str = ""
    player: Optional[IntakePlayer] = None


class ActivePlayersRequest(BaseModel):
    player_ids: List[str] = Field(default_factory=list)
    interval_sec: int = Field(default=30, ge=5, le=300)


class ActivePlayersState(BaseModel):
    player_ids: List[str] = Field(default_factory=list)
    interval_sec: int = 30
    updated_at: str = ""
