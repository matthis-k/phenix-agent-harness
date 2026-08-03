import type { MemoryNote, MemoryStatus } from "../../../domain/memory/model.ts";
import {
  textSpan,
  type WorkspaceRowPresentation,
  type WorkspaceTextTone,
} from "../presentation.ts";
import {
  defineWorkspaceView,
  type WorkspaceViewSnapshot,
  workspaceViewLayout,
} from "./workspace-view.ts";
import { compactTime, truncateWorkspaceText } from "./workspace-view-format.ts";

const RECENT_MEMORY_LIMIT = 50;

export function projectWorkspaceMemory(snapshot: WorkspaceViewSnapshot): readonly MemoryNote[] {
  if (!snapshot.memory) return [];
  return [...snapshot.memory.notes]
    .sort((left, right) => {
      const state = statusRank(left.status) - statusRank(right.status);
      return state || right.updatedAt.localeCompare(left.updatedAt);
    })
    .slice(0, RECENT_MEMORY_LIMIT);
}

export const memoryWorkspaceView = defineWorkspaceView<MemoryNote>({
  id: "memory",
  title: "Memory",
  layout: workspaceViewLayout("memory"),
  project: (snapshot) =>
    projectWorkspaceMemory(snapshot).map((value) => {
      const expandable =
        Boolean(value.subject) || value.evidenceIds.length > 0 || value.objectiveIds.length > 0;
      const present = ({
        width,
        expanded,
      }: {
        readonly width: number;
        readonly expanded: boolean;
      }): WorkspaceRowPresentation => {
        const prefix = `${compactTime(value.updatedAt)} ${value.kind}`;
        const detail = expanded
          ? [
              value.subject ? `subject ${value.subject}` : undefined,
              value.objectiveIds.length > 0 ? `objectives ${value.objectiveIds.length}` : undefined,
              value.evidenceIds.length > 0 ? `evidence ${value.evidenceIds.join(",")}` : undefined,
              `id ${value.id}`,
            ]
              .filter((item): item is string => Boolean(item))
              .join(" · ")
          : value.summary;
        return {
          spans: [
            textSpan(prefix, { tone: "dim" }),
            textSpan(" "),
            textSpan(value.status, { tone: memoryStatusTone(value.status), strong: true }),
            textSpan(" "),
            textSpan(
              truncateWorkspaceText(
                detail,
                Math.max(8, width - prefix.length - value.status.length - 3),
              ),
              {
                tone:
                  value.status === "invalidated" || value.status === "superseded"
                    ? "muted"
                    : "text",
              },
            ),
          ],
          muted: value.status === "invalidated" || value.status === "superseded",
        };
      };
      return {
        id: value.id,
        value,
        expandable,
        present,
      };
    }),
});

function statusRank(status: MemoryStatus): number {
  switch (status) {
    case "active":
      return 0;
    case "uncertain":
      return 1;
    case "superseded":
      return 2;
    case "invalidated":
      return 3;
  }
}

function memoryStatusTone(status: MemoryStatus): WorkspaceTextTone {
  switch (status) {
    case "active":
      return "success";
    case "uncertain":
      return "warning";
    case "superseded":
      return "muted";
    case "invalidated":
      return "error";
  }
}
