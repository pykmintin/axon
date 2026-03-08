from __future__ import annotations

from pathlib import Path

import pytest

from axon.core.ingestion.walker import discover_files, walk_repo


@pytest.fixture()
def tmp_repo(tmp_path: Path) -> Path:
    """Create a realistic temporary repo structure for testing.

    Layout::

        tmp_repo/
        +-- src/
        |   +-- main.py          ("def main(): pass")
        |   +-- utils.py         ("def helper(): pass")
        |   +-- __pycache__/
        |       +-- main.cpython-311.pyc  (should be ignored)
        +-- lib/
        |   +-- index.ts         ("export function hello() {}")
        +-- node_modules/
        |   +-- pkg/
        |       +-- index.js     (should be ignored)
        +-- README.md            (not a supported language)
        +-- .gitignore           ("*.log")
    """
    # src/
    src = tmp_path / "src"
    src.mkdir()
    (src / "main.py").write_text("def main(): pass", encoding="utf-8")
    (src / "utils.py").write_text("def helper(): pass", encoding="utf-8")

    # src/__pycache__/
    pycache = src / "__pycache__"
    pycache.mkdir()
    (pycache / "main.cpython-311.pyc").write_bytes(b"\x00\x01\x02compiled")

    # lib/
    lib = tmp_path / "lib"
    lib.mkdir()
    (lib / "index.ts").write_text("export function hello() {}", encoding="utf-8")

    # node_modules/
    nm = tmp_path / "node_modules" / "pkg"
    nm.mkdir(parents=True)
    (nm / "index.js").write_text("module.exports = {}", encoding="utf-8")

    # README.md
    (tmp_path / "README.md").write_text("# Hello", encoding="utf-8")

    # .gitignore
    (tmp_path / ".gitignore").write_text("*.log\n", encoding="utf-8")

    return tmp_path

class TestWalkRepoFindsSourceFiles:
    def test_walk_repo_finds_source_files(self, tmp_repo: Path) -> None:
        entries = walk_repo(tmp_repo)
        paths = {e.path for e in entries}
        assert "src/main.py" in paths
        assert "src/utils.py" in paths
        assert "lib/index.ts" in paths

class TestWalkRepoIgnoresPycache:
    def test_walk_repo_ignores_pycache(self, tmp_repo: Path) -> None:
        entries = walk_repo(tmp_repo)
        paths = {e.path for e in entries}
        pycache_paths = [p for p in paths if "__pycache__" in p]
        assert pycache_paths == []

class TestWalkRepoIgnoresNodeModules:
    def test_walk_repo_ignores_node_modules(self, tmp_repo: Path) -> None:
        entries = walk_repo(tmp_repo)
        paths = {e.path for e in entries}
        nm_paths = [p for p in paths if "node_modules" in p]
        assert nm_paths == []

class TestWalkRepoSkipsUnsupported:
    def test_walk_repo_skips_unsupported(self, tmp_repo: Path) -> None:
        entries = walk_repo(tmp_repo)
        paths = {e.path for e in entries}
        assert "README.md" not in paths

class TestWalkRepoRelativePaths:
    def test_walk_repo_relative_paths(self, tmp_repo: Path) -> None:
        entries = walk_repo(tmp_repo)
        for entry in entries:
            assert not Path(entry.path).is_absolute(), (
                f"Expected relative path, got: {entry.path}"
            )

class TestWalkRepoReadsContent:
    def test_walk_repo_reads_content(self, tmp_repo: Path) -> None:
        entries = walk_repo(tmp_repo)
        by_path = {e.path: e for e in entries}

        assert by_path["src/main.py"].content == "def main(): pass"
        assert by_path["src/utils.py"].content == "def helper(): pass"
        assert by_path["lib/index.ts"].content == "export function hello() {}"

class TestWalkRepoDetectsLanguage:
    def test_walk_repo_detects_language(self, tmp_repo: Path) -> None:
        entries = walk_repo(tmp_repo)
        by_path = {e.path: e for e in entries}

        assert by_path["src/main.py"].language == "python"
        assert by_path["src/utils.py"].language == "python"
        assert by_path["lib/index.ts"].language == "typescript"

class TestWalkRepoSorted:
    def test_walk_repo_sorted(self, tmp_repo: Path) -> None:
        entries = walk_repo(tmp_repo)
        paths = [e.path for e in entries]
        assert paths == sorted(paths)

class TestDiscoverFiles:
    def test_discover_files(self, tmp_repo: Path) -> None:
        paths = discover_files(tmp_repo)

        # Should return Path objects, not strings
        assert all(isinstance(p, Path) for p in paths)

        # Should find the same source files
        rel_paths = {str(p.relative_to(tmp_repo.resolve())) for p in paths}
        assert "src/main.py" in rel_paths
        assert "src/utils.py" in rel_paths
        assert "lib/index.ts" in rel_paths

        # Should exclude ignored / unsupported
        for p in paths:
            rel = str(p.relative_to(tmp_repo.resolve()))
            assert "node_modules" not in rel
            assert "__pycache__" not in rel
            assert not rel.endswith(".md")

class TestWalkRepoGitignore:
    def test_walk_repo_gitignore(self, tmp_repo: Path) -> None:
        # Create a .py file that should be excluded by a gitignore pattern.
        (tmp_repo / "secret.py").write_text("password = 'hunter2'", encoding="utf-8")
        # Another .py file that should NOT be excluded.
        (tmp_repo / "logger.py").write_text("import logging", encoding="utf-8")

        gitignore_patterns = ["secret.py"]
        entries = walk_repo(tmp_repo, gitignore_patterns=gitignore_patterns)
        paths = {e.path for e in entries}

        # secret.py matches the gitignore pattern and must be excluded.
        assert "secret.py" not in paths
        # logger.py does not match and must still be present.
        assert "logger.py" in paths

class TestWalkRepoEmptyRepo:
    def test_walk_repo_empty_repo(self, tmp_path: Path) -> None:
        entries = walk_repo(tmp_path)
        assert entries == []

class TestWalkRepoSkipsBinary:
    def test_walk_repo_skips_binary(self, tmp_path: Path) -> None:
        # Create a .py file with invalid UTF-8 bytes
        binary_file = tmp_path / "binary.py"
        binary_file.write_bytes(b"\x80\x81\x82\x83\xff\xfe")

        # Create a valid .py file alongside it
        valid_file = tmp_path / "valid.py"
        valid_file.write_text("x = 1", encoding="utf-8")

        entries = walk_repo(tmp_path)
        paths = {e.path for e in entries}

        assert "binary.py" not in paths
        assert "valid.py" in paths
