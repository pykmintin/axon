"""Tests for Axon Web API route handlers.

All tests mock the storage backend to avoid needing a real KuzuDB database.
Each route handler is tested for expected response shape and error paths.
"""

from __future__ import annotations

from pathlib import Path
from unittest.mock import MagicMock, patch

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from axon.core.graph.graph import KnowledgeGraph
from axon.core.graph.model import (
    GraphNode,
    GraphRelationship,
    NodeLabel,
    RelType,
)


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _make_app(
    storage: MagicMock,
    repo_path: Path | None = None,
    watch: bool = False,
) -> FastAPI:
    """Build a FastAPI app with a mocked storage backend.

    Instead of calling ``create_app`` (which needs a real KuzuDB path),
    this replicates the app assembly from ``app.py`` but injects a mock
    storage directly.
    """
    from axon.web.routes.analysis import router as analysis_router
    from axon.web.routes.cypher import router as cypher_router
    from axon.web.routes.diff import router as diff_router
    from axon.web.routes.events import router as events_router
    from axon.web.routes.files import router as files_router
    from axon.web.routes.graph import router as graph_router
    from axon.web.routes.processes import router as processes_router
    from axon.web.routes.search import router as search_router

    app = FastAPI()
    app.state.storage = storage
    app.state.repo_path = repo_path
    app.state.event_queue = None
    app.state.watch = watch

    app.include_router(graph_router)
    app.include_router(search_router)
    app.include_router(analysis_router)
    app.include_router(files_router)
    app.include_router(cypher_router)
    app.include_router(diff_router)
    app.include_router(processes_router)
    app.include_router(events_router)

    return app


def _sample_node(
    node_id: str = "function:src/app.py:main",
    label: NodeLabel = NodeLabel.FUNCTION,
    name: str = "main",
    file_path: str = "src/app.py",
    start_line: int = 1,
    end_line: int = 20,
    **kwargs,
) -> GraphNode:
    return GraphNode(
        id=node_id,
        label=label,
        name=name,
        file_path=file_path,
        start_line=start_line,
        end_line=end_line,
        **kwargs,
    )


def _sample_edge(
    edge_id: str = "calls:main->helper",
    rel_type: RelType = RelType.CALLS,
    source: str = "function:src/app.py:main",
    target: str = "function:src/utils.py:helper",
    **props,
) -> GraphRelationship:
    return GraphRelationship(
        id=edge_id,
        type=rel_type,
        source=source,
        target=target,
        properties=props,
    )


# ---------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------


@pytest.fixture
def mock_storage() -> MagicMock:
    """Create a MagicMock that mimics StorageBackend with sane defaults."""
    storage = MagicMock()

    # Default: empty graph
    graph = KnowledgeGraph()
    storage.load_graph.return_value = graph

    # Default: node lookup returns None (tests override as needed)
    storage.get_node.return_value = None
    storage.get_callers_with_confidence.return_value = []
    storage.get_callees_with_confidence.return_value = []
    storage.get_type_refs.return_value = []
    storage.get_process_memberships.return_value = {}
    storage.traverse_with_depth.return_value = []
    storage.execute_raw.return_value = []

    return storage


@pytest.fixture
def client(mock_storage: MagicMock) -> TestClient:
    """Create a TestClient with mocked storage and no repo_path."""
    app = _make_app(mock_storage)
    return TestClient(app)


@pytest.fixture
def client_with_repo(mock_storage: MagicMock, tmp_path: Path) -> TestClient:
    """Create a TestClient with mocked storage and a real repo_path."""
    app = _make_app(mock_storage, repo_path=tmp_path, watch=True)
    return TestClient(app)


# ---------------------------------------------------------------------------
# GET /graph
# ---------------------------------------------------------------------------


