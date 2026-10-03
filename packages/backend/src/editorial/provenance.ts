// Who wrote a reader-facing answer. In this deployment the "model" is the local fixture stub
// (tooling/brain-stub.ts): an answer built from a fixture was written and signed by a person in
// tooling/fixtures/*.jsonl, an answer built from a capability's default was assembled by a rule. The two
// are not the same kind of thing, and reader-facing prose may only come from the first. The stub marks the
// difference on the response (`usage.brain.fixture` / `usage.brain.author` / `usage.brain.rule`), which the
// provider stores on the receipt, so the judgement is checkable after the fact, not just at write time.
//
// A real provider sends no `brain` block: then there is no machine default to guard against and the normal
// gates (identity guard, Chinese check, selection thresholds) are the whole story.

export interface BrainProvenance {
  capability: string | null;
  /** The fixture id whose authored reply answered this call (null on a machine default). */
  fixture: string | null;
  /** Who signed that fixture. */
  author: string | null;
  /** `rule:*` when the answer came from the capability's default (null when a fixture answered). */
  rule: string | null;
}

const str = (value: unknown): string | null => (typeof value === "string" && value.trim() ? value.trim() : null);

/** The stub's provenance block of a provider response's `usage`, or null when the provider is not the stub. */
export function brainProvenance(usage: Record<string, unknown> | null | undefined): BrainProvenance | null {
  const brain = usage?.brain;
  if (!brain || typeof brain !== "object") return null;
  const b = brain as Record<string, unknown>;
  return { capability: str(b.capability), fixture: str(b.fixture), author: str(b.author), rule: str(b.rule) };
}

/**
 * The rule that assembled this answer, when no fixture and no author stand behind it. Callers use it to
 * keep the copy they already have instead of publishing prose nobody wrote (`null` = nothing to refuse).
 */
export function machineRuleOf(usage: Record<string, unknown> | null | undefined): string | null {
  const brain = brainProvenance(usage);
  if (!brain) return null;
  if (brain.fixture || brain.author) return null;
  return brain.rule?.startsWith("rule:") ? brain.rule : null;
}
