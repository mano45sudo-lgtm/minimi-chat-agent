// Central configuration. Everything tunable lives here and is overridable via env.
try {
  process.loadEnvFile(); // Node >= 20.12: reads .env without a dependency
} catch {
  /* no .env file - rely on the real environment */
}

export type ProviderId = "anthropic" | "openai" | "gemini" | "groq";
type Effort = "low" | "medium" | "high";

const env = (k: string) => process.env[k]?.trim() || undefined;

export const config = {
  port: Number(env("PORT") ?? 3000),
  /** Default provider. Falls back to the first one with a key. */
  provider: env("PROVIDER") as ProviderId | undefined,
  /** Reasoning depth for the chat model. `medium` balances speed with multi-search research. */
  effort: (env("CHAT_EFFORT") ?? "medium") as Effort,
  /** Hard cap on web searches per user turn, where the vendor supports one (cost + latency guardrail). */
  maxSearchesPerTurn: Number(env("MAX_SEARCHES_PER_TURN") ?? 8),
  dbPath: env("DB_PATH") ?? "data/minimi.db",

  anthropic: {
    enabled: !!(env("ANTHROPIC_API_KEY") || env("ANTHROPIC_AUTH_TOKEN")),
    chatModel: env("ANTHROPIC_CHAT_MODEL") ?? "claude-opus-5-5",
    memoryModel: env("ANTHROPIC_MEMORY_MODEL") ?? "claude-haiku-5-5",
  },
  openai: {
    enabled: !!env("OPENAI_API_KEY"),
    chatModel: env("OPENAI_CHAT_MODEL") ?? "gpt-5",
    memoryModel: env("OPENAI_MEMORY_MODEL") ?? "gpt-5-mini",
  },
  gemini: {
    enabled: !!env("GEMINI_API_KEY"),
    chatModel: env("GEMINI_CHAT_MODEL") ?? "gemini-3.8-flash",
    memoryModel: env("GEMINI_MEMORY_MODEL") ?? "gemini-3.8-flash",
  },
  groq: {
    enabled: !!env("GROQ_API_KEY"),
    chatModel: env("GROQ_CHAT_MODEL") ?? "openai/gpt-oss-120b", // browser_search-capable
    memoryModel: env("GROQ_MEMORY_MODEL") ?? "openai/gpt-oss-20b",
    // Groq has no per-request search cap; effort is the lever. At `medium`, a pricing
    // comparison ran 16 searches / 137 s, so default `low` (Groq's own recommendation).
    effort: (env("GROQ_EFFORT") ?? "low") as Effort,
  },
};
