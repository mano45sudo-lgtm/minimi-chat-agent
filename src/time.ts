// Deterministic temporal grounding. The model is good at language and bad at calendars,
// so "last Tuesday" / "on 3 November" / "Monday" are resolved here, in code, against the
// user's own clock - before the model runs. Zero latency, zero tokens, testable.
import * as chrono from "chrono-node";

export interface UserClock {
  /** The instant "now" (UTC). Overridable so memory can be tested / seeded at any date. */
  now: Date;
  /** Minutes east of UTC, e.g. +330 for IST, -300 for EST. */
  offsetMin: number;
  /** IANA name, display only (e.g. "Asia/Kolkata"). */
  timeZone?: string;
}

export interface DateRef {
  /** The text that produced this reference, e.g. "last Tuesday". */
  phrase: string;
  /** Inclusive local-date range, YYYY-MM-DD. */
  from: string;
  to: string;
  /** A second plausible reading of an ambiguous phrase ("last Tuesday"). */
  alternative?: DateRef;
}

const DAY_MS = 86_400_000;
const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

/** Local calendar date (YYYY-MM-DD) of an instant, in the user's offset. */
export function localDate(instant: Date, offsetMin: number): string {
  return new Date(instant.getTime() + offsetMin * 60_000).toISOString().slice(0, 10);
}

export function addDays(ymd: string, days: number): string {
  return new Date(Date.parse(ymd + "T00:00:00Z") + days * DAY_MS).toISOString().slice(0, 10);
}

export function weekday(ymd: string): string {
  return WEEKDAYS[new Date(ymd + "T00:00:00Z").getUTCDay()]!;
}

/** "Tuesday 3 November 2026" */
export function humanDate(ymd: string): string {
  const d = new Date(ymd + "T00:00:00Z");
  const month = d.toLocaleString("en-GB", { month: "long", timeZone: "UTC" });
  return `${weekday(ymd)} ${d.getUTCDate()} ${month} ${d.getUTCFullYear()}`;
}

export function humanNow(clock: UserClock): string {
  const local = new Date(clock.now.getTime() + clock.offsetMin * 60_000);
  const hh = String(local.getUTCHours()).padStart(2, "0");
  const mm = String(local.getUTCMinutes()).padStart(2, "0");
  const sign = clock.offsetMin >= 0 ? "+" : "-";
  const abs = Math.abs(clock.offsetMin);
  const off = `UTC${sign}${String(Math.floor(abs / 60)).padStart(2, "0")}:${String(abs % 60).padStart(2, "0")}`;
  return `${humanDate(localDate(clock.now, clock.offsetMin))}, ${hh}:${mm} (${clock.timeZone ?? off}${clock.timeZone ? `, ${off}` : ""})`;
}

/**
 * Find every reference to a past day/period in the message.
 *
 * Memory is always about the past, so an ambiguous reference that chrono places in the
 * future ("Monday" said on a Wednesday, "3 December" said in November) is rolled back to
 * its most recent past occurrence.
 */
export function resolveDateRefs(text: string, clock: UserClock): DateRef[] {
  const today = localDate(clock.now, clock.offsetMin);
  const results = chrono.en.GB.parse(text, { instant: clock.now, timezone: clock.offsetMin });
  const refs: DateRef[] = [];

  for (const r of results) {
    let from = localDate(r.start.date(), clock.offsetMin);
    let to = r.end ? localDate(r.end.date(), clock.offsetMin) : from;

    if (from > today) {
      if (!r.start.isCertain("day") && r.start.isCertain("weekday")) {
        from = addDays(from, -7);
        to = addDays(to, -7);
      } else if (!r.start.isCertain("year")) {
        from = shiftYear(from, -1);
        to = shiftYear(to, -1);
      } else {
        continue; // a genuinely future date says nothing about memory
      }
    }

    // Widen period phrases ("last week", "last month") from a single day to the period.
    const phrase = r.text.toLowerCase();
    if (/\bweek\b/.test(phrase)) {
      const dow = (new Date(from + "T00:00:00Z").getUTCDay() + 6) % 7; // Monday = 0
      from = addDays(from, -dow);
      to = addDays(from, 6);
    } else if (/\bmonth\b/.test(phrase)) {
      from = from.slice(0, 8) + "01";
      to = addDays(shiftMonth(from, 1), -1);
    }
    if (to > today) to = today;

    // "since Monday" → from Monday until today
    const before = text.slice(Math.max(0, r.index - 7), r.index).toLowerCase();
    const since = /since\s*$/.test(before) || /^since\b/i.test(r.text);
    if (since) to = today;

    const ref: DateRef = { phrase: r.text.replace(/^(on|since|from)\s+/i, ""), from, to };
    // "last Tuesday" said on a Wednesday: yesterday, or the week before? People use both.
    // Keep the other reading as an alternative; recall checks both and the evidence decides.
    if (/^last\s+\w+day$/i.test(ref.phrase)) {
      if (!since && from === to) ref.alternative = { phrase: ref.phrase, from: addDays(from, -7), to: addDays(from, -7) };
      if (since) ref.alternative = { phrase: ref.phrase, from: addDays(from, -7), to: today };
    }
    refs.push(ref);
  }

  // "on the 3rd" / "Tuesday the 3rd": a bare day-of-month, which chrono misses. It means
  // the most recent past day with that number; it overrides an adjacent bare weekday.
  for (const m of text.matchAll(/\bthe\s+(\d{1,2})(?:st|nd|rd|th)\b/gi)) {
    const day = Number(m[1]);
    if (day < 1 || day > 31) continue;
    let ymd = today.slice(0, 8) + String(day).padStart(2, "0");
    if (ymd > today || !isRealDate(ymd)) ymd = shiftMonth(today.slice(0, 8) + "01", -1).slice(0, 8) + String(day).padStart(2, "0");
    if (!isRealDate(ymd)) continue;
    const at = m.index ?? 0;
    const adjacent = refs.findIndex((r) => {
      const i = text.toLowerCase().lastIndexOf(r.phrase.toLowerCase(), at);
      return i >= 0 && at - (i + r.phrase.length) <= 2 && /day$/i.test(r.phrase);
    });
    if (adjacent >= 0) refs.splice(adjacent, 1);
    refs.push({ phrase: m[0], from: ymd, to: ymd });
  }
  return refs;
}

function isRealDate(ymd: string): boolean {
  const d = new Date(ymd + "T00:00:00Z");
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === ymd;
}

function shiftYear(ymd: string, years: number): string {
  return String(Number(ymd.slice(0, 4)) + years) + ymd.slice(4);
}

function shiftMonth(ymd: string, months: number): string {
  const d = new Date(ymd + "T00:00:00Z");
  d.setUTCMonth(d.getUTCMonth() + months);
  return d.toISOString().slice(0, 10);
}

/**
 * Does the message point back at earlier conversations? Used to decide whether an empty
 * recall result must be stated explicitly ("no record of that") so the model never
 * invents a past conversation.
 */
export function refersToPast(text: string): boolean {
  return /\b(i|we)\s+(asked|said|told|discussed|talked|shortlisted|picked|chose|compared|looked|mentioned|decided|went over|were)\b|\b(did|do)\s+(i|we)\b|\bask(ed)?\s+you\b|\byou\s+(said|told|answered|recommended|suggested|mentioned|found|gave|picked)\b|\b(last time|earlier|previous(ly)?|remember|recall|since then|your (answer|recommendation|list)|we (had|did)|our (chat|conversation|list|shortlist))\b/i.test(
    text,
  );
}
