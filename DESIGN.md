# Minimi: design

## The idea
All three example questions are about the past: *what did I ask, what did we shortlist, has it changed since?* Web search is built into every AI provider now. Remembering correctly and re-checking old answers isn't. So that's where the effort went.

## How it works
1. **Dates are worked out by code, not the AI.** "Last Tuesday" or "on the 3rd" becomes a real date in your timezone. If a phrase could mean two days, both are checked.
2. **Past chats are looked up** for those dates and topics. If there's no record, the agent is told so and must say so, then still help.
3. **The question picks the path:**
   - *"Has it changed?"*: every fact it told you before is re-checked **at the same time**, one quick search each.
   - *"What did I ask?"*: answered from memory, with no web search.
   - Anything else: a normal web search answer, with sources.
4. **After each answer, it saves the facts it stated** (e.g. "Neon: $19/month", plus the source), so they can be re-checked later.

You see every search live while it works. It runs on Claude, OpenAI, Gemini or Groq.

## Results
All live testing used **Groq's free tier**: we had no credits for the other three.

| What we tested | Result |
|---|---|
| "Has pricing changed since last Tuesday?" | Passed 6/6 checks, 3 times, in **4–6 s** |
| Same kind of question, model searching one by one | **137 s**, 16 searches |
| "On Monday we shortlisted 5 CRMs…" with **no history** | Passed 6/6: said it had no record, then checked the 5 likely CRMs. Invented nothing |
| 14 reworded questions ("are those prices still right?") | All take the correct path |
| A small model claimed "I re-checked all 7 prices" after 1 search | Now impossible: a fact can't be marked "unchanged" without a source |

Testing also found 4 real bugs, all fixed: "the 3rd" wasn't read as a date, "since last Tuesday" missed a day, "double-check" wasn't treated as a re-check, and "right now" pulled in unrelated chats.

**Not yet tested live:** Claude, OpenAI and Gemini. Run `npm run eval -- --provider anthropic` (or `openai` / `gemini`) with your key to check them.

## Why this way
- **Code handles dates and memory.** It's instant (about 0.03 ms) and testable. AI is slow and gets dates wrong.
- **Re-checking runs all at once.** You wait for the slowest check, not the total.
- **Honesty is enforced by code, not just asked for in the prompt.** No source means "couldn't verify".
- **Simple stack.** SQLite built into Node, a plain web server, a plain HTML page. `npm install && npm run dev` just works.

## Considered and rejected
- **Memory as a tool the AI calls:** an extra round trip, and models forget to use it.
- **Sending the whole history every time:** slow, expensive, and buries the relevant chat.
- **Embeddings / vector search:** an extra API key, and worse at exact names, dates and prices.
- **A framework like LangChain:** it hides exactly what differs between providers.

## Known limits
- Question types are detected by keyword patterns, so an unusual phrasing may take the slower general path.
- "No record" questions that still need research take about 14 s on Groq.

## With another week
1. Run every eval on all four providers and tune for speed from the numbers.
2. Track each fact over time, so "what changed since Monday?" is an instant lookup.
3. Let users see, edit and delete what it remembers.
