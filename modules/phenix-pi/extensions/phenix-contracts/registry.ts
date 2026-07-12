/**
 * phenix-contracts — registry
 *
 * In-memory registry of compiled contract definitions.
 */

import type { ContractDefinitionId } from "../phenix-kernel/ids.ts";
import type {
  ContractDefinition,
  CompiledContract,
  ContractValidationResult,
} from "./definitions.ts";
import { validateContract } from "./validator.ts";

// ── Compile ────────────────────────────────────────────────────────────────

function compile<T>(definition: ContractDefinition<T>): CompiledContract<T> {
  return {
    definition,
    validate(value: unknown): ContractValidationResult<T> {
      return validateContract(definition, value);
    },
  };
}

// ── Registry ───────────────────────────────────────────────────────────────

export class ContractRegistry {
  private readonly contracts = new Map<
    ContractDefinitionId,
    CompiledContract
  >();

  register<T>(definition: ContractDefinition<T>): void {
    const compiled = compile(definition);
    if (this.contracts.has(definition.id)) {
      throw new Error(
        `Duplicate contract definition ID: "${definition.id}"`,
      );
    }
    this.contracts.set(definition.id, compiled);
  }

  get<T = unknown>(
    id: ContractDefinitionId,
  ): CompiledContract<T> | undefined {
    return this.contracts.get(id) as CompiledContract<T> | undefined;
  }

  require<T = unknown>(
    id: ContractDefinitionId,
  ): CompiledContract<T> {
    const contract = this.get<T>(id);
    if (!contract) {
      throw new Error(`Contract definition not found: "${id}"`);
    }
    return contract;
  }

  validate<T = unknown>(
    id: ContractDefinitionId,
    value: unknown,
  ): ContractValidationResult<T> {
    const contract = this.require<T>(id);
    return contract.validate(value);
  }

  get idCount(): number {
    return this.contracts.size;
  }
}
