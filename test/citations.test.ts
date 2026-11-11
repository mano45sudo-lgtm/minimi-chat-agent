import { test } from "node:test";
import assert from "node:assert/strict";
import { renderCitations } from "../src/providers/types.ts";
import { stripCursorCitations } from "../src/providers/groq.ts";

test("Groq cursor citations are stripped", () => {
  assert.equal(stripCursorCitations("Neon is $19/mo 【2†L6-L10】. Supabase is $25【3†source】.\n"), "Neon is $19/mo. Supabase is $25.");
});

const a = { url: "https://neon.com/pricing", title: "Neon pricing" };
const b = { url: "https://supabase.com/pricing", title: "Supabase pricing" };

test("numbers sources in reading order and inserts markers at span ends", () => {
  const text = "Neon Launch is $19/mo. Supabase Pro is $25/mo.";
  const { answer, sources } = renderCitations(text, [
    { end: text.indexOf("Supabase") + "Supabase Pro is $25/mo".length, sources: [b] },
    { end: "Neon Launch is $19/mo".length, sources: [a] },
  ]);
  assert.deepEqual(sources.map((s) => s.url), [a.url, b.url]);
  assert.equal(answer, `Neon Launch is $19/mo. [1](${a.url}) Supabase Pro is $25/mo. [2](${b.url})`);
});

test("reused sources keep their number; markers skip closing markdown", () => {
  const text = "**Neon** is cheapest. Neon also has branching.";
  const { answer, sources } = renderCitations(text, [
    { end: "**Neon".length, sources: [a] },
    { end: text.length, sources: [a, b] },
  ]);
  assert.equal(sources.length, 2);
  assert.ok(answer.startsWith(`**Neon** [1](${a.url}) is cheapest.`), answer);
  assert.ok(answer.endsWith(`branching. [1](${a.url}) [2](${b.url})`), answer);
});
