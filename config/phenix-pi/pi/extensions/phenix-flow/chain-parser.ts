/**
 * chain-parser.ts — Parse chain files (.chain.md and .chain.json) into ChainStep arrays.
 *
 * Extracted from index.ts to reduce file size and cognitive complexity.
 */

import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import type { ChainStep, Difficulty } from "./types.js";

/**
 * Resolve the chain file path for a difficulty level.
 * Checks for .chain.md first, then .chain.json.
 */
export function resolveChainFile(
	difficulty: Difficulty,
	configDir: string,
): string | null {
	const name = chainFileName(difficulty);
	const candidates = [
		resolve(configDir, "chains", name + ".chain.md"),
		resolve(configDir, "chains", name + ".chain.json"),
	];
	for (const f of candidates) {
		if (existsSync(f)) return f;
	}
	return null;
}

/** Map difficulty to chain file base name. */
function chainFileName(difficulty: Difficulty): string {
	if (difficulty === "D0") return "phenix-d0";
	if (difficulty === "D3") return "phenix-d3";
	if (difficulty === "D2") return "phenix-d2";
	return "phenix-d1";
}

/**
 * Parse a chain file into an ordered array of ChainStep.
 * Handles both .chain.json (with optional parallel groups) and .chain.md formats.
 *
 * Cognitive complexity kept low by dispatching to dedicated parsers immediately.
 */
export function parseChainSteps(filePath: string): ChainStep[] {
	const content = readFileSync(filePath, "utf-8").trim();

	if (filePath.endsWith(".json")) {
		return parseJsonChain(content);
	}

	return parseMarkdownChain(content);
}

/** Parse a JSON-format chain file. */
function parseJsonChain(content: string): ChainStep[] {
	try {
		const parsed = JSON.parse(content);
		const raw = parsed.chain ?? [];
		const steps: ChainStep[] = [];

		for (const s of raw) {
			if (s.parallel) {
				// Flatten parallel groups into sequential steps
				for (const p of s.parallel) {
					steps.push(stepFromJsonEntry(p));
				}
			} else {
				steps.push(stepFromJsonEntry(s));
			}
		}
		return steps;
	} catch {
		return [];
	}
}

/** Convert a single JSON chain entry (parallel or top-level) into a ChainStep. */
function stepFromJsonEntry(entry: Record<string, unknown>): ChainStep {
	return {
		agent: (entry.agent as string) ?? "unknown",
		phase: (entry.phase as string) ?? "",
		label: (entry.label as string) ?? "",
		as: entry.as as string | undefined,
		output: entry.output as string | undefined,
		outputMode: entry.outputMode as string | undefined,
		model: entry.model as string | undefined,
		thinking: entry.thinking as string | undefined,
		instruction: (entry.task ?? entry.instruction ?? "") as string,
	};
}

/** Parse a Markdown-format chain file (## agent-name blocks). */
function parseMarkdownChain(content: string): ChainStep[] {
	const steps: ChainStep[] = [];
	const blocks = content.split(/^## /m).slice(1);

	for (const block of blocks) {
		const lines = block.split("\n");
		const agent = lines[0]?.trim() ?? "unknown";

		// Split header (key: value lines) from body (instruction text)
		const bodyStart = lines.findIndex(
			(l: string) => l.trim() && !l.includes(":"),
		);
		const headerLines =
			bodyStart > 0 ? lines.slice(1, bodyStart) : lines.slice(1);
		const bodyLines = bodyStart > 0 ? lines.slice(bodyStart) : lines.slice(1);

		steps.push({
			agent,
			phase: readHeader(headerLines, "phase") ?? "",
			label: readHeader(headerLines, "label") ?? "",
			as: readHeader(headerLines, "as"),
			output: readHeader(headerLines, "output"),
			outputMode: readHeader(headerLines, "outputMode"),
			model: readHeader(headerLines, "model"),
			thinking: readHeader(headerLines, "thinking"),
			instruction: bodyLines.join("\n").trim(),
		});
	}

	return steps;
}

/** Extract a header value by key from a list of "key: value" lines. */
function readHeader(lines: string[], key: string): string | undefined {
	const prefix = `${key}:`;
	for (const l of lines) {
		if (l.startsWith(prefix)) return l.slice(prefix.length).trim();
	}
	return undefined;
}
