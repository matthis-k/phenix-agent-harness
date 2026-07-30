import type {
  ProjectDecision,
  ProjectMap,
  ProjectTrackerLink,
} from "../domain/project/model.ts";

export interface ProjectTrackerPublication {
  readonly tracker: ProjectTrackerLink;
  readonly decisions: ReadonlyMap<string, { readonly issueNumber: number; readonly url: string }>;
}

export interface ProjectTracker {
  publish(project: ProjectMap): Promise<ProjectTrackerPublication>;
  claim(project: ProjectMap, decision: ProjectDecision): Promise<void>;
  resolve(project: ProjectMap, decision: ProjectDecision): Promise<void>;
  refresh(project: ProjectMap): Promise<void>;
}