class TestGraphEndpoint:
    """Tests for GET /graph — full graph serialization."""

    def test_empty_graph(self, client: TestClient) -> None:
        response = client.get("/graph")
        assert response.status_code == 200
        data = response.json()
        assert "nodes" in data
        assert "edges" in data
        assert data["nodes"] == []
        assert data["edges"] == []

    def test_graph_with_nodes_and_edges(
        self, mock_storage: MagicMock, client: TestClient
    ) -> None:
        node = _sample_node()
        edge = _sample_edge(confidence=0.9)
        graph = KnowledgeGraph()
        graph.add_node(node)
        graph.add_node(
            _sample_node(
                node_id="function:src/utils.py:helper",
                name="helper",
                file_path="src/utils.py",
            )
        )
        graph.add_relationship(edge)
        mock_storage.load_graph.return_value = graph

        response = client.get("/graph")
        assert response.status_code == 200
        data = response.json()
        assert len(data["nodes"]) == 2
        assert len(data["edges"]) == 1

        # Verify node serialization shape (camelCase)
        n = data["nodes"][0]
        assert "id" in n
        assert "label" in n
        assert "name" in n
        assert "filePath" in n
        assert "startLine" in n
        assert "endLine" in n
        assert "isDead" in n
        assert "isEntryPoint" in n
        assert "isExported" in n

        # Verify edge serialization shape
        e = data["edges"][0]
        assert "id" in e
        assert "type" in e
        assert "source" in e
        assert "target" in e
        assert "confidence" in e

    def test_graph_load_failure(
        self, mock_storage: MagicMock, client: TestClient
    ) -> None:
        mock_storage.load_graph.side_effect = RuntimeError("DB error")
        response = client.get("/graph")
        assert response.status_code == 500


# ---------------------------------------------------------------------------
# GET /overview
# ---------------------------------------------------------------------------


class TestOverviewEndpoint:
    """Tests for GET /overview — aggregate node/edge counts."""

    def test_empty_overview(self, client: TestClient) -> None:
        response = client.get("/overview")
        assert response.status_code == 200
        data = response.json()
        assert "nodesByLabel" in data
        assert "edgesByType" in data
        assert "totalNodes" in data
        assert "totalEdges" in data
        assert data["totalNodes"] == 0
        assert data["totalEdges"] == 0

    def test_overview_with_data(
        self, mock_storage: MagicMock, client: TestClient
    ) -> None:
        # First call: node counts, second call: edge counts
        mock_storage.execute_raw.side_effect = [
            [["Function", 42], ["Class", 10]],
            [["calls", 100], ["imports", 30]],
        ]

        response = client.get("/overview")
        assert response.status_code == 200
        data = response.json()
        assert data["totalNodes"] == 52
        assert data["totalEdges"] == 130
        assert data["nodesByLabel"]["Function"] == 42
        assert data["edgesByType"]["calls"] == 100


# ---------------------------------------------------------------------------
# GET /node/{node_id}
# ---------------------------------------------------------------------------


class TestNodeEndpoint:
    """Tests for GET /node/{node_id} — single node with context."""

    def test_node_not_found(self, client: TestClient) -> None:
        response = client.get("/node/nonexistent:id")
        assert response.status_code == 404

    def test_node_with_context(
        self, mock_storage: MagicMock, client: TestClient
    ) -> None:
        target_node = _sample_node()
        caller_node = _sample_node(
            node_id="function:src/cli.py:run",
            name="run",
            file_path="src/cli.py",
        )
        callee_node = _sample_node(
            node_id="function:src/utils.py:helper",
            name="helper",
            file_path="src/utils.py",
        )
        type_ref_node = _sample_node(
            node_id="class:src/models.py:User",
            label=NodeLabel.CLASS,
            name="User",
            file_path="src/models.py",
        )

        mock_storage.get_node.return_value = target_node
        mock_storage.get_callers_with_confidence.return_value = [
            (caller_node, 1.0)
        ]
        mock_storage.get_callees_with_confidence.return_value = [
            (callee_node, 0.8)
        ]
        mock_storage.get_type_refs.return_value = [type_ref_node]
        mock_storage.get_process_memberships.return_value = {}

        response = client.get("/node/function:src/app.py:main")
        assert response.status_code == 200
        data = response.json()

        assert "node" in data
        assert data["node"]["name"] == "main"
        assert "callers" in data
        assert len(data["callers"]) == 1
        assert data["callers"][0]["confidence"] == 1.0
        assert "callees" in data
        assert len(data["callees"]) == 1
        assert data["callees"][0]["confidence"] == 0.8
        assert "typeRefs" in data
        assert len(data["typeRefs"]) == 1
        assert "processMemberships" in data


