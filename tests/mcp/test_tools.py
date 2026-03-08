from __future__ import annotations

import json
from unittest.mock import MagicMock

import pytest

from axon.core.graph.graph import KnowledgeGraph
from axon.core.graph.model import GraphNode, GraphRelationship, NodeLabel, RelType
from axon.core.storage.base import SearchResult
from axon.mcp.resources import get_dead_code_list, get_overview, get_schema
from axon.mcp.tools import (
    _confidence_tag,
    _format_query_results,
    _group_by_process,
    handle_call_path,
    handle_communities,
    handle_context,
    handle_coupling,
    handle_cycles,
    handle_cypher,
    handle_dead_code,
    handle_detect_changes,
    handle_explain,
    handle_file_context,
    handle_impact,
    handle_list_repos,
    handle_query,
    handle_review_risk,
    handle_test_impact,
)


@pytest.fixture
def mock_storage():
    """Create a mock storage backend with common default return values."""
    storage = MagicMock()
    storage.fts_search.return_value = [
        SearchResult(
            node_id="function:src/auth.py:validate",
            score=1.0,
            node_name="validate",
            file_path="src/auth.py",
            label="function",
            snippet="def validate(user): ...",
        ),
    ]
    storage.get_node.return_value = GraphNode(
        id="function:src/auth.py:validate",
        label=NodeLabel.FUNCTION,
        name="validate",
        file_path="src/auth.py",
        start_line=10,
        end_line=30,
    )
    storage.get_callers.return_value = []
    storage.get_callees.return_value = []
    storage.get_type_refs.return_value = []
    storage.vector_search.return_value = []
    storage.traverse.return_value = []
    storage.traverse_with_depth.return_value = []
    storage.get_callers_with_confidence.return_value = []
    storage.get_callees_with_confidence.return_value = []
    storage.get_process_memberships.return_value = {}
    storage.execute_raw.return_value = []
    return storage


@pytest.fixture
def mock_storage_with_relations(mock_storage):
    """Storage mock with callers, callees, and type refs populated."""
    _caller = GraphNode(
        id="function:src/routes/auth.py:login_handler",
        label=NodeLabel.FUNCTION,
        name="login_handler",
        file_path="src/routes/auth.py",
        start_line=12,
        end_line=40,
    )
    _callee = GraphNode(
        id="function:src/auth/crypto.py:hash_password",
        label=NodeLabel.FUNCTION,
        name="hash_password",
        file_path="src/auth/crypto.py",
        start_line=5,
        end_line=20,
    )
    mock_storage.get_callers.return_value = [_caller]
    mock_storage.get_callees.return_value = [_callee]
    mock_storage.get_callers_with_confidence.return_value = [(_caller, 1.0)]
    mock_storage.get_callees_with_confidence.return_value = [(_callee, 0.8)]
    mock_storage.get_type_refs.return_value = [
        GraphNode(
            id="class:src/models.py:User",
            label=NodeLabel.CLASS,
            name="User",
            file_path="src/models.py",
            start_line=1,
            end_line=50,
        ),
    ]
    return mock_storage


class TestHandleListRepos:
    def test_no_registry_dir(self, tmp_path):
        result = handle_list_repos(registry_dir=tmp_path / "nonexistent")
        assert "No indexed repositories found" in result

    def test_empty_registry_dir(self, tmp_path):
        registry = tmp_path / "repos"
        registry.mkdir()
        result = handle_list_repos(registry_dir=registry)
        assert "No indexed repositories found" in result

    def test_with_repos(self, tmp_path):
        registry = tmp_path / "repos"
        repo_dir = registry / "my-project"
        repo_dir.mkdir(parents=True)
        meta = {
            "name": "my-project",
            "path": "/home/user/my-project",
            "stats": {
                "files": 25,
                "symbols": 150,
                "relationships": 200,
            },
        }
        (repo_dir / "meta.json").write_text(json.dumps(meta))

        result = handle_list_repos(registry_dir=registry)
        assert "my-project" in result
        assert "150" in result
        assert "200" in result
        assert "Indexed repositories (1)" in result


class TestHandleQuery:
    def test_returns_results(self, mock_storage):
        result = handle_query(mock_storage, "validate")
        assert "validate" in result
        assert "Function" in result
        assert "src/auth.py" in result
        assert "Next:" in result

    def test_no_results(self, mock_storage):
        mock_storage.fts_search.return_value = []
        mock_storage.vector_search.return_value = []
        result = handle_query(mock_storage, "nonexistent")
        assert "No results found" in result

    def test_snippet_included(self, mock_storage):
        result = handle_query(mock_storage, "validate")
        assert "def validate" in result

    def test_custom_limit(self, mock_storage):
        handle_query(mock_storage, "validate", limit=5)
        # hybrid_search calls fts_search with candidate_limit = limit * 3
        mock_storage.fts_search.assert_called_once_with("validate", limit=15)


