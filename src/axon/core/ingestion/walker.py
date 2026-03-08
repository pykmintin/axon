"""File system walker for discovering and reading source files in a repository."""

from __future__ import annotations

import os
import subprocess
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass
from pathlib import Path

from axon.config.ignore import DEFAULT_IGNORE_PATTERNS, should_ignore
from axon.config.languages import get_language, is_supported

_PRUNE_DIRS: frozenset[str] = frozenset(
    p for p in DEFAULT_IGNORE_PATTERNS
    if ("*" not in p and "." not in p) or p.startswith(".")
) | frozenset({
    ".git", "node_modules", "__pycache__", ".venv", "venv", ".env",
    "dist", "build", ".idea", ".vscode", ".mypy_cache", ".pytest_cache",
    ".ruff_cache", ".tox", ".eggs", ".axon",
})

@dataclass
class FileEntry:
    path: str
    content: str
    language: str

def _discover_via_git(repo_path: Path, gitignore_patterns: list[str] | None) -> list[Path] | None:
    try:
        result = subprocess.run(
            ["git", "ls-files", "--cached", "--others", "--exclude-standard"],
            cwd=repo_path,
            capture_output=True,
            text=True,
            timeout=10,
        )
        if result.returncode != 0:
            return None
    except (subprocess.TimeoutExpired, FileNotFoundError):
        return None

    discovered: list[Path] = []
    for line in result.stdout.splitlines():
        line = line.strip()
        if not line:
            continue
        if should_ignore(line, gitignore_patterns):
            continue
        full = repo_path / line
        if is_supported(full):
            discovered.append(full)
    return discovered


def _discover_via_walk(repo_path: Path, gitignore_patterns: list[str] | None) -> list[Path]:
    discovered: list[Path] = []

    for dirpath, dirnames, filenames in os.walk(repo_path, topdown=True):
        dirnames[:] = [
            d for d in dirnames
            if d not in _PRUNE_DIRS and not d.endswith(".egg-info")
        ]

        for fname in filenames:
            full = Path(dirpath) / fname
            try:
                relative = full.relative_to(repo_path)
            except ValueError:
                continue

            if should_ignore(str(relative), gitignore_patterns):
                continue
            if not is_supported(full):
                continue
            discovered.append(full)

    return discovered


def discover_files(
    repo_path: Path,
    gitignore_patterns: list[str] | None = None,
) -> list[Path]:
    repo_path = repo_path.resolve()
    result = _discover_via_git(repo_path, gitignore_patterns)
    if result is not None:
        return result

    return _discover_via_walk(repo_path, gitignore_patterns)

def read_file(repo_path: Path, file_path: Path) -> FileEntry | None:
    relative = file_path.relative_to(repo_path)

    try:
        content = file_path.read_text(encoding="utf-8")
    except (UnicodeDecodeError, ValueError, OSError):
        return None

    if not content:
        return None

    language = get_language(file_path)
    if language is None:
        return None

    return FileEntry(
        path=str(relative),
        content=content,
        language=language,
    )

def walk_repo(
    repo_path: Path,
    gitignore_patterns: list[str] | None = None,
    max_workers: int = 8,
) -> list[FileEntry]:
    repo_path = repo_path.resolve()
    file_paths = discover_files(repo_path, gitignore_patterns)

    with ThreadPoolExecutor(max_workers=max_workers) as executor:
        results = executor.map(lambda fp: read_file(repo_path, fp), file_paths)

    entries = [entry for entry in results if entry is not None]
    entries.sort(key=lambda e: e.path)
    return entries
