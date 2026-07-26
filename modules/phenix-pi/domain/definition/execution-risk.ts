const SENSITIVE_TEXT_PATTERNS = [
  ["secret", /(?:^|[^a-z0-9])secrets?\b/i],
  ["credential", /(?:^|[^a-z0-9])credentials?\b/i],
  ["password", /(?:^|[^a-z0-9])passwords?\b/i],
  ["passphrase", /(?:^|[^a-z0-9])passphrases?\b/i],
  ["token", /(?:^|[^a-z0-9])tokens?\b/i],
  ["api key", /\bapi[-_\s]?keys?\b/i],
  ["private key", /\bprivate[-_\s]?keys?\b/i],
  ["jwt", /(?:^|[^a-z0-9])jwts?\b/i],
  ["authentication", /\bauthentication\b/i],
  ["authorization", /\bauthorization\b/i],
  ["security", /\bsecurity\b/i],
  ["deployment", /\bdeployment\b/i],
  ["production", /\bproduction\b/i],
  ["release", /\brelease\b/i],
  ["main-bound", /\bmain[-_\s]?bound\b/i],
] as const satisfies readonly (readonly [label: string, pattern: RegExp])[];

const SENSITIVE_PATHS = [
  /(?:^|\/)\.github\/workflows(?:\/|$)/i,
  /(?:^|\/)(?:secrets?|credentials?|auth)(?:[./_-]|$)/i,
  /(?:^|\/)(?:deploy|deployment|production|release)(?:[./_-]|$)/i,
] as const;

const FREE_MODEL_BLOCKED_COMMANDS = [
  /\bgit\s+push\b/i,
  /\bgh\s+pr\s+merge\b/i,
  /\bgit\s+merge\b/i,
  /\bgit\s+(?:switch|checkout)\s+(?:main|master)\b/i,
  /\bgit\s+reset\s+--hard\b/i,
  /\bgit\s+clean\b(?=[^\r\n]*\s-[a-z]*f)(?=[^\r\n]*\s-[a-z]*d)/i,
  /\bgit\s+branch\s+(?:-[A-Za-z]*D[A-Za-z]*|--delete\s+--force)\b/,
  /\bnix\s+flake\s+update\b/i,
  /\b(?:deploy|release)\b/i,
] as const;

const EXPLICIT_RISK_KEYS = new Set([
  "secrecy",
  "changeKind",
  "targetState",
  "environment",
  "risk",
  "sensitivity",
]);

const EXPLICIT_RISK_VALUES = new Set([
  "private",
  "secret",
  "security",
  "auth",
  "authentication",
  "authorization",
  "ci",
  "deployment",
  "production",
  "release",
  "main-bound",
]);

export interface ExecutionRiskAssessment {
  readonly sensitive: boolean;
  readonly reasons: readonly string[];
}

export function assessExecutionRisk(value: unknown): ExecutionRiskAssessment {
  const reasons = new Set<string>();
  visit(value, reasons, 0, "input");
  return { sensitive: reasons.size > 0, reasons: [...reasons] };
}

export function assessRootMutation(input: {
  readonly userText?: string;
  readonly toolName: string;
  readonly toolInput: unknown;
}): ExecutionRiskAssessment {
  const reasons = new Set<string>();
  visit(input.userText, reasons, 0, "user request");
  visit(input.toolInput, reasons, 0, `${input.toolName} input`);

  const serialized = stringsFrom(input.toolInput).join("\n");
  for (const pattern of SENSITIVE_PATHS) {
    if (pattern.test(serialized)) reasons.add(`sensitive path matched ${pattern.source}`);
  }
  if (input.toolName === "bash" || input.toolName === "nix_shell") {
    for (const pattern of FREE_MODEL_BLOCKED_COMMANDS) {
      if (pattern.test(serialized)) reasons.add(`sensitive command matched ${pattern.source}`);
    }
  }
  return { sensitive: reasons.size > 0, reasons: [...reasons] };
}

function visit(value: unknown, reasons: Set<string>, depth: number, path: string): void {
  if (depth > 5 || reasons.size >= 12 || value === null || value === undefined) return;
  if (typeof value === "string") {
    for (const [label, pattern] of SENSITIVE_TEXT_PATTERNS) {
      if (pattern.test(value)) reasons.add(`${path} mentions ${label}`);
    }
    for (const pattern of SENSITIVE_PATHS) {
      if (pattern.test(value)) reasons.add(`${path} contains a sensitive path`);
    }
    return;
  }
  if (Array.isArray(value)) {
    for (const [index, item] of value.slice(0, 64).entries()) {
      visit(item, reasons, depth + 1, `${path}[${index}]`);
    }
    return;
  }
  if (typeof value !== "object") return;

  for (const [key, child] of Object.entries(value).slice(0, 64)) {
    if (
      EXPLICIT_RISK_KEYS.has(key) &&
      typeof child === "string" &&
      EXPLICIT_RISK_VALUES.has(child.toLowerCase())
    ) {
      reasons.add(`${path}.${key}=${child}`);
    }
    visit(child, reasons, depth + 1, `${path}.${key}`);
  }
}

function stringsFrom(value: unknown): string[] {
  const output: string[] = [];
  collectStrings(value, output, 0);
  return output;
}

function collectStrings(value: unknown, output: string[], depth: number): void {
  if (depth > 4 || output.length >= 64 || value === null || value === undefined) return;
  if (typeof value === "string") {
    output.push(value);
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value.slice(0, 64)) collectStrings(item, output, depth + 1);
    return;
  }
  if (typeof value === "object") {
    for (const item of Object.values(value).slice(0, 64)) {
      collectStrings(item, output, depth + 1);
    }
  }
}
