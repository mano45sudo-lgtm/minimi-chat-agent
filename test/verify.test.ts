import { test } from "node:test";
import assert from "node:assert/strict";
import { claimsToCheck, linkCitations, parseCheck, wantsVerification } from "../src/verify.ts";
import type { Turn } from "../src/db.ts";

const src = { url: "https://neon.com/pricing", title: "Neon pricing" };

test("verification intent", () => {
  assert.ok(wantsVerification("What did I ask you on 3 November? Is your answer still correct today?"));
  assert.ok(wantsVerification("Last Tuesday I asked you about Postgres hosting. Has any pricing changed since then?"));
  assert.ok(wantsVerification("Has any of them shipped something big since Monday?"));
  assert.ok(!wantsVerification("What did I ask you on 3 November?"));
  assert.ok(!wantsVerification("Which Postgres host is cheapest?"));
});

test("a verdict without a source is downgraded to unverified", () => {
  const r = parseCheck(1, "STATUS: unchanged\nNOW: $19/month\nCHANGED: unknown", []);
  assert.equal(r.status, "unverified");
});

test("parses verdicts, tolerating markdown and citation links", () => {
  const r = parseCheck(2, `**STATUS:** changed\n**NOW:** $25/month [1](${src.url})\n**CHANGED:** 5 Nov 2026`, [src]);
  assert.equal(r.status, "changed");
  assert.equal(r.now, "$25/month");
  assert.equal(r.changedOn, "5 Nov 2026");
  assert.equal(parseCheck(3, "I could not tell.", [src]).status, "unverified");
});

test("claims dedupe by subject, newest statement wins", () => {
  const turn = (date: string, fact: string) =>
    ({ localDate: date, claims: [{ subject: "Neon Launch", fact, sourceUrl: null }] }) as unknown as Turn;
  const cs = claimsToCheck([turn("2026-11-03", "$19/mo"), turn("2026-11-09", "$20/mo")]);
  assert.equal(cs.length, 1);
  assert.equal(cs[0]!.fact, "$20/mo");
});

test("same vendor + same figure is one fact; conversation meta-claims are dropped", () => {
  const t = {
    localDate: "2026-11-03",
    claims: [
      { subject: "AWS RDS PostgreSQL entry-tier cost", fact: "$11.68 (compute only)", sourceUrl: null },
      { subject: "AWS RDS entry-tier", fact: "$11.68/month", sourceUrl: null },
      { subject: "Price validity", fact: "All of the quoted prices are still current", sourceUrl: null },
    ],
  } as unknown as Turn;
  assert.deepEqual(claimsToCheck([t]).map((c) => c.subject), ["AWS RDS PostgreSQL entry-tier cost"]);
});

test("bare [n] markers become links; existing links untouched", () => {
  assert.equal(linkCitations("Neon $19 [1]; see [1](x) and [9]", [src]), `Neon $19 [1](${src.url}); see [1](x) and [9]`);
});
