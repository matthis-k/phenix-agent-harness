from pathlib import Path

root = Path(__file__).resolve().parents[2]
path = root / "modules/phenix-pi/extensions/phenix.ts"
content = path.read_text()
old = "  workflows: [],\n"
if content.count(old) != 1:
    raise RuntimeError(f"expected one workflow placeholder, found {content.count(old)}")
path.write_text(content.replace(old, "", 1))
