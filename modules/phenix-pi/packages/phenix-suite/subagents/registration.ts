import type { PhenixSubagentFacade } from "./facade.ts";

/** Public registration dependency; concrete delegation/store internals stay behind the facade. */
export interface PhenixSubagentsOptions {
  readonly facade: PhenixSubagentFacade;
}
