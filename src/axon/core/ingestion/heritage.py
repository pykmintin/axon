"""Phase 6: Heritage extraction — creates EXTENDS / IMPLEMENTS edges."""

from __future__ import annotations

import logging
import os
from concurrent.futures import ThreadPoolExecutor

from axon.core.graph.graph import KnowledgeGraph
from axon.core.graph.model import (
    GraphRelationship,
    NodeLabel,
    RelType,
)
from axon.core.ingestion.parser_phase import FileParseData
from axon.core.ingestion.resolved import NodePropertyPatch, ResolvedEdge
from axon.core.ingestion.symbol_lookup import build_name_index

logger = logging.getLogger(__name__)

_HERITAGE_LABELS: tuple[NodeLabel, ...] = (NodeLabel.CLASS, NodeLabel.INTERFACE)

_KIND_TO_REL: dict[str, RelType] = {
    "extends": RelType.EXTENDS,
    "implements": RelType.IMPLEMENTS,
}

_PROTOCOL_MARKERS: frozenset[str] = frozenset({"Protocol", "ABC", "ABCMeta"})

def _resolve_node(
    name: str,
    file_path: str,
    symbol_index: dict[str, list[str]],
    graph: KnowledgeGraph,
) -> str | None:
    """Resolve a symbol name to a node ID, preferring same-file matches."""
    candidate_ids = symbol_index.get(name)
    if not candidate_ids:
        return None

    for nid in candidate_ids:
        node = graph.get_node(nid)
        if node is not None and node.file_path == file_path:
            return nid

    return candidate_ids[0]

def resolve_file_heritage(
    fpd: FileParseData,
    symbol_index: dict[str, list[str]],
    graph: KnowledgeGraph,
) -> tuple[list[ResolvedEdge], list[NodePropertyPatch]]:
    """Resolve heritage relationships for a single file. Pure read, no graph mutation."""
    edges: list[ResolvedEdge] = []
    patches: list[NodePropertyPatch] = []

    for class_name, kind, parent_name in fpd.parse_result.heritage:
        rel_type = _KIND_TO_REL.get(kind)
        if rel_type is None:
            logger.warning(
                "Unknown heritage kind %r for %s in %s, skipping",
                kind,
                class_name,
                fpd.file_path,
            )
            continue

        child_id = _resolve_node(
            class_name, fpd.file_path, symbol_index, graph
        )
        parent_id = _resolve_node(
            parent_name, fpd.file_path, symbol_index, graph
        )

        if child_id is None:
            logger.debug(
                "Skipping heritage %s %s %s in %s: unresolved child",
                class_name,
                kind,
                parent_name,
                fpd.file_path,
            )
            continue

        if parent_id is None:
            if parent_name in _PROTOCOL_MARKERS:
                patches.append(NodePropertyPatch(
                    node_id=child_id,
                    key="is_protocol",
                    value=True,
                ))
                logger.debug(
                    "Annotated %s as protocol in %s (parent: %s)",
                    class_name,
                    fpd.file_path,
                    parent_name,
                )
            else:
                logger.debug(
                    "Skipping heritage %s %s %s in %s: unresolved parent",
                    class_name,
                    kind,
                    parent_name,
                    fpd.file_path,
                )
            continue

        rel_id = f"{kind}:{child_id}->{parent_id}"
        edges.append(ResolvedEdge(
            rel_id=rel_id,
            rel_type=rel_type,
            source=child_id,
            target=parent_id,
        ))

    return edges, patches


def process_heritage(
    parse_data: list[FileParseData],
    graph: KnowledgeGraph,
    name_index: dict[str, list[str]] | None = None,
    *,
    parallel: bool = False,
    collect: bool = False,
) -> tuple[list[ResolvedEdge], list[NodePropertyPatch]] | None:
    """Create EXTENDS and IMPLEMENTS relationships from heritage tuples.

    For each ``(class_name, kind, parent_name)`` tuple in the parse results:

    * Resolve *class_name* and *parent_name* to existing graph nodes,
      preferring nodes defined in the same file.
    * If both nodes are found, add a relationship of the appropriate type.
    * If either node cannot be resolved (e.g. an external parent class),
      the tuple is silently skipped.

    Args:
        parse_data: File parse results produced by the parser phase.
        graph: The knowledge graph to populate with heritage relationships.
        parallel: When ``True``, resolve files in parallel using threads.
        collect: When ``True``, return flat list of edges instead of writing.
    """
    symbol_index = name_index if name_index is not None else build_name_index(graph, _HERITAGE_LABELS)

    if parallel:
        workers = min(os.cpu_count() or 4, 8, len(parse_data))
        with ThreadPoolExecutor(max_workers=workers) as pool:
            all_results = list(pool.map(
                lambda fpd: resolve_file_heritage(fpd, symbol_index, graph),
                parse_data,
            ))
    else:
        all_results = [resolve_file_heritage(fpd, symbol_index, graph) for fpd in parse_data]

    flat_edges = [edge for edges, _ in all_results for edge in edges]
    flat_patches = [patch for _, patches in all_results for patch in patches]

    if collect:
        return flat_edges, flat_patches

    for patch in flat_patches:
        node = graph.get_node(patch.node_id)
        if node is not None:
            node.properties[patch.key] = patch.value

    written: set[str] = set()
    for edge in flat_edges:
        if edge.rel_id in written:
            continue
        written.add(edge.rel_id)
        graph.add_relationship(
            GraphRelationship(
                id=edge.rel_id,
                type=edge.rel_type,
                source=edge.source,
                target=edge.target,
                properties=edge.properties,
            )
        )
    return None
