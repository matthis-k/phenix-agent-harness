export type MarkdownFields = Readonly<Record<string, string>>;

const FENCE = "\x60\x60\x60";

export function markdownTitle(source: string): string {
  const match = /^#\s+(.+)$/m.exec(source);
  if (!match) throw new Error("Missing definition title");
  return match[1].trim();
}

export function parseMarkdownFields(block: string): Record<string, string> {
  const fields: Record<string, string> = {};
  for (const [index, rawLine] of block.split("\n").entries()) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const separator = line.indexOf(":");
    if (separator < 1) throw new Error(`Invalid field on line ${index + 1}: ${rawLine}`);
    const key = line.slice(0, separator).trim();
    const value = unquote(line.slice(separator + 1).trim());
    if (key in fields) throw new Error(`Duplicate field ${key}`);
    fields[key] = value;
  }
  return fields;
}

export function requiredMarkdownSection(source: string, heading: string): string {
  const section = optionalMarkdownSection(source, heading);
  if (section === undefined) throw new Error(`Missing ## ${heading} section`);
  return section;
}

export function optionalMarkdownSection(source: string, heading: string): string | undefined {
  const marker = new RegExp(`^##\\s+${escapeRegExp(heading)}\\s*$`, "m").exec(source);
  if (!marker || marker.index === undefined) return undefined;
  const remainder = source.slice(marker.index + marker[0].length);
  const next = /^##\s+/m.exec(remainder);
  return remainder.slice(0, next?.index ?? remainder.length);
}

export function optionalMarkdownSubsection(source: string, heading: string): string | undefined {
  const marker = new RegExp(`^####\\s+${escapeRegExp(heading)}\\s*$`, "m").exec(source);
  if (!marker || marker.index === undefined) return undefined;
  const remainder = source.slice(marker.index + marker[0].length);
  const next = /^####\s+/m.exec(remainder);
  return remainder.slice(0, next?.index ?? remainder.length);
}

export function requiredMarkdownFence(source: string, language: string): string {
  const pattern = `${FENCE}${escapeRegExp(language)}\\s*\\n([\\s\\S]*?)\\n${FENCE}`;
  const match = new RegExp(pattern, "m").exec(source);
  if (!match) throw new Error(`Missing fenced ${language} block`);
  return match[1];
}

export function requiredMarkdownField(fields: MarkdownFields, key: string, owner: string): string {
  const value = fields[key];
  if (!value) throw new Error(`${owner} requires ${key}`);
  return value;
}

export function assertMarkdownFields(
  fields: MarkdownFields,
  allowed: readonly string[],
  owner: string,
): void {
  const known = new Set(allowed);
  for (const key of Object.keys(fields)) {
    if (!known.has(key)) throw new Error(`${owner} has unknown field ${key}`);
  }
}

export function markdownInteger(
  fields: MarkdownFields,
  key: string,
  owner: string,
  minimum: number,
): number {
  const value = requiredMarkdownField(fields, key, owner);
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < minimum) {
    throw new Error(`${owner}.${key} must be an integer greater than or equal to ${minimum}`);
  }
  return parsed;
}

export function optionalMarkdownInteger(
  fields: MarkdownFields,
  key: string,
  owner: string,
  minimum: number,
): number | undefined {
  if (!fields[key]) return undefined;
  return markdownInteger(fields, key, owner, minimum);
}

export function markdownBoolean(fields: MarkdownFields, key: string, owner: string): boolean {
  const value = requiredMarkdownField(fields, key, owner);
  if (value === "true") return true;
  if (value === "false") return false;
  throw new Error(`${owner}.${key} must be true or false`);
}

export function markdownList(fields: MarkdownFields, key: string): string[] {
  const value = fields[key]?.trim();
  if (!value) return [];
  return value
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

export function markdownEnum<const T extends readonly string[]>(
  fields: MarkdownFields,
  key: string,
  owner: string,
  allowed: T,
): T[number] {
  const value = requiredMarkdownField(fields, key, owner);
  if ((allowed as readonly string[]).includes(value)) return value as T[number];
  throw new Error(`${owner}.${key} must be one of ${allowed.join(", ")}`);
}

function unquote(value: string): string {
  const quoted =
    (value.startsWith('"') && value.endsWith('"')) ||
    (value.startsWith("'") && value.endsWith("'"));
  return quoted ? value.slice(1, -1) : value;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
