export type WorkspaceSurfaceId =
  | "runs"
  | "objectives"
  | "files"
  | "facts"
  | "transcript"
  | "input"
  | "status";

export interface WorkspaceSurfaceSpec {
  readonly id: WorkspaceSurfaceId;
  readonly axis: "horizontal" | "vertical";
  readonly min: number;
  readonly max?: number;
  readonly preferred?: number;
  readonly priority: number;
  readonly collapsible?: boolean;
}

export interface WorkspaceSurfaceAllocation {
  readonly id: WorkspaceSurfaceId;
  readonly start: number;
  readonly size: number;
  readonly collapsed: boolean;
}

export function allocateWorkspaceSurfaces(
  total: number,
  specs: readonly WorkspaceSurfaceSpec[],
): readonly WorkspaceSurfaceAllocation[] {
  if (total < 0) throw new Error(`Workspace surface total must be non-negative`);
  if (specs.length === 0) return [];
  const desired = specs.map((spec) => clamp(spec.preferred ?? spec.min, spec.min, spec.max));
  const minimum = specs.map((spec) => (spec.collapsible ? 0 : spec.min));
  let sizes = [...desired];
  let overflow = sum(sizes) - total;

  if (overflow > 0) {
    const order = specs
      .map((spec, index) => ({ index, priority: spec.priority }))
      .sort((left, right) => left.priority - right.priority);
    for (const { index } of order) {
      if (overflow <= 0) break;
      const available = sizes[index] - minimum[index];
      const reduction = Math.min(available, overflow);
      sizes[index] -= reduction;
      overflow -= reduction;
    }
  }

  if (overflow > 0) {
    for (let index = sizes.length - 1; index >= 0 && overflow > 0; index -= 1) {
      const reduction = Math.min(sizes[index], overflow);
      sizes[index] -= reduction;
      overflow -= reduction;
    }
  }

  let remaining = total - sum(sizes);
  const growOrder = specs
    .map((spec, index) => ({ index, priority: spec.priority }))
    .sort((left, right) => right.priority - left.priority);
  while (remaining > 0) {
    let grew = false;
    for (const { index } of growOrder) {
      if (remaining <= 0) break;
      const max = specs[index].max ?? Number.POSITIVE_INFINITY;
      if (sizes[index] >= max) continue;
      sizes[index] += 1;
      remaining -= 1;
      grew = true;
    }
    if (!grew) break;
  }

  let start = 0;
  return specs.map((spec, index) => {
    const size = sizes[index];
    const allocation = { id: spec.id, start, size, collapsed: size === 0 };
    start += size;
    return allocation;
  });
}

function clamp(value: number, min: number, max: number | undefined): number {
  return Math.max(min, Math.min(value, max ?? Number.POSITIVE_INFINITY));
}

function sum(values: readonly number[]): number {
  return values.reduce((total, value) => total + value, 0);
}
