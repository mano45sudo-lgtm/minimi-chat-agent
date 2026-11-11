// After each answer, a small model distills the turn into durable memory: a summary, the
// concrete facts we asserted (with sources), and entities. This runs off the critical path
// (the user already has their answer) and is what makes "has anything changed since?"
// answerable: we compare *what we said then* against *what the web says now*.
import { z } from "zod";
import { store, type Turn } from "./db.ts";
import type { Provider } from "./providers/types.ts";

const Distillation = z.object({
  thread_title: z.string().describe("3-7 word title for the conversation, e.g. 'CRM shortlist for 20-person sales team'"),
  summary: z.string().describe("1-3 sentences: what the user wanted and what the assistant concluded"),
  entities: z.array(z.string()).describe("Products, companies, people, technologies discussed"),
  claims: z
    .array(
      z.object({
        subject: z.string().describe("What the fact is about, e.g. 'HubSpot Sales Hub Starter'"),
        fact: z.string().describe("The checkable fact, with numbers/dates verbatim, e.g. '$20/seat/month billed annually'"),
        source_url: z.string().nullable(),
      }),
    )
    .describe("Every concrete, time-sensitive fact the assistant asserted (prices, plans, versions, dates, limits). Max 15."),
});

export async function distillTurn(
  provider: Provider,
  turnId: number,
  turn: Pick<Turn, "userText" | "answer" | "sources" | "threadId">,
) {
  const sources = turn.sources.map((s, i) => `[${i + 1}] ${s.url}`).join("\n");
  const prompt = `Distill this chat turn into memory. Copy facts exactly as stated in the answer; do not add facts.\n\n<question>\n${turn.userText}\n</question>\n\n<answer>\n${turn.answer}\n</answer>\n\n<sources>\n${sources || "(none)"}\n</sources>`;
  try {
    const d = await provider.structured(prompt, Distillation, "distillation");
    if (!d) return;
    store.saveDistillation(turnId, {
      summary: d.summary,
      entities: d.entities.slice(0, 20),
      claims: d.claims.slice(0, 15).map((c) => ({ subject: c.subject, fact: c.fact, sourceUrl: c.source_url })),
    });
    store.setThreadTitle(turn.threadId, d.thread_title);
  } catch (err) {
    // Memory degrades gracefully: the raw answer is already indexed and recallable.
    console.warn(`[distill] turn ${turnId} failed:`, err instanceof Error ? err.message : err);
  }
}
