# Minimi

A chat agent with one tool, web search, and a **dated, verifiable memory** of every conversation you've had with it. It runs on Claude, OpenAI, Gemini or Groq, each with its vendor's native web search. Any provider with a key in `.env` appears in the model picker.

```bash
cp .env.example .env      # set at least one of ANTHROPIC_API_KEY, OPENAI_API_KEY, GEMINI_API_KEY, GROQ_API_KEY
npm install
npm run dev               # → http://localhost:3000
```

Requires Node ≥ 22.13 (it uses the built-in `node:sqlite`, so there's no native build step).

## Try it

- *"Which managed Postgres hosts have the cheapest entry plan right now?"*
- Come back on another day: *"Last Tuesday I asked you about Postgres hosting. Has any pricing changed since then?"*
- *"What did I ask you on 3 November? Is your answer still correct today?"*

**Testing memory across days without waiting:**

- **Time travel:** open `http://localhost:3000/?now=2026-11-03T10:00` and chat. Turns are stored with that date. Then open the app normally and ask about "3 November".
- **Seed:** `npm run seed` runs the real agent with a back-dated clock, adding a Postgres conversation on a Tuesday ~8 days ago and a CRM shortlist on the most recent Monday. The searches and answers are real; only the timestamps are in the past.

## Scripts

| | |
|---|---|
| `npm run dev` | Server with reload, on port 3000 |
| `npm test` | Unit tests for date resolution and recall (no API key needed) |
| `npm run typecheck` | `tsc --noEmit` |
| `npm run seed` | Optional demo history (needs API key) |

## Layout

```
src/
  server.ts   HTTP: static UI, JSON API, SSE chat stream
  agent.ts    one turn: recall → prompt → provider (streamed, native search) → persist
  providers/  types.ts (the contract + citation rendering), anthropic.ts, openai.ts, gemini.ts, groq.ts
  memory.ts   recall (dates + BM25), context block, conversation ledger
  time.ts     deterministic date resolution in the user's timezone
  distill.ts  background memory distillation (summary, claims, entities)
  prompt.ts   system prompt
  db.ts       SQLite + FTS5 store
public/       vanilla JS chat UI
test/         node:test unit tests
```

See [DESIGN.md](DESIGN.md) for how it works and why.
