"""Phase 4: Import resolution for Axon.

Takes the FileParseData produced by the parsing phase and resolves import
statements to actual File nodes in the knowledge graph, creating IMPORTS
relationships between the importing file and the target file.
"""

from __future__ import annotations

import logging
import os
from concurrent.futures import ThreadPoolExecutor
from pathlib import PurePosixPath

from axon.core.graph.graph import KnowledgeGraph
from axon.core.graph.model import (
    GraphRelationship,
    NodeLabel,
    RelType,
    generate_id,
)
from axon.core.ingestion.parser_phase import FileParseData
from axon.core.ingestion.resolved import ResolvedEdge
from axon.core.parsers.base import ImportInfo

logger = logging.getLogger(__name__)

_JS_TS_EXTENSIONS = (".ts", ".js", ".tsx", ".jsx")

def build_file_index(graph: KnowledgeGraph) -> dict[str, str]:
    """Return a mapping of file paths to graph node IDs for all File nodes."""
    file_nodes = graph.get_nodes_by_label(NodeLabel.FILE)
    return {node.file_path: node.id for node in file_nodes}

def _detect_source_roots(file_index: dict[str, str]) -> set[str]:
    """Detect Python source root directories (e.g. ``src/``) from the file index.

    A source root is a directory whose children have ``__init__.py`` but the
    directory itself does not, indicating a ``src/`` layout.
    """
    init_dirs: set[str] = set()
    for path in file_index:
        if path.endswith("/__init__.py"):
            init_dirs.add(str(PurePosixPath(path).parent))

    roots: set[str] = set()
    for d in init_dirs:
        parent = str(PurePosixPath(d).parent)
        if parent != "." and parent not in init_dirs:
            roots.add(parent)
    return roots


def resolve_import_path(
    importing_file: str,
    import_info: ImportInfo,
    file_index: dict[str, str],
    source_roots: set[str] | None = None,
) -> str | None:
    """Resolve an import statement to a file node ID, or ``None`` for external imports."""
    language = _detect_language(importing_file)

    if language == "python":
        return _resolve_python(importing_file, import_info, file_index, source_roots)
    if language in ("typescript", "javascript"):
        return _resolve_js_ts(importing_file, import_info, file_index)

    return None

def resolve_file_imports(
    fpd: FileParseData,
    file_index: dict[str, str],
    source_roots: set[str],
) -> list[ResolvedEdge]:
    """Resolve imports for a single file — pure read, no graph mutation.

    Returns one :class:`ResolvedEdge` per unique ``(source, target)`` pair
    with per-file merged symbols.  Cross-file symbol merging happens in the
    caller.
    """
    source_file_id = generate_id(NodeLabel.FILE, fpd.file_path)
    pair_symbols: dict[str, set[str]] = {}

    for imp in fpd.parse_result.imports:
        target_id = resolve_import_path(fpd.file_path, imp, file_index, source_roots)
        if target_id is None:
            continue
        if target_id not in pair_symbols:
            pair_symbols[target_id] = set()
        pair_symbols[target_id].update(imp.names)

    edges: list[ResolvedEdge] = []
    for target_id, symbols in pair_symbols.items():
        rel_id = f"imports:{source_file_id}->{target_id}"
        edges.append(ResolvedEdge(
            rel_id=rel_id,
            rel_type=RelType.IMPORTS,
            source=source_file_id,
            target=target_id,
            properties={"symbols": symbols},
        ))
    return edges


def _write_import_edges(
    all_edges: list[list[ResolvedEdge]],
    graph: KnowledgeGraph,
) -> None:
    """Merge cross-file symbol sets and write IMPORTS edges to the graph."""
    merged: dict[str, tuple[str, str, set[str]]] = {}
    for file_edges in all_edges:
        for edge in file_edges:
            if edge.rel_id in merged:
                merged[edge.rel_id][2].update(edge.properties["symbols"])
            else:
                merged[edge.rel_id] = (edge.source, edge.target, set(edge.properties["symbols"]))

    for rel_id, (source, target, symbols) in merged.items():
        graph.add_relationship(
            GraphRelationship(
                id=rel_id,
                type=RelType.IMPORTS,
                source=source,
                target=target,
                properties={"symbols": ",".join(sorted(symbols))},
            )
        )


