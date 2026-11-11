// The seam between the agent and a model vendor. Everything above this line - time,
// recall, prompt, persistence, UI - is provider-agnostic. A provider only has to:
//   1. answer one turn with its own native web search, streaming progress as AgentEvents
//   2. return the final text with numbered citations and the sources behind them
//   3. produce schema-valid JSON for background memory distillation
import type { z } from "zod";
import type { Source } from "../db.ts";
import type { UserClock } from "../time.ts";

export type AgentEvent =
  | { type: "thread"; threadId: string }
  | { type: "recall"; dates: string[]; turns: Array<{ date: string; question: string }> }
  | { type: "status"; text: string }
  | { type: "search"; query: string }
  | { type: "results"; query: string; results: Source[]; error?: string }
  | { type: "text"; delta: string }
  | { type: "final"; turnId: number; answer: string; sources: Source[]; model: string }
  | { type: "error"; message: string };

export interface TurnRequest {
  /** Static instructions (cacheable). */
  system: string;
  /** Conversation ledger: changes only when threads change. */
  ledger: string;
  /** Prior turns of this thread, as text. */
  history: Array<{ role: "user" | "assistant"; text: string }>;
  /** This turn: grounding <context> block + the user's message. */
  user: string;
  clock: UserClock;
  signal?: AbortSignal;
  emit: (e: AgentEvent) => void;
}

export interface TurnResult {
  /** Markdown with citations rendered as ` [n](url)` links. */
  answer: string;
  sources: Source[];
  searches: string[];
  /** The vendor declined to answer (safety). */
  refused?: boolean;
}

export interface Provider {
  id: "anthropic" | "openai" | "gemini" | "groq";
  /** Model that talks to the user. */
  chatModel: string;
  answer(req: TurnRequest): Promise<TurnResult>;
  /** Cheap model, JSON constrained to `schema`. Used off the critical path. */
  structured<T>(prompt: string, schema: z.ZodType<T>, name: string): Promise<T | null>;
  /** Map vendor errors to a short user-facing message, or null if unknown. */
  describeError(err: unknown): string | null;
}

/** Turn citation spans into ` [n](url)` markers inserted at each span's end. */
export function renderCitations(
  text: string,
  spans: Array<{ end: number; sources: Source[] }>,
  known: Map<string, Source> = new Map(),
): { answer: string; sources: Source[] } {
  const sources: Source[] = [];
  const index = new Map<string, number>();
  const number = (s: Source) => {
    let n = index.get(s.url);
    if (n === undefined) {
      sources.push(known.get(s.url) ?? s);
      n = sources.length;
      index.set(s.url, n);
    }
    return n;
  };
  // Number in reading order, then insert from the end so earlier offsets stay valid.
  const marks = [...spans]
    .sort((a, b) => a.end - b.end)
    .map((s) => ({ end: s.end, nums: [...new Set(s.sources.map(number))] }));
  let out = text;
  for (const m of marks.reverse()) {
    if (!m.nums.length) continue;
    const at = snapToWordEnd(out, m.end);
    out = out.slice(0, at) + m.nums.map((n) => ` [${n}](${sources[n - 1]!.url})`).join("") + out.slice(at);
  }
  return { answer: out.trim(), sources };
}

// Keep markers outside markdown tokens: move past closing punctuation like ** or ).
function snapToWordEnd(text: string, i: number): number {
  let at = Math.max(0, Math.min(i, text.length));
  while (at < text.length && /[*_)\].,;:!?%]/.test(text[at]!)) at++;
  return at;
}
