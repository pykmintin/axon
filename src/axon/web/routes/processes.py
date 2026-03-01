"""Process routes — list discovered execution processes with their steps."""

from __future__ import annotations

import logging

from fastapi import APIRouter, HTTPException, Request

logger = logging.getLogger(__name__)

router = APIRouter(tags=["processes"])


@router.get("/processes")
def get_processes(request: Request) -> dict:
    """Query all Process nodes and their ordered steps."""
    storage = request.app.state.storage

    try:
        rows = storage.execute_raw(
            "MATCH (p) WHERE labels(p) = 'Process' "
            "OPTIONAL MATCH (n)-[r]->(p) WHERE r.rel_type = 'step_in_process' "
            "RETURN p.id, p.name, p.kind, collect(n.id), collect(r.step_number) "
            "ORDER BY p.name"
        )
    except Exception as exc:
        logger.error("Processes query failed: %s", exc, exc_info=True)
        raise HTTPException(status_code=500, detail="Processes query failed") from exc

    if not rows:
        return {"processes": []}

    processes = []
    for row in rows:
        _, pname, kind, node_ids, step_numbers = row
        steps = sorted(
            [{"nodeId": nid, "stepNumber": sn} for nid, sn in zip(node_ids or [], step_numbers or [])],
            key=lambda s: s["stepNumber"],
        )
        processes.append({
            "name": pname,
            "kind": kind,
            "stepCount": len(steps),
            "steps": steps,
        })

    return {"processes": processes}
