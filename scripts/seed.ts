// Optional demo: build a realistic history by running the REAL agent with a back-dated
// clock (real searches, real answers - only the timestamp is in the past). Then ask the
// agent today "Last Tuesday I asked you about Postgres hosting. Has any pricing changed?"
//
//   npm run seed            (needs ANTHROPIC_API_KEY; ~2-4 minutes)
import { runTurn } from "../src/agent.ts";
import { addDays, localDate } from "../src/time.ts";

const offsetMin = -new Date().getTimezoneOffset();
const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
const today = localDate(new Date(), offsetMin);

// Most recent past Monday / Tuesday, and a fixed-ish date ~8 days ago.
const lastWeekday = (dow: number) => {
  for (let i = 1; i <= 7; i++) {
    const d = addDays(today, -i);
    if (new Date(d + "T00:00:00Z").getUTCDay() === dow) return d;
  }
  return addDays(today, -7);
};

const script: Array<{ date: string; time: string; message: string }> = [
  { date: addDays(lastWeekday(2), -7), time: "10:15", message: "What are the best managed Postgres hosting options for a small startup, and what do their entry paid plans cost?" },
  { date: lastWeekday(1), time: "16:40", message: "We need a CRM for a 20-person sales team. Shortlist 5 tools with per-seat pricing for the tier we'd realistically need." },
];

for (const s of script) {
  const local = new Date(`${s.date}T${s.time}:00Z`);
  const now = new Date(local.getTime() - offsetMin * 60_000);
  process.stdout.write(`\n[${s.date} ${s.time}] ${s.message}\n`);
  await runTurn({
    threadId: null,
    message: s.message,
    clock: { now, offsetMin, timeZone },
    emit: (e) => {
      if (e.type === "search") process.stdout.write(`  ⌕ ${e.query}\n`);
      if (e.type === "final") process.stdout.write(`  ✓ answered with ${e.sources.length} sources\n`);
      if (e.type === "error") process.stdout.write(`  ✗ ${e.message}\n`);
    },
  });
}
// Let background distillation finish before exiting.
await new Promise((r) => setTimeout(r, 15_000));
console.log("\nSeeded. Start the app with `npm run dev` and ask about those conversations.");
