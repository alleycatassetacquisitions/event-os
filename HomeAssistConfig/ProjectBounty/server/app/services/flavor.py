"""Template-based bounty flavor generator.

Swap `generate_flavor` internals later for an on-site local LLM while keeping
the same request/response shape (`POST /api/flavor/generate`).
"""
from __future__ import annotations

import hashlib
import random
from typing import List

from app.models import Allegiance, FlavorResponse, PosterStats, Role

_BOUNTY_CRIMES = [
    "Data siphon from NeoCorp vaults",
    "Unauthorized mesh relay hijack",
    "Black-market PDN cloning",
    "Corporate sabotage — Helix labs",
    "Street-level woolong laundering",
    "Breaking and entering (sector 7)",
    "Assault on bounty intermediaries",
    "Falsifying allegiance credentials",
    "Illegal drone swarm operation",
    "Smuggling restricted firmware",
    "Interference with FDN uplinks",
    "Theft of experimental cyberware",
]

_HUNTER_REASONS = [
    "Elite Interdiction Specialist — clean extractions under fire",
    "Verified track record on high-value NeoCorp contracts",
    "Five-star field reviews from past Fixer clients",
    "Rapid response across mesh-blackout zones",
    "Specialist in non-lethal collar ops",
    "Known for returning targets alive when the contract allows",
]

_HEIGHTS = ["5'6\"", "5'8\"", "5'10\"", "5'11\"", "6'0\"", "6'1\"", "6'2\"", "6'3\""]
_WEIGHTS = ["140 LBS", "155 LBS", "165 LBS", "175 LBS", "185 LBS", "195 LBS", "210 LBS"]
_AGES = ["22", "24", "27", "29", "31", "34", "36", "38", "41"]

_BLURBS = {
    "reboot": [
        "{name} runs cold and precise — Reboot ghosts leave clean logs and empty vaults.",
        "Last seen near a Reboot uplink. {name} treats firewalls like suggestions.",
        "Flagged by Mission Control: {name} moves with Reboot discipline and zero remorse.",
    ],
    "helix": [
        "{name} burns bright — Helix ops leave scorched trails and unpaid debts.",
        "Helix handlers want {name} offline. Expect flash, noise, and collateral.",
        "{name} weaponizes spectacle. Helix gold trails wherever they cut a deal.",
    ],
    "endline": [
        "{name} walks Endline alleys like they own the rain. Approach armed.",
        "Endline dossiers mark {name} as extremely dangerous — dead or alive optional.",
        "Blood-red warrants follow {name}. Endline does not negotiate twice.",
    ],
    "freelancer": [
        "{name} answers to no NeoCorp. That makes the bounty harder — and higher.",
        "Unaffiliated. Unpredictable. {name} sells loyalty by the hour.",
        "No allegiance patch on file. Treat {name} as a free-floating threat.",
    ],
}

_HUNTER_BLURBS = {
    "reboot": [
        "{name} — Reboot-trained contractor. Quiet entries, quieter exits.",
        "Mission Control vetted: {name} handles Reboot-sector extractions without chatter.",
    ],
    "helix": [
        "{name} brings Helix-grade spectacle to contract work. Results match the noise.",
        "Helix-adjacent operator {name} — high risk, higher completion rate.",
    ],
    "endline": [
        "{name} walks the red line between bounty and butcher. Endline clients only.",
        "Endline streets know {name}. Hire if you need problems erased.",
    ],
    "freelancer": [
        "{name} — unaffiliated gun for hire. No NeoCorp leash, no corporate leash.",
        "Freelancer {name} answers to the contract, not the boardroom.",
    ],
}

_BOUNTY_BASE = {
    "reboot": 1_800_000,
    "helix": 2_200_000,
    "endline": 2_750_000,
    "freelancer": 1_250_000,
}

_HUNTER_BASE = {
    "reboot": 950_000,
    "helix": 1_100_000,
    "endline": 1_350_000,
    "freelancer": 800_000,
}


def _rng_for(name: str, allegiance: str, role: str) -> random.Random:
    digest = hashlib.sha256(f"{name.strip().lower()}|{allegiance}|{role}".encode()).hexdigest()
    return random.Random(int(digest[:16], 16))


def generate_flavor(
    name: str,
    allegiance: Allegiance = "freelancer",
    role: Role = "bounty",
) -> FlavorResponse:
    """Generate mock poster flavor from templates (deterministic per name+allegiance+role)."""
    clean = (name or "UNKNOWN").strip() or "UNKNOWN"
    alleg: Allegiance = allegiance if allegiance in _BOUNTY_BASE else "freelancer"
    player_role: Role = role if role in ("hunter", "bounty") else "bounty"
    rng = _rng_for(clean, alleg, player_role)

    if player_role == "hunter":
        crimes = rng.sample(_HUNTER_REASONS, k=min(3, len(_HUNTER_REASONS)))
        blurb_pool = _HUNTER_BLURBS[alleg]
        base = _HUNTER_BASE[alleg]
        jitter = rng.randint(-100_000, 200_000)
    else:
        crimes = rng.sample(_BOUNTY_CRIMES, k=3)
        blurb_pool = _BLURBS[alleg]
        base = _BOUNTY_BASE[alleg]
        jitter = rng.randint(-250_000, 450_000)

    stats = PosterStats(
        height=rng.choice(_HEIGHTS),
        weight=rng.choice(_WEIGHTS),
        age=rng.choice(_AGES),
    )
    blurb_template = rng.choice(blurb_pool)
    flavor_text = blurb_template.format(name=clean.upper())
    amount = max(250_000, base + jitter)
    amount = int(round(amount / 10_000) * 10_000)

    return FlavorResponse(
        bounty_amount=amount,
        crimes=crimes,
        stats=stats,
        flavor_text=flavor_text,
        source="templates",
    )