class TestHandleContext:
    def test_basic_context(self, mock_storage):
        result = handle_context(mock_storage, "validate")
        assert "Symbol: validate (Function)" in result
        assert "src/auth.py:10-30" in result
        assert "Next:" in result

    def test_not_found_fts_empty(self, mock_storage):
        mock_storage.exact_name_search.return_value = []
        mock_storage.fts_search.return_value = []
        result = handle_context(mock_storage, "nonexistent")
        assert "not found" in result.lower()

    def test_not_found_node_none(self, mock_storage):
        mock_storage.get_node.return_value = None
        result = handle_context(mock_storage, "validate")
        assert "not found" in result.lower()

    def test_with_callers_callees_type_refs(self, mock_storage_with_relations):
        result = handle_context(mock_storage_with_relations, "validate")
        assert "Callers (1):" in result
        assert "login_handler" in result
        assert "Callees (1):" in result
        assert "hash_password" in result
        assert "Type references (1):" in result
        assert "User" in result

    def test_dead_code_flag(self, mock_storage):
        mock_storage.get_node.return_value = GraphNode(
            id="function:src/old.py:deprecated",
            label=NodeLabel.FUNCTION,
            name="deprecated",
            file_path="src/old.py",
            start_line=1,
            end_line=5,
            is_dead=True,
        )
        result = handle_context(mock_storage, "deprecated")
        assert "DEAD CODE" in result

    def test_heritage_shown(self, mock_storage):
        mock_storage.get_node.return_value = GraphNode(
            id="class:src/models.py:Admin",
            label=NodeLabel.CLASS,
            name="Admin",
            file_path="src/models.py",
            start_line=50,
            end_line=80,
        )
        mock_storage.execute_raw.side_effect = [
            # Heritage query
            [["User", "src/models.py", "extends"]],
            # Imported-by query
            [],
        ]
        result = handle_context(mock_storage, "Admin")
        assert "Heritage" in result
        assert "extends" in result
        assert "User" in result

    def test_imported_by_shown(self, mock_storage):
        mock_storage.execute_raw.side_effect = [
            # Heritage query
            [],
            # Imported-by query
            [["src/mcp/server.py"], ["tests/test_auth.py"]],
        ]
        result = handle_context(mock_storage, "validate")
        assert "Imported by (2)" in result
        assert "src/mcp/server.py" in result
        assert "tests/test_auth.py" in result


class TestHandleImpact:
    def test_no_downstream(self, mock_storage):
        result = handle_impact(mock_storage, "validate")
        assert "No upstream callers found" in result or "No downstream dependencies" in result

    def test_with_affected_symbols(self, mock_storage):
        _login = GraphNode(
            id="function:src/api.py:login",
            label=NodeLabel.FUNCTION,
            name="login",
            file_path="src/api.py",
            start_line=5,
            end_line=20,
        )
        _register = GraphNode(
            id="function:src/api.py:register",
            label=NodeLabel.FUNCTION,
            name="register",
            file_path="src/api.py",
            start_line=25,
            end_line=50,
        )
        mock_storage.traverse.return_value = [_login, _register]
        mock_storage.traverse_with_depth.return_value = [(_login, 1), (_register, 2)]
        mock_storage.get_callers_with_confidence.return_value = [(_login, 1.0)]
        result = handle_impact(mock_storage, "validate", depth=2)
        assert "Impact analysis for: validate" in result
        assert "Total: 2 symbols" in result
        assert "login" in result
        assert "register" in result
        assert "Depth: 2" in result

    def test_symbol_not_found(self, mock_storage):
        mock_storage.exact_name_search.return_value = []
        mock_storage.fts_search.return_value = []
        result = handle_impact(mock_storage, "nonexistent")
        assert "not found" in result.lower()


class TestHandleDeadCode:
    def test_no_dead_code(self, mock_storage):
        result = handle_dead_code(mock_storage)
        assert "No dead code detected" in result

    def test_with_dead_code(self, mock_storage):
        mock_storage.execute_raw.return_value = [
            ["function:src/old.py:unused_func", "unused_func", "src/old.py", 10, "Function"],
            ["class:src/models.py:DeprecatedModel", "DeprecatedModel", "src/models.py", 5, "Class"],
        ]
        result = handle_dead_code(mock_storage)
        assert "Dead Code Report (2 symbols)" in result
        assert "unused_func" in result
        assert "DeprecatedModel" in result

    def test_execute_raw_exception(self, mock_storage):
        mock_storage.execute_raw.side_effect = RuntimeError("DB error")
        result = handle_dead_code(mock_storage)
        assert "Could not retrieve dead code list" in result


