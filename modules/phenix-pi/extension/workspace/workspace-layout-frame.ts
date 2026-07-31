import { type Rect, rect } from "../../domain/workspace/geometry.ts";
import {
  type LayoutFrame,
  type LayoutNode,
  type LayoutResult,
  solveLayout,
} from "../../domain/workspace/layout.ts";
import type { PaneId, ViewId } from "../../domain/workspace/state.ts";
import { fitViewLine, sliceViewLine } from "../components/index.ts";

const SIDEBAR_MIN_WIDTH = 90;
const CONVERSATION_GAP = 1;
const RESET_BACKGROUND = "\x1b[49m";

export interface WorkspaceDimensions {
  readonly width: number;
  readonly height: number;
  readonly sidebarVisible: boolean;
  readonly sidebarWidth: number;
  readonly mainWidth: number;
}

export interface WorkspaceLayoutInput {
  readonly width: number;
  readonly height: number;
  readonly editorHeight: number;
  readonly sidebarRequested: boolean;
  readonly revision: number;
}

export interface WorkspacePaneOutput {
  readonly lines: readonly string[];
}

export function computeWorkspaceDimensions(
  width: number,
  height: number,
  sidebarRequested = true,
): WorkspaceDimensions {
  const sidebarVisible = sidebarRequested && width >= SIDEBAR_MIN_WIDTH;
  const sidebarWidth = sidebarVisible ? Math.min(38, Math.max(28, Math.floor(width * 0.22))) : 0;
  return {
    width,
    height,
    sidebarVisible,
    sidebarWidth,
    mainWidth: Math.max(1, width - sidebarWidth - (sidebarVisible ? 1 : 0)),
  };
}

export function solveWorkspaceLayout(input: WorkspaceLayoutInput): LayoutResult {
  const dimensions = computeWorkspaceDimensions(input.width, input.height, input.sidebarRequested);
  const gap = input.height >= 3 ? CONVERSATION_GAP : 0;
  const editorHeight = clamp(input.editorHeight, 1, Math.max(1, input.height - gap - 1));
  const transcriptHeight = Math.max(1, input.height - editorHeight - gap);
  const conversation = fixedVerticalConversation(
    dimensions.mainWidth,
    transcriptHeight,
    editorHeight,
    gap,
  );
  const specification: LayoutNode = dimensions.sidebarVisible
    ? {
        kind: "split",
        axis: "horizontal",
        gap: 1,
        children: [
          {
            node: conversation,
            weight: 0,
            min: dimensions.mainWidth,
            max: dimensions.mainWidth,
          },
          {
            node: fixedPane("runs", dimensions.sidebarWidth, input.height, false),
            weight: 0,
            min: dimensions.sidebarWidth,
            max: dimensions.sidebarWidth,
          },
        ],
      }
    : conversation;
  return solveLayout(specification, rect(0, 0, input.width, input.height), {
    revision: input.revision,
    flags: new Set(),
  });
}

export function composeWorkspaceTextFrame(
  frame: LayoutFrame,
  outputs: ReadonlyMap<PaneId, WorkspacePaneOutput>,
): readonly string[] {
  return Array.from({ length: frame.terminal.height }, (_, rowOffset) => {
    const row = frame.terminal.y + rowOffset;
    const panes = [...frame.panes.entries()]
      .filter(([, bounds]) => row >= bounds.y && row < bounds.y + bounds.height)
      .sort((left, right) => left[1].x - right[1].x);
    let column = frame.terminal.x;
    let line = RESET_BACKGROUND;
    for (const [paneId, bounds] of panes) {
      if (bounds.x > column) line += " ".repeat(bounds.x - column);
      const localRow = row - bounds.y;
      const source = outputs.get(paneId)?.lines[localRow] ?? "";
      line += RESET_BACKGROUND;
      line += sliceViewLine(source, 0, bounds.width);
      line += RESET_BACKGROUND;
      column = bounds.x + bounds.width;
    }
    if (column < frame.terminal.x + frame.terminal.width) {
      line += " ".repeat(frame.terminal.x + frame.terminal.width - column);
    }
    return `${fitViewLine(line, frame.terminal.width)}${RESET_BACKGROUND}`;
  });
}

export function paneRect(frame: LayoutFrame, paneId: PaneId): Rect {
  const bounds = frame.panes.get(paneId);
  if (!bounds) throw new Error(`Workspace layout does not contain pane ${paneId}`);
  return bounds;
}

function fixedVerticalConversation(
  width: number,
  transcriptHeight: number,
  editorHeight: number,
  gap: number,
): LayoutNode {
  return {
    kind: "split",
    axis: "vertical",
    gap,
    children: [
      {
        node: fixedPane("transcript", width, transcriptHeight),
        weight: 0,
        min: transcriptHeight,
        max: transcriptHeight,
      },
      {
        node: fixedPane("editor", width, editorHeight),
        weight: 0,
        min: editorHeight,
        max: editorHeight,
      },
    ],
  };
}

function fixedPane(paneId: PaneId, width: number, height: number, focusable = true): LayoutNode {
  return {
    kind: "pane",
    paneId,
    viewId: paneId as ViewId,
    minWidth: width,
    maxWidth: width,
    minHeight: height,
    maxHeight: height,
    focusable,
  };
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(Math.max(Math.floor(value), minimum), Math.max(minimum, maximum));
}
