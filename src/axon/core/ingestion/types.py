"""Phase 7: Type analysis for Axon.

Takes FileParseData from the parser phase and resolves type annotation
references to their corresponding Class, Interface, or TypeAlias nodes,
creating USES_TYPE relationships from Function/Method nodes to the resolved
type nodes.
"""

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
from axon.core.ingestion.resolved import ResolvedEdge
from axon.core.ingestion.symbol_lookup import (
    FileSymbolIndex,
    build_file_symbol_index,
    build_name_index,
    find_containing_symbol,
)

logger = logging.getLogger(__name__)

_TYPE_LABELS: tuple[NodeLabel, ...] = (
    NodeLabel.CLASS,
    NodeLabel.INTERFACE,
    NodeLabel.TYPE_ALIAS,
)

_CONTAINER_LABELS: tuple[NodeLabel, ...] = (
    NodeLabel.FUNCTION,
    NodeLabel.METHOD,
)

def _resolve_type(
    type_name: str,
    file_path: str,
    type_index: dict[str, list[str]],
    graph: KnowledgeGraph,
) -> str | None:
    candidate_ids = type_index.get(type_name, [])
    if not candidate_ids:
        return None

    for nid in candidate_ids:
        node = graph.get_node(nid)
        if node is not None and node.file_path == file_path:
            return nid

    return candidate_ids[0]

def resolve_file_types(
    fpd: FileParseData,
    type_index: dict[str, list[str]],
    file_sym_index: FileSymbolIndex,
    graph: KnowledgeGraph,
) -> list[ResolvedEdge]:
    """Resolve type references for a single file — pure read, no graph mutation.

    Returns one :class:`ResolvedEdge` per unique ``(source, target, role)``
    triple.  Per-file dedup via a local ``seen`` set.
    """
    seen: set[str] = set()
    edges: list[ResolvedEdge] = []

    for type_ref in fpd.parse_result.type_refs:
        source_id = find_containing_symbol(
            type_ref.line, fpd.file_path, file_sym_index
        )
        if source_id is None:
            continue

        target_id = _resolve_type(
            type_ref.name, fpd.file_path, type_index, graph
        )
        if target_id is None:
            continue

        role = type_ref.kind
        rel_id = f"uses_type:{source_id}->{target_id}:{role}"
        if rel_id in seen:
            continue
        seen.add(rel_id)

        edges.append(ResolvedEdge(
            rel_id=rel_id,
            rel_type=RelType.USES_TYPE,
            source=source_id,
            target=target_id,
            properties={"role": role},
        ))
    return edges


def process_types(
    parse_data: list[FileParseData],
    graph: KnowledgeGraph,
    name_index: dict[str, list[str]] | None = None,
    *,
    parallel: bool = False,
    collect: bool = False,
) -> list[ResolvedEdge] | None:
    """Resolve type references and create USES_TYPE relationships in the graph.

    Args:
        parse_data: File parse results from the parser phase.
        graph: The knowledge graph to populate with USES_TYPE relationships.
        parallel: When ``True``, resolve files in parallel using threads.
        collect: When ``True``, return flat list of edges instead of writing.
    """
    type_index = name_index if name_index is not None else build_name_index(graph, _TYPE_LABELS)
    file_sym_index = build_file_symbol_index(graph, _CONTAINER_LABELS)

    if parallel:
        workers = min(os.cpu_count() or 4, 8, len(parse_data))
        with ThreadPoolExecutor(max_workers=workers) as pool:
            all_edges = list(pool.map(
                lambda fpd: resolve_file_types(fpd, type_index, file_sym_index, graph),
                parse_data,
            ))
    else:
        all_edges = [resolve_file_types(fpd, type_index, file_sym_index, graph) for fpd in parse_data]

    flat = [edge for file_edges in all_edges for edge in file_edges]

    if collect:
        return flat

    written: set[str] = set()
    for edge in flat:
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