SAMPLE_DIFF = """\
diff --git a/src/auth.py b/src/auth.py
index abc1234..def5678 100644
--- a/src/auth.py
+++ b/src/auth.py
@@ -10,5 +10,7 @@ def validate(user):
     if not user:
         return False
+    # Added new validation
+    check_permissions(user)
     return True
"""


class TestHandleDetectChanges:
    def test_parses_diff(self, mock_storage):
        # handle_detect_changes now uses execute_raw() with a Cypher query
        # to find symbols in the changed file.
        mock_storage.execute_raw.return_value = [
            ["function:src/auth.py:validate", "validate", "src/auth.py", 10, 30],
        ]

        result = handle_detect_changes(mock_storage, SAMPLE_DIFF)
        assert "src/auth.py" in result
        assert "validate" in result
        assert "Total affected symbols:" in result

    def test_empty_diff(self, mock_storage):
        result = handle_detect_changes(mock_storage, "")
        assert "Empty diff provided" in result

    def test_unparseable_diff(self, mock_storage):
        result = handle_detect_changes(mock_storage, "just some random text")
        assert "Could not parse" in result

    def test_no_symbols_in_changed_lines(self, mock_storage):
        mock_storage.execute_raw.return_value = []
        result = handle_detect_changes(mock_storage, SAMPLE_DIFF)
        assert "src/auth.py" in result
        assert "no indexed symbols" in result


class TestHandleCypher:
    def test_returns_results(self, mock_storage):
        mock_storage.execute_raw.return_value = [
            ["validate", "src/auth.py", 10],
            ["login", "src/api.py", 5],
        ]
        result = handle_cypher(mock_storage, "MATCH (n) RETURN n.name, n.file_path, n.start_line")
        assert "Results (2 rows)" in result
        assert "validate" in result
        assert "src/api.py" in result

    def test_no_results(self, mock_storage):
        result = handle_cypher(mock_storage, "MATCH (n:Nonexistent) RETURN n")
        assert "no results" in result.lower()

    def test_query_error(self, mock_storage):
        mock_storage.execute_raw.side_effect = RuntimeError("Syntax error")
        result = handle_cypher(mock_storage, "INVALID QUERY")
        assert "failed" in result.lower()
        assert "Syntax error" in result

    def test_handle_cypher_rejects_write(self, mock_storage):
        result = handle_cypher(mock_storage, "DELETE (n)")
        assert "not permitted" in result.lower() or "not allowed" in result.lower()
        mock_storage.execute_raw.assert_not_called()


class TestResources:
    def test_get_schema(self):
        result = get_schema()
        assert "Node Labels:" in result
        assert "Relationship Types:" in result
        assert "CALLS" in result
        assert "Function" in result

    def test_get_overview(self, mock_storage):
        mock_storage.execute_raw.return_value = [["Function", 42]]
        result = get_overview(mock_storage)
        assert "Axon Codebase Overview" in result

    def test_get_dead_code_list(self, mock_storage):
        mock_storage.execute_raw.return_value = [
            ["function:src/old.py:old_func", "old_func", "src/old.py", 10, "Function"],
        ]
        result = get_dead_code_list(mock_storage)
        assert "Dead Code Report" in result
        assert "old_func" in result

    def test_get_dead_code_list_empty(self, mock_storage):
        result = get_dead_code_list(mock_storage)
        assert "No dead code detected" in result


class TestConfidenceTag:
    def test_high_confidence(self):
        assert _confidence_tag(1.0) == ""
        assert _confidence_tag(0.95) == ""
        assert _confidence_tag(0.9) == ""

    def test_medium_confidence(self):
        assert _confidence_tag(0.89) == " (~)"
        assert _confidence_tag(0.5) == " (~)"
        assert _confidence_tag(0.7) == " (~)"

    def test_low_confidence(self):
        assert _confidence_tag(0.49) == " (?)"
        assert _confidence_tag(0.1) == " (?)"
        assert _confidence_tag(0.0) == " (?)"


class TestConfidenceInContext:
    def test_medium_confidence_tag_shown(self, mock_storage_with_relations):
        result = handle_context(mock_storage_with_relations, "validate")
        # _callee has confidence 0.8, which produces " (~)"
        assert "(~)" in result

    def test_high_confidence_no_tag(self, mock_storage_with_relations):
        result = handle_context(mock_storage_with_relations, "validate")
        # login_handler has confidence 1.0 — no tag after its line
        assert "login_handler" in result
        # There should be no "(?)" for the high-confidence caller
        lines = result.split("\n")
        caller_line = [l for l in lines if "login_handler" in l][0]
        assert "(?)" not in caller_line
        assert "(~)" not in caller_line


