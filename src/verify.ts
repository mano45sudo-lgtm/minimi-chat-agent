// "Is that still correct?" / "Has anything changed since?" — the questions this agent is
// built around — are not open-ended research. We already know exactly which facts were
// stated and when (distilled claims). So instead of letting the model run a serial search
// loop, code fans out ONE small, fast, search-enabled check per claim, all in parallel,
// streams each verdict as it lands, and only then lets the main model write the reply
// from those results (no search, so it's quick).
//
// Speed and correctness come from the same move: wall time is the slowest single check,
// not the sum of all of them, and "unchanged" can only be said about a fact that a check
// actually confirmed this turn, with a source.
import type { Claim, Source, Turn } from "./db.ts";
import type { Provider, TurnRequest } from "./providers/types.ts";
import { humanDate, localDate, type UserClock } from "./time.ts";

const MAX_CLAIMS = 10;

export interface DatedClaim extends Claim {
  id: number;
  date: string; // local date the claim was stated
}

export interface CheckResult {
  id: number;
  status: "unchanged" | "changed" | "unverified";
  now: string;
  changedOn: string | null;
  sources: Source[];
}

/** Does the message ask whether earlier facts still hold / what changed? */
export function wantsVerification(text: string): boolean {
  return /\b(double[- ]?check|re-?check|re-?verify|verify|confirm|still\s+(correct|right|true|valid|accurate|current|the case|good)|chang(e|ed|es|ing)|up[- ]to[- ]date|outdated|out of date|any\s+(updates?|news)|anything new|shipped|is\s+(it|that|this)\s+still|since\s+(then|we|i|you|last|monday|tuesday|wednesday|thursday|friday|saturday|sunday|yesterday|\d))\b/i.test(
    text,
  );
}

export function claimsToCheck(turns: Turn[]): DatedClaim[] {
  const seen = new Set<string>();
  const out: DatedClaim[] = [];
  // Newest statements first: if a fact was restated, the latest version is the baseline.
  for (const t of [...turns].reverse()) {
    for (const c of t.claims) {
      // Same vendor + same headline figure = same fact, however the subject was worded
      // ("AWS RDS PostgreSQL entry-tier cost" vs "AWS RDS entry-tier", both $11.68).
      const vendor = c.subject.toLowerCase().match(/[a-z0-9]+/)?.[0] ?? "";
      const figure = c.fact.match(/\d+(?:[.,]\d+)?/)?.[0];
      const keys = [c.subject.toLowerCase(), ...(figure ? [`${vendor}|${figure}`] : [])];
      if (keys.some((k) => seen.has(k)) || !isWorldFact(c)) continue;
      for (const k of keys) seen.add(k);
      out.push({ ...c, id: out.length + 1, date: t.localDate });
    }
  }
  return out.slice(0, MAX_CLAIMS);
}

/** Guard against distilled "claims" that are really about the conversation itself. */
export function isWorldFact(c: Claim): boolean {
  if (c.subject.length > 80) return false;
  return !/\b(you|your|i|we|user|assistant|answer|question|asked|conversation|quoted|all of the)\b/i.test(`${c.subject} ${c.fact}`);
}

export const CHECK_SYSTEM = `You verify ONE previously stated fact against the live web. Search (once or twice), preferring the vendor's official page. Then reply in exactly this format and nothing else:
STATUS: unchanged | changed | unverified
NOW: <the current value as the source states it, with exact figures; or "not found">
CHANGED: <when it changed, e.g. "5 Nov 2026", or "unknown">
Rules: "unchanged" or "changed" only if a source you found in this search states the current value. Otherwise "unverified".`;

export function checkPrompt(c: DatedClaim, clock: UserClock): string {
  return `Today is ${humanDate(localDate(clock.now, clock.offsetMin))}.
On ${humanDate(c.date)} this was stated: "${c.subject}: ${c.fact}"${c.sourceUrl ? ` (source then: ${c.sourceUrl})` : ""}.
Is it still accurate today?`;
}

/** Parse a check reply. Anything malformed, or a verdict without a source, is "unverified". */
export function parseCheck(id: number, text: string, sources: Source[]): CheckResult {
  const clean = text.replace(/\s?\[\d+\]\([^)]*\)/g, ""); // drop rendered citation links
  const field = (name: string) => new RegExp(`^\\s*[*_]*${name}\\s*[*_]*\\s*:\\s*[*_]*\\s*(.+)$`, "im").exec(clean)?.[1]?.trim().replace(/\*+$/, "") ?? "";
  const raw = field("STATUS").toLowerCase();
  let status: CheckResult["status"] = raw.startsWith("unchanged") ? "unchanged" : raw.startsWith("changed") ? "changed" : "unverified";
  const now = field("NOW") || "not found";
  const changed = field("CHANGED");
  // The guarantee: no evidence, no verdict.
  if (sources.length === 0 || /^not found/i.test(now)) status = "unverified";
  return {
    id,
    status,
    now,
    changedOn: changed && !/^unknown/i.test(changed) ? changed : null,
    sources: sources.slice(0, 3),
  };
}