# ---------------------------------------------------------------------------
# POST /search
# ---------------------------------------------------------------------------


class TestSearchEndpoint:
    """Tests for POST /search — hybrid search."""

    def test_search_returns_results(
        self, mock_storage: MagicMock, client: TestClient
    ) -> None:
        from axon.core.storage.base import SearchResult

        search_results = [
            SearchResult(
                node_id="function:src/auth.py:validate",
                score=0.95,
                node_name="validate",
                file_path="src/auth.py",
                label="function",
                snippet="def validate(user): ...",
            ),
        ]

        with patch("axon.web.routes.search.hybrid_search", return_value=search_results):
            with patch("axon.web.routes.search._get_model", side_effect=ImportError):
                response = client.post(
                    "/search", json={"query": "validate", "limit": 10}
                )

        assert response.status_code == 200
        data = response.json()
        assert "results" in data
        assert len(data["results"]) == 1

        r = data["results"][0]
        assert r["nodeId"] == "function:src/auth.py:validate"
        assert r["score"] == 0.95
        assert r["name"] == "validate"
        assert r["filePath"] == "src/auth.py"
        assert r["label"] == "function"
        assert r["snippet"] == "def validate(user): ..."

    def test_search_empty_results(
        self, mock_storage: MagicMock, client: TestClient
    ) -> None:
        with patch("axon.web.routes.search.hybrid_search", return_value=[]):
            with patch("axon.web.routes.search._get_model", side_effect=ImportError):
                response = client.post(
                    "/search", json={"query": "nonexistent", "limit": 5}
                )

        assert response.status_code == 200
        data = response.json()
        assert data["results"] == []

    def test_search_failure(
        self, mock_storage: MagicMock, client: TestClient
    ) -> None:
        with patch(
            "axon.web.routes.search.hybrid_search",
            side_effect=RuntimeError("search error"),
        ):
            with patch("axon.web.routes.search._get_model", side_effect=ImportError):
                response = client.post(
                    "/search", json={"query": "test"}
                )

        assert response.status_code == 500


# ---------------------------------------------------------------------------
# GET /dead-code
# ---------------------------------------------------------------------------


class TestDeadCodeEndpoint:
    """Tests for GET /dead-code — dead code listing grouped by file."""

    def test_no_dead_code(self, client: TestClient) -> None:
        response = client.get("/dead-code")
        assert response.status_code == 200
        data = response.json()
        assert data["total"] == 0
        assert data["byFile"] == {}

    def test_dead_code_found(
        self, mock_storage: MagicMock, client: TestClient
    ) -> None:
        mock_storage.execute_raw.return_value = [
            ["id1", "unused_func", "src/old.py", 10, "Function"],
            ["id2", "stale_helper", "src/old.py", 25, "Function"],
            ["id3", "OldModel", "src/models.py", 5, "Class"],
        ]

        response = client.get("/dead-code")
        assert response.status_code == 200
        data = response.json()
        assert data["total"] == 3
        assert "src/old.py" in data["byFile"]
        assert len(data["byFile"]["src/old.py"]) == 2
        assert "src/models.py" in data["byFile"]

    def test_dead_code_query_failure(
        self, mock_storage: MagicMock, client: TestClient
    ) -> None:
        mock_storage.execute_raw.side_effect = RuntimeError("DB error")
        response = client.get("/dead-code")
        assert response.status_code == 500


# ---------------------------------------------------------------------------
# GET /coupling
# ---------------------------------------------------------------------------


