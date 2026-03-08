"""Shared symbol lookup utilities for ingestion phases.

Provides line-based containment lookups using a pre-built per-file
interval index.
"""

from __future__ import annotations

from collections import defaultdict

from axon.core.graph.graph import KnowledgeGraph
from axon.core.graph.model import NodeLabel


def build_name_index(
    graph: KnowledgeGraph,
    labels: tuple[NodeLabel, ...],
) -> dict[str, list[str]]:
    """Return a mapping from symbol name to list of node IDs across the given labels."""
    index: dict[str, list[str]] = {}
    for label in labels:
        for node in graph.get_nodes_by_label(label):
            index.setdefault(node.name, []).append(node.id)
    return index


class FileSymbolIndex:
    """Pre-built per-file interval index for containment lookups.

    Stores ``(start_line, end_line, span, node_id)`` tuples sorted by
    ``start_line``.  Lookups scan all entries for a file to find the
    narrowest containing span (typically <200 symbols per file).
    """

    __slots__ = ("_entries",)

    def __init__(
        self,
        entries: dict[str, list[tuple[int, int, int, str]]],
    ) -> None:
        self._entries = entries

    def get_entries(self, file_path: str) -> list[tuple[int, int, int, str]] | None:
        return self._entries.get(file_path)

def build_file_symbol_index(
    graph: KnowledgeGraph,
    labels: tuple[NodeLabel, ...],
) -> FileSymbolIndex:
    """Build a per-file sorted interval index for containment lookups."""
    entries: dict[str, list[tuple[int, int, int, str]]] = defaultdict(list)

    for label in labels:
        for node in graph.get_nodes_by_label(label):
            if node.file_path and node.start_line > 0:
                span = node.end_line - node.start_line
                entries[node.file_path].append(
                    (node.start_line, node.end_line, span, node.id)
                )

    for file_entries in entries.values():
        file_entries.sort(key=lambda t: t[0])

    return FileSymbolIndex(entries)

def find_containing_symbol(
    line: int,
    file_path: str,
    file_symbol_index: FileSymbolIndex,
) -> str | None:
    """Return the node ID of the narrowest symbol containing *line*, or None."""
    entries = file_symbol_index.get_entries(file_path)
    if not entries:
        return None

    best_id: str | None = None
    best_span = float("inf")

    for start, end, span, nid in entries:
        if start <= line <= end and span < best_span:
            best_span = span
            best_id = nid

    return best_id
