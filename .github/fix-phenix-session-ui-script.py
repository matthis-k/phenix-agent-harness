from pathlib import Path

path = Path(".github/apply-phenix-session-ui.py")
text = path.read_text()
old = '''replace_once(
    path,
    '    const paneLabel = PANE_LABELS[this.view][this.pane] ?? `pane ${this.pane + 1}`;\\n',
    '    const paneLabel = this.paneLabels()[this.pane] ?? `pane ${this.pane + 1}`;\\n',
)
'''
new = '''replace_once(
    path,
    'PANE_LABELS[this.view][this.pane]',
    'this.paneLabels()[this.pane]',
)
'''
if text.count(old) != 1:
    raise RuntimeError(f"expected one script block, found {text.count(old)}")
path.write_text(text.replace(old, new, 1))
