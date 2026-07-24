export const BUNDLED_WORKFLOW_SOURCE_NAMES = ["implement", "qa"] as const;

export type BundledWorkflowSourceName = (typeof BUNDLED_WORKFLOW_SOURCE_NAMES)[number];
