export interface Point {
  readonly x: number;
  readonly y: number;
}

export interface Size {
  readonly width: number;
  readonly height: number;
}

export interface Rect extends Point, Size {}

export function point(x: number, y: number): Point {
  return { x: integer("x", x), y: integer("y", y) };
}

export function size(width: number, height: number): Size {
  return {
    width: nonNegativeInteger("width", width),
    height: nonNegativeInteger("height", height),
  };
}

export function rect(x: number, y: number, width: number, height: number): Rect {
  return { ...point(x, y), ...size(width, height) };
}

export function right(value: Rect): number {
  return value.x + value.width;
}

export function bottom(value: Rect): number {
  return value.y + value.height;
}

export function containsPoint(bounds: Rect, value: Point): boolean {
  return (
    value.x >= bounds.x &&
    value.y >= bounds.y &&
    value.x < right(bounds) &&
    value.y < bottom(bounds)
  );
}

export function containsRect(bounds: Rect, value: Rect): boolean {
  return (
    value.x >= bounds.x &&
    value.y >= bounds.y &&
    right(value) <= right(bounds) &&
    bottom(value) <= bottom(bounds)
  );
}

export function intersects(left: Rect, rightValue: Rect): boolean {
  return (
    left.x < right(rightValue) &&
    right(left) > rightValue.x &&
    left.y < bottom(rightValue) &&
    bottom(left) > rightValue.y
  );
}

export function intersection(left: Rect, rightValue: Rect): Rect | undefined {
  const x = Math.max(left.x, rightValue.x);
  const y = Math.max(left.y, rightValue.y);
  const x2 = Math.min(right(left), right(rightValue));
  const y2 = Math.min(bottom(left), bottom(rightValue));
  if (x2 <= x || y2 <= y) return undefined;
  return rect(x, y, x2 - x, y2 - y);
}

export function translate(value: Rect, by: Point): Rect {
  return rect(value.x + by.x, value.y + by.y, value.width, value.height);
}

export function localRect(value: Rect, parent: Rect): Rect {
  return rect(value.x - parent.x, value.y - parent.y, value.width, value.height);
}

function integer(name: string, value: number): number {
  if (!Number.isInteger(value)) throw new RangeError(`${name} must be an integer`);
  return value;
}

function nonNegativeInteger(name: string, value: number): number {
  const validated = integer(name, value);
  if (validated < 0) throw new RangeError(`${name} must not be negative`);
  return validated;
}
