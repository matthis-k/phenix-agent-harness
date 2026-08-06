import type { MemoryNote, MemoryNoteId } from "../domain/memory/model.ts";

export class MemorySearchIndex {
  private readonly postings = new Map<string, Set<MemoryNoteId>>();
  private readonly termsByNote = new Map<MemoryNoteId, ReadonlySet<string>>();

  constructor(notes: readonly MemoryNote[] = []) {
    for (const note of notes) this.upsert(note);
  }

  upsert(note: MemoryNote): void {
    this.remove(note.id);
    const terms = indexTerms(note);
    this.termsByNote.set(note.id, terms);
    for (const term of terms) {
      const posting = this.postings.get(term) ?? new Set<MemoryNoteId>();
      posting.add(note.id);
      this.postings.set(term, posting);
    }
  }

  remove(id: MemoryNoteId): void {
    const previous = this.termsByNote.get(id);
    if (!previous) return;
    for (const term of previous) {
      const posting = this.postings.get(term);
      if (!posting) continue;
      posting.delete(id);
      if (posting.size === 0) this.postings.delete(term);
    }
    this.termsByNote.delete(id);
  }

  candidates(queryTerms: readonly string[]): ReadonlySet<MemoryNoteId> | undefined {
    if (queryTerms.length === 0) return undefined;
    const result = new Set<MemoryNoteId>();
    for (const term of queryTerms) {
      for (const id of this.postings.get(term) ?? []) result.add(id);
    }
    return result;
  }

  size(): number {
    return this.termsByNote.size;
  }
}

export function normalizeMemoryTerms(query: string | undefined): readonly string[] {
  if (!query?.trim()) return [];
  return [...new Set(query.toLowerCase().match(/[\p{L}\p{N}_./:-]{2,}/gu) ?? [])];
}

function indexTerms(note: MemoryNote): ReadonlySet<string> {
  return new Set(
    normalizeMemoryTerms(
      [
        note.kind,
        note.status,
        note.retention,
        note.reliability,
        note.runId,
        ...note.objectiveIds,
        note.subject ?? "",
        note.summary,
      ].join(" "),
    ),
  );
}
