// Provider registry: every vendor with a key in the environment is available; the
// default is PROVIDER, else the first configured one. The UI can pick per message.
import { config, type ProviderId } from "../config.ts";
import { anthropicProvider } from "./anthropic.ts";
import { geminiProvider } from "./gemini.ts";
import { groqProvider } from "./groq.ts";
import { openaiProvider } from "./openai.ts";
import type { Provider } from "./types.ts";

const registry = new Map<ProviderId, Provider>();
if (config.anthropic.enabled) {
  registry.set("anthropic", anthropicProvider({ ...config.anthropic, effort: config.effort, maxSearches: config.maxSearchesPerTurn }));
}
if (config.openai.enabled) registry.set("openai", openaiProvider({ ...config.openai, effort: config.effort }));
if (config.gemini.enabled) registry.set("gemini", geminiProvider({ ...config.gemini, effort: config.effort }));
if (config.groq.enabled) registry.set("groq", groqProvider(config.groq));

export const defaultProviderId: ProviderId | null =
  config.provider && registry.has(config.provider) ? config.provider : (registry.keys().next().value ?? null);

if (config.provider && !registry.has(config.provider)) {
  console.warn(`[minimi] PROVIDER=${config.provider} but its API key is not set; using ${defaultProviderId ?? "none"}.`);
}
if (!defaultProviderId) {
  console.warn("\n[minimi] No API key found. Copy .env.example to .env and set at least one of ANTHROPIC_API_KEY, OPENAI_API_KEY, GEMINI_API_KEY.\n");
}

const ALL: Array<{ id: ProviderId; key: string }> = [
  { id: "anthropic", key: "ANTHROPIC_API_KEY" },
  { id: "openai", key: "OPENAI_API_KEY" },
  { id: "gemini", key: "GEMINI_API_KEY" },
  { id: "groq", key: "GROQ_API_KEY" },
];

export function isKnownProvider(id: string): id is ProviderId {
  return ALL.some((p) => p.id === id);
}

/** A requested provider must be configured; no silent fallback to a different model. */
export function getProvider(id?: string | null): Provider | null {
  if (id) return registry.get(id as ProviderId) ?? null;
  return defaultProviderId ? registry.get(defaultProviderId)! : null;
}

/** Every supported provider, so the UI can show what exists and which key enables it. */
export function listProviders() {
  return ALL.map(({ id, key }) => ({
    id,
    model: registry.get(id)?.chatModel ?? config[id].chatModel,
    available: registry.has(id),
    key,
    default: id === defaultProviderId,
  }));
}