class TestGroupByProcess:
    def test_empty_results(self, mock_storage):
        groups = _group_by_process([], mock_storage)
        assert groups == {}

    def test_with_memberships(self, mock_storage):
        results = [
            SearchResult(node_id="func:a", score=1.0, node_name="a"),
            SearchResult(node_id="func:b", score=0.9, node_name="b"),
            SearchResult(node_id="func:c", score=0.8, node_name="c"),
        ]
        mock_storage.get_process_memberships.return_value = {
            "func:a": "Auth Flow",
            "func:c": "Auth Flow",
        }
        groups = _group_by_process(results, mock_storage)
        assert "Auth Flow" in groups
        assert len(groups["Auth Flow"]) == 2

    def test_backend_missing_method(self, mock_storage):
        mock_storage.get_process_memberships.side_effect = AttributeError
        results = [SearchResult(node_id="func:a", score=1.0)]
        groups = _group_by_process(results, mock_storage)
        assert groups == {}


class TestFormatQueryResults:
    def test_ungrouped_only(self):
        results = [
            SearchResult(
                node_id="func:a", score=1.0, node_name="foo",
                file_path="src/a.py", label="function",
            ),
        ]
        output = _format_query_results(results, {})
        assert "foo (Function)" in output
        assert "src/a.py" in output
        assert "Next:" in output

    def test_with_groups(self):
        r1 = SearchResult(
            node_id="func:a", score=1.0, node_name="login",
            file_path="src/auth.py", label="function",
        )
        r2 = SearchResult(
            node_id="func:b", score=0.9, node_name="helper",
            file_path="src/utils.py", label="function",
        )
        groups = {"Auth Flow": [r1]}
        output = _format_query_results([r1, r2], groups)
        assert "=== Auth Flow ===" in output
        assert "=== Other results ===" in output
        assert "login" in output
        assert "helper" in output

    def test_snippet_truncation(self):
        long_snippet = "x" * 300
        results = [
            SearchResult(
                node_id="func:a", score=1.0, node_name="foo",
                file_path="src/a.py", label="function", snippet=long_snippet,
            ),
        ]
        output = _format_query_results(results, {})
        # Snippet in output should be at most 200 chars
        lines = output.split("\n")
        snippet_lines = [l for l in lines if l.strip().startswith("xxx")]
        for line in snippet_lines:
            assert len(line.strip()) <= 200


class TestImpactDepthGrouping:
    def test_depth_section_headers(self, mock_storage):
        _login = GraphNode(
            id="function:src/api.py:login",
            label=NodeLabel.FUNCTION,
            name="login",
            file_path="src/api.py",
            start_line=5,
            end_line=20,
        )
        _register = GraphNode(
            id="function:src/api.py:register",
            label=NodeLabel.FUNCTION,
            name="register",
            file_path="src/api.py",
            start_line=25,
            end_line=50,
        )
        mock_storage.traverse_with_depth.return_value = [
            (_login, 1), (_register, 2),
        ]
        mock_storage.get_callers_with_confidence.return_value = [(_login, 0.8)]

        result = handle_impact(mock_storage, "validate", depth=2)
        assert "Depth 1" in result
        assert "Direct callers (will break)" in result
        assert "Depth 2" in result
        assert "Indirect (may break)" in result

    def test_depth_3_transitive_label(self, mock_storage):
        _node = GraphNode(
            id="function:src/far.py:distant",
            label=NodeLabel.FUNCTION,
            name="distant",
            file_path="src/far.py",
            start_line=1,
            end_line=10,
        )
        mock_storage.traverse_with_depth.return_value = [(_node, 3)]
        mock_storage.get_callers_with_confidence.return_value = []

        result = handle_impact(mock_storage, "validate", depth=3)
        assert "Transitive (review)" in result

    def test_confidence_shown_for_direct_callers(self, mock_storage):
        _login = GraphNode(
            id="function:src/api.py:login",
            label=NodeLabel.FUNCTION,
            name="login",
            file_path="src/api.py",
            start_line=5,
            end_line=20,
        )
        mock_storage.traverse_with_depth.return_value = [(_login, 1)]
        mock_storage.get_callers_with_confidence.return_value = [(_login, 0.75)]

        result = handle_impact(mock_storage, "validate", depth=1)
        assert "confidence: 0.75" in result

    def test_depth_clamped_to_max(self, mock_storage):
        mock_storage.traverse_with_depth.return_value = []
        result = handle_impact(mock_storage, "validate", depth=100)
        assert "No upstream callers found" in result


