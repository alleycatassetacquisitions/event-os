"""Flavor generation endpoint (templates now, local LLM later)."""
from __future__ import annotations

from fastapi import APIRouter

from app.models import FlavorRequest, FlavorResponse
from app.services.flavor import generate_flavor

router = APIRouter(tags=["flavor"])


@router.post("/api/flavor/generate", response_model=FlavorResponse)
async def flavor_generate(body: FlavorRequest) -> FlavorResponse:
    """Generate poster flavor text / crimes / stats / mock bounty.

    Hook for on-site AI: replace `generate_flavor` with a local model call
    without changing this route contract.
    """
    return generate_flavor(body.name, body.allegiance, body.role)
