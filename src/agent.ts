// One user turn, end to end, independent of the model vendor:
//   recall (code) → prompt assembly → provider.answer (streamed, native web search)
//   → persist → background distillation.
import { store } from "./db.ts";
import { distillTurn } from "./distill.ts";
import { recall, renderContext, renderLedger } from "./memory.ts";
import { SYSTEM_PROMPT } from "./prompt.ts";
import { getProvider } from "./providers/index.ts";
import type { AgentEvent, TurnResult } from "./providers/types.ts";
import { localDate, type UserClock } from "./time.ts";
import { claimsToCheck, linkCitations, renderFallback, renderVerification, runChecks, wantsVerification } from "./verify.ts";

export type { AgentEvent };

/** Words that mean the answer depends on the world now, not just on what was said. */
const NEEDS_FRESH_DATA = /\b(now|today|current(ly)?|latest|price|pricing|cost|news|release[ds]?|version)\b/i;

export interface TurnInput {
  threadId: string | null;
  message: string;
  clock: UserClock;
  /** anthropic | openai | gemini; defaults to PROVIDER / first configured. */
  provider?: string | null;
  /** Per-message reasoning depth from the UI. */
  effort?: "low" | "medium" | "high";
  signal?: AbortSignal;
  emit: (e: AgentEvent) => void;
}

export async function runTurn({ threadId, message, clock, provider: providerId, effort, signal, emit }: TurnInput): Promise<void> {
  const provider = getProvider(providerId);
  if (!provider) {
    emit({ type: "error", message: "No model provider is configured. Set an API key in .env (see .env.example) and restart." });
    return;
  }

  const thread = (threadId && store.getThread(threadId)) || store.createThread(clock.now.getTime());
  emit({ type: "thread", threadId: thread.id });

  // 1. Recall, deterministically, before the model runs.
  const r = recall(message, clock, thread.id);
  if (r.turns.length || r.emptyRefs.length) {
    emit({
      type: "recall",
      dates: (r.turns.length ? r.dateRefs : r.emptyRefs)
        .flatMap((d) => (d.alternative ? [d, d.alternative] : [d]))
        .map((d) => (d.from === d.to ? d.from : `${d.from}..${d.to}`)),
      turns: r.turns.map((t) => ({ date: t.localDate, question: t.userText.slice(0, 120) })),
    });
  }
  const promptText = renderContext(message, clock, r);

  // 2. Prior turns are replayed as compact text (question-as-sent + final cited answer),
  //    not raw search payloads: small, fast, vendor-neutral (a thread can switch models
  //    mid-conversation), and byte-stable so prefix caches keep hitting.
  const history = store.threadTurns(thread.id).flatMap((t) => [
    { role: "user" as const, text: t.promptText },
    { role: "assistant" as const, text: t.answer || "(no answer)" },
  ]);

  // 3. Route. The shape of the question decides how much work it needs:
  //    verify   - "still correct?" / "changed since?" with recorded claims → parallel
  //               per-claim checks, then a no-search reply written from the results.
  //    recall   - "what did I ask on 3 Nov?" → answerable from memory alone: fast model,
  //               no search.
  //    research - everything else → main model with its native search loop.
  const searches: string[] = [];
  const tap = (e: AgentEvent) => {
    if (e.type === "search") searches.push(e.query);
    emit(e);
  };
  const base = { system: SYSTEM_PROMPT, ledger: renderLedger(clock, thread.id), history, clock, signal, effort, emit: tap };
  const claims = claimsToCheck(r.turns);
  const verify = claims.length > 0 && wantsVerification(message);
  const memoryOnly = !verify && r.turns.length > 0 && r.refersToPast && !NEEDS_FRESH_DATA.test(message);

  let result: TurnResult;
  let sentText = promptText;
  if (verify) {
    emit({ type: "status", text: `Re-checking ${claims.length} recorded fact${claims.length > 1 ? "s" : ""} in parallel…` });
    const checks = await runChecks(provider, claims, clock, signal, tap);
    const { block, sources } = renderVerification(claims, checks, clock);
    sentText = `${promptText}\n\n${block}`;
    try {
      const reply = await provider.answer({ ...base, user: sentText, search: false });
      result = { ...reply, answer: linkCitations(reply.answer, sources), sources };
    } catch (err) {
      if (signal?.aborted) throw err;
      console.warn("[verify] reply model failed, using deterministic summary:", describeError(err, providerId));
      result = { answer: renderFallback(claims, checks, sources), sources, searches: [] };
    }
  } else {
    result = await provider.answer({ ...base, user: promptText, search: !memoryOnly, fast: memoryOnly });
  }
  result.searches = [...new Set([...searches, ...result.searches])];

  if (result.refused) {
    emit({ type: "error", message: "I can't help with that request." });
    return;
  }
  if (!result.answer.trim()) {
    emit({ type: "error", message: "The model returned an empty answer. Please try again." });
    return;
  }

  // 4. Persist.
  const turnId = store.insertTurn({
    threadId: thread.id,
    createdAt: clock.now.getTime(),
    localDate: localDate(clock.now, clock.offsetMin),
    userText: message,
    promptText: sentText,
    answer: result.answer,
    sources: result.sources,
    searches: result.searches,
    model: `${provider.id}/${provider.chatModel}`,
  });
  emit({ type: "final", turnId, answer: result.answer, sources: result.sources, model: provider.chatModel });

  // 5. Distill into durable memory - after the user already has the answer.
  void distillTurn(provider, turnId, { userText: message, answer: result.answer, sources: result.sources, threadId: thread.id });
}

export function describeError(err: unknown, providerId?: string | null): string {
  const p = getProvider(providerId);
  const known = p?.describeError(err);
  if (known) return known;
  if (err instanceof Error && err.name === "AbortError") return "Cancelled.";
  return err instanceof Error ? err.message : String(err);
}