class TestHandleCoupling:
    def test_returns_coupled_files(self, mock_storage):
        mock_storage.execute_raw.side_effect = [
            [["src/auth/session.py", 0.85, 12], ["src/tests/test_login.py", 0.72, 9]],
            [["src/auth/session.py"]],
        ]
        result = handle_coupling(mock_storage, "src/auth/login.py")
        assert "src/auth/session.py" in result
        assert "0.85" in result
        assert "src/tests/test_login.py" in result

    def test_flags_hidden_dependencies(self, mock_storage):
        mock_storage.execute_raw.side_effect = [
            [["src/tests/test_login.py", 0.72, 9]],
            [],
        ]
        result = handle_coupling(mock_storage, "src/auth/login.py")
        assert "hidden" in result.lower()

    def test_no_coupling_found(self, mock_storage):
        mock_storage.execute_raw.side_effect = [[], []]
        result = handle_coupling(mock_storage, "src/isolated.py")
        assert "No temporal coupling" in result

    def test_min_strength_filter(self, mock_storage):
        mock_storage.execute_raw.side_effect = [
            [["src/weak.py", 0.2, 2]],
            [],
        ]
        result = handle_coupling(mock_storage, "src/a.py", min_strength=0.3)
        assert "No temporal coupling" in result

    def test_empty_file_path(self, mock_storage):
        result = handle_coupling(mock_storage, "")
        assert "required" in result.lower()


class TestHandleCommunities:
    def test_list_all_communities(self, mock_storage):
        mock_storage.execute_raw.side_effect = [
            [
                ["ingestion+storage", 0.72, '{"symbol_count": 23}'],
                ["mcp+server", 0.65, '{"symbol_count": 15}'],
            ],
            [],  # Cross-community processes
        ]
        result = handle_communities(mock_storage)
        assert "ingestion+storage" in result
        assert "0.72" in result
        assert "23" in result
        assert "mcp+server" in result

    def test_drill_into_community(self, mock_storage):
        mock_storage.execute_raw.return_value = [
            ["run_pipeline", "Function", "src/pipeline.py", 45, True, False],
            ["KuzuBackend", "Class", "src/storage.py", 10, False, True],
        ]
        result = handle_communities(mock_storage, community="ingestion+storage")
        assert "run_pipeline" in result
        assert "entry point" in result.lower()
        assert "KuzuBackend" in result

    def test_no_communities(self, mock_storage):
        mock_storage.execute_raw.side_effect = [[], []]
        result = handle_communities(mock_storage)
        assert "No communities" in result

    def test_community_not_found(self, mock_storage):
        mock_storage.execute_raw.return_value = []
        result = handle_communities(mock_storage, community="nonexistent")
        assert "not found" in result.lower()


class TestHandleExplain:
    def test_basic_explanation(self, mock_storage):
        mock_storage.get_node.return_value = GraphNode(
            id="function:src/pipeline.py:run_pipeline",
            label=NodeLabel.FUNCTION,
            name="run_pipeline",
            file_path="src/pipeline.py",
            start_line=45,
            end_line=120,
            is_entry_point=True,
            is_exported=True,
        )
        mock_storage.get_callers_with_confidence.return_value = [
            (GraphNode(id="f:cli.py:main", label=NodeLabel.FUNCTION, name="main",
                       file_path="src/cli.py", start_line=1, end_line=10), 1.0),
        ]
        mock_storage.get_callees_with_confidence.return_value = [
            (GraphNode(id="f:walk.py:walk", label=NodeLabel.FUNCTION, name="walk",
                       file_path="src/walk.py", start_line=1, end_line=10), 0.9),
            (GraphNode(id="f:parse.py:parse", label=NodeLabel.FUNCTION, name="parse",
                       file_path="src/parse.py", start_line=1, end_line=10), 0.8),
        ]
        mock_storage.execute_raw.side_effect = [
            [["ingestion+storage"]],  # Community membership
            [["run → walk → parse", 1]],  # Process flows
        ]

        result = handle_explain(mock_storage, "run_pipeline")
        assert "run_pipeline" in result
        assert "Entry point" in result
        assert "Exported" in result
        assert "ingestion+storage" in result
        assert "Called by 1" in result
        assert "main" in result
        assert "Calls 2" in result

    def test_symbol_not_found(self, mock_storage):
        mock_storage.exact_name_search.return_value = []
        mock_storage.fts_search.return_value = []
        result = handle_explain(mock_storage, "nonexistent")
        assert "not found" in result.lower()

    def test_empty_symbol(self, mock_storage):
        result = handle_explain(mock_storage, "")
        assert "required" in result.lower()

    def test_dead_code_symbol(self, mock_storage):
        mock_storage.get_node.return_value = GraphNode(
            id="function:src/old.py:old_func",
            label=NodeLabel.FUNCTION,
            name="old_func",
            file_path="src/old.py",
            start_line=1,
            end_line=10,
            is_dead=True,
        )
        mock_storage.get_callers_with_confidence.return_value = []
        mock_storage.get_callees_with_confidence.return_value = []
        mock_storage.execute_raw.side_effect = [[], []]

        result = handle_explain(mock_storage, "old_func")
        assert "dead code" in result.lower() or "Dead code" in result


