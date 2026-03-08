"""Host metadata route for shared Axon host discovery."""

from __future__ import annotations

from fastapi import APIRouter, Request

router = APIRouter(tags=["host"])


@router.get("/host")
def get_host_info(request: Request) -> dict:
    """Return metadata about the currently running Axon host."""
    return {
        "repoPath": str(request.app.state.repo_path) if request.app.state.repo_path else None,
        "hostUrl": getattr(request.app.state, "host_url", None),
        "mcpUrl": getattr(request.app.state, "mcp_url", None),
        "watch": getattr(request.app.state, "watch", False),
        "mode": getattr(request.app.state, "mode", "standalone"),
    }
