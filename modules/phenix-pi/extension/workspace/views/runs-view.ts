import { runsWorkspaceView as semanticRunsWorkspaceView } from "../../../application/workspace/views/runs-view.ts";
import { withTerminalWorkspaceView } from "./workspace-view-terminal.ts";

export {
  projectWorkspaceRuns,
  type WorkspaceRunRow,
} from "../../../application/workspace/views/runs-view.ts";

export const runsWorkspaceView = withTerminalWorkspaceView(semanticRunsWorkspaceView);
