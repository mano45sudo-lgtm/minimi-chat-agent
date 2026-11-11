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

export function getProvider(id?: string | null): Provider | null {
  if (id && registry.has(id as ProviderId)) return registry.get(id as ProviderId)!;
  return defaultProviderId ? registry.get(defaultProviderId)! : null;
}

export function listProviders() {
  return [...registry.values()].map((p) => ({ id: p.id, model: p.chatModel, default: p.id === defaultProviderId }));
}
