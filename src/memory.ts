// Recall: decide, in code and before the model runs, which past conversations are relevant
// to this message, and render them as a compact, dated block of evidence.
//
// Two signals, merged:
//   1. Dates  - "on 3 November", "last Tuesday" → every turn the user had on those days.
//   2. Topic  - BM25 over questions, distilled summaries, entities and recorded claims.
// Plus a ledger (one line per past thread) that is always in context, so the model can
// answer "what did we talk about?" questions and knows what it does *not* remember.
import { store, type Turn } from "./db.ts";
import { humanDate, humanNow, localDate, refersToPast, resolveDateRefs, weekday, type DateRef, type UserClock } from "./time.ts";

const MAX_RECALLED_TURNS = 6;
const MAX_ANSWER_CHARS = 1800; // fallback when a turn has not been distilled yet

const STOPWORDS = new Set(
  "a an and are as at be been but by can could did do does for from had has have how i if in into is it its just me my no not of on or our since so than that the their them then there these they this those to up us was we were what when where which who why will with would you your yours about any anything has have changed change still correct today ask asked tell told said again last week month day pricing price prices priced cost costs plan plans tool tools option options best cheapest something anything big new shipped released launched update updates updated latest current currently right now people person team monday tuesday wednesday thursday friday saturday sunday january february march april may june july august september october november december".split(
    " ",
  ),
);

export interface Recall {
  dateRefs: DateRef[];
  turns: Turn[];
  /** Date ranges the user referred to that have no conversations at all. */
  emptyRefs: DateRef[];
  refersToPast: boolean;
}

export function recall(text: string, clock: UserClock, currentThreadId: string | null): Recall {
  const exclude = currentThreadId ?? undefined;
  const pastIntent = refersToPast(text);
  // "right now" / "today" usually anchors the *question* ("latest version right now",
  // "still correct today?"), not a memory lookup. Only "what did I ask today?" - past
  // intent with no other date - makes "today" a memory reference.
  const allRefs = resolveDateRefs(text, clock);
  const isNow = (r: DateRef) => /^(today|now|right now|currently|tonight|this morning)$/i.test(r.phrase.trim());
  const onlyNow = allRefs.length > 0 && allRefs.every(isNow);
  const dateRefs = allRefs.filter((r) => !isNow(r) || (onlyNow && pastIntent));
  const picked = new Map<number, Turn>();
  const emptyRefs: DateRef[] = [];

  // Topic scores first, so date-matched turns can be ordered by relevance too.
  const query = ftsQuery(text);
  const topical = query ? store.searchTurns(query, 12, exclude) : [];
  const topicRank = new Map(topical.map((t, i) => [t.id, i]));

  for (const ref of dateRefs) {
    let onDay = [ref, ref.alternative]
      .filter((x): x is DateRef => !!x)
      .flatMap((x) => store.turnsBetween(x.from, x.to, exclude));
    // If some of that day's turns match the topic, keep only those ("last Tuesday ...
    // Postgres" shouldn't drag in Tuesday's banana bread). If none match, keep the whole
    // day only when the user points at our past ("what did I ask on 3 Nov?"); a dated
    // question about the world ("AI news last Tuesday") recalls nothing.
    const onTopic = onDay.filter((t) => topicRank.has(t.id));
    if (onTopic.length) onDay = onTopic;
    else if (!pastIntent) onDay = [];
    if (onDay.length === 0) {
      if (pastIntent) emptyRefs.push(ref);
      continue;
    }
    // A busy day can hold many turns; prefer the ones that also match the topic.
    onDay.sort((a, b) => (topicRank.get(a.id) ?? 99) - (topicRank.get(b.id) ?? 99));
    for (const t of onDay.slice(0, MAX_RECALLED_TURNS)) picked.set(t.id, t);
  }

  // Topic matches fill the remaining slots. Without a date anchor, require the message to
  // actually point at the past, or a strong lexical match - otherwise recall is noise.
  for (const t of topical) {
    if (picked.size >= MAX_RECALLED_TURNS) break;
    if (dateRefs.length > 0 && !pastIntent) continue; // dated question about the world, not about us
    if (!pastIntent && dateRefs.length === 0 && t.score > -2.5) continue; // weak match
    picked.set(t.id, t);
  }

  const turns = [...picked.values()].sort((a, b) => a.id - b.id);
  return { dateRefs, turns, emptyRefs, refersToPast: pastIntent };
}

