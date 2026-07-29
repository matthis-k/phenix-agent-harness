import { sliceByColumn, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";

export interface ViewportState {
  readonly offset: number;
  readonly followEnd: boolean;
}

export interface ViewportRange {
  readonly offset: number;
  readonly end: number;
  readonly maximumOffset: number;
}

export function viewportRange(total: number, height: number, state: ViewportState): ViewportRange {
  const visibleHeight = Math.max(0, Math.floor(height));
  const itemCount = Math.max(0, Math.floor(total));
  const maximumOffset = Math.max(0, itemCount - visibleHeight);
  const offset = state.followEnd ? maximumOffset : clamp(state.offset, 0, maximumOffset);
  return {
    offset,
    end: Math.min(itemCount, offset + visibleHeight),
    maximumOffset,
  };
}

export function keepIndexVisible(
  offset: number,
  index: number,
  height: number,
  total: number,
): number {
  const visibleHeight = Math.max(0, Math.floor(height));
  const maximumOffset = Math.max(0, Math.floor(total) - visibleHeight);
  if (visibleHeight === 0) return 0;

  let next = clamp(offset, 0, maximumOffset);
  if (index < next) next = index;
  if (index >= next + visibleHeight) next = index - visibleHeight + 1;
  return clamp(next, 0, maximumOffset);
}

export function fitViewLine(line: string, width: number): string {
  const targetWidth = Math.max(0, Math.floor(width));
  const clipped = truncateToWidth(line, targetWidth, "");
  return clipped + " ".repeat(Math.max(0, targetWidth - visibleWidth(clipped)));
}

export function sliceViewLine(line: string, offset: number, width: number): string {
  return fitViewLine(
    sliceByColumn(line, Math.max(0, Math.floor(offset)), Math.max(0, Math.floor(width)), true),
    width,
  );
}

export function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(Math.max(Math.floor(value), minimum), Math.max(minimum, maximum));
}