class TestCouplingEndpoint:
    """Tests for GET /coupling — temporal coupling pairs."""

    def test_no_coupling(self, client: TestClient) -> None:
        response = client.get("/coupling")
        assert response.status_code == 200
        data = response.json()
        assert "pairs" in data
        assert data["pairs"] == []

    def test_coupling_with_data(
        self, mock_storage: MagicMock, client: TestClient
    ) -> None:
        mock_storage.execute_raw.return_value = [
            ["FileA", "src/a.py", "FileB", "src/b.py", 0.85, 12],
        ]

        response = client.get("/coupling")
        assert response.status_code == 200
        data = response.json()
        assert len(data["pairs"]) == 1
        pair = data["pairs"][0]
        assert pair["fileA"] == "src/a.py"
        assert pair["fileB"] == "src/b.py"
        assert pair["strength"] == 0.85
        assert pair["coChanges"] == 12


# ---------------------------------------------------------------------------
# GET /health
# ---------------------------------------------------------------------------


class TestHealthEndpoint:
    """Tests for GET /health — composite codebase health score."""

    def test_health_returns_score_and_breakdown(
        self, mock_storage: MagicMock, client: TestClient
    ) -> None:
        # The health endpoint makes many execute_raw calls.
        # Return sensible defaults for each.
        mock_storage.execute_raw.side_effect = [
            [[100]],     # total symbols
            [[5]],       # dead count
            [[0.5]],     # coupling strength (single row for iteration)
            [[3]],       # community count
            [[0.9]],     # avg confidence
            [[50]],      # callable count
            [[10]],      # in-process count
        ]

        response = client.get("/health")
        assert response.status_code == 200
        data = response.json()
        assert "score" in data
        assert "breakdown" in data
        assert isinstance(data["score"], (int, float))
        breakdown = data["breakdown"]
        assert "deadCode" in breakdown
        assert "coupling" in breakdown
        assert "modularity" in breakdown
        assert "confidence" in breakdown
        assert "coverage" in breakdown

    def test_health_handles_empty_db(self, client: TestClient) -> None:
        """Health endpoint gracefully handles empty database (all defaults)."""
        response = client.get("/health")
        assert response.status_code == 200
        data = response.json()
        assert "score" in data
        assert "breakdown" in data


# ---------------------------------------------------------------------------
# GET /communities
# ---------------------------------------------------------------------------


class TestCommunitiesEndpoint:
    """Tests for GET /communities — community clusters."""

    def test_no_communities(self, client: TestClient) -> None:
        response = client.get("/communities")
        assert response.status_code == 200
        data = response.json()
        assert "communities" in data
        assert data["communities"] == []

    def test_communities_with_data(
        self, mock_storage: MagicMock, client: TestClient
    ) -> None:
        mock_storage.execute_raw.return_value = [
            ["community:auth", "Auth Module", 0.85, ["func:login", "func:register"]],
        ]

        response = client.get("/communities")
        assert response.status_code == 200
        data = response.json()
        assert len(data["communities"]) == 1
        comm = data["communities"][0]
        assert comm["id"] == "community:auth"
        assert comm["name"] == "Auth Module"
        assert comm["memberCount"] == 2
        assert comm["cohesion"] == 0.85
        assert len(comm["members"]) == 2


# ---------------------------------------------------------------------------
# GET /processes
# ---------------------------------------------------------------------------


class TestProcessesEndpoint:
    """Tests for GET /processes — execution processes with steps."""

    def test_no_processes(self, client: TestClient) -> None:
        response = client.get("/processes")
        assert response.status_code == 200
        data = response.json()
        assert "processes" in data
        assert data["processes"] == []

    def test_processes_with_data(
        self, mock_storage: MagicMock, client: TestClient
    ) -> None:
        mock_storage.execute_raw.return_value = [
            ["process:login-flow", "Login Flow", "http",
             ["func:validate", "func:auth"], [1, 2]],
        ]

        response = client.get("/processes")
        assert response.status_code == 200
        data = response.json()
        assert len(data["processes"]) == 1
        proc = data["processes"][0]
        assert proc["name"] == "Login Flow"
        assert proc["kind"] == "http"
        assert proc["stepCount"] == 2
        assert len(proc["steps"]) == 2
        assert proc["steps"][0]["nodeId"] == "func:validate"
        assert proc["steps"][0]["stepNumber"] == 1


