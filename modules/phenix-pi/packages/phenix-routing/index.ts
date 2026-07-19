/**
 * phenix-routing — public facade
 *
 * Pi registration lives exclusively in extension.ts. This facade exposes
 * passive routing state and lookup interfaces only.
 */

export { modelRegistry } from "./registry.ts";
export {
  getActiveRouteForSession,
  setActiveRouteForSession,
} from "./stream-proxy.ts";
