import type { ProjectDecision, ProjectMap } from "../domain/project/model.ts";
import type {
  ProjectTracker,
  ProjectTrackerPublication,
} from "../ports/project-tracker.ts";

/** Keep the local ledger usable before a project has a tracker projection. */
export class PublishedProjectTracker implements ProjectTracker {
  constructor(private readonly inner: ProjectTracker) {}

  publish(project: ProjectMap): Promise<ProjectTrackerPublication> {
    return this.inner.publish(project);
  }

  claim(project: ProjectMap, decision: ProjectDecision): Promise<void> {
    return project.tracker && decision.issue
      ? this.inner.claim(project, decision)
      : Promise.resolve();
  }

  release(project: ProjectMap, decision: ProjectDecision): Promise<void> {
    return project.tracker && decision.issue
      ? this.inner.release(project, decision)
      : Promise.resolve();
  }

  resolve(project: ProjectMap, decision: ProjectDecision): Promise<void> {
    return project.tracker && decision.issue
      ? this.inner.resolve(project, decision)
      : Promise.resolve();
  }

  refresh(project: ProjectMap): Promise<void> {
    return project.tracker ? this.inner.refresh(project) : Promise.resolve();
  }
}
