"""In-memory knowledge graph for Axon.

Provides a lightweight, dict-backed graph that stores :class:`GraphNode` and
:class:`GraphRelationship` instances with O(1) lookups by ID.  Secondary
indexes on label, relationship type, and adjacency lists ensure that queries
scale linearly with the *result* set rather than the total graph size.
"""

from __future__ import annotations

from collections import defaultdict
from collections.abc import Iterator

from axon.core.graph.model import GraphNode, GraphRelationship, NodeLabel, RelType


class KnowledgeGraph:
    """An in-memory directed graph of code-level entities and their relationships.

    Nodes are keyed by their ``id`` string; relationships are keyed likewise.
    Removing a node cascades to any relationship where the node appears as
    ``source`` or ``target``.

    All query methods are backed by secondary indexes so that look-ups by
    label, relationship type, or adjacency are O(result) rather than O(graph).
    """

    def __init__(self) -> None:
        self._nodes: dict[str, GraphNode] = {}
        self._relationships: dict[str, GraphRelationship] = {}

        self._by_label: dict[NodeLabel, dict[str, GraphNode]] = defaultdict(dict)
        self._by_rel_type: dict[RelType, dict[str, GraphRelationship]] = defaultdict(dict)
        self._outgoing: dict[str, dict[str, GraphRelationship]] = defaultdict(dict)
        self._incoming: dict[str, dict[str, GraphRelationship]] = defaultdict(dict)
        self._incoming_by_type: dict[str, dict[RelType, set[str]]] = defaultdict(
            lambda: defaultdict(set)
        )

    def iter_nodes(self) -> Iterator[GraphNode]:
        return iter(self._nodes.values())

    def iter_relationships(self) -> Iterator[GraphRelationship]:
        return iter(self._relationships.values())

    @property
    def node_count(self) -> int:
        return len(self._nodes)

    @property
    def relationship_count(self) -> int:
        return len(self._relationships)

    def count_nodes_by_label(self, label: NodeLabel) -> int:
        return len(self._by_label.get(label, {}))

    def has_incoming(self, node_id: str, rel_type: RelType) -> bool:
        return bool(self._incoming_by_type.get(node_id, {}).get(rel_type))

    def add_node(self, node: GraphNode) -> None:
        old = self._nodes.get(node.id)
        if old is not None and old.label != node.label:
            self._by_label[old.label].pop(node.id, None)
        self._nodes[node.id] = node
        self._by_label[node.label][node.id] = node

    def get_node(self, node_id: str) -> GraphNode | None:
        return self._nodes.get(node_id)

    def remove_node(self, node_id: str) -> bool:
        """Remove a node and cascade-delete all relationships that reference it."""
        node = self._nodes.pop(node_id, None)
        if node is None:
            return False

        self._by_label[node.label].pop(node_id, None)
        self._cascade_relationships_for_node(node_id)
        return True

    def remove_nodes_by_file(self, file_path: str) -> int:
        """Remove every node whose file_path matches and cascade relationships."""
        ids_to_remove = [
            nid for nid, node in self._nodes.items() if node.file_path == file_path
        ]
        if not ids_to_remove:
            return 0

        for nid in ids_to_remove:
            node = self._nodes.pop(nid)
            self._by_label[node.label].pop(nid, None)

        for nid in ids_to_remove:
            self._cascade_relationships_for_node(nid)
        return len(ids_to_remove)

    def add_relationship(self, rel: GraphRelationship) -> None:
        old = self._relationships.get(rel.id)
        if old is not None:
            self._by_rel_type[old.type].pop(rel.id, None)
            self._outgoing[old.source].pop(rel.id, None)
            self._incoming[old.target].pop(rel.id, None)
            self._incoming_by_type[old.target][old.type].discard(rel.id)
        self._relationships[rel.id] = rel
        self._by_rel_type[rel.type][rel.id] = rel
        self._outgoing[rel.source][rel.id] = rel
        self._incoming[rel.target][rel.id] = rel
        self._incoming_by_type[rel.target][rel.type].add(rel.id)

    def get_nodes_by_label(self, label: NodeLabel) -> list[GraphNode]:
        """Return all nodes whose label matches *label*."""
        return list(self._by_label.get(label, {}).values())

    def get_relationships_by_type(self, rel_type: RelType) -> list[GraphRelationship]:
        """Return all relationships whose type matches *rel_type*."""
        return list(self._by_rel_type.get(rel_type, {}).values())

    def get_outgoing(
        self, node_id: str, rel_type: RelType | None = None
    ) -> list[GraphRelationship]:
        """Return relationships originating from *node_id*.

        If *rel_type* is given, only relationships of that type are returned.
        """
        rels = self._outgoing.get(node_id, {})
        if rel_type is None:
            return list(rels.values())
        return [r for r in rels.values() if r.type == rel_type]

    def get_incoming(
        self, node_id: str, rel_type: RelType | None = None
    ) -> list[GraphRelationship]:
        """Return relationships targeting *node_id*.

        If *rel_type* is given, only relationships of that type are returned.
        """
        rels = self._incoming.get(node_id, {})
        if rel_type is None:
            return list(rels.values())
        return [r for r in rels.values() if r.type == rel_type]

    def stats(self) -> dict[str, int]:
        return {"nodes": len(self._nodes), "relationships": len(self._relationships)}

    def _cascade_relationships_for_node(self, node_id: str) -> None:
        out_rels = list(self._outgoing.pop(node_id, {}).values())
        for rel in out_rels:
            self._relationships.pop(rel.id, None)
            self._by_rel_type.get(rel.type, {}).pop(rel.id, None)
            self._incoming.get(rel.target, {}).pop(rel.id, None)
            ibt = self._incoming_by_type.get(rel.target, {}).get(rel.type)
            if ibt is not None:
                ibt.discard(rel.id)

        in_rels = list(self._incoming.pop(node_id, {}).values())
        self._incoming_by_type.pop(node_id, None)
        for rel in in_rels:
            self._relationships.pop(rel.id, None)
            self._by_rel_type.get(rel.type, {}).pop(rel.id, None)
            self._outgoing.get(rel.source, {}).pop(rel.id, None)