/** Grounding block prepended to the user's message: the clock, plus recalled evidence. */
export function renderContext(text: string, clock: UserClock, r: Recall): string {
  const lines: string[] = [`Now: ${humanNow(clock)}.`];

  for (const ref of r.dateRefs) {
    const alt = ref.alternative ? ` (or ${span(ref.alternative)} - ambiguous; trust whichever date the recalled record matches)` : "";
    lines.push(`"${ref.phrase}" = ${span(ref)}${alt}.`);
  }

  if (r.turns.length > 0) {
    lines.push("", "Recalled from past conversations (verbatim record, oldest first):");
    for (const t of r.turns) lines.push(renderTurn(t, clock));
  }

  for (const ref of r.emptyRefs) {
    lines.push(`No conversations on record for ${span(ref)}${ref.alternative ? ` or ${span(ref.alternative)}` : ""}.`);
  }
  if (r.refersToPast && r.turns.length === 0) {
    const first = store.firstTurnDate();
    lines.push(
      first
        ? `No matching past conversation was found. Earliest conversation on record: ${humanDate(first)}.`
        : "There are no past conversations on record at all - this user's history is empty.",
    );
    // Restated here, next to the gap, because models under-weight the system prompt.
    lines.push(
      "Do not invent what was said. Say in one sentence that you have no record of it, then still help: search for the most likely candidates for the need described, label them as your assumption, and invite the user to share the real list.",
    );
  }

  return `<context>\n${lines.join("\n")}\n</context>\n\n${text}`;
}

function span(ref: DateRef): string {
  return ref.from === ref.to ? humanDate(ref.from) : `${humanDate(ref.from)} – ${humanDate(ref.to)}`;
}

function renderTurn(t: Turn, clock: UserClock): string {
  const local = new Date(t.createdAt + clock.offsetMin * 60_000);
  const time = `${String(local.getUTCHours()).padStart(2, "0")}:${String(local.getUTCMinutes()).padStart(2, "0")}`;
  const thread = store.getThread(t.threadId);
  const out = [`\n[${weekday(t.localDate)} ${t.localDate} ${time} · thread "${thread?.title ?? "untitled"}"]`, `User asked: ${t.userText}`];
  if (t.summary) {
    out.push(`You answered (summary): ${t.summary}`);
    if (t.claims.length) {
      out.push("Facts you stated then:");
      for (const c of t.claims) out.push(`- ${c.subject}: ${c.fact}${c.sourceUrl ? ` (${c.sourceUrl})` : ""}`);
    }
  } else {
    const a = t.answer.length > MAX_ANSWER_CHARS ? t.answer.slice(0, MAX_ANSWER_CHARS) + " …" : t.answer;
    out.push(`You answered: ${a}`);
  }
  return out.join("\n");
}

/** One line per past thread. Lives in the system prompt; changes only when threads change. */
export function renderLedger(clock: UserClock, currentThreadId: string | null): string {
  const threads = store.listThreads().filter((t) => t.id !== currentThreadId).slice(0, 80);
  if (threads.length === 0) return "Conversation history: none yet. This is the user's first conversation.";
  const lines = threads.map((t) => {
    const days = t.dates.map((d) => `${weekday(d).slice(0, 3)} ${d}`).join(", ");
    return `- ${days} · "${t.title ?? "untitled"}"`;
  });
  return `Conversation history (one line per past thread, newest first; details are recalled into <context> when relevant):\n${lines.join("\n")}`;
}

/** Turn free text into a safe FTS5 OR-query of meaningful terms. */
export function ftsQuery(text: string): string | null {
  const terms = [
    ...new Set(
      text
        .toLowerCase()
        .replace(/[^\p{L}\p{N}\s-]/gu, " ")
        .split(/\s+/)
        .map((w) => w.replace(/^-+|-+$/g, ""))
        .filter((w) => w.length >= 3 && !STOPWORDS.has(w) && !/^\d+$/.test(w)),
    ),
  ].slice(0, 16);
  if (terms.length === 0) return null;
  return terms.map((t) => `"${t.replace(/"/g, "")}"*`).join(" OR ");
}

export { localDate };
