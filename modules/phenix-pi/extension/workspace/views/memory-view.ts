import { memoryWorkspaceView as semanticMemoryWorkspaceView } from "../../../application/workspace/views/memory-view.ts";
import { withTerminalWorkspaceView } from "./workspace-view-terminal.ts";

export { projectWorkspaceMemory } from "../../../application/workspace/views/memory-view.ts";

export const memoryWorkspaceView = withTerminalWorkspaceView(semanticMemoryWorkspaceView);
