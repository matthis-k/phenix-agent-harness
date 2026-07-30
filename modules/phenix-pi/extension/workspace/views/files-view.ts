import { filesWorkspaceView as semanticFilesWorkspaceView } from "../../../application/workspace/views/files-view.ts";
import { withTerminalWorkspaceView } from "./workspace-view-terminal.ts";

export {
  projectWorkspaceFiles,
  type WorkspaceFileRow,
} from "../../../application/workspace/views/files-view.ts";

export const filesWorkspaceView = withTerminalWorkspaceView(semanticFilesWorkspaceView);
