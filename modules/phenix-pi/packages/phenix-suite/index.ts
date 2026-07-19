/**
 * phenix-suite — public facade
 *
 * Pi registration and composition startup live in extension.ts. This facade
 * exposes only the stable composition and subagent APIs.
 */

export * from "./composition/index.ts";
export * from "./runtime/index.ts";
