import type {
  MemoryHealthSnapshot,
  MemoryNote,
  MemoryStatus,
} from "../../../domain/memory/model.ts";
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

type MemoryWorkspaceItem =
  | { readonly kind: "health"; readonly health: MemoryHealthSnapshot }
  | { readonly kind: "note"; readonly note: MemoryNote };

export function projectWorkspaceMemory(snapshot: WorkspaceViewSnapshot): readonly MemoryNote[] {
  if (!snapshot.memory) return [];
  return [...snapshot.memory.notes]
    .sort((left, right) => {
      const state = statusRank(left.status) - statusRank(right.status);
      return state || right.updatedAt.localeCompare(left.updatedAt);
    })
    .slice(0, RECENT_MEMORY_LIMIT);
}

export const memoryWorkspaceView = defineWorkspaceView<MemoryWorkspaceItem>({
  id: "memory",
  title: "Memory",
  layout: workspaceViewLayout("memory"),
  project: (snapshot) => {
    if (!snapshot.memory) return [];
    const healthItem = createHealthItem(snapshot.memory.health);
    const noteItems = projectWorkspaceMemory(snapshot).map(createNoteItem);
    return [healthItem, ...noteItems];
  },
});

function createHealthItem(health: MemoryHealthSnapshot) {
  return {
    id: "memory-health",
    value: { kind: "health" as const, health },
    expandable: health.issues.length > 0,
    present: ({
      width,
      expanded,
    }: {
      readonly width: number;
      readonly expanded: boolean;
    }): WorkspaceRowPresentation => {
      const label = `health ${health.state}`;
      const detail = expanded
        ? health.issues.length > 0
          ? health.issues.map((issue) => issue.kind).join(", ")
          : "no integrity issues"
        : `${health.noteCount} notes · ${health.evidenceCount} evidence · ${formatBytes(
            health.storedBytes,
          )} · ${health.writable ? "writable" : "read-only"}`;
      return {
        spans: [
          textSpan(label, { tone: healthTone(health), strong: true }),
          textSpan(" "),
          textSpan(truncateWorkspaceText(detail, Math.max(8, width - label.length - 1)), {
            tone: health.state === "healthy" ? "dim" : "text",
          }),
        ],
        muted: false,
      };
    },
  };
}

function createNoteItem(value: MemoryNote) {
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
    value: { kind: "note" as const, note: value },
    expandable,
    present,
  };
}

function healthTone(health: MemoryHealthSnapshot): WorkspaceTextTone {
  switch (health.state) {
    case "healthy":
      return "success";
    case "degraded":
      return "warning";
    case "corrupt":
    case "unavailable":
      return "error";
  }
}

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

function formatBytes(bytes: number): string {
  if (bytes < 1_024) return `${bytes} B`;
  if (bytes < 1_024 * 1_024) return `${Math.round(bytes / 1_024)} KiB`;
  return `${Math.round(bytes / (1_024 * 1_024))} MiB`;
}