class TestHandleReviewRisk:
    def test_basic_risk_assessment(self, mock_storage):
        mock_storage.execute_raw.side_effect = [
            # Symbols in changed file
            [["function:src/auth.py:validate", "validate", "src/auth.py", 10, 30]],
            # Coupling for src/auth.py
            [["src/tests/test_auth.py", 0.82]],
            # Community for validate
            [["auth+security"]],
        ]
        mock_storage.get_node.return_value = GraphNode(
            id="function:src/auth.py:validate",
            label=NodeLabel.FUNCTION,
            name="validate",
            file_path="src/auth.py",
            start_line=10,
            end_line=30,
            is_entry_point=False,
        )
        mock_storage.traverse_with_depth.return_value = [
            (GraphNode(id="f:api.py:login", label=NodeLabel.FUNCTION, name="login",
                       file_path="src/api.py", start_line=5, end_line=20), 1),
        ]

        result = handle_review_risk(mock_storage, SAMPLE_DIFF)
        assert "Risk" in result
        assert "validate" in result

    def test_flags_missing_cochange_files(self, mock_storage):
        mock_storage.execute_raw.side_effect = [
            [["function:src/auth.py:validate", "validate", "src/auth.py", 10, 30]],
            [["src/tests/test_auth.py", 0.82]],
            [["auth"]],
        ]
        mock_storage.get_node.return_value = GraphNode(
            id="function:src/auth.py:validate",
            label=NodeLabel.FUNCTION,
            name="validate",
            file_path="src/auth.py",
            start_line=10,
            end_line=30,
        )
        mock_storage.traverse_with_depth.return_value = []
        result = handle_review_risk(mock_storage, SAMPLE_DIFF)
        assert "test_auth.py" in result
        assert "missing" in result.lower() or "usually change" in result.lower()

    def test_empty_diff(self, mock_storage):
        result = handle_review_risk(mock_storage, "")
        assert "Empty diff" in result

    def test_no_affected_symbols(self, mock_storage):
        mock_storage.execute_raw.side_effect = [
            [],  # No symbols in changed file
            [],  # No coupling
        ]
        result = handle_review_risk(mock_storage, SAMPLE_DIFF)
        assert "No indexed symbols" in result or "LOW" in result


class TestHandleCallPath:
    def test_direct_path(self, mock_storage):
        """Two symbols where A calls B directly."""
        _callee = GraphNode(
            id="function:src/perms.py:check_perms",
            label=NodeLabel.FUNCTION,
            name="check_perms",
            file_path="src/perms.py",
            start_line=25,
            end_line=40,
        )
        mock_storage.get_callees.return_value = [_callee]
        # Need separate fts_search results for from and to symbols
        mock_storage.fts_search.side_effect = [
            [SearchResult(node_id="function:src/auth.py:validate", score=1.0, node_name="validate")],
            [SearchResult(node_id="function:src/perms.py:check_perms", score=1.0, node_name="check_perms")],
        ]
        mock_storage.get_node.side_effect = [
            GraphNode(id="function:src/auth.py:validate", label=NodeLabel.FUNCTION,
                      name="validate", file_path="src/auth.py", start_line=10, end_line=30),
            GraphNode(id="function:src/perms.py:check_perms", label=NodeLabel.FUNCTION,
                      name="check_perms", file_path="src/perms.py", start_line=25, end_line=40),
            # get_node calls during path reconstruction
            GraphNode(id="function:src/auth.py:validate", label=NodeLabel.FUNCTION,
                      name="validate", file_path="src/auth.py", start_line=10, end_line=30),
            GraphNode(id="function:src/perms.py:check_perms", label=NodeLabel.FUNCTION,
                      name="check_perms", file_path="src/perms.py", start_line=25, end_line=40),
        ]
        result = handle_call_path(mock_storage, "validate", "check_perms")
        assert "validate" in result
        assert "check_perms" in result
        assert "1 hop" in result
        assert "→" in result

    def test_no_path_found(self, mock_storage):
        mock_storage.get_callees.return_value = []
        mock_storage.fts_search.side_effect = [
            [SearchResult(node_id="function:src/a.py:foo", score=1.0, node_name="foo")],
            [SearchResult(node_id="function:src/b.py:bar", score=1.0, node_name="bar")],
        ]
        mock_storage.get_node.side_effect = [
            GraphNode(id="function:src/a.py:foo", label=NodeLabel.FUNCTION,
                      name="foo", file_path="src/a.py", start_line=1, end_line=10),
            GraphNode(id="function:src/b.py:bar", label=NodeLabel.FUNCTION,
                      name="bar", file_path="src/b.py", start_line=1, end_line=10),
        ]
        result = handle_call_path(mock_storage, "foo", "bar")
        assert "No call path found" in result

    def test_same_symbol(self, mock_storage):
        mock_storage.fts_search.return_value = [
            SearchResult(node_id="function:src/a.py:foo", score=1.0, node_name="foo"),
        ]
        mock_storage.get_node.return_value = GraphNode(
            id="function:src/a.py:foo", label=NodeLabel.FUNCTION,
            name="foo", file_path="src/a.py", start_line=1, end_line=10,
        )
        result = handle_call_path(mock_storage, "foo", "foo")
        assert "same symbol" in result.lower()

    def test_empty_from_symbol(self, mock_storage):
        result = handle_call_path(mock_storage, "", "bar")
        assert "required" in result.lower()

    def test_empty_to_symbol(self, mock_storage):
        result = handle_call_path(mock_storage, "foo", "")
        assert "required" in result.lower()

    def test_source_not_found(self, mock_storage):
        mock_storage.exact_name_search.return_value = []
        mock_storage.fts_search.side_effect = [
            [],  # from_symbol not found
        ]
        result = handle_call_path(mock_storage, "nonexistent", "bar")
        assert "not found" in result.lower()


