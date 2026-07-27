import {
  isStructuredDocument,
  type StructuredContentNode,
  type StructuredDocument,
} from "../domain/presentation/structured-content.ts";
import type { ResultTransformStep } from "./result-presentation.ts";

interface RenderContext {
  readonly headingLevel: number;
  readonly listDepth: number;
}

export const structuredContentContractStep: ResultTransformStep = {
  id: "structured-content-contract",
  inputKind: "contract",
  outputKind: "structured-content",
  transform(input) {
    return input.kind === "contract" && isStructuredDocument(input.value)
      ? { kind: "structured-content", document: input.value }
      : undefined;
  },
};

export const structuredContentMarkdownStep: ResultTransformStep = {
  id: "structured-content-markdown",
  inputKind: "structured-content",
  outputKind: "markdown",
  transform(input) {
    return input.kind === "structured-content"
      ? { kind: "markdown", content: renderStructuredContentMarkdown(input.document) }
      : undefined;
  },
};

export function renderStructuredContentMarkdown(document: StructuredDocument): string {
  const headingLevel = document.content?.trim() ? 2 : 1;
  const body = renderChildren(document.children, { headingLevel, listDepth: 0 });
  return [document.content?.trim() ? `# ${document.content.trim()}` : "", body]
    .filter(Boolean)
    .join("\n\n");
}

function renderNode(node: StructuredContentNode, context: RenderContext): string {
  switch (node.contentType) {
    case "document":
      return renderStructuredContentMarkdown(node as StructuredDocument);
    case "section":
      return renderSection(node, context);
    case "paragraph":
      return node.content?.trim() ?? "";
    case "blockquote":
      return quote(node.content ?? "");
    case "unordered-list":
      return renderList(node, false, context);
    case "ordered-list":
      return renderList(node, true, context);
    case "list-item":
      return renderListItem(node, "-", context);
    case "table":
      return renderTable(node);
    case "code-block":
      return fencedCode(node.content ?? "");
    case "horizontal-rule":
      return "---";
    case "table-row":
    case "table-cell":
      return node.content?.trim() ?? renderChildren(node.children, context);
  }
}

function renderSection(node: StructuredContentNode, context: RenderContext): string {
  const title = node.content?.trim();
  const heading = title ? `${"#".repeat(Math.min(6, context.headingLevel))} ${title}` : "";
  const body = renderChildren(node.children, {
    ...context,
    headingLevel: Math.min(6, context.headingLevel + 1),
  });
  return [heading, body].filter(Boolean).join("\n\n");
}

function renderChildren(
  children: readonly StructuredContentNode[] | undefined,
  context: RenderContext,
): string {
  return (children ?? [])
    .map((child) => renderNode(child, context))
    .filter((content) => content.length > 0)
    .join("\n\n");
}

function renderList(
  node: StructuredContentNode,
  ordered: boolean,
  context: RenderContext,
): string {
  const marker = ordered ? "0." : "-";
  return (node.children ?? [])
    .filter((child) => child.contentType === "list-item")
    .map((item) => renderListItem(item, marker, context))
    .join("\n");
}

function renderListItem(
  node: StructuredContentNode,
  marker: string,
  context: RenderContext,
): string {
  const indent = "  ".repeat(context.listDepth);
  const lines = [`${indent}${marker}${node.content?.trim() ? ` ${node.content.trim()}` : ""}`];
  for (const child of node.children ?? []) {
    if (child.contentType === "ordered-list" || child.contentType === "unordered-list") {
      lines.push(
        renderNode(child, {
          ...context,
          listDepth: context.listDepth + 1,
        }),
      );
      continue;
    }
    const rendered = renderNode(child, context);
    if (!rendered) continue;
    const childIndent = `${indent}   `;
    lines.push(
      rendered
        .split("\n")
        .map((line) => (line ? `${childIndent}${line}` : ""))
        .join("\n"),
    );
  }
  return lines.join("\n");
}

function renderTable(node: StructuredContentNode): string {
  const rows = (node.children ?? [])
    .filter((child) => child.contentType === "table-row")
    .map((row) =>
      (row.children ?? [])
        .filter((child) => child.contentType === "table-cell")
        .map((cell) => markdownCell(cell.content ?? "")),
    );
  if (rows.length === 0) return "";

  const width = Math.max(...rows.map((row) => row.length));
  const normalized = rows.map((row) => [
    ...row,
    ...Array.from({ length: width - row.length }, () => ""),
  ]);
  const [header, ...body] = normalized;
  return [
    `| ${header.join(" | ")} |`,
    `|${header.map(() => "---").join("|")}|`,
    ...body.map((row) => `| ${row.join(" | ")} |`),
  ].join("\n");
}

function markdownCell(value: string): string {
  return value.trim().replaceAll("|", "\\|").replace(/\r?\n/g, "<br>");
}

function quote(value: string): string {
  return value
    .trim()
    .split(/\r?\n/)
    .map((line) => `> ${line}`)
    .join("\n");
}

function fencedCode(value: string): string {
  const longestFence = Math.max(0, ...(value.match(/`+/g) ?? []).map((run) => run.length));
  const fence = "`".repeat(Math.max(3, longestFence + 1));
  return `${fence}\n${value}\n${fence}`;
}