# ---------------------------------------------------------------------------
# POST /cypher
# ---------------------------------------------------------------------------


class TestCypherEndpoint:
    """Tests for POST /cypher — read-only Cypher query execution."""

    def test_valid_query(
        self, mock_storage: MagicMock, client: TestClient
    ) -> None:
        mock_storage.execute_raw.return_value = [
            ["main", "src/app.py", 1],
            ["helper", "src/utils.py", 5],
        ]

        response = client.post(
            "/cypher",
            json={"query": "MATCH (n) RETURN n.name, n.file_path, n.start_line"},
        )
        assert response.status_code == 200
        data = response.json()
        assert "columns" in data
        assert "rows" in data
        assert "rowCount" in data
        assert "durationMs" in data
        assert data["rowCount"] == 2
        assert len(data["rows"]) == 2
        assert isinstance(data["durationMs"], (int, float))

    def test_empty_results(
        self, mock_storage: MagicMock, client: TestClient
    ) -> None:
        mock_storage.execute_raw.return_value = []

        response = client.post(
            "/cypher",
            json={"query": "MATCH (n:Nonexistent) RETURN n"},
        )
        assert response.status_code == 200
        data = response.json()
        assert data["rowCount"] == 0
        assert data["rows"] == []

    def test_null_results(
        self, mock_storage: MagicMock, client: TestClient
    ) -> None:
        mock_storage.execute_raw.return_value = None

        response = client.post(
            "/cypher",
            json={"query": "MATCH (n:Nonexistent) RETURN n"},
        )
        assert response.status_code == 200
        data = response.json()
        assert data["rowCount"] == 0

    def test_write_query_blocked_create(self, client: TestClient) -> None:
        response = client.post(
            "/cypher",
            json={"query": "CREATE (n:Test {name: 'test'})"},
        )
        assert response.status_code == 400
        assert "read-only" in response.json()["detail"].lower()

    def test_write_query_blocked_delete(self, client: TestClient) -> None:
        response = client.post(
            "/cypher",
            json={"query": "MATCH (n) DELETE n"},
        )
        assert response.status_code == 400

    def test_write_query_blocked_set(self, client: TestClient) -> None:
        response = client.post(
            "/cypher",
            json={"query": "MATCH (n) SET n.name = 'hacked'"},
        )
        assert response.status_code == 400

    def test_write_query_blocked_drop(self, client: TestClient) -> None:
        response = client.post(
            "/cypher",
            json={"query": "DROP TABLE Node"},
        )
        assert response.status_code == 400

    def test_write_query_blocked_merge(self, client: TestClient) -> None:
        response = client.post(
            "/cypher",
            json={"query": "MERGE (n:Test {name: 'x'})"},
        )
        assert response.status_code == 400

    def test_write_query_blocked_detach(self, client: TestClient) -> None:
        response = client.post(
            "/cypher",
            json={"query": "MATCH (n) DETACH DELETE n"},
        )
        assert response.status_code == 400

    def test_write_query_blocked_case_insensitive(
        self, client: TestClient
    ) -> None:
        response = client.post(
            "/cypher",
            json={"query": "match (n) delete n"},
        )
        assert response.status_code == 400

    def test_query_execution_failure(
        self, mock_storage: MagicMock, client: TestClient
    ) -> None:
        mock_storage.execute_raw.side_effect = RuntimeError("Syntax error in query")
        response = client.post(
            "/cypher",
            json={"query": "MATCH (n) RETURN invalid"},
        )
        assert response.status_code == 400
        assert "Syntax error" in response.json()["detail"]

    def test_columns_extracted_from_return(
        self, mock_storage: MagicMock, client: TestClient
    ) -> None:
        mock_storage.execute_raw.return_value = [["test", 42]]

        response = client.post(
            "/cypher",
            json={"query": "MATCH (n) RETURN n.name AS name, count(n)"},
        )
        assert response.status_code == 200
        data = response.json()
        assert "name" in data["columns"]


