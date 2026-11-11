// Groq: open-weight GPT-OSS on Groq's fast inference, with the built-in `browser_search`
// tool (server-side, like the other vendors). Search results come back as
// `executed_tools`. The model's inline citations are browser-cursor markers like
// 【2†L6-L10】 that don't map reliably to URLs, so this adapter strips them and lists the
// sources under the answer: honest, slightly coarser attribution than the others.
// (Groq's `compound` search models were decommissioned on 2026-09-21.)
import Groq from "groq-sdk";
import { z } from "zod";
import type { Source } from "../db.ts";
import type { Provider, TurnRequest, TurnResult } from "./types.ts";

type Effort = "low" | "medium" | "high";
type ExecutedTool = NonNullable<Groq.Chat.ChatCompletion.Choice["message"]["executed_tools"]>[number];

export function groqProvider(opts: { chatModel: string; memoryModel: string; effort: Effort }): Provider {
  const client = new Groq();

  return {
    id: "groq",
    chatModel: opts.chatModel,

    async answer({ system, ledger, history, user, signal, emit, search = true, fast = false }: TurnRequest): Promise<TurnResult> {
      const stream = await client.chat.completions.create(
        {
          model: fast ? opts.memoryModel : opts.chatModel,
          messages: [
            { role: "system", content: ledger ? `${system}\n\n${ledger}` : system },
            ...history.map((h) => ({ role: h.role, content: h.text })),
            { role: "user", content: user },
          ],
          ...(search ? { tools: [{ type: "browser_search" as const }], tool_choice: "auto" as const } : {}),
          reasoning_effort: fast ? "low" : opts.effort,
          include_reasoning: true,
          max_completion_tokens: 16000,
          stream: true,
        },
        { signal },
      );

      let text = "";
      let reasoning = "";
      let lastStatus = "";
      const tools = new Map<number, ExecutedTool>();
      const searches: string[] = [];
      let finish: string | null = null;

      for await (const chunk of stream) {
        const choice = chunk.choices[0];
        if (!choice) continue;
        const d = choice.delta;
        if (d.reasoning) {
          reasoning += d.reasoning;
          // Emit only completed lines, not every token, to keep the event stream light.
          const lines = reasoning.split("\n").filter((l) => l.trim());
          const line = (reasoning.endsWith("\n") ? lines.pop() : lines[lines.length - 2])?.trim().slice(0, 160);
          if (line && line !== lastStatus) {
            lastStatus = line;
            emit({ type: "status", text: line });
          }
        }
        for (const t of d.executed_tools ?? []) {
          const prev = tools.get(t.index);
          tools.set(t.index, { ...prev, ...t } as ExecutedTool);
          const q = queryOf(t.arguments);
          if (q && !searches.includes(q)) {
            searches.push(q);
            emit({ type: "search", query: q });
          }
          const results = sourcesOf(t);
          if (results.length) emit({ type: "results", query: q ?? "", results });
        }
        if (d.content) {
          text += d.content;
          emit({ type: "text", delta: d.content });
        }
        if (choice.finish_reason) finish = choice.finish_reason;
      }

      if (finish === "content_filter") return { answer: "", sources: [], searches, refused: true };

      const seen = new Set<string>();
      const sources: Source[] = [];
      for (const t of tools.values()) {
        for (const s of sourcesOf(t)) {
          if (seen.has(s.url)) continue;
          seen.add(s.url);
          sources.push(s);
        }
      }
      return { answer: stripCursorCitations(text), sources: sources.slice(0, 12), searches };
    },

    async structured<T>(prompt: string, schema: z.ZodType<T>, name: string): Promise<T | null> {
      const res = await client.chat.completions.create({
        model: opts.memoryModel,
        messages: [{ role: "user", content: prompt }],
        response_format: { type: "json_schema", json_schema: { name, schema: z.toJSONSchema(schema) as Record<string, unknown> } },
        reasoning_effort: "low",
      });
      const parsed = schema.safeParse(JSON.parse(res.choices[0]?.message.content ?? "null"));
      return parsed.success ? parsed.data : null;
    },

    describeError(err) {
      if (err instanceof Groq.AuthenticationError) return "The Groq API key is invalid. Check GROQ_API_KEY in .env.";
      if (err instanceof Groq.RateLimitError) {
        // Free-tier limits are per day as well as per minute; say which, and when it resets.
        const daily = /tokens per day|requests per day/i.test(err.message);
        const wait = /try again in ([\dhms.]+)/i.exec(err.message)?.[1]?.replace(/\.\d+s$/, "s");
        return `Groq ${daily ? "daily" : "per-minute"} rate limit reached${wait ? ` - try again in ${wait}` : ""}, or switch model.`;
      }
      if (err instanceof Groq.APIError) return `Groq API error (${err.status ?? "network"}): ${err.message}`;
      return null;
    },
  };
}

function queryOf(args: string | undefined): string | null {
  if (!args) return null;
  try {
    const a = JSON.parse(args) as Record<string, unknown>;
    const q = a.query ?? a.q ?? a.search_query;
    return typeof q === "string" && q.trim() ? q.trim() : null;
  } catch {
    return null;
  }
}

function sourcesOf(t: ExecutedTool): Source[] {
  const out: Source[] = [];
  for (const r of t.search_results?.results ?? []) {
    const x = r as { url?: string; title?: string };
    if (x.url) out.push({ url: x.url, title: x.title || x.url });
  }
  for (const r of t.browser_results ?? []) if (r.url) out.push({ url: r.url, title: r.title || r.url });
  return out;
}

/** Remove GPT-OSS browser cursor markers such as 【2†L6-L10】 or 【3†source】. */
export function stripCursorCitations(text: string): string {
  return text
    .replace(/\s?【[^】]*†[^】]*】/g, "")
    .replace(/[ \t]+\n/g, "\n")
    .trim();
}
