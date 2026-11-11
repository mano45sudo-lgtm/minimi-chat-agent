import { test } from "node:test";
import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Isolated database for this test run (config reads DB_PATH at import time).
process.env.DB_PATH = join(tmpdir(), `minimi-test-${process.pid}-${Date.now()}.db`);
const { store } = await import("../src/db.ts");
const { recall, renderContext } = await import("../src/memory.ts");

const clock = { now: new Date("2026-11-11T08:30:00Z"), offsetMin: 330, timeZone: "Asia/Kolkata" };

function seed(date: string, question: string, answer: string, title: string, claims: Array<[string, string]> = []) {
  const at = new Date(`${date}T10:00:00+05:30`).getTime();
  const thread = store.createThread(at);
  const id = store.insertTurn({
    threadId: thread.id,
    createdAt: at,
    localDate: date,
    userText: question,
    promptText: question,
    answer,
    sources: [],
    searches: [],
  });
  store.saveDistillation(id, {
    summary: answer,
    entities: [],
    claims: claims.map(([subject, fact]) => ({ subject, fact, sourceUrl: null })),
  });
  store.setThreadTitle(thread.id, title);
  return thread.id;
}

seed("2026-11-03", "What's the best managed Postgres hosting for a small startup?", "Compared Neon, Supabase and RDS.", "Postgres hosting options", [
  ["Neon Launch", "$19/month"],
  ["Supabase Pro", "$25/month"],
]);
seed("2026-11-09", "Shortlist 5 CRM tools for a 20-person sales team", "Shortlisted HubSpot, Pipedrive, Salesforce, Zoho, Attio.", "CRM shortlist for sales team");
seed("2026-11-10", "Recipe for banana bread?", "Here is a recipe.", "Banana bread");

test("recall by explicit date", () => {
  const r = recall("What did I ask you on 3 November? Is your answer still correct today?", clock, null);
  assert.equal(r.turns.length, 1);
  assert.match(r.turns[0]!.userText, /Postgres/);
  const ctx = renderContext("q", clock, r);
  assert.match(ctx, /Neon Launch: \$19\/month/);
});

test("ambiguous 'last Tuesday' finds the conversation on either candidate day", () => {
  const r = recall("Last Tuesday I asked you about Postgres hosting. Has any pricing changed since then?", clock, null);
  assert.ok(r.turns.some((t) => /Postgres/.test(t.userText)));
  assert.ok(!r.turns.some((t) => /banana/i.test(t.userText)), "topic should filter out unrelated same-day turns");
});

test("weekday reference + topic", () => {
  const r = recall("On Monday we shortlisted 5 CRM tools for a 20-person sales team. Has any of them changed pricing since?", clock, null);
  assert.equal(r.turns.length, 1);
  assert.match(r.turns[0]!.answer, /HubSpot/);
});

test("missing memory is stated, not invented", () => {
  const r = recall("What did I ask you on 20 October?", clock, null);
  assert.equal(r.turns.length, 0);
  const ctx = renderContext("q", clock, r);
  assert.match(ctx, /No conversations on record for Tuesday 20 October 2026/);
});

test('"right now" anchors the question, not a memory lookup', () => {
  const at = new Date("2026-11-11T05:00:00Z").getTime();
  const th = store.createThread(at);
  store.insertTurn({ threadId: th.id, createdAt: at, localDate: "2026-11-11", userText: "Banana bread recipe", promptText: "x", answer: "Here is a stable recipe.", sources: [], searches: [] });
  // Not a date reference for memory, so today's unrelated turns can't ride in on a shared word.
  assert.equal(recall("What is the latest stable Node.js version right now?", clock, null).dateRefs.length, 0);
  // ...but "what did I ask today?" still recalls today.
  assert.ok(recall("What did I ask you today?", clock, null).turns.some((t) => /banana/i.test(t.userText)));
  store.deleteThread(th.id);
});

test("questions about the world don't drag in memory", () => {
  const r = recall("What's the cheapest serverless Postgres right now?", clock, null);
  assert.equal(r.turns.length, 0);
});

test("the current thread is excluded (it's already in context)", () => {
  const crm = store.listThreads().find((t) => t.title?.startsWith("CRM"))!;
  const r = recall("On Monday we shortlisted CRM tools", clock, crm.id);
  assert.equal(r.turns.length, 0);
});
