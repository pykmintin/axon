"""Shared runtime state for Axon host processes."""

from __future__ import annotations

import asyncio
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from axon.core.storage.base import StorageBackend


@dataclass(slots=True)
class AxonRuntime:
    """Shared runtime container for web and MCP surfaces."""

    storage: StorageBackend
    repo_path: Path | None = None
    watch: bool = False
    lock: asyncio.Lock | None = None
    host_url: str | None = None
    mcp_url: str | None = None
    owns_storage: bool = True
    event_listeners: list[asyncio.Queue[Any]] | None = field(default=None)

    def __post_init__(self) -> None:
        if self.event_listeners is None and self.watch:
            self.event_listeners = []
