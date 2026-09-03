"""MAC intake stub for future FDN → ProjectBounty wiring."""
from __future__ import annotations

from fastapi import APIRouter, status
from fastapi.responses import JSONResponse

from app.models import IntakeRequest, IntakeResponse
from app.services.registration_client import lookup_by_mac

router = APIRouter(tags=["intake"])


@router.post("/api/intake", response_model=IntakeResponse)
async def intake_mac(body: IntakeRequest) -> JSONResponse:
    """Accept a PDN MAC from an FDN.

    v1: lookup is not wired — returns 501 with a stable JSON shape so FDN
    clients and the Mission Control simulate field can integrate early.
    """
    mac = (body.mac or "").strip()
    if not mac:
        return JSONResponse(
            status_code=status.HTTP_400_BAD_REQUEST,
            content=IntakeResponse(
                ok=False,
                mac="",
                reason="mac_required",
            ).model_dump(),
        )

    player = await lookup_by_mac(mac)
    if player is None:
        return JSONResponse(
            status_code=status.HTTP_501_NOT_IMPLEMENTED,
            content=IntakeResponse(
                ok=False,
                mac=mac,
                reason="mac_lookup_not_configured",
                player=None,
            ).model_dump(),
        )

    return JSONResponse(
        status_code=status.HTTP_200_OK,
        content=IntakeResponse(
            ok=True,
            mac=mac,
            reason="",
            player=player,
        ).model_dump(),
    )
