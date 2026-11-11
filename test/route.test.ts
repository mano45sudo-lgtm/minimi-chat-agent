// Real users won't type the brief's examples word for word. These paraphrases pin down
// which path each kind of question takes, with no model involved.
import { test } from "node:test";
import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.DB_PATH = join(tmpdir(), `minimi-route-${process.pid}-${Date.now()}.db`);
const { store } = await import("../src/db.ts");
const { recall } = await import("../src/memory.ts");
const { chooseRoute } = await import("../src/route.ts");

// Wednesday 11 Nov 2026, India. Memory: one Postgres conversation on Tuesday 3 Nov.
const clock = { now: new Date("2026-11-11T08:30:00Z"), offsetMin: 330, timeZone: "Asia/Kolkata" };
const at = new Date("2026-11-03T10:00:00+05:30").getTime();
const th = store.createThread(at);
const id = store.insertTurn({
  threadId: th.id,
  createdAt: at,
  localDate: "2026-11-03",
  userText: "What are the cheapest managed Postgres hosting options for a small startup?",
  promptText: "x",
  answer: "Supabase Pro is $25/month; Neon Launch starts at $19/month.",
  sources: [],
  searches: [],
});
store.saveDistillation(id, {
  summary: "Compared managed Postgres hosts and entry prices.",
  entities: ["Postgres", "Supabase", "Neon"],
  claims: [
    { subject: "Supabase Pro", fact: "$25/month", sourceUrl: null },
    { subject: "Neon Launch", fact: "starts at $19/month", sourceUrl: null },
  ],
});
store.setThreadTitle(th.id, "Managed Postgres hosting");

function routeOf(message: string) {
  const r = recall(message, clock, null);
  return { route: chooseRoute(message, r).route, days: r.turns.map((t) => t.localDate) };
}

const cases: Array<[message: string, route: "verify" | "recall" | "research", recalls: boolean]> = [
  // "Is it still true?" - should re-check the recorded facts
  ["Last Tuesday I asked you about Postgres hosting. Has any pricing changed since then?", "verify", true],
  ["What did I ask you on 3 November? Is your answer still correct today?", "verify", true],
  ["Are the Postgres prices you gave me last week still right?", "verify", true],
  ["Anything new with those Postgres hosts since last Tuesday?", "verify", true],
  ["Is what you told me about Postgres hosting on the 3rd still accurate?", "verify", true],
  ["Did any of those Postgres plans get more expensive since we talked?", "verify", true],
  ["Can you double-check the Postgres numbers from our chat on Tuesday the 3rd?", "verify", true],
  // "What did we say?" - memory alone answers it
  ["What did I ask you on 3 November?", "recall", true],
  ["Remind me what we talked about last Tuesday.", "recall", true],
  ["What was that Postgres thing we looked at last week?", "recall", true],
  ["What did we discuss on the 3rd?", "recall", true],
  // About the world, or nothing on record - search the web
  ["On Monday we shortlisted 5 CRM tools for a 20-person sales team. Has any of them changed pricing since?", "research", false],
  ["Which Postgres host is cheapest right now?", "research", false],
  ["What's new in Node.js 26?", "research", false],
];

for (const [message, route, recalls] of cases) {
  test(`${route}: ${message}`, () => {
    const got = routeOf(message);
    assert.equal(got.route, route, `route for: ${message}`);
    assert.equal(got.days.includes("2026-11-03"), recalls, `recall of 3 Nov for: ${message} (got ${got.days.join(",") || "none"})`);
  });
}
