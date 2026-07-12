#!/usr/bin/env python3
from __future__ import annotations

import os
import subprocess
import sys
import tempfile
from dataclasses import dataclass
from pathlib import Path


@dataclass(frozen=True)
class Hunk:
    old: str
    new: str


OPTIONAL_HUNKS = {
    (
        Path("modules/phenix-pi/extensions/phenix-subagents/attempt-runner.ts"),
        9,
    ),
}


def parse_patch(patch_text: str) -> dict[Path, list[Hunk]]:
    lines = patch_text.splitlines(keepends=True)
    files: dict[Path, list[Hunk]] = {}
    current: Path | None = None
    index = 0

    while index < len(lines):
        line = lines[index]

        if line.startswith("diff --git "):
            parts = line.rstrip("\n").split(" ")
            if (
                len(parts) != 4
                or not parts[2].startswith("a/")
                or not parts[3].startswith("b/")
            ):
                raise RuntimeError(f"unsupported diff header: {line.rstrip()}")
            old_path = parts[2][2:]
            new_path = parts[3][2:]
            if old_path != new_path:
                raise RuntimeError("renames are not supported")
            current = Path(old_path)
            files.setdefault(current, [])
            index += 1
            continue

        if line.startswith("@@ "):
            if current is None:
                raise RuntimeError("hunk encountered before file header")

            old_lines: list[str] = []
            new_lines: list[str] = []
            index += 1

            while index < len(lines):
                hunk_line = lines[index]
                if hunk_line.startswith("@@ ") or hunk_line.startswith("diff --git "):
                    break
                if hunk_line.startswith("\\ No newline at end of file"):
                    index += 1
                    continue
                if not hunk_line:
                    raise RuntimeError("empty patch line without prefix")

                prefix = hunk_line[0]
                content = hunk_line[1:]
                if prefix in (" ", "-"):
                    old_lines.append(content)
                if prefix in (" ", "+"):
                    new_lines.append(content)
                if prefix not in (" ", "-", "+"):
                    raise RuntimeError(f"unsupported hunk line: {hunk_line.rstrip()}")

                index += 1

            files[current].append(Hunk("".join(old_lines), "".join(new_lines)))
            continue

        index += 1

    if not files:
        raise RuntimeError("patch contains no files")
    return files


def apply_hunks(source: str, hunks: list[Hunk], path: Path) -> str:
    result = source
    cursor = 0

    for number, hunk in enumerate(hunks, start=1):
        if not hunk.old:
            raise RuntimeError(f"{path}: insertion-only hunks are not supported")

        position = result.find(hunk.old, cursor)
        if position < 0:
            first = result.find(hunk.old)
            if first < 0:
                if (path, number) in OPTIONAL_HUNKS:
                    print(f"skipping optional hunk {number} for {path}")
                    continue
                raise RuntimeError(
                    f"{path}: exact source for hunk {number} was not found"
                )
            second = result.find(hunk.old, first + 1)
            if second >= 0:
                raise RuntimeError(
                    f"{path}: hunk {number} matched multiple locations"
                )
            position = first

        result = result[:position] + hunk.new + result[position + len(hunk.old):]
        cursor = position + len(hunk.new)

    return result


def main() -> int:
    if len(sys.argv) != 2:
        print(f"usage: {sys.argv[0]} PATCH", file=sys.stderr)
        return 2

    root = Path(
        subprocess.check_output(
            ["git", "rev-parse", "--show-toplevel"],
            text=True,
        ).strip()
    )
    patch_path = (root / sys.argv[1]).resolve()
    parsed = parse_patch(patch_path.read_text(encoding="utf-8"))

    outputs: dict[Path, str] = {}
    for relative, hunks in parsed.items():
        target = root / relative
        source = target.read_text(encoding="utf-8")
        outputs[target] = apply_hunks(source, hunks, relative)

    originals = {path: path.read_bytes() for path in outputs}
    written: list[Path] = []

    try:
        for path, content in outputs.items():
            fd, temporary_name = tempfile.mkstemp(
                prefix=f".{path.name}.",
                suffix=".tmp",
                dir=path.parent,
            )
            try:
                with os.fdopen(fd, "w", encoding="utf-8") as temporary:
                    temporary.write(content)
                    temporary.flush()
                    os.fsync(temporary.fileno())
                os.replace(temporary_name, path)
                written.append(path)
            finally:
                if os.path.exists(temporary_name):
                    os.unlink(temporary_name)

        subprocess.run(
            [
                "git",
                "diff",
                "--check",
                "--",
                *[str(path.relative_to(root)) for path in outputs],
            ],
            cwd=root,
            check=True,
        )
    except Exception:
        for path in written:
            path.write_bytes(originals[path])
        raise

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
