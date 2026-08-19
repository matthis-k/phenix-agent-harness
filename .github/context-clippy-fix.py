from pathlib import Path

path = Path("rust/crates/phenix-conductor/src/context.rs")
text = path.read_text()
old = '''        let project_root = project_root(cwd);
        let mut registry = Self::default();
        registry.base_documents = discover_base_documents(&project_root, cwd)?;
'''
new = '''        let project_root = project_root(cwd);
        let mut registry = Self {
            base_documents: discover_base_documents(&project_root, cwd)?,
            ..Self::default()
        };
'''
if text.count(old) != 1:
    raise SystemExit(f"expected one context initializer anchor, found {text.count(old)}")
path.write_text(text.replace(old, new, 1))
