from __future__ import annotations

from pathlib import Path

import pytest

from axon.core.graph.graph import KnowledgeGraph
from axon.core.graph.model import GraphNode, NodeLabel, RelType, generate_id
from axon.core.ingestion.coupling import (
    build_cochange_matrix,
    calculate_coupling,
    process_coupling,
)


@pytest.fixture()
def graph() -> KnowledgeGraph:
    """Return a KnowledgeGraph pre-populated with File nodes.

    Layout:
    - File:src/auth.py
    - File:src/models.py
    - File:src/views.py
    - File:src/utils.py
    """
    g = KnowledgeGraph()

    for path in ("src/auth.py", "src/models.py", "src/views.py", "src/utils.py"):
        g.add_node(
            GraphNode(
                id=generate_id(NodeLabel.FILE, path),
                label=NodeLabel.FILE,
                name=path.split("/")[-1],
                file_path=path,
            )
        )

    return g

class TestBuildCochangeMatrix:
    def test_build_cochange_matrix(self) -> None:
        commits = [
            ["src/auth.py", "src/models.py"],
            ["src/auth.py", "src/models.py"],
            ["src/auth.py", "src/models.py"],
            ["src/views.py", "src/utils.py"],
        ]
        matrix, total = build_cochange_matrix(commits, min_cochanges=1)

        pair = ("src/auth.py", "src/models.py")
        assert pair in matrix
        assert matrix[pair] == 3

        pair_vu = ("src/utils.py", "src/views.py")
        assert pair_vu in matrix
        assert matrix[pair_vu] == 1

        assert total["src/auth.py"] == 3
        assert total["src/models.py"] == 3
        assert total["src/views.py"] == 1

    def test_build_cochange_matrix_min_threshold(self) -> None:
        commits = [
            ["src/auth.py", "src/models.py"],
            ["src/auth.py", "src/models.py"],
            ["src/auth.py", "src/models.py"],
            ["src/views.py", "src/utils.py"],
        ]
        matrix, _ = build_cochange_matrix(commits, min_cochanges=3)

        # auth+models has 3 co-changes, should be included.
        assert ("src/auth.py", "src/models.py") in matrix

        # views+utils has only 1, should be filtered.
        assert ("src/utils.py", "src/views.py") not in matrix

    def test_build_cochange_matrix_empty(self) -> None:
        matrix, total = build_cochange_matrix([], min_cochanges=1)
        assert matrix == {}
        assert total == {}

class TestCalculateCoupling:
    def test_calculate_coupling(self) -> None:
        total_changes = {"src/auth.py": 10, "src/models.py": 5}
        strength = calculate_coupling(
            "src/auth.py", "src/models.py", co_changes=5, total_changes=total_changes
        )
        # 5 / max(10, 5) = 5 / 10 = 0.5
        assert strength == pytest.approx(0.5)

    def test_calculate_coupling_equal_changes(self) -> None:
        total_changes = {"src/auth.py": 8, "src/models.py": 8}
        strength = calculate_coupling(
            "src/auth.py", "src/models.py", co_changes=6, total_changes=total_changes
        )
        # 6 / max(8, 8) = 6 / 8 = 0.75
        assert strength == pytest.approx(0.75)

    def test_calculate_coupling_zero_total_changes(self) -> None:
        total_changes = {"src/auth.py": 0, "src/models.py": 0}
        strength = calculate_coupling(
            "src/auth.py", "src/models.py", co_changes=0, total_changes=total_changes
        )
        assert strength == 0.0

class TestProcessCoupling:
    def test_process_coupling_creates_relationships(
        self, graph: KnowledgeGraph
    ) -> None:
        # auth.py and models.py change together 4 times out of 5 commits each.
        # views.py and utils.py change together only once.
        commits = [
            ["src/auth.py", "src/models.py"],
            ["src/auth.py", "src/models.py"],
            ["src/auth.py", "src/models.py"],
            ["src/auth.py", "src/models.py"],
            ["src/auth.py"],
            ["src/models.py"],
            ["src/views.py", "src/utils.py"],
        ]

        count = process_coupling(
            graph,
            Path("/fake/repo"),
            min_strength=0.3,
            commits=commits,
            min_cochanges=1,
        )

        # auth+models: coupling = 4 / max(5, 5) = 0.8 >= 0.3 -> created
        # views+utils: coupling = 1 / max(1, 1) = 1.0 >= 0.3 -> created
        assert count == 2

        coupled_rels = graph.get_relationships_by_type(RelType.COUPLED_WITH)
        assert len(coupled_rels) == 2

        # Verify properties on the auth+models relationship.
        auth_id = generate_id(NodeLabel.FILE, "src/auth.py")
        models_id = generate_id(NodeLabel.FILE, "src/models.py")

        auth_models_rel = next(
            (
                r
                for r in coupled_rels
                if r.source == auth_id and r.target == models_id
            ),
            None,
        )
        assert auth_models_rel is not None
        assert auth_models_rel.properties["strength"] == pytest.approx(0.8)
        assert auth_models_rel.properties["co_changes"] == 4

    def test_process_coupling_no_git(self, graph: KnowledgeGraph) -> None:
        count = process_coupling(
            graph,
            Path("/nonexistent/repo"),
            min_strength=0.3,
            commits=[],
        )
        assert count == 0

        coupled_rels = graph.get_relationships_by_type(RelType.COUPLED_WITH)
        assert len(coupled_rels) == 0

    def test_process_coupling_filters_weak_pairs(
        self, graph: KnowledgeGraph
    ) -> None:
        # auth changes 10 times, models 10 times, but they co-change only twice.
        # coupling = 2/10 = 0.2 which is below min_strength=0.3
        commits = [
            ["src/auth.py", "src/models.py"],
            ["src/auth.py", "src/models.py"],
            ["src/auth.py"],
            ["src/auth.py"],
            ["src/auth.py"],
            ["src/auth.py"],
            ["src/auth.py"],
            ["src/auth.py"],
            ["src/models.py"],
            ["src/models.py"],
            ["src/models.py"],
            ["src/models.py"],
            ["src/models.py"],
            ["src/models.py"],
        ]

        count = process_coupling(
            graph,
            Path("/fake/repo"),
            min_strength=0.3,
            commits=commits,
        )
        assert count == 0

    def test_process_coupling_relationship_id_format(
        self, graph: KnowledgeGraph
    ) -> None:
        commits = [
            ["src/auth.py", "src/models.py"],
            ["src/auth.py", "src/models.py"],
            ["src/auth.py", "src/models.py"],
        ]

        process_coupling(
            graph,
            Path("/fake/repo"),
            min_strength=0.3,
            commits=commits,
        )

        coupled_rels = graph.get_relationships_by_type(RelType.COUPLED_WITH)
        assert len(coupled_rels) >= 1

        for rel in coupled_rels:
            assert rel.id.startswith("coupled:")
            assert "->" in rel.id
