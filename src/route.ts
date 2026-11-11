// Which path a message takes. Pure function of the message and what recall found, so it
// can be unit-tested against paraphrases without calling any model.
//
//   verify   - "still correct?" / "changed since?" AND we have recorded facts to check
//              → parallel per-fact checks, then a no-search reply written from them
//   recall   - points at our past, memory has it, nothing about the world now
//              → fast model, no search
//   research - everything else (including "no record" cases) → main model + web search
import type { Recall } from "./memory.ts";
import { claimsToCheck, wantsVerification, type DatedClaim } from "./verify.ts";

export type Route = "verify" | "recall" | "research";

/** Words that mean the answer depends on the world now, not just on what was said. */
const NEEDS_FRESH_DATA = /\b(now|today|current(ly)?|latest|price[sd]?|pricing|cost|news|release[ds]?|version|still)\b/i;

export function chooseRoute(message: string, r: Recall): { route: Route; claims: DatedClaim[] } {
  const claims = claimsToCheck(r.turns);
  if (claims.length > 0 && wantsVerification(message)) return { route: "verify", claims };
  if (r.turns.length > 0 && r.refersToPast && !NEEDS_FRESH_DATA.test(message)) return { route: "recall", claims };
  return { route: "research", claims };
}