class TestHandleFileContext:
    def test_full_file_context(self, mock_storage):
        mock_storage.execute_raw.side_effect = [
            # Symbols
            [
                ["handle_query", "Function", 170, False, True, False],
                ["handle_context", "Function", 197, False, False, False],
            ],
            # Imports out
            [["src/storage/base.py"], ["src/search/hybrid.py"]],
            # Imported by
            [["src/mcp/server.py"]],
            # Coupling
            [["tests/mcp/test_tools.py", 0.85, 12]],
            # Dead code
            [],
            # Communities
            [["mcp+server", 2]],
        ]
        result = handle_file_context(mock_storage, "src/mcp/tools.py")
        assert "src/mcp/tools.py" in result
        assert "handle_query" in result
        assert "entry point" in result.lower()
        assert "Imports (2)" in result
        assert "Imported by (1)" in result
        assert "test_tools.py" in result
        assert "0.85" in result
        assert "mcp+server" in result

    def test_empty_file(self, mock_storage):
        mock_storage.execute_raw.side_effect = [[], [], [], [], [], []]
        result = handle_file_context(mock_storage, "src/empty.py")
        assert "No data found" in result

    def test_file_with_dead_code(self, mock_storage):
        mock_storage.execute_raw.side_effect = [
            [["old_func", "Function", 45, True, False, False]],
            [], [], [],
            [["old_func", 45, "Function"]],
            [],
        ]
        result = handle_file_context(mock_storage, "src/old.py")
        assert "Dead code" in result
        assert "old_func" in result

    def test_empty_file_path(self, mock_storage):
        result = handle_file_context(mock_storage, "")
        assert "required" in result.lower()


class TestHandleTestImpact:
    def test_finds_test_callers_via_diff(self, mock_storage):
        # Changed symbol in diff
        mock_storage.execute_raw.return_value = [
            ["function:src/auth.py:validate", "validate", 10, 30],
        ]
        # Test function that calls validate
        _test_caller = GraphNode(
            id="function:tests/test_auth.py:test_validate",
            label=NodeLabel.FUNCTION,
            name="test_validate",
            file_path="tests/test_auth.py",
            start_line=5,
            end_line=15,
        )
        mock_storage.traverse_with_depth.return_value = [(_test_caller, 1)]

        result = handle_test_impact(mock_storage, diff=SAMPLE_DIFF)
        assert "test_validate" in result
        assert "tests/test_auth.py" in result
        assert "validate" in result

    def test_finds_test_callers_via_symbols(self, mock_storage):
        _test_caller = GraphNode(
            id="function:tests/test_auth.py:test_validate",
            label=NodeLabel.FUNCTION,
            name="test_validate",
            file_path="tests/test_auth.py",
            start_line=5,
            end_line=15,
        )
        mock_storage.traverse_with_depth.return_value = [(_test_caller, 1)]

        result = handle_test_impact(mock_storage, symbols=["validate"])
        assert "test_validate" in result
        assert "tests/test_auth.py" in result

    def test_no_tests_found(self, mock_storage):
        mock_storage.execute_raw.return_value = [
            ["function:src/auth.py:validate", "validate", 10, 30],
        ]
        # Non-test caller
        _caller = GraphNode(
            id="function:src/api.py:login",
            label=NodeLabel.FUNCTION,
            name="login",
            file_path="src/api.py",
            start_line=5,
            end_line=20,
        )
        mock_storage.traverse_with_depth.return_value = [(_caller, 1)]

        result = handle_test_impact(mock_storage, diff=SAMPLE_DIFF)
        assert "No test files found" in result

    def test_no_params(self, mock_storage):
        result = handle_test_impact(mock_storage)
        assert "provide either" in result.lower()

    def test_transitive_test(self, mock_storage):
        mock_storage.execute_raw.return_value = [
            ["function:src/auth.py:validate", "validate", 10, 30],
        ]
        _test_caller = GraphNode(
            id="function:tests/e2e/test_full.py:test_e2e",
            label=NodeLabel.FUNCTION,
            name="test_e2e",
            file_path="tests/e2e/test_full.py",
            start_line=5,
            end_line=15,
        )
        mock_storage.traverse_with_depth.return_value = [(_test_caller, 3)]

        result = handle_test_impact(mock_storage, diff=SAMPLE_DIFF)
        assert "indirect" in result.lower() or "transitive" in result.lower()
        assert "test_e2e" in result