# ---------------------------------------------------------------------------
# GET /tree
# ---------------------------------------------------------------------------


class TestTreeEndpoint:
    """Tests for GET /tree — file tree."""

    def test_empty_tree(self, client: TestClient) -> None:
        response = client.get("/tree")
        assert response.status_code == 200
        data = response.json()
        assert "tree" in data
        assert data["tree"] == []

    def test_tree_with_files(
        self, mock_storage: MagicMock, client: TestClient
    ) -> None:
        mock_storage.execute_raw.side_effect = [
            # File nodes
            [
                ["file:src/app.py", "app.py", "src/app.py", "python"],
                ["file:src/utils.py", "utils.py", "src/utils.py", "python"],
            ],
            # Folder nodes
            [],
            # Symbol counts
            [["src/app.py", 5], ["src/utils.py", 3]],
        ]

        response = client.get("/tree")
        assert response.status_code == 200
        data = response.json()
        assert len(data["tree"]) >= 1

        # Should have a "src" folder at root
        src_folder = next(
            (item for item in data["tree"] if item["name"] == "src"), None
        )
        assert src_folder is not None
        assert src_folder["type"] == "folder"
        assert "children" in src_folder


# ---------------------------------------------------------------------------
# GET /file
# ---------------------------------------------------------------------------


class TestFileEndpoint:
    """Tests for GET /file?path=... — file content."""

    def test_no_repo_path(self, client: TestClient) -> None:
        """Returns 400 when no repo_path is configured."""
        response = client.get("/file?path=src/app.py")
        assert response.status_code == 400
        assert "repo_path" in response.json()["detail"].lower()

    def test_file_not_found(
        self, client_with_repo: TestClient
    ) -> None:
        response = client_with_repo.get("/file?path=nonexistent.py")
        assert response.status_code == 404

    def test_file_found(
        self, mock_storage: MagicMock, tmp_path: Path
    ) -> None:
        # Create a real file in the tmp repo
        src_dir = tmp_path / "src"
        src_dir.mkdir()
        test_file = src_dir / "app.py"
        test_file.write_text("def main():\n    pass\n", encoding="utf-8")

        app = _make_app(mock_storage, repo_path=tmp_path)
        client = TestClient(app)

        response = client.get("/file?path=src/app.py")
        assert response.status_code == 200
        data = response.json()
        assert data["path"] == "src/app.py"
        assert "def main()" in data["content"]
        assert data["language"] == "python"

    def test_path_traversal_blocked(
        self, mock_storage: MagicMock, tmp_path: Path
    ) -> None:
        app = _make_app(mock_storage, repo_path=tmp_path)
        client = TestClient(app)

        response = client.get("/file?path=../../etc/passwd")
        assert response.status_code == 400
        assert "traversal" in response.json()["detail"].lower()


# ---------------------------------------------------------------------------
# POST /diff
# ---------------------------------------------------------------------------


