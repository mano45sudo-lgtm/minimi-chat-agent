// Anthropic: Claude with the server-side web_search tool. Searches run inside the model
// request (no client round trips); a long search loop may return pause_turn, which we resume.
import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import type { BetaContentBlock, BetaMessage, BetaMessageParam } from "@anthropic-ai/sdk/resources/beta/messages/messages";
import type { z } from "zod";
import type { Source } from "../db.ts";
import type { Provider, TurnRequest, TurnResult } from "./types.ts";

const MAX_CONTINUATIONS = 4;
const BETAS = [
  "server-side-fallback-2026-07-01", // retry on a fallback model instead of a bare refusal
  "thinking-display-updates-2026-08-18", // short progress notes between searches, for the UI
];

type Effort = "low" | "medium" | "high" | "xhigh" | "max";

export function anthropicProvider(opts: { chatModel: string; memoryModel: string; effort: Effort; maxSearches: number }): Provider {
  const client = new Anthropic();

  return {
    id: "anthropic",
    chatModel: opts.chatModel,

    async answer({ system, ledger, history, user, clock, signal, emit }: TurnRequest): Promise<TurnResult> {
      const messages: BetaMessageParam[] = [
        ...history.map((h) => ({ role: h.role, content: h.text })),
        { role: "user", content: user },
      ];
      const blocks: BetaContentBlock[] = [];
      const searches: string[] = [];
      const pageAges = new Map<string, string | null>();
      const queriesById = new Map<string, string>();
      let final: BetaMessage | null = null;

      for (let i = 0; i <= MAX_CONTINUATIONS; i++) {
        const stream = client.beta.messages.stream(
          {
            model: opts.chatModel,
            max_tokens: 32000,
            betas: BETAS,
            fallbacks: "default",
            thinking: { type: "adaptive", display: "updates" },
            output_config: { effort: opts.effort },
            cache_control: { type: "ephemeral" }, // auto-cache the conversation prefix
            system: [
              { type: "text", text: system, cache_control: { type: "ephemeral" } },
              { type: "text", text: ledger },
            ],
            tools: [
              {
                type: "web_search_20260209",
                name: "web_search",
                max_uses: opts.maxSearches,
                ...(clock.timeZone ? { user_location: { type: "approximate" as const, timezone: clock.timeZone } } : {}),
              },
            ],
            messages,
          },
          { signal },
        );
        stream.on("text", (delta) => emit({ type: "text", delta }));
        stream.on("thinking", (_d, snapshot) => {
          const note = snapshot.trim().split("\n").pop()?.trim();
          if (note) emit({ type: "status", text: note.slice(0, 160) });
        });
        stream.on("contentBlock", (block) => {
          if (block.type === "server_tool_use" && block.name === "web_search") {
            const query = String((block.input as { query?: unknown }).query ?? "");
            queriesById.set(block.id, query);
            searches.push(query);
            emit({ type: "search", query });
          } else if (block.type === "web_search_tool_result") {
            const query = queriesById.get(block.tool_use_id) ?? "";
            if (Array.isArray(block.content)) {
              const results = block.content.map((x) => ({ url: x.url, title: x.title, pageAge: x.page_age }));
              for (const x of results) pageAges.set(x.url, x.pageAge ?? null);
              emit({ type: "results", query, results });
            } else {
              emit({ type: "results", query, results: [], error: block.content.error_code });
            }
          }
        });

        final = await stream.finalMessage();
        blocks.push(...final.content);
        if (final.stop_reason !== "pause_turn") break;
        messages.push({ role: "assistant", content: final.content });
      }

      if (final?.stop_reason === "refusal") return { answer: "", sources: [], searches, refused: true };
      return { ...renderBlocks(blocks, pageAges), searches };
    },

    async structured<T>(prompt: string, schema: z.ZodType<T>): Promise<T | null> {
      const res = await client.messages.parse({
        model: opts.memoryModel,
        max_tokens: 4000,
        output_config: { format: zodOutputFormat(schema), effort: "low" },
        messages: [{ role: "user", content: prompt }],
      });
      return (res.parsed_output as T | null) ?? null;
    },

    describeError(err) {
      if (err instanceof Anthropic.AuthenticationError) return "The Anthropic API key is invalid. Check ANTHROPIC_API_KEY in .env.";
      if (err instanceof Anthropic.RateLimitError) return "Rate limited by Anthropic. Please retry in a moment.";
      if (err instanceof Anthropic.APIError) return `Anthropic API error (${err.status ?? "network"}): ${err.message}`;
      return null;
    },
  };
}

/** Claude splits text into blocks at citation boundaries; cite each block at its end. */
function renderBlocks(blocks: BetaContentBlock[], pageAges: Map<string, string | null>) {
  const sources: Source[] = [];
  const index = new Map<string, number>();
  let answer = "";
  for (const b of blocks) {
    if (b.type !== "text") continue;
    answer += b.text;
    const nums: number[] = [];
    for (const c of b.citations ?? []) {
      if (c.type !== "web_search_result_location") continue;
      let n = index.get(c.url);
      if (n === undefined) {
        sources.push({ url: c.url, title: c.title ?? c.url, pageAge: pageAges.get(c.url) ?? null });
        n = sources.length;
        index.set(c.url, n);
      }
      if (!nums.includes(n)) nums.push(n);
    }
    if (nums.length) answer += nums.map((n) => ` [${n}](${sources[n - 1]!.url})`).join("");
  }
  return { answer: answer.trim(), sources };
}
