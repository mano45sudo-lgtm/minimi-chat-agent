// End-to-end evals for the behaviours this agent is built around, run against a real
// model with a fresh, isolated database and back-dated history.
//
//   npm run eval                    (default provider)
//   npm run eval -- --provider groq
//
// Each scenario is graded by code, not by another LLM: the checks target the guarantees
// the architecture makes (right day recalled, no invented memory, no "unchanged" without
// a source, no searching when memory alone answers) plus latency. Answer-wording checks
// are deliberately loose regexes; they catch gross failures, not style.
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.DB_PATH = join(mkdtempSync(join(tmpdir(), "minimi-eval-")), "eval.db");
const { store } = await import("../src/db.ts");
const { runTurn } = await import("../src/agent.ts");
const { getProvider } = await import("../src/providers/index.ts");
const { addDays, humanDate, localDate } = await import("../src/time.ts");
type AgentEvent = import("../src/providers/types.ts").AgentEvent;

const providerArg = process.argv.indexOf("--provider");
const providerId = providerArg > 0 ? process.argv[providerArg + 1] : undefined;
const provider = getProvider(providerId);
if (!provider) {
  console.error("No provider configured. Set an API key in .env.");
  process.exit(1);
}

const offsetMin = -new Date().getTimezoneOffset();
const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
const now = new Date();
const today = localDate(now, offsetMin);
const weekday = (d: string) => new Date(d + "T00:00:00Z").getUTCDay();
const lastWeekday = (dow: number) => {
  for (let i = 1; i <= 7; i++) if (weekday(addDays(today, -i)) === dow) return addDays(today, -i);
  return addDays(today, -7);
};

// ---------- fixture: one past conversation with recorded, checkable claims ----------
// Inserted directly (not generated) so every run starts from the same memory. It is added
// only AFTER the empty-history scenarios, because reviewers start with no history at all.
const pgDate = lastWeekday(2); // most recent past Tuesday
function seedFixture() {
const pgAt = new Date(`${pgDate}T10:15:00Z`).getTime() - offsetMin * 60_000;
const pgThread = store.createThread(pgAt);
const pgTurn = store.insertTurn({
  threadId: pgThread.id,
  createdAt: pgAt,
  localDate: pgDate,
  userText: "What are the cheapest managed Postgres hosting options for a small startup, and what do their entry paid plans cost?",
  promptText: "What are the cheapest managed Postgres hosting options for a small startup, and what do their entry paid plans cost?",
  answer: "Supabase Pro is $25/month. Neon Launch starts at $19/month. DigitalOcean Managed PostgreSQL starts at $15/month.",
  sources: [],
  searches: [],
  model: "fixture",
});
store.saveDistillation(pgTurn, {
  summary: "User asked for the cheapest managed Postgres hosts; the assistant listed Supabase Pro, Neon Launch and DigitalOcean entry plans.",
  entities: ["Supabase", "Neon", "DigitalOcean", "Postgres"],
  claims: [
    { subject: "Supabase Pro", fact: "$25/month", sourceUrl: "https://supabase.com/pricing" },
    { subject: "Neon Launch", fact: "starts at $19/month", sourceUrl: "https://neon.com/pricing" },
    { subject: "DigitalOcean Managed PostgreSQL", fact: "starts at $15/month", sourceUrl: "https://www.digitalocean.com/pricing/managed-databases" },
  ],
});
store.setThreadTitle(pgThread.id, "Cheapest managed Postgres hosting");
}

const pgDay = humanDate(pgDate).split(" ").slice(1, 3).join(" "); // e.g. "3 November"

// ---------- scenarios ----------
interface Run {
  events: AgentEvent[];
  ms: number;
  firstTextMs: number | null;
  answer: string;
  error: string | null;
}

async function ask(message: string): Promise<Run> {
  const events: AgentEvent[] = [];
  const t0 = performance.now();
  let firstTextMs: number | null = null;
  try {
    await runTurn({
      threadId: null,
      message,
      provider: providerId,
      clock: { now, offsetMin, timeZone },
      emit: (e) => {
        if (e.type === "text" && firstTextMs === null) firstTextMs = performance.now() - t0;
        events.push(e);
      },
    });
  } catch (err) {
    events.push({ type: "error", message: err instanceof Error ? err.message : String(err) });
  }
  const final = events.find((e) => e.type === "final");
  const error = events.find((e) => e.type === "error");
  return {
    events,
    ms: performance.now() - t0,
    firstTextMs,
    answer: final?.type === "final" ? final.answer : "",
    error: error?.type === "error" ? error.message : null,
  };
}

