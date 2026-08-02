import { objectivesWorkspaceView as semanticObjectivesWorkspaceView } from "../../../application/workspace/views/objectives-view.ts";
import { withTerminalWorkspaceView } from "./workspace-view-terminal.ts";

export {
  projectWorkspaceObjectives,
  type WorkspaceObjectiveRow,
} from "../../../application/workspace/views/objectives-view.ts";

export const objectivesWorkspaceView = withTerminalWorkspaceView(semanticObjectivesWorkspaceView);
