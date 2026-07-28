import { containsPoint, intersection, localRect, point, rect, type Point, type Rect } from "./geometry.ts";
import type { LayoutFrame } from "./layout.ts";
import type { WorkspaceError } from "./errors.ts";
import type { PaneId, ViewId } from "./state.ts";

export interface RenderCell {
  readonly glyph: string;
  readonly style?: string;
}

export interface LocalCursor extends Point {}

export interface LocalHitRegion {
  readonly id: string;
  readonly bounds: Rect;
  readonly action: string;
}

export interface AbsoluteCursor extends Point {
  readonly paneId: PaneId;
}

export interface AbsoluteHitRegion extends LocalHitRegion {
  readonly paneId: PaneId;
}

export interface RenderOutput {
  readonly surface: Surface;
  readonly cursor?: LocalCursor;
  readonly hitRegions: readonly LocalHitRegion[];
}

export interface WorkspaceView<Model, State> {
  readonly id: ViewId;
  render(model: Model, state: State, context: RenderContext): RenderOutput;
}

export interface RenderContext {
  readonly rect: Rect;
  readonly focused: boolean;
  readonly layoutRevision: number;
}

export interface HitMap {
  readonly layoutRevision: number;
  readonly regions: readonly AbsoluteHitRegion[];
}

export interface CompositorResult {
  readonly lines: readonly string[];
  readonly cursor?: AbsoluteCursor;
  readonly hitMap: HitMap;
  readonly diagnostics: readonly WorkspaceError[];
}

const BLANK: RenderCell = { glyph: " " };

export class Surface {
  readonly width: number;
  readonly height: number;
  private readonly rows: RenderCell[][];

  constructor(width: number, height: number, fill: RenderCell = BLANK) {
    this.width = nonNegativeInteger("width", width);
    this.height = nonNegativeInteger("height", height);
    this.rows = Array.from({ length: this.height }, () =>
      Array.from({ length: this.width }, () => fill),
    );
  }

  write(row: number, column: number, cells: readonly RenderCell[]): void {
    if (!Number.isInteger(row) || !Number.isInteger(column) || row < 0 || row >= this.height) return;
    for (const [index, value] of cells.entries()) {
      const target = column + index;
      if (target < 0 || target >= this.width) continue;
      this.rows[row]![target] = value;
    }
  }

  writeText(row: number, column: number, text: string, style?: string): void {
    this.write(
      row,
      column,
      Array.from(text, (glyph) => ({ glyph, ...(style ? { style } : {}) })),
    );
  }

  fill(bounds: Rect, value: RenderCell): void {
    const clipped = intersection(bounds, rect(0, 0, this.width, this.height));
    if (!clipped) return;
    for (let row = clipped.y; row < clipped.y + clipped.height; row += 1) {
      for (let column = clipped.x; column < clipped.x + clipped.width; column += 1) {
        this.rows[row]![column] = value;
      }
    }
  }

  blit(child: Surface, destination: Point): void {
    for (let row = 0; row < child.height; row += 1) {
      this.write(destination.y + row, destination.x, child.rows[row] ?? []);
    }
  }

  toLines(): readonly string[] {
    return this.rows.map((row) => row.map((cell) => cell.glyph).join(""));
  }
}

export function composeFrame(
  frame: LayoutFrame,
  outputs: ReadonlyMap<PaneId, RenderOutput>,
  focusedPaneId: PaneId,
): CompositorResult {
  const root = new Surface(frame.terminal.width, frame.terminal.height);
  const diagnostics: WorkspaceError[] = [];
  const hitRegions: AbsoluteHitRegion[] = [];
  let cursor: AbsoluteCursor | undefined;

  for (const [paneId, paneBounds] of frame.panes) {
    const output = outputs.get(paneId);
    if (!output) continue;
    if (output.surface.width !== paneBounds.width || output.surface.height !== paneBounds.height) {
      diagnostics.push(renderError(paneId, "View surface does not match its assigned rectangle"));
      root.blit(errorSurface(paneBounds.width, paneBounds.height), {
        x: paneBounds.x - frame.terminal.x,
        y: paneBounds.y - frame.terminal.y,
      });
      continue;
    }
    root.blit(output.surface, {
      x: paneBounds.x - frame.terminal.x,
      y: paneBounds.y - frame.terminal.y,
    });

    for (const region of output.hitRegions) {
      const clipped = intersection(region.bounds, rect(0, 0, paneBounds.width, paneBounds.height));
      if (!clipped) continue;
      hitRegions.push({
        ...region,
        paneId,
        bounds: rect(
          paneBounds.x + clipped.x,
          paneBounds.y + clipped.y,
          clipped.width,
          clipped.height,
        ),
      });
    }

    if (paneId !== focusedPaneId || !output.cursor) continue;
    if (!containsPoint(rect(0, 0, paneBounds.width, paneBounds.height), output.cursor)) {
      diagnostics.push(renderError(paneId, "Focused view requested a cursor outside its rectangle"));
      continue;
    }
    cursor = {
      paneId,
      x: paneBounds.x + output.cursor.x,
      y: paneBounds.y + output.cursor.y,
    };
  }

  return {
    lines: root.toLines(),
    ...(cursor ? { cursor } : {}),
    hitMap: { layoutRevision: frame.revision, regions: hitRegions },
    diagnostics,
  };
}

export function hitTest(hitMap: HitMap, layoutRevision: number, target: Point): AbsoluteHitRegion | undefined {
  if (hitMap.layoutRevision !== layoutRevision) return undefined;
  return hitMap.regions.find((region) => containsPoint(region.bounds, target));
}

export function localBounds(paneBounds: Rect, absolute: Rect): Rect | undefined {
  const clipped = intersection(paneBounds, absolute);
  return clipped ? localRect(clipped, paneBounds) : undefined;
}

function errorSurface(width: number, height: number): Surface {
  const surface = new Surface(width, height);
  if (height > 0) surface.writeText(0, 0, "View unavailable".slice(0, width));
  return surface;
}

function renderError(paneId: PaneId, message: string): WorkspaceError {
  return {
    code: "view-render-failed",
    owner: { kind: "pane", paneId },
    message,
    recoverable: true,
  };
}

function nonNegativeInteger(name: string, value: number): number {
  if (!Number.isInteger(value) || value < 0) {
    throw new RangeError(`${name} must be a non-negative integer`);
  }
  return value;
}
