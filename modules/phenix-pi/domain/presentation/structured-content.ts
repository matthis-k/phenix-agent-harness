export const STRUCTURED_CONTENT_TYPES = [
  "document",
  "section",
  "paragraph",
  "blockquote",
  "unordered-list",
  "ordered-list",
  "list-item",
  "table",
  "table-row",
  "table-cell",
  "code-block",
  "horizontal-rule",
] as const;

export type StructuredContentType = (typeof STRUCTURED_CONTENT_TYPES)[number];

export interface StructuredContentNode {
  readonly contentType: StructuredContentType;
  readonly content?: string;
  readonly children?: readonly StructuredContentNode[];
}

export interface StructuredDocument extends StructuredContentNode {
  readonly contentType: "document";
}

export function isStructuredDocument(value: unknown): value is StructuredDocument {
  return isStructuredContentNode(value) && value.contentType === "document";
}

export function isStructuredContentNode(value: unknown): value is StructuredContentNode {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const node = value as Readonly<Record<string, unknown>>;
  if (!STRUCTURED_CONTENT_TYPES.includes(node.contentType as StructuredContentType)) return false;
  if (node.content !== undefined && typeof node.content !== "string") return false;
  return (
    node.children === undefined ||
    (Array.isArray(node.children) && node.children.every(isStructuredContentNode))
  );
}