class TestHandleCycles:
    def test_no_cycles(self, mock_storage):
        """Graph with no cycles returns clean message."""
        kg = KnowledgeGraph()
        # Add 3 nodes with no cycles: A -> B -> C
        a = GraphNode(id="function:a.py:a", label=NodeLabel.FUNCTION, name="a",
                      file_path="a.py", start_line=1, end_line=5)
        b = GraphNode(id="function:b.py:b", label=NodeLabel.FUNCTION, name="b",
                      file_path="b.py", start_line=1, end_line=5)
        c = GraphNode(id="function:c.py:c", label=NodeLabel.FUNCTION, name="c",
                      file_path="c.py", start_line=1, end_line=5)
        kg.add_node(a)
        kg.add_node(b)
        kg.add_node(c)
        kg.add_relationship(GraphRelationship(
            id="r1", type=RelType.CALLS, source=a.id, target=b.id))
        kg.add_relationship(GraphRelationship(
            id="r2", type=RelType.CALLS, source=b.id, target=c.id))

        mock_storage.load_graph.return_value = kg

        result = handle_cycles(mock_storage)
        assert "No circular dependencies" in result

    def test_detects_cycle(self, mock_storage):
        """Graph with A -> B -> A cycle is detected."""
        kg = KnowledgeGraph()
        a = GraphNode(id="function:a.py:a", label=NodeLabel.FUNCTION, name="a",
                      file_path="a.py", start_line=1, end_line=5)
        b = GraphNode(id="function:b.py:b", label=NodeLabel.FUNCTION, name="b",
                      file_path="b.py", start_line=1, end_line=5)
        kg.add_node(a)
        kg.add_node(b)
        kg.add_relationship(GraphRelationship(
            id="r1", type=RelType.CALLS, source=a.id, target=b.id))
        kg.add_relationship(GraphRelationship(
            id="r2", type=RelType.CALLS, source=b.id, target=a.id))

        mock_storage.load_graph.return_value = kg

        result = handle_cycles(mock_storage)
        assert "Circular Dependencies" in result
        assert "1 groups" in result or "Cycle 1" in result
        assert "a" in result
        assert "b" in result

    def test_critical_large_cycle(self, mock_storage):
        """Cycles with 5+ symbols are marked CRITICAL."""
        kg = KnowledgeGraph()
        nodes = []
        for i in range(5):
            n = GraphNode(id=f"function:{i}.py:f{i}", label=NodeLabel.FUNCTION,
                          name=f"f{i}", file_path=f"{i}.py", start_line=1, end_line=5)
            kg.add_node(n)
            nodes.append(n)
        # Create cycle: f0 -> f1 -> f2 -> f3 -> f4 -> f0
        for i in range(5):
            kg.add_relationship(GraphRelationship(
                id=f"r{i}", type=RelType.CALLS,
                source=nodes[i].id, target=nodes[(i + 1) % 5].id))

        mock_storage.load_graph.return_value = kg

        result = handle_cycles(mock_storage)
        assert "CRITICAL" in result

    def test_load_graph_error(self, mock_storage):
        mock_storage.load_graph.side_effect = RuntimeError("DB error")
        result = handle_cycles(mock_storage)
        assert "Error loading graph" in result

    def test_empty_graph(self, mock_storage):
        kg = KnowledgeGraph()
        mock_storage.load_graph.return_value = kg
        result = handle_cycles(mock_storage)
        assert "No symbols" in result
