/**
 * phenix-routing — public facade
 *
 * Pi registration lives in extension.ts. The default export remains the
 * registration interface; routing implementation stays in focused modules.
 */

export { default, default as registerPhenixRouting } from "./extension.ts";
export { modelRegistry } from "./registry.ts";
export {
  getActiveRouteForSession,
  setActiveRouteForSession,
} from "./stream-proxy.ts";
