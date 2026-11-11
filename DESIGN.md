# How Minimi works, and why

## The idea

The three example questions in the brief, *"On Monday we shortlisted…"*, *"What did I ask you on 3 November?"* and *"Last Tuesday I asked about Postgres… has pricing changed?"*, aren't really search questions. They're about **memory and time**: what did we talk about, when, and is it still true? Any model can search the web now. Remembering correctly, and honestly re-checking what it said before, is the hard part. So that's where most of the work went.

## What happens when you send a message

1. **Work out the dates (plain code, no AI).** "Last Tuesday" or "on 3 November" is turned into real dates in *your* timezone. A bare "Monday" means the most recent past Monday. "Last Tuesday" said on a Wednesday could mean yesterday or the week before, so both are checked. This takes about 0.03 ms and is covered by unit tests.
2. **Look up past conversations (plain code).** Find chats from those dates, plus chats on the same topic. A simple word search in SQLite does this. If you point to a conversation that doesn't exist, the assistant is told so explicitly, and must say it has no record instead of making one up.
3. **Pick the fastest path for the question.**
   - *"Is that still correct?" / "Has anything changed since?"*: re-check each fact it stated before, **all at the same time** (see below).
   - *"What did I ask you on 3 November?"*: memory alone answers this, so a smaller, faster model answers with no web search.
   - Anything else: the main model answers, searching the web as needed.
4. **Show the work.** The answer streams in word by word. Above it, a collapsible timeline shows what the assistant did: memory looked up, each search and how many results it found.
5. **Remember it.** After answering, a small model writes down a short summary and the concrete facts that were stated (for example "Neon Launch: $19/month", with its source). This runs after you already have your answer, so it never slows you down.

## The part we're proudest of: re-checking old answers

When you ask "has pricing changed?", we already know exactly which facts to check: the ones saved in step 5. So instead of letting the AI search one thing after another, the code starts **one small search per fact, all at once**. Each result appears as a row: ✓ unchanged, Δ changed, or ? couldn't verify. The main model then writes the reply from those results.

- **Faster:** the wait is only as long as the slowest single check. On Groq, letting the model search one thing at a time took 137 s and 16 searches for a similar Postgres pricing question. The parallel way answers "has pricing changed since last Tuesday?" in about 5–6 s. These aren't identical tasks, but the gap is the point.
- **More honest:** the code only lets a fact be called "unchanged" or "changed" if that check found a source. Otherwise it's "couldn't verify". We added this after watching a small model claim it had "re-checked all seven prices" when it had done one search.
- **Doesn't fall over:** if the model writing the final reply fails (for example, a rate limit), the code builds the results table itself, so the checks aren't wasted.

## Other choices

- **Works with four AI providers** (Anthropic, OpenAI, Google, Groq), each using its own built-in web search. Each provider is one file behind a small shared interface. The memory and date code doesn't know or care which one is answering.
- **Simple building blocks:** SQLite built into Node, a plain Node web server, and a chat page in plain HTML/JS. No framework and no separate database to install.

## What we tried or rejected

- **Memory as a tool the AI calls:** the brief allows one tool (web search). It would also add an extra round trip, and models often forget to call it.
- **Letting the AI work out dates:** models get calendar math wrong, and code is instant and testable.
- **Sending the whole history every time:** slow, expensive, and the one relevant chat gets buried.
- **Embeddings / a vector database:** they need another API key, and they're worse than plain word search at exact names, dates and prices.

## How we tested it, honestly

- **22 unit tests** for the code that doesn't need an AI: dates, memory search, citations, fact-check rules.
- **An eval script** (`npm run eval`) that plays five realistic conversations against a real model and checks the results with code.
- **All live testing used Groq's free tier** (`gpt-oss-120b`, plus `gpt-oss-20b` for the quick checks), because we had no credits for the others. The main "changed since last Tuesday?" scenario passed all 6 checks twice, in 4.8 s and 5.9 s. The free tier's daily limit blocked the remaining scenarios on later runs. The evals also found a real bug ("right now" was pulling in unrelated chats from today), which we fixed.
- **Anthropic, OpenAI and Gemini are written and compile, but haven't answered a real question yet.** `npm run eval -- --provider anthropic` (or `openai` / `gemini`) checks them with your key.

## Known weak spots

- Deciding which path a question takes uses keyword patterns. An unusual phrasing may take the slower general path. That's still correct, just slower.
- Each fact re-check is one small AI call, so re-checking many facts costs more.
- The small free model sometimes asks you for details when it should just make a reasonable attempt.

## With another week

1. Run the evals on all four providers, with several phrasings of each question, and tune for speed and accuracy from the numbers.
2. Replace the keyword patterns with a small trained classifier.
3. Keep a history of each fact over time, so "what changed since Monday?" becomes a lookup, and repeat checks on the same day are instant.
4. Let users see, edit and delete what the assistant remembers.
