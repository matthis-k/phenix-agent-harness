import type { ChildParentExecutionContext } from "./child-session-types.ts";

/** Explicit identity and authority source for one workflow API caller. */
export type ParentExecutionContext =
  | {
      readonly kind: "root";
      readonly sessionId: string;
      readonly cwd: string;
      readonly maximumDelegationDepth: number;
    }
  | ChildParentExecutionContext;