def process_imports(
    parse_data: list[FileParseData],
    graph: KnowledgeGraph,
    *,
    parallel: bool = False,
    collect: bool = False,
    file_index: dict[str, str] | None = None,
) -> list[ResolvedEdge] | None:
    """Resolve imports and create IMPORTS relationships in the graph.

    For each file's parsed imports, resolves the target file and creates
    an ``IMPORTS`` relationship from the importing file node to the target
    file node.  Duplicate edges (same source -> same target) are skipped.

    Args:
        parse_data: Parse results from the parsing phase.
        graph: The knowledge graph to populate with IMPORTS relationships.
        parallel: When ``True``, resolve files in parallel using threads.
        collect: When ``True``, return flat list of edges instead of writing.
        file_index: Optional pre-built ``{file_path: node_id}`` mapping.
            When ``None``, built from the graph's File nodes.
    """
    if file_index is None:
        file_index = build_file_index(graph)
    source_roots = _detect_source_roots(file_index)

    if parallel:
        workers = min(os.cpu_count() or 4, 8, len(parse_data))
        with ThreadPoolExecutor(max_workers=workers) as pool:
            all_edges = list(pool.map(
                lambda fpd: resolve_file_imports(fpd, file_index, source_roots),
                parse_data,
            ))
    else:
        all_edges = [resolve_file_imports(fpd, file_index, source_roots) for fpd in parse_data]

    if collect:
        return [edge for file_edges in all_edges for edge in file_edges]

    _write_import_edges(all_edges, graph)
    return None

def _detect_language(file_path: str) -> str:
    """Infer language from a file's extension."""
    suffix = PurePosixPath(file_path).suffix.lower()
    if suffix == ".py":
        return "python"
    if suffix in (".ts", ".tsx"):
        return "typescript"
    if suffix in (".js", ".jsx"):
        return "javascript"
    return ""

def _resolve_python(
    importing_file: str,
    import_info: ImportInfo,
    file_index: dict[str, str],
    source_roots: set[str] | None = None,
) -> str | None:
    if import_info.is_relative:
        return _resolve_python_relative(importing_file, import_info, file_index)
    return _resolve_python_absolute(import_info, file_index, source_roots)

def _resolve_python_relative(
    importing_file: str,
    import_info: ImportInfo,
    file_index: dict[str, str],
) -> str | None:
    """Resolve a relative Python import (``from .foo import bar``)."""
    module = import_info.module
    assert module.startswith("."), f"Expected relative import, got {module!r}"

    dot_count = 0
    for ch in module:
        if ch == ".":
            dot_count += 1
        else:
            break

    remainder = module[dot_count:]

    base = PurePosixPath(importing_file).parent
    for _ in range(dot_count - 1):
        base = base.parent

    if remainder:
        segments = remainder.split(".")
        target_dir = base / PurePosixPath(*segments)
    else:
        target_dir = base

    return _try_python_paths(str(target_dir), file_index)

def _resolve_python_absolute(
    import_info: ImportInfo,
    file_index: dict[str, str],
    source_roots: set[str] | None = None,
) -> str | None:
    """Resolve an absolute Python import (``from mypackage.auth import validate``)."""
    module = import_info.module
    target_path = str(PurePosixPath(*module.split(".")))

    result = _try_python_paths(target_path, file_index)
    if result:
        return result

    if source_roots:
        for root in source_roots:
            result = _try_python_paths(f"{root}/{target_path}", file_index)
            if result:
                return result

    return None

def _try_python_paths(base_path: str, file_index: dict[str, str]) -> str | None:
    """Try ``base_path.py`` then ``base_path/__init__.py`` against the file index."""
    candidates = [
        f"{base_path}.py",
        f"{base_path}/__init__.py",
    ]
    for candidate in candidates:
        if candidate in file_index:
            return file_index[candidate]
    return None

def _resolve_js_ts(
    importing_file: str,
    import_info: ImportInfo,
    file_index: dict[str, str],
) -> str | None:
    """Resolve a JS/TS import; bare specifiers (external packages) return ``None``."""
    module = import_info.module

    if not module.startswith("."):
        return None

    base = PurePosixPath(importing_file).parent
    resolved = base / module

    resolved_str = str(PurePosixPath(*resolved.parts))

    return _try_js_ts_paths(resolved_str, file_index)

def _try_js_ts_paths(base_path: str, file_index: dict[str, str]) -> str | None:
    """Try exact match, then extension variants, then ``index`` variants against the file index."""
    if base_path in file_index:
        return file_index[base_path]

    for ext in _JS_TS_EXTENSIONS:
        if f"{base_path}{ext}" in file_index:
            return file_index[f"{base_path}{ext}"]

    for ext in _JS_TS_EXTENSIONS:
        if f"{base_path}/index{ext}" in file_index:
            return file_index[f"{base_path}/index{ext}"]

    return None
