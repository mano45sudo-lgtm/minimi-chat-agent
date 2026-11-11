import { test } from "node:test";
import assert from "node:assert/strict";
import { refersToPast, resolveDateRefs, type UserClock } from "../src/time.ts";

// Wednesday 11 November 2026, 14:00 in India (UTC+05:30)
const clock: UserClock = { now: new Date("2026-11-11T08:30:00Z"), offsetMin: 330, timeZone: "Asia/Kolkata" };
const one = (text: string, c = clock) => {
  const refs = resolveDateRefs(text, c);
  assert.equal(refs.length, 1, `expected one date ref in "${text}", got ${JSON.stringify(refs)}`);
  return refs[0]!;
};

test("explicit day without year resolves to the most recent past occurrence", () => {
  assert.deepEqual(one("What did I ask you on 3 November?"), { phrase: "3 November", from: "2026-11-03", to: "2026-11-03" });
  assert.equal(one("what did we discuss on 20 December").from, "2025-12-20");
});

test("relative weekdays point to the past", () => {
  // Said on a Wednesday, "last Tuesday" is ambiguous: yesterday, or the week before.
  const lastTue = one("Last Tuesday I asked you about Postgres hosting");
  assert.equal(lastTue.from, "2026-11-10");
  assert.equal(lastTue.alternative?.from, "2026-11-03");
  assert.equal(one("On Monday we shortlisted 5 CRM tools").from, "2026-11-09");
  assert.equal(one("on Friday we talked about it").from, "2026-11-06");
});

test("yesterday and since-phrases", () => {
  assert.equal(one("what did I ask yesterday").from, "2026-11-10");
  const since = one("has anything changed since Monday?");
  assert.equal(since.from, "2026-11-09");
  assert.equal(since.to, "2026-11-11");
});

test("bare day-of-month ('the 3rd') is the most recent past such day, and beats an adjacent weekday", () => {
  assert.equal(one("what did we discuss on the 3rd?").from, "2026-11-03");
  assert.equal(one("what did we discuss on the 25th?").from, "2026-10-25");
  assert.equal(one("our chat on Tuesday the 3rd").from, "2026-11-03");
});

test("'since last Tuesday' keeps both readings", () => {
  const r = one("anything new since last Tuesday?");
  assert.equal(r.from, "2026-11-10");
  assert.equal(r.alternative?.from, "2026-11-03");
  assert.equal(r.alternative?.to, "2026-11-11");
});

test("periods widen to their full range", () => {
  const w = one("what did we talk about last week?");
  assert.equal(w.from, "2026-11-02");
  assert.equal(w.to, "2026-11-08");
});

test("local date respects the user's timezone near midnight", () => {
  // 23:30 on Tue 10 Nov in New York is already Wed 11 Nov in UTC
  const ny: UserClock = { now: new Date("2026-11-11T04:30:00Z"), offsetMin: -300 };
  assert.equal(one("what did I ask yesterday", ny).from, "2026-11-09");
});

test("past-reference detection", () => {
  assert.ok(refersToPast("What did I ask you on 3 November?"));
  assert.ok(refersToPast("Last Tuesday I asked you about Postgres hosting"));
  assert.ok(refersToPast("On Monday we shortlisted 5 CRM tools"));
  assert.ok(refersToPast("Is your answer still correct?"));
  assert.ok(!refersToPast("What's the cheapest Postgres hosting today?"));
});
