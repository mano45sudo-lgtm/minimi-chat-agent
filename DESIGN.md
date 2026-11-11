# Minimi: design

**The bet:** the example prompts ("on Monday we shortlisted…", "what did I ask on 3 November?", "has pricing changed since?") are about *time and memory* more than search. Search is a commodity. Memory you can trust, plus re-checking what you said before, is the hard part. So that's where the design effort went.

## How a turn works

```
message ─► time.ts    resolve "last Tuesday" / "3 Nov" in the user's timezone   (code, ~0 ms)
        ─► memory.ts  recall turns on those dates ∪ BM25 topic matches (SQLite FTS5)
        ─► route      verify   → verify.ts: one fast search per stored claim, all in parallel,
                                 each verdict streamed live → reply written with search off
                      recall   → fast model, no search ("what did I ask on 3 Nov?")
                      research → main model + its native web search loop
        ─► persist    → distill.ts (background, cheap model): summary, claims, title
```

## Key decisions

- **Recall runs in code before the model, not as a tool.** It keeps the one-tool brief and saves a round trip on every memory question. `chrono-node` plus rules handles the past ("Monday" means the last Monday). "Last Tuesday" said on a Wednesday is ambiguous, so both dates are checked and the record decides. Turns store the user's local date, so "3 November" means *their* 3 November.
- **Absence is said out loud.** If the user points to the past and nothing matches, the context says "no conversations on record for Tue 20 Oct" and gives the earliest date on record. The agent says so, then makes a labeled best attempt. It never invents a memory.
- **Answers become checkable claims.** After each reply, a cheap model extracts the time-sensitive facts it stated ("Neon Launch: $19/mo", with source). Code drops claims about the conversation itself and merges restatements.
- **Verification is a fixed pipeline, not an agent loop.** For "still correct?" or "changed since?", we already know which facts to check. So code fans out one fast, search-enabled check per claim, in parallel. Wall time is the slowest single check, not the sum. On Groq, a model-driven loop took 137 s; parallel checks took about 14 s and found two real price changes. Code allows "unchanged" or "changed" only when a check returned a source this turn; otherwise the fact is "not verified". If the reply model fails, code renders the verdict table itself.
- **A thin provider interface.** Claude, OpenAI, Gemini and Groq each use their own native web search, behind one interface in `providers/types.ts`: stream events, return text with citation spans, produce JSON. The adapters' real work is turning four citation formats into numbered links. Groq's markers don't map to URLs, so it lists sources per answer instead: coarser attribution, but never a fake citation.
- **Speed you can see.** Streaming over SSE, plus a reasoning timeline (recall, searches with result counts, thinking notes) that folds away once the answer starts. A static system prompt with per-turn data in the user turn, and history replayed as compact text, keeps prompt caches hitting.
- **Boring infrastructure.** `node:sqlite` with FTS5 (no native build), plain `node:http`, vanilla JS. `npm install && npm run dev` just works.

## Considered and rejected

- **Memory as a tool:** it would break the brief, add a round trip, and models skip it when they shouldn't.
- **Embeddings:** they need a second key and are weaker on exact dates, product names and prices than BM25 plus a date index.
- **The LLM doing calendar math:** unreliable and slow; code is deterministic and unit-tested.
- **A custom search API plus reranker:** more keys and client round trips, for no proven gain over native search.
- **LangChain or a generic AI SDK:** it hides exactly what differs between vendors (search tools, citations, streams).
- **Dumping all history into context:** slow, costly, and it buries the one relevant turn.

## Known limits

Intent routing uses keyword patterns: a paraphrase may take the slower research path, which is still correct. The per-claim checks spend one small model call per fact. Live testing so far ran on Groq's free tier; the other adapters are typed against their SDKs but unexercised.

## With another week

1. **Evals:** scripted multi-day conversations replayed with clock overrides, graded on memory accuracy, freshness and citation support. Then tune effort and prompts against them.
2. **Claim time series:** link re-checks to the same claim, so "what changed since Monday?" becomes a query and same-day re-checks come from cache.
3. **Learned router** to replace the regexes, picking provider per route by measured speed and accuracy.
4. **Hybrid retrieval** (BM25 + embeddings), **watchlists** (scheduled claim re-checks), **multi-user** auth with a user-editable memory page.
