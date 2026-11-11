// OpenAI: Responses API with the hosted `web_search` tool. Like Anthropic's, the search
// loop runs server-side inside one request; citations come back as url_citation
// annotations with character offsets into the output text.
import OpenAI from "openai";
import { zodTextFormat } from "openai/helpers/zod";
import type { z } from "zod";
import type { Source } from "../db.ts";
import { renderCitations, type Provider, type TurnRequest, type TurnResult } from "./types.ts";

type Effort = "low" | "medium" | "high";

export function openaiProvider(opts: { chatModel: string; memoryModel: string; effort: Effort }): Provider {
  const client = new OpenAI();

  return {
    id: "openai",
    chatModel: opts.chatModel,

    async answer({ system, ledger, history, user, clock, signal, emit }: TurnRequest): Promise<TurnResult> {
      const searches: string[] = [];
      let summary = "";

      const stream = client.responses.stream(
        {
          model: opts.chatModel,
          // Static text first so OpenAI's automatic prefix caching keeps hitting.
          instructions: `${system}\n\n${ledger}`,
          input: [...history.map((h) => ({ role: h.role, content: h.text })), { role: "user" as const, content: user }],
          tools: [
            {
              type: "web_search",
              ...(clock.timeZone ? { user_location: { type: "approximate" as const, timezone: clock.timeZone } } : {}),
            },
          ],
          reasoning: { effort: opts.effort, summary: "auto" },
          store: false,
        },
        { signal },
      );

      for await (const ev of stream) {
        switch (ev.type) {
          case "response.output_text.delta":
            emit({ type: "text", delta: ev.delta });
            break;
          case "response.reasoning_summary_text.delta": {
            summary += ev.delta;
            const line = summary.trim().split("\n").pop()?.replace(/\*\*/g, "").trim();
            if (line) emit({ type: "status", text: line.slice(0, 160) });
            break;
          }
          case "response.reasoning_summary_part.done":
            summary = "";
            break;
          case "response.output_item.done":
            if (ev.item.type === "web_search_call" && ev.item.action.type === "search") {
              const qs = ev.item.action.queries?.length ? ev.item.action.queries : [ev.item.action.query ?? ""];
              for (const q of qs.filter(Boolean)) {
                searches.push(q);
                emit({ type: "search", query: q });
              }
              const results = (ev.item.action.sources ?? []).map((s) => ({ url: s.url, title: s.url }));
              emit({ type: "results", query: qs[0] ?? "", results });
            }
            break;
        }
      }

      const res = await stream.finalResponse();
      if (res.status === "incomplete" && res.incomplete_details?.reason === "content_filter") {
        return { answer: "", sources: [], searches, refused: true };
      }

      // Concatenate message outputs, shifting each annotation by the text before it.
      let text = "";
      const spans: Array<{ end: number; sources: Source[] }> = [];
      for (const item of res.output) {
        if (item.type !== "message") continue;
        for (const part of item.content) {
          if (part.type === "refusal") return { answer: "", sources: [], searches, refused: true };
          const base = text.length;
          text += part.text;
          for (const a of part.annotations) {
            if (a.type === "url_citation") spans.push({ end: base + a.end_index, sources: [{ url: a.url, title: a.title }] });
          }
        }
      }
      // OpenAI often also writes its own inline markdown links for citations; drop the
      // ones that duplicate an annotation so each source shows once, as a number.
      const { answer, sources } = renderCitations(text, spans);
      return { answer: stripDuplicateLinks(answer, sources), sources, searches };
    },

    async structured<T>(prompt: string, schema: z.ZodType<T>, name: string): Promise<T | null> {
      const res = await client.responses.parse({
        model: opts.memoryModel,
        input: prompt,
        text: { format: zodTextFormat(schema, name) },
        store: false,
      });
      return (res.output_parsed as T | null) ?? null;
    },

    describeError(err) {
      if (err instanceof OpenAI.AuthenticationError) return "The OpenAI API key is invalid. Check OPENAI_API_KEY in .env.";
      if (err instanceof OpenAI.RateLimitError) return "Rate limited by OpenAI. Please retry in a moment.";
      if (err instanceof OpenAI.APIError) return `OpenAI API error (${err.status ?? "network"}): ${err.message}`;
      return null;
    },
  };
}

/** Remove `([title](url))`-style inline links whose URL is already a numbered citation. */
function stripDuplicateLinks(md: string, sources: Source[]): string {
  const urls = new Set(sources.map((s) => s.url));
  return md.replace(/\s?\(\[[^\]]+\]\((https?:\/\/[^)\s]+)\)\)/g, (m, url: string) => (urls.has(url) ? "" : m));
}
