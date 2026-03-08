"""FastAPI application factory for the Axon Web UI.

Creates a configured FastAPI app that wraps the StorageBackend,
serves API routes, and optionally mounts the frontend SPA.
"""

from __future__ import annotations

import logging
from contextlib import asynccontextmanager
from pathlib import Path
from typing import AsyncIterator

import httpx
from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import Response, StreamingResponse
from fastapi.staticfiles import StaticFiles
from starlette.routing import Route

from axon.core.storage.kuzu_backend import KuzuBackend
from axon.mcp.server import create_streamable_http_app
from axon.runtime import AxonRuntime
from axon.web.routes.analysis import router as analysis_router
from axon.web.routes.cypher import router as cypher_router
from axon.web.routes.diff import router as diff_router
from axon.web.routes.events import router as events_router
from axon.web.routes.files import router as files_router
from axon.web.routes.graph import router as graph_router
from axon.web.routes.host import router as host_router
from axon.web.routes.processes import router as processes_router
from axon.web.routes.search import router as search_router

logger = logging.getLogger(__name__)


FRONTEND_DIR = Path(__file__).resolve().parent / "frontend" / "dist"


def create_app(
    db_path: Path,
    repo_path: Path | None = None,
    watch: bool = False,
    dev: bool = False,
    runtime: AxonRuntime | None = None,
    mount_mcp: bool = False,
    host_url: str | None = None,
    mcp_url: str | None = None,
    mount_frontend: bool = True,
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
    if runtime is None:
        storage = KuzuBackend()
        storage.initialize(db_path, read_only=True)
        runtime = AxonRuntime(
            storage=storage,
            repo_path=repo_path,
            watch=watch,
            host_url=host_url,
            mcp_url=mcp_url,
            owns_storage=True,
        )
    else:
        runtime.repo_path = repo_path if repo_path is not None else runtime.repo_path
        runtime.watch = watch
        runtime.host_url = host_url or runtime.host_url
        runtime.mcp_url = mcp_url or runtime.mcp_url
        if runtime.event_listeners is None and watch:
            runtime.event_listeners = []

    session_manager = None
    streamable_http_app = None
    if mount_mcp:
        session_manager, streamable_http_app = create_streamable_http_app()

    @asynccontextmanager
    async def lifespan(app: FastAPI) -> AsyncIterator[None]:
        if session_manager is not None:
            async with session_manager.run():
                yield
        else:
            yield
        if runtime.owns_storage:
            runtime.storage.close()
            logger.info("Storage backend closed")

    app = FastAPI(
        title="Axon Web UI",
        description="Graph-powered code intelligence engine",
        version="0.2.4",
        lifespan=lifespan,
    )

    app.state.runtime = runtime
    app.state.storage = runtime.storage
    app.state.repo_path = runtime.repo_path
    app.state.event_listeners = runtime.event_listeners
    app.state.watch = runtime.watch
    app.state.host_url = runtime.host_url
    app.state.mcp_url = runtime.mcp_url
    app.state.mode = "host" if mount_mcp else "standalone"

    app.add_middleware(
        CORSMiddleware,
        allow_origin_regex=r"https?://localhost(:\d+)?",
        allow_credentials=True,
        allow_methods=["GET", "POST", "OPTIONS"],
        allow_headers=["Content-Type", "Accept"],
    )

    app.include_router(graph_router, prefix="/api")
    app.include_router(host_router, prefix="/api")
    app.include_router(search_router, prefix="/api")
    app.include_router(analysis_router, prefix="/api")
    app.include_router(files_router, prefix="/api")
    app.include_router(cypher_router, prefix="/api")
    app.include_router(diff_router, prefix="/api")
    app.include_router(processes_router, prefix="/api")
    app.include_router(events_router, prefix="/api")

    if streamable_http_app is not None:
        app.router.routes.append(Route("/mcp", endpoint=streamable_http_app))

    if mount_frontend and not dev and FRONTEND_DIR.is_dir():
        app.mount("/", StaticFiles(directory=str(FRONTEND_DIR), html=True), name="frontend")
        logger.info("Serving frontend from %s", FRONTEND_DIR)
    elif mount_frontend and dev:
        logger.info("Dev mode: skipping static file mount (use Vite on :5173)")

    return app


def create_ui_proxy_app(api_base_url: str, *, dev: bool = False) -> FastAPI:
    """Create a UI-only app that proxies API requests to an existing backend."""
    app = FastAPI(title="Axon UI Proxy", description="UI proxy for a shared Axon backend")

    async def _proxy_request(request: Request, path: str = "") -> Response:
        upstream = f"{api_base_url}/api/{path}".rstrip("/")
        body = await request.body()
        headers = {
            key: value
            for key, value in request.headers.items()
            if key.lower() not in {"host", "content-length", "connection"}
        }

        async with httpx.AsyncClient(timeout=httpx.Timeout(30.0, read=300.0)) as client:
            if request.url.path == "/api/events":
                upstream_request = client.build_request(
                    request.method,
                    upstream,
                    params=request.query_params,
                    headers=headers,
                    content=body if body else None,
                )
                upstream_stream = await client.send(upstream_request, stream=True)

                async def _iter_bytes():
                    try:
                        async for chunk in upstream_stream.aiter_bytes():
                            yield chunk
                    finally:
                        await upstream_stream.aclose()

                return StreamingResponse(
                    _iter_bytes(),
                    status_code=upstream_stream.status_code,
                    headers={
                        key: value
                        for key, value in upstream_stream.headers.items()
                        if key.lower() not in {"content-length", "connection"}
                    },
                    media_type=upstream_stream.headers.get("content-type"),
                )

            response = await client.request(
                request.method,
                upstream,
                params=request.query_params,
                headers=headers,
                content=body if body else None,
            )
            return Response(
                content=response.content,
                status_code=response.status_code,
                headers={
                    key: value
                    for key, value in response.headers.items()
                    if key.lower() not in {"content-length", "connection"}
                },
                media_type=response.headers.get("content-type"),
            )

    app.add_api_route("/api", _proxy_request, methods=["GET", "POST", "OPTIONS"])
    app.add_api_route("/api/{path:path}", _proxy_request, methods=["GET", "POST", "OPTIONS"])

    if not dev and FRONTEND_DIR.is_dir():
        app.mount("/", StaticFiles(directory=str(FRONTEND_DIR), html=True), name="frontend")
    elif dev:
        logger.info("Dev mode: skipping static file mount (use Vite on :5173)")

    return app
