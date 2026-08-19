from pathlib import Path

path = Path("rust/crates/phenix-conductor/src/server.rs")
content = path.read_text()
old = "        assert!(EXECUTION_WORKERS >= 2);\n"
if content.count(old) != 1:
    raise SystemExit(f"expected one constant worker assertion, found {content.count(old)}")
path.write_text(content.replace(old, "", 1))
