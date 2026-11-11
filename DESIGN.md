# Minimi: design

## The problem, re-read

All three example prompts are mostly about **time**, not search: *"on Monday we shortlisted…"*, *"what did I ask you on 3 November?"*, *"last Tuesday… has pricing changed since?"*. Answering them well takes four things:

1. Knowing what today is, and what "last Tuesday" means **for this user** (their timezone, not the server's).
2. Recalling exactly what was asked and answered back then.
3. Knowing which **facts** that answer asserted, so they can be re-checked.
4. Fresh search to compare against, with the agent honest about what it can't find.

Search quality is mostly a commodity now. Memory you can trust is what's actually hard here, so that's where most of the design effort went.

## How a turn works

```
user msg ─► time.ts   resolve dates in user's tz ("last Tuesday" → 10 Nov, alt 3 Nov)
        ─► memory.ts  recall: turns on those dates  ∪  BM25 topic matches   (SQLite FTS5)
        ─► <context>  Now: Wed 11 Nov 14:05 IST · resolved dates · recalled turns + their claims
        ─► provider   Claude | GPT | Gemini | Groq, each with its vendor's native web search, streamed (SSE)
        ─► citations  normalised to numbered links; turn persisted
        ─► distill.ts (background, cheap model) summary · claims[] · entities · thread title
```

- **Recall runs in code, before the model, not as a tool.** The brief says there's one tool, and this also saves a round trip on every memory question. Date references go through `chrono-node` plus rules for the past: a bare "Monday" means the most recent past Monday; "3 December" said in November means last year. "Last Tuesday" said on a Wednesday is genuinely ambiguous, so both readings are recalled and the matching record wins. Turns store the user's local date at write time, so "on 3 November" means their 3 November.
- **Precision before recall.** A day's turns are narrowed by topic overlap (no "banana bread" in a Postgres answer). A dated question about the world ("AI news last Tuesday") recalls nothing. Topic-only recall needs past-pointing language or a strong match.
- **Absence is said out loud.** When the user points to the past and nothing matches, the context says *"No conversations on record for Tuesday 20 October"* plus the earliest date on record. The prompt forbids inventing memories, then tells the agent to still be useful: say there's no record in one line, then make a clearly labeled best attempt. A judge with an empty history asking "on Monday we shortlisted 5 CRMs…" gets honesty plus a check of the likely candidates, not a made-up shortlist.
- **A ledger is always in context**: one line per past thread (dates and title), in the system prompt. It lets the agent answer "what have we talked about?" and know where its memory ends.
- **Distilled claims make "is it still correct?" checkable.** After each answer, Haiku extracts the concrete, time-sensitive facts the agent asserted (*"Neon Launch: $19/mo"*, with source). Later, the agent re-verifies each one and reports *still correct / changed (old → new, when) / couldn't verify*. This runs off the critical path: the user already has their answer.

## Why these choices

- **A thin provider seam, with memory above it.** `providers/types.ts` is the whole contract: answer a turn with native search while emitting common events (`search`, `status`, `text`), return text plus citation spans, and produce schema-valid JSON for distillation. Time, recall, the prompt, storage and the UI never know which vendor answered. History is replayed as plain text, so a thread can even switch models mid-conversation. Adapters run 110–150 lines each. Whichever keys are present become available, and the UI picks one per message.
- **Each vendor's native search, not my own pipeline.** Claude `web_search_20260209`, OpenAI's Responses `web_search`, Gemini's Google Search grounding and Groq's `browser_search` on GPT-OSS all run the search loop server-side inside one request. That means no client round trip per search and parallel queries. The adapters' real work is normalising citation formats into one: Claude's cited text blocks, OpenAI's character offsets, and Gemini's byte-offset segments, which are located by their text. Groq's inline markers (`【2†L6-L10】`) don't map reliably to URLs, so that adapter strips them and lists sources per answer instead of per sentence. The interface allows degraded attribution, but never a fake citation. The shared prompt does the rest: plan queries, search in parallel, go to primary sources (pricing pages, changelogs), check page dates for "since X" questions, treat results as untrusted.
- **Defaults: Opus 5.5 at `medium` effort, streamed.** Search activity, recall chips and progress notes (Claude's between-search updates, OpenAI's reasoning summaries, Gemini's thought summaries) stream into the UI, so a 10-second research turn never looks frozen. On Claude, server-side refusal fallbacks are on.
- **Cache-friendly prompt layout.** The static system prompt is cached. Per-turn volatile data (clock, recall) goes in the user turn, not the system prompt. Prior turns are replayed as *what the model was sent* plus the *final cited answer*: byte-stable, so the conversation prefix keeps hitting the cache, and much smaller than replaying raw search payloads.
- **SQLite via `node:sqlite` with FTS5.** One file, transactional, BM25 for free, no native build. `npm install && npm run dev` just works.
- **Plain `node:http` and vanilla JS.** Five routes and one page. A framework would add surface area, not capability.

## Considered and rejected

- **Memory as a `recall` tool.** It would break the one-tool brief, and it costs an extra model round trip on exactly the questions where memory matters. The model also tends to skip it when it should call it.
- **Embeddings / vector DB.** It needs a second provider key and is weaker on what matters here: exact dates, product names and prices. BM25 plus date indexing matches better. Embeddings would be a good second retrieval signal later (see below).
- **Dumping all history into context.** It doesn't scale, it's slow and expensive, and it buries the one relevant turn.
- **Asking the LLM to resolve dates.** Models are unreliable at calendar math, and it costs latency. Code is deterministic and unit-tested (`npm test`).
- **A third-party search API (Tavily/Exa/Brave) plus a custom fetch/rerank pipeline.** That means more control and more keys, but each search costs a client round trip and the citations have to be hand-built. Worth revisiting only with evals showing it beats the native tool.
- **A framework abstraction (LangChain, a generic AI SDK) for multi-provider.** It hides exactly what differs and matters here: each vendor's search tool, citation format and streaming events. Three explicit adapters behind one small interface are easier to read and to debug.
- **Compaction / long-context tricks.** Text-only replay keeps threads small. Cross-thread memory is retrieval, not context length.

## With another week

1. **Evals first.** Build a dataset of multi-day scripted conversations (the three examples and variants), replayed with clock overrides, graded per turn on memory accuracy, freshness and citation support. Then tune the effort level, search caps and prompt against it.
2. **Claim diffing as data.** Store a re-verification as a new dated observation of the same claim, so "what changed since Monday?" becomes a query over a time series instead of a fresh comparison.
3. **Hybrid retrieval.** Add embeddings to BM25 with reciprocal-rank fusion, plus query rewriting for paraphrases ("DB hosting" ↔ "Postgres").
4. **Watchlists.** "Tell me if any of these 5 CRMs change pricing" becomes a scheduled re-verification of stored claims.
5. **Multi-user.** Auth, per-user stores, and a memory page where users can see, edit and forget what the agent remembers.
6. **Latency routing.** A fast path (a small model, low effort) for chit-chat and memory-only questions, with the large model kept for research turns. Use the eval set to pick the default provider per route, rather than by taste.
