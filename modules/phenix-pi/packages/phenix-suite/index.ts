/**
 * phenix-suite — public facade
 *
 * Pi registration and composition startup live in extension.ts. This facade
 * exposes stable authority, composition, and subagent APIs only.
 */

export * from "./authority/index.ts";
export * from "./authority/ports.ts";
export * from "./composition/index.ts";
export * from "./runtime/index.ts";
