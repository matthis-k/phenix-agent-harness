from pathlib import Path

root = Path(__file__).resolve().parents[2]
path = root / "modules/phenix-pi/extensions/phenix.ts"
content = path.read_text()
old = 'import type { ExtensionAPI, ModelRegistry } from "@earendil-works/pi-coding-agent";\n'
new = '''import type {
  ExtensionAPI,
  ModelRegistry,
  ToolDefinition,
} from "@earendil-works/pi-coding-agent";
'''
if content.count(old) != 1:
    raise RuntimeError("unexpected pi-coding-agent import shape")
path.write_text(content.replace(old, new, 1))
