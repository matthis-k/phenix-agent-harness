from pathlib import Path

root = Path(__file__).resolve().parents[1]
path = root / "modules/phenix-pi/extension/root-extension.ts"
source = path.read_text()


def replace_once(old: str, new: str) -> None:
    global source
    count = source.count(old)
    if count != 1:
        raise RuntimeError(f"expected one occurrence, found {count}: {old[:120]!r}")
    source = source.replace(old, new, 1)


replace_once(
    "  let modelRegistry: ModelRegistry | undefined;\n  let toolsRegistered = false;\n",
    "  let modelRegistry: ModelRegistry | undefined;\n  let usesPhenixBudget = false;\n  let toolsRegistered = false;\n",
)
replace_once(
    "    modelRegistry = ctx.modelRegistry;\n    disposeStatus?.();\n",
    "    modelRegistry = ctx.modelRegistry;\n    usesPhenixBudget = ctx.model?.provider === \"phenix\";\n    disposeStatus?.();\n",
)
replace_once(
    "    await syncBudgetFromThinking(pi, runtime, rootRunId);\n",
    "    if (usesPhenixBudget) await syncBudgetFromThinking(pi, runtime, rootRunId);\n",
)
replace_once(
    "  pi.on(\"model_select\", async (event) => {\n    if (!runtime || !rootRunId) return;\n",
    "  pi.on(\"model_select\", async (event) => {\n    usesPhenixBudget = event.model.provider === \"phenix\";\n    if (!runtime || !rootRunId) return;\n",
)
replace_once(
    "    modelRegistry = undefined;\n    disposeStatus?.();\n",
    "    modelRegistry = undefined;\n    usesPhenixBudget = false;\n    disposeStatus?.();\n",
)

path.write_text(source)
