/**
 * phenix-composition — public configuration and linking API.
 *
 * Composition owns passive declarations and the immutable graph consumed by
 * runtime services. Workflow execution remains in phenix-workflow.
 */

// Configuration
export type { PhenixConfiguration } from "./configuration.ts";
export { definePhenixConfiguration } from "./configuration.ts";

// Linked graph
export type {
  LinkedAgentClient,
  LinkedAgentRoute,
  LinkedModelPool,
  LinkedModelSet,
  LinkedPhenixGraph,
  LinkedRoutingGraph,
} from "./linked-graph.ts";

// Linker
export type { LinkResult } from "./linker.ts";
export { link } from "./linker.ts";
