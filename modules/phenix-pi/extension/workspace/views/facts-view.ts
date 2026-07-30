import { factsWorkspaceView as semanticFactsWorkspaceView } from "../../../application/workspace/views/facts-view.ts";
import { withTerminalWorkspaceView } from "./workspace-view-terminal.ts";

export { projectWorkspaceFacts } from "../../../application/workspace/views/facts-view.ts";

export const factsWorkspaceView = withTerminalWorkspaceView(semanticFactsWorkspaceView);
