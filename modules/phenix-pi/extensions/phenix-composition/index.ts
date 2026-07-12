/**
 * phenix-composition — index
 *
 * Single composition package that imports all declaration types,
 * links them, and bootstraps the Phenix runtime.
 */

// Configuration
export type { PhenixConfiguration } from "./configuration.ts";
export { definePhenixConfiguration } from "./configuration.ts";

// Linked graph
export type {
  LinkedAgentClient,
  LinkedAgentRoute,
  LinkedModelSet,
  LinkedModelPool,
  LinkedRoutingGraph,
  LinkedWorkflowDefinition,
  LinkedPhenixGraph,
} from "./linked-graph.ts";

// Linker
export type { LinkResult } from "./linker.ts";
export { link } from "./linker.ts";
