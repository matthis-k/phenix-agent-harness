import type { EventBus, ModelRegistry } from "@earendil-works/pi-coding-agent";

import type { IdGenerator } from "../ports/clock.ts";
import type { DiagnosticLog } from "../ports/diagnostic-log.ts";
import type { RoutingPolicy } from "../ports/model-resolver.ts";
import type { RunLedger } from "../ports/run-ledger.ts";

export interface PhenixHostServices {
  readonly cwd: string;
  readonly agentDir: string;
  readonly stateDir?: string;
  readonly modelRegistry: ModelRegistry;
  readonly routingPolicy?: RoutingPolicy;
  readonly piEventBus?: EventBus;
  readonly ledger?: RunLedger;
  readonly diagnostics?: DiagnosticLog;
  readonly ids?: IdGenerator;
}
