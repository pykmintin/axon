"""FastAPI application factory for the Axon Web UI.

Creates a configured FastAPI app that wraps the StorageBackend,
serves API routes, and optionally mounts the frontend SPA.
"""

from __future__ import annotations

import asyncio
import logging
from contextlib import asynccontextmanager
from pathlib import Path
from typing import AsyncIterator

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles

logger = logging.getLogger(__name__)


FRONTEND_DIR = Path(__file__).resolve().parent / "frontend" / "dist"


def create_app(
    db_path: Path,
    repo_path: Path | None = None,
    watch: bool = False,
    dev: bool = False,
) -> FastAPI:
    """Build and return a fully configured FastAPI application.

    Args:
        db_path: Path to the KuzuDB database directory.
        repo_path: Root of the repository (for file serving and reindex).
        watch: When True, enables SSE event streaming and reindex support.
        dev: When True, skips static file serving (use Vite dev server instead).

    Returns:
        A ready-to-run FastAPI instance.
    """
    from axon.core.storage.kuzu_backend import KuzuBackend

    storage = KuzuBackend()
    read_only = not watch
    storage.initialize(db_path, read_only=read_only)

    event_queue: asyncio.Queue | None = asyncio.Queue() if watch else None

    @asynccontextmanager
    async def lifespan(app: FastAPI) -> AsyncIterator[None]:
        yield
        storage.close()
        logger.info("Storage backend closed")

    app = FastAPI(
        title="Axon Web UI",
        description="Graph-powered code intelligence engine",
        version="0.2.4",
        lifespan=lifespan,
    )

    app.state.storage = storage
    app.state.repo_path = repo_path
    app.state.event_queue = event_queue
    app.state.watch = watch

    app.add_middleware(
        CORSMiddleware,
        allow_origin_regex=r"https?://localhost(:\d+)?",
        allow_credentials=True,
        allow_methods=["*"],
        allow_headers=["*"],
    )

    from axon.web.routes.analysis import router as analysis_router
    from axon.web.routes.cypher import router as cypher_router
    from axon.web.routes.diff import router as diff_router
    from axon.web.routes.events import router as events_router
    from axon.web.routes.files import router as files_router
    from axon.web.routes.graph import router as graph_router
    from axon.web.routes.processes import router as processes_router
    from axon.web.routes.search import router as search_router

    app.include_router(graph_router, prefix="/api")
    app.include_router(search_router, prefix="/api")
    app.include_router(analysis_router, prefix="/api")
    app.include_router(files_router, prefix="/api")
    app.include_router(cypher_router, prefix="/api")
    app.include_router(diff_router, prefix="/api")
    app.include_router(processes_router, prefix="/api")
    app.include_router(events_router, prefix="/api")

    if not dev and FRONTEND_DIR.is_dir():
        app.mount("/", StaticFiles(directory=str(FRONTEND_DIR), html=True), name="frontend")
        logger.info("Serving frontend from %s", FRONTEND_DIR)
    elif dev:
        logger.info("Dev mode: skipping static file mount (use Vite on :5173)")

    return app
