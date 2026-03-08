"""Shared data types for resolution results."""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any

from axon.core.graph.model import RelType


@dataclass(slots=True, frozen=True)
class ResolvedEdge:
    rel_id: str
    rel_type: RelType
    source: str
    target: str
    properties: dict[str, Any] = field(default_factory=dict)


@dataclass(slots=True, frozen=True)
class NodePropertyPatch:
    node_id: str
    key: str
    value: Any
