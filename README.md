# Minimi

A chat assistant that can search the web and remembers what you talked about, and when.

You can ask it things like *"Last Tuesday I asked you about Postgres hosting. Has any pricing changed since then?"*. It finds that conversation, re-checks each price it gave you, and tells you what changed.

## Run it

```bash
cp .env.example .env      # add at least one API key (see below)
npm install
npm run dev               # open http://localhost:3000
```

You need Node 22.13 or newer. There's no database to install: it uses SQLite, which is built into Node.

### Which API key?

It works with any one of these. Each one uses its own built-in web search, so you don't need a separate search key.

| Provider | Key in `.env` | Model used | Tested by us? |
|---|---|---|---|
| Groq | `GROQ_API_KEY` | `openai/gpt-oss-120b` | **Yes**: all our live testing and evals ran on Groq's free tier |
| Anthropic | `ANTHROPIC_API_KEY` | `claude-opus-5-5` | Written and compiles, but not run live (we had no credits) |
| OpenAI | `OPENAI_API_KEY` | `gpt-5` | Written and compiles, but not run live |
| Google | `GEMINI_API_KEY` | `gemini-3.8-flash` | Written and compiles, but not run live (our key was over its quota) |

All four appear in the model menu at the bottom of the chat. Ones without a key are greyed out. To check a provider yourself, run the evals against it (below).

## Things to try

1. **Ask about something current:** *"Which managed Postgres hosts have the cheapest paid plan right now?"* It searches the web and answers with numbered sources.
2. **Ask about the past with an empty history:** *"On Monday we shortlisted 5 CRM tools…"*. It tells you it has no record of that conversation instead of making one up.
3. **Ask about the past with history.** You can fake earlier days in two ways:
   - Open `http://localhost:3000/?now=2026-11-03T10:00` and chat. Messages are saved as if sent on that date. Then open the app normally and ask *"What did I ask you on 3 November? Is it still correct today?"*
   - Or run `npm run seed`. It asks the agent two real questions with past dates.

## Evals

```bash
npm run eval -- --provider groq        # or anthropic / openai / gemini
```

This runs five realistic conversations against the real model, using a fresh database with one pre-made past conversation. Code (not another AI) checks the results. It checks whether the agent found the right day, re-checked each old fact, never called a fact "unchanged" without a source, didn't search when memory was enough, and didn't invent a past conversation. It also prints how long each answer took.

**What we've run so far:** only Groq (free tier). The main scenario, *"has pricing changed since last Tuesday?"*, passed all 6 checks twice, in 4.8 s and 5.9 s. The free tier's daily limit stopped the other four scenarios on the later runs, and the eval reports those as "blocked", not as failures. **We have not run the evals on Anthropic, OpenAI or Gemini.** With a key for one of them, the command above checks it.

## Other commands

| Command | What it does |
|---|---|
| `npm test` | 22 fast unit tests (dates, memory search, citations, fact checks). No API key needed |
| `npm run typecheck` | Checks the TypeScript |

## Where things are

```
src/
  server.ts      web server: serves the page and streams answers
  agent.ts       handles one message from start to finish
  time.ts        works out what "last Tuesday" or "3 November" means for the user
  memory.ts      finds relevant past conversations
  verify.ts      re-checks old facts, all at the same time
  distill.ts     after each answer, saves a short summary and the facts it stated
  providers/     one file per AI provider (Anthropic, OpenAI, Gemini, Groq)
  db.ts          the SQLite database
public/          the chat page (plain HTML, CSS and JavaScript)
test/            unit tests
scripts/         eval.ts (end-to-end tests), seed.ts (demo history)
```

[DESIGN.md](DESIGN.md) explains how it works and why we built it this way.
