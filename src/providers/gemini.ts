// Gemini: Google Search grounding. Search happens inside the request; the queries and
// sources arrive as groundingMetadata, usually with the last chunks of the stream, and
// citations are segments of the answer text mapped to grounding chunks.
import { ApiError, GoogleGenAI, ThinkingLevel, type GroundingMetadata } from "@google/genai";
import { z } from "zod";
import type { Source } from "../db.ts";
import { renderCitations, type Provider, type TurnRequest, type TurnResult } from "./types.ts";

type Effort = "low" | "medium" | "high";
const LEVEL: Record<Effort, ThinkingLevel> = { low: ThinkingLevel.LOW, medium: ThinkingLevel.MEDIUM, high: ThinkingLevel.HIGH };

export function geminiProvider(opts: { chatModel: string; memoryModel: string; effort: Effort }): Provider {
  const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });

  return {
    id: "gemini",
    chatModel: opts.chatModel,

    async answer({ system, ledger, history, user, signal, emit }: TurnRequest): Promise<TurnResult> {
      const stream = await ai.models.generateContentStream({
        model: opts.chatModel,
        contents: [
          ...history.map((h) => ({ role: h.role === "assistant" ? "model" : "user", parts: [{ text: h.text }] })),
          { role: "user", parts: [{ text: user }] },
        ],
        config: {
          systemInstruction: `${system}\n\n${ledger}`,
          tools: [{ googleSearch: {} }],
          thinkingConfig: { includeThoughts: true, thinkingLevel: LEVEL[opts.effort] },
          abortSignal: signal,
        },
      });

      let text = "";
      let thoughts = "";
      let grounding: GroundingMetadata | undefined;
      let blocked = false;
      const seenQueries = new Set<string>();

      for await (const chunk of stream) {
        const cand = chunk.candidates?.[0];
        if (!cand) {
          if (chunk.promptFeedback?.blockReason) blocked = true;
          continue;
        }
        if (cand.finishReason === "SAFETY" || cand.finishReason === "PROHIBITED_CONTENT") blocked = true;
        for (const part of cand.content?.parts ?? []) {
          if (!part.text) continue;
          if (part.thought) {
            thoughts += part.text;
            const line = thoughts.trim().split("\n").filter(Boolean).pop()?.replace(/\*\*/g, "").trim();
            if (line) emit({ type: "status", text: line.slice(0, 160) });
          } else {
            text += part.text;
            emit({ type: "text", delta: part.text });
          }
        }
        if (cand.groundingMetadata) {
          grounding = cand.groundingMetadata;
          for (const q of grounding.webSearchQueries ?? []) {
            if (seenQueries.has(q)) continue;
            seenQueries.add(q);
            emit({ type: "search", query: q });
          }
        }
      }

      if (blocked && !text) return { answer: "", sources: [], searches: [...seenQueries], refused: true };

      const chunks: Source[] = (grounding?.groundingChunks ?? []).map((c) => ({
        url: c.web?.uri ?? "",
        title: c.web?.title ?? c.web?.domain ?? "source",
      }));
      if (chunks.length) emit({ type: "results", query: [...seenQueries][0] ?? "", results: chunks.filter((c) => c.url) });

      // Segment offsets are byte-based, so locate each supported segment by its text.
      const spans: Array<{ end: number; sources: Source[] }> = [];
      let cursor = 0;
      for (const s of grounding?.groundingSupports ?? []) {
        const seg = s.segment?.text;
        if (!seg) continue;
        let at = text.indexOf(seg, cursor);
        if (at < 0) at = text.indexOf(seg);
        if (at < 0) continue;
        cursor = at;
        const srcs = (s.groundingChunkIndices ?? []).map((i) => chunks[i]).filter((c): c is Source => !!c?.url);
        spans.push({ end: at + seg.length, sources: srcs });
      }
      return { ...renderCitations(text, spans), searches: [...seenQueries] };
    },

    async structured<T>(prompt: string, schema: z.ZodType<T>): Promise<T | null> {
      const res = await ai.models.generateContent({
        model: opts.memoryModel,
        contents: prompt,
        config: {
          responseMimeType: "application/json",
          responseJsonSchema: z.toJSONSchema(schema),
          thinkingConfig: { thinkingLevel: ThinkingLevel.LOW },
        },
      });
      const parsed = schema.safeParse(JSON.parse(res.text ?? "null"));
      return parsed.success ? parsed.data : null;
    },

    describeError(err) {
      if (err instanceof ApiError) {
        if (err.status === 400 && /api key/i.test(err.message)) return "The Gemini API key is invalid. Check GEMINI_API_KEY in .env.";
        if (err.status === 429) return "Rate limited by Gemini. Please retry in a moment.";
        return `Gemini API error (${err.status}): ${err.message}`;
      }
      return null;
    },
  };
}
