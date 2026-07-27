from pathlib import Path
import re


def replace_once(path: Path, old: str, new: str) -> None:
    text = path.read_text()
    if text.count(old) != 1:
        raise RuntimeError(f"{path}: expected one block, found {text.count(old)}")
    path.write_text(text.replace(old, new, 1))


def normalize_hunk_counts(path: Path) -> None:
    lines = path.read_text().splitlines(keepends=True)
    header = re.compile(
        r"^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@(?P<suffix>.*?)(?P<newline>\r?\n)?$"
    )
    normalized: list[str] = []
    index = 0
    while index < len(lines):
        match = header.match(lines[index])
        if not match:
            normalized.append(lines[index])
            index += 1
            continue

        end = index + 1
        while end < len(lines) and not lines[end].startswith(("@@ ", "diff --git ")):
            end += 1
        body = lines[index + 1 : end]
        old_count = sum(
            1
            for line in body
            if not line.startswith(("+", "\\ No newline at end of file"))
        )
        new_count = sum(
            1
            for line in body
            if not line.startswith(("-", "\\ No newline at end of file"))
        )
        newline = match.group("newline") or ""
        normalized.append(
            f"@@ -{match.group(1)},{old_count} +{match.group(2)},{new_count} @@{match.group('suffix')}{newline}"
        )
        normalized.extend(body)
        index = end

    path.write_text("".join(normalized))


script = Path(".github/apply-phenix-session-ui.py")
replace_once(
    script,
    '''replace_once(
    path,
    '    const paneLabel = PANE_LABELS[this.view][this.pane] ?? `pane ${this.pane + 1}`;\\n',
    '    const paneLabel = this.paneLabels()[this.pane] ?? `pane ${this.pane + 1}`;\\n',
)
''',
    '''replace_once(
    path,
    'PANE_LABELS[this.view][this.pane]',
    'this.paneLabels()[this.pane]',
)
''',
)
normalize_hunk_counts(Path("modules/patches/pi-extension-sidebar.patch"))