/** Run every check in parallel; emit each result the moment it lands. */
export async function runChecks(
  provider: Provider,
  claims: DatedClaim[],
  clock: UserClock,
  signal: AbortSignal | undefined,
  emit: TurnRequest["emit"],
): Promise<CheckResult[]> {
  emit({ type: "checks", items: claims.map((c) => ({ id: c.id, subject: c.subject, then: c.fact, date: c.date })) });
  return Promise.all(
    claims.map(async (c) => {
      let result: CheckResult;
      try {
        const r = await provider.answer({
          system: CHECK_SYSTEM,
          ledger: "",
          history: [],
          user: checkPrompt(c, clock),
          clock,
          signal,
          fast: true,
          search: true,
          emit: (e) => {
            if (e.type === "search") emit(e); // show the queries, keep the rest internal
          },
        });
        result = parseCheck(c.id, r.answer, r.sources);
      } catch (err) {
        if (signal?.aborted) throw err;
        const why = provider.describeError(err) ?? (err instanceof Error ? err.message : "error");
        result = { id: c.id, status: "unverified", now: `check failed (${why.slice(0, 80)})`, changedOn: null, sources: [] };
      }
      emit({ type: "check", ...result });
      return result;
    }),
  );
}

/** Evidence block for the reply-writing model, plus the numbered source list it cites. */
export function renderVerification(claims: DatedClaim[], results: CheckResult[], clock: UserClock) {
  const sources: Source[] = [];
  const num = (s: Source) => {
    let i = sources.findIndex((x) => x.url === s.url);
    if (i < 0) i = sources.push(s) - 1;
    return i + 1;
  };
  const lines = claims.map((c) => {
    const r = results.find((x) => x.id === c.id)!;
    const cites = r.sources.map((s) => `[${num(s)}]`).join("");
    const verdict =
      r.status === "unchanged"
        ? `UNCHANGED - now: ${r.now} ${cites}`
        : r.status === "changed"
          ? `CHANGED - now: ${r.now}${r.changedOn ? ` (changed ${r.changedOn})` : ""} ${cites}`
          : "NOT VERIFIED - no current source found";
    return `${c.id}. ${c.subject} - stated ${c.date}: ${c.fact} → ${verdict}`;
  });
  const block = `<verification>
Each fact below was re-checked just now (${humanDate(localDate(clock.now, clock.offsetMin))}) by a separate live search, in parallel:
${lines.join("\n")}

Sources:
${sources.map((s, i) => `[${i + 1}] ${s.title} - ${s.url}`).join("\n") || "(none)"}
</verification>
Write the reply from these results only. Lead with the overall verdict (how many unchanged / changed / not verified). Then a compact table: item, then, now, status. Cite with [n] exactly as numbered above. Do not search, and do not claim anything these results don't show.`;
  return { block, sources };
}

/**
 * Deterministic reply, used when the reply-writing model fails (rate limit, outage).
 * The checks are the expensive part; never throw them away.
 */
export function renderFallback(claims: DatedClaim[], results: CheckResult[], sources: Source[]): string {
  const count = (s: CheckResult["status"]) => results.filter((r) => r.status === s).length;
  const cite = (r: CheckResult) =>
    r.sources.map((s) => `[${sources.findIndex((x) => x.url === s.url) + 1}](${s.url})`).join(" ");
  const allFailed = results.length > 0 && results.every((r) => r.now.startsWith("check failed"));
  if (allFailed) {
    return `I found what you asked on ${claims[0]!.date}, but I couldn't re-check it just now: ${results[0]!.now.replace(/^check failed \(|\)$/g, "")}. Here is what I said then:\n\n${claims.map((c) => `- **${c.subject}**: ${c.fact}`).join("\n")}`;
  }
  const rows = claims.map((c) => {
    const r = results.find((x) => x.id === c.id)!;
    const status = r.status === "unchanged" ? "✓ unchanged" : r.status === "changed" ? "**Δ changed**" : "? not verified";
    const now = r.status === "unverified" ? "-" : `${r.now}${r.changedOn ? ` (changed ${r.changedOn})` : ""} ${cite(r)}`;
    return `| ${c.subject} | ${c.fact} | ${now.replace(/\|/g, "/")} | ${status} |`;
  });
  return [
    `**${count("changed")} changed, ${count("unchanged")} unchanged, ${count("unverified")} not verified** (each fact re-checked just now).`,
    "",
    "| Item | Then | Now | Status |",
    "|---|---|---|---|",
    ...rows,
  ].join("\n");
}

/** Turn bare [n] markers from the reply into links to the numbered sources. */
export function linkCitations(text: string, sources: Source[]): string {
  return text.replace(/\[(\d+)\](?!\()/g, (m, n: string) => {
    const s = sources[Number(n) - 1];
    return s ? `[${n}](${s.url})` : m;
  });
}