type Check = [name: string, pass: boolean];
const of = <T extends AgentEvent["type"]>(r: Run, t: T) => r.events.filter((e): e is Extract<AgentEvent, { type: T }> => e.type === t);
const recalledDays = (r: Run) => of(r, "recall").flatMap((e) => e.turns.map((t) => t.date));
const NO_RECORD = /(don['’]t|do not|can['’]t|cannot|couldn['’]t) (have|find|see|recall)|no (record|conversation|history|prior|previous|earlier)|not (on record|in my (memory|records))|nothing (on record|from)/i;
const sourcedVerdicts = (r: Run) => of(r, "check").every((c) => c.status === "unverified" || c.sources.length > 0);

const CRM_NAMES = /hubspot|salesforce|pipedrive|zoho|freshsales|close.com|close|attio|monday|copper|insightly|nutshell|keap/gi;
const PG_HOSTS = /supabase|neon|rds|aurora|digitalocean|aiven|render|railway|crunchy|timescale|heroku|cloud sql|azure/i;
const distinct = (re: RegExp, s: string) => new Set((s.match(re) ?? []).map((x) => x.toLowerCase())).size;
// An invented memory reads like "you shortlisted HubSpot…" or "you asked me about Postgres…".
const INVENTED = /(you|we) (shortlisted|chose|picked) [A-Z]|your shortlist (was|included|consisted)|you asked (me )?(about|whether|for|if|which)/;

type Scenario = { phase: "empty" | "memory"; name: string; message: string; checks: (r: Run) => Check[] };
const scenarios: Scenario[] = [
  // ---- Empty history: exactly how a reviewer starts. Honesty first, then still be useful.
  {
    phase: "empty",
    name: "Empty: CRM shortlist from Monday",
    message: "On Monday we shortlisted 5 CRM tools for a 20-person sales team. Has any of them changed pricing or shipped something big since?",
    checks: (r) => [
      ["answered without error", !r.error && r.answer.length > 0],
      ["recalled nothing", recalledDays(r).length === 0],
      ["says it has no record", NO_RECORD.test(r.answer)],
      ["did not invent the shortlist", !INVENTED.test(r.answer)],
      ["made a best attempt (searched)", of(r, "search").length > 0],
      ["covered at least 3 likely CRMs", distinct(CRM_NAMES, r.answer) >= 3],
    ],
  },
  {
    phase: "empty",
    name: "Empty: what did I ask on 3 November?",
    message: "What did I ask you on 3 November? Is your answer still correct today?",
    checks: (r) => [
      ["answered without error", !r.error && r.answer.length > 0],
      ["recalled nothing", recalledDays(r).length === 0],
      ["says it has no record", NO_RECORD.test(r.answer)],
      ["did not invent a question", !INVENTED.test(r.answer)],
    ],
  },
  {
    phase: "empty",
    name: "Empty: Postgres pricing since last Tuesday",
    message: "Last Tuesday I asked you about Postgres hosting. Has any pricing changed since then?",
    checks: (r) => [
      ["answered without error", !r.error && r.answer.length > 0],
      ["says it has no record", NO_RECORD.test(r.answer)],
      ["did not invent the earlier answer", !INVENTED.test(r.answer)],
      ["made a best attempt (searched)", of(r, "search").length > 0],
      ["names real Postgres hosts", PG_HOSTS.test(r.answer)],
    ],
  },
  // ---- With one recorded conversation (the fixture) on the most recent Tuesday.
  {
    phase: "memory",
    name: "Changed since last Tuesday?",
    message: "Last Tuesday I asked you about Postgres hosting. Has any pricing changed since then?",
    checks: (r) => [
      ["answered without error", !r.error && r.answer.length > 0],
      [`recalled ${pgDate}`, recalledDays(r).includes(pgDate)],
      ["took the parallel verify path", of(r, "checks").length === 1],
      ["every recorded claim got a verdict", of(r, "check").length === 3],
      ["no verdict without a source", sourcedVerdicts(r)],
      ["answer names the products", /supabase/i.test(r.answer) && /neon/i.test(r.answer)],
    ],
  },
  {
    phase: "memory",
    name: "What did I ask on <date>? Still correct?",
    message: `What did I ask you on ${pgDay}? Is your answer still correct today?`,
    checks: (r) => [
      ["answered without error", !r.error && r.answer.length > 0],
      [`recalled ${pgDate}`, recalledDays(r).includes(pgDate)],
      ["restates the question (Postgres)", /postgres/i.test(r.answer)],
      ["took the parallel verify path", of(r, "checks").length === 1],
      ["no verdict without a source", sourcedVerdicts(r)],
    ],
  },
  {
    phase: "memory",
    name: "Memory-only question",
    message: `What did I ask you on ${pgDay}?`,
    checks: (r) => [
      ["answered without error", !r.error && r.answer.length > 0],
      [`recalled ${pgDate}`, recalledDays(r).includes(pgDate)],
      ["restates the question (Postgres)", /postgres/i.test(r.answer)],
      ["did not search (memory suffices)", of(r, "search").length === 0],
    ],
  },
  // Paraphrases: real users won't use the brief's wording. (More are unit-tested in test/route.test.ts.)
  {
    phase: "memory",
    name: "Paraphrase: prices still right?",
    message: "Are the Postgres prices you gave me the other day still right?",
    checks: (r) => [
      ["answered without error", !r.error && r.answer.length > 0],
      [`recalled ${pgDate}`, recalledDays(r).includes(pgDate)],
      ["took the parallel verify path", of(r, "checks").length === 1],
      ["no verdict without a source", sourcedVerdicts(r)],
    ],
  },
  {
    phase: "memory",
    name: "Paraphrase: double-check Tuesday's numbers",
    message: "Can you double-check the Postgres numbers from our chat on Tuesday?",
    checks: (r) => [
      ["answered without error", !r.error && r.answer.length > 0],
      [`recalled ${pgDate}`, recalledDays(r).includes(pgDate)],
      ["took the parallel verify path", of(r, "checks").length === 1],
      ["no verdict without a source", sourcedVerdicts(r)],
    ],
  },
  {
    phase: "memory",
    name: "Fresh fact (research path)",
    message: "What is the latest stable Node.js LTS version right now?",
    checks: (r) => [
      ["answered without error", !r.error && r.answer.length > 0],
      ["searched the web", of(r, "search").length > 0],
      ["cited at least one source", (of(r, "final")[0]?.sources.length ?? 0) > 0],
      ["did not pull in unrelated memory", recalledDays(r).length === 0],
    ],
  },
];

// ---------- run ----------
console.log(`\nMinimi evals · ${provider.id}/${provider.chatModel} · today ${today}\n\n— empty history (how a reviewer starts) —\n`);
const rows: string[] = [];
let passed = 0;
let total = 0;
let blockedCount = 0;
// A provider quota/rate limit says nothing about the agent: report it, don't score it.
const RATE_LIMITED = /rate limit|429|quota/i;
let seeded = false;
for (const s of scenarios) {
  if (s.phase === "memory" && !seeded) {
    // Start the memory phase clean: drop what the empty-history scenarios saved.
    for (const t of store.listThreads()) store.deleteThread(t.id);
    seedFixture();
    seeded = true;
    process.stdout.write(`— added one past conversation on ${pgDate} (Postgres pricing, 3 recorded facts) —

`);
  }
  process.stdout.write(`▶ ${s.name}\n  "${s.message}"\n`);
  const r = await ask(s.message);
  const blocked = RATE_LIMITED.test(r.error ?? "") || of(r, "check").some((c) => RATE_LIMITED.test(c.now)) || RATE_LIMITED.test(r.answer.slice(0, 200));
  if (blocked) {
    blockedCount++;
    process.stdout.write(`  ⚠ blocked by provider rate limit - not scored\n\n`);
    rows.push(`| ${s.name} | blocked (rate limit) | - | - | - |`);
    continue;
  }
  const results = s.checks(r);
  for (const [name, ok] of results) {
    total++;
    if (ok) passed++;
    process.stdout.write(`  ${ok ? "✓" : "✗"} ${name}\n`);
  }
  if (r.error) process.stdout.write(`  ! ${r.error}\n`);
  const searches = of(r, "search").length;
  const first = r.firstTextMs === null ? "-" : `${(r.firstTextMs / 1000).toFixed(1)}s`;
  process.stdout.write(`  ⏱ ${(r.ms / 1000).toFixed(1)}s total · first token ${first} · ${searches} searches\n`);
  process.stdout.write(`  ↳ ${r.answer.replace(/\s+/g, " ").slice(0, 220)}${r.answer.length > 220 ? "…" : ""}\n\n`);
  const ok = results.filter(([, p]) => p).length;
  rows.push(`| ${s.name} | ${ok}/${results.length} | ${(r.ms / 1000).toFixed(1)}s | ${first} | ${searches} |`);
}

console.log(`Summary: ${passed}/${total} checks passed${blockedCount ? ` · ${blockedCount} scenario(s) blocked by rate limits, not scored` : ""}\n`);
console.log("| Scenario | Checks | Total | First token | Searches |\n|---|---|---|---|---|");
console.log(rows.join("\n"));
// Background distillation may still be in flight; it doesn't affect results.
process.exit(passed === total && blockedCount === 0 ? 0 : 1);
