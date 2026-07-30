import { tasksWorkspaceView as semanticTasksWorkspaceView } from "../../../application/workspace/views/tasks-view.ts";
import { withTerminalWorkspaceView } from "./workspace-view-terminal.ts";

export {
  projectWorkspaceTasks,
  type WorkspaceTaskRow,
} from "../../../application/workspace/views/tasks-view.ts";

export const tasksWorkspaceView = withTerminalWorkspaceView(semanticTasksWorkspaceView);