class TestDiffEndpoint:
    """Tests for POST /diff — branch comparison."""

    def test_no_repo_path(self, client: TestClient) -> None:
        response = client.post("/diff", json={"base": "main", "compare": "feature"})
        assert response.status_code == 400
        assert "repo_path" in response.json()["detail"].lower()

    def test_diff_success(
        self, mock_storage: MagicMock, tmp_path: Path
    ) -> None:
        from dataclasses import dataclass, field as dc_field

        @dataclass
        class FakeDiffResult:
            added_nodes: list = dc_field(default_factory=list)
            removed_nodes: list = dc_field(default_factory=list)
            modified_nodes: list = dc_field(default_factory=list)
            added_relationships: list = dc_field(default_factory=list)
            removed_relationships: list = dc_field(default_factory=list)

        added_node = _sample_node(
            node_id="function:src/new.py:new_func",
            name="new_func",
            file_path="src/new.py",
        )
        fake_result = FakeDiffResult(added_nodes=[added_node])

        app = _make_app(mock_storage, repo_path=tmp_path)
        client = TestClient(app)

        with patch("axon.web.routes.diff.diff_branches", return_value=fake_result):
            response = client.post(
                "/diff", json={"base": "main", "compare": "feature"}
            )

        assert response.status_code == 200
        data = response.json()
        assert "added" in data
        assert "removed" in data
        assert "modified" in data
        assert "addedEdges" in data
        assert "removedEdges" in data
        assert len(data["added"]) == 1
        assert data["added"][0]["name"] == "new_func"

    def test_diff_value_error(
        self, mock_storage: MagicMock, tmp_path: Path
    ) -> None:
        app = _make_app(mock_storage, repo_path=tmp_path)
        client = TestClient(app)

        with patch(
            "axon.web.routes.diff.diff_branches",
            side_effect=ValueError("Invalid branch range"),
        ):
            response = client.post(
                "/diff", json={"base": "main", "compare": "nonexistent"}
            )

        assert response.status_code == 400


# ---------------------------------------------------------------------------
# POST /reindex
# ---------------------------------------------------------------------------


class TestReindexEndpoint:
    """Tests for POST /reindex — trigger background reindex."""

    def test_reindex_no_repo_path(self, client: TestClient) -> None:
        """Returns 400 when no repo_path is configured."""
        response = client.post("/reindex")
        assert response.status_code == 400

    def test_reindex_not_in_watch_mode(
        self, mock_storage: MagicMock
    ) -> None:
        """Returns 400 when not in watch mode."""
        app = _make_app(mock_storage, repo_path=Path("/tmp/fake"), watch=False)
        client = TestClient(app)
        response = client.post("/reindex")
        assert response.status_code == 400
        assert "watch" in response.json()["detail"].lower()

    def test_reindex_success(self, client_with_repo: TestClient) -> None:
        """Returns started status when in watch mode with repo_path."""
        with patch("axon.web.routes.analysis.threading") as mock_threading:
            response = client_with_repo.post("/reindex")

        assert response.status_code == 200
        data = response.json()
        assert data["status"] == "started"


# ---------------------------------------------------------------------------
# GET /impact/{node_id}
# ---------------------------------------------------------------------------


class TestImpactEndpoint:
    """Tests for GET /impact/{node_id} — blast radius analysis."""

    def test_node_not_found(self, client: TestClient) -> None:
        response = client.get("/impact/nonexistent:id")
        assert response.status_code == 404

    def test_impact_with_affected(
        self, mock_storage: MagicMock, client: TestClient
    ) -> None:
        target = _sample_node()
        affected = _sample_node(
            node_id="function:src/cli.py:run",
            name="run",
            file_path="src/cli.py",
        )

        mock_storage.get_node.return_value = target
        mock_storage.traverse_with_depth.return_value = [(affected, 1)]

        response = client.get("/impact/function:src/app.py:main")
        assert response.status_code == 200
        data = response.json()
        assert "target" in data
        assert "affected" in data
        assert "depths" in data
        assert data["affected"] == 1
        assert data["target"]["name"] == "main"


# ---------------------------------------------------------------------------
# GET /events
# ---------------------------------------------------------------------------


class TestEventsEndpoint:
    """Tests for GET /events — SSE endpoint."""

    def test_events_endpoint_exists(self, client: TestClient) -> None:
        """The /events endpoint should be registered and respond."""
        # SSE endpoints return a streaming response. With no event_queue
        # (non-watch mode), the generator exits immediately.
        response = client.get("/events")
        # sse-starlette returns 200 for SSE responses
        assert response.status_code == 200
