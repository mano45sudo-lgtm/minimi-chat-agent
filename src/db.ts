// Persistence: one SQLite file via Node's built-in node:sqlite (no native build step),
// with an FTS5 index for lexical recall over past turns.
import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";
import { config } from "./config.ts";

export interface Source {
  url: string;
  title: string;
  /** Publication / last-updated hint from the search index, when known. */
  pageAge?: string | null;
}

export interface Claim {
  subject: string;
  fact: string;
  sourceUrl: string | null;
}

export interface Turn {
  id: number;
  threadId: string;
  createdAt: number; // epoch ms
  localDate: string; // YYYY-MM-DD in the user's timezone at the time of the turn
  userText: string; // what the user typed
  promptText: string; // what the model actually received (user text + grounding context)
  answer: string; // final markdown, with [n] citation markers
  sources: Source[];
  searches: string[];
  summary: string | null; // distilled by the memory model, async
  claims: Claim[];
  entities: string[];
  model: string | null; // provider/model that answered, e.g. "gemini/gemini-3.8-flash"
}

export interface Thread {
  id: string;
  title: string | null;
  createdAt: number;
  updatedAt: number;
}

mkdirSync(dirname(config.dbPath), { recursive: true });
const db = new DatabaseSync(config.dbPath);
db.exec(`
  PRAGMA journal_mode = WAL;
  CREATE TABLE IF NOT EXISTS threads (
    id TEXT PRIMARY KEY,
    title TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS turns (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    thread_id TEXT NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
    created_at INTEGER NOT NULL,
    local_date TEXT NOT NULL,
    user_text TEXT NOT NULL,
    prompt_text TEXT NOT NULL,
    answer TEXT NOT NULL,
    sources TEXT NOT NULL DEFAULT '[]',
    searches TEXT NOT NULL DEFAULT '[]',
    summary TEXT,
    claims TEXT NOT NULL DEFAULT '[]',
    entities TEXT NOT NULL DEFAULT '[]',
    model TEXT
  );
  CREATE INDEX IF NOT EXISTS turns_by_thread ON turns(thread_id, id);
  CREATE INDEX IF NOT EXISTS turns_by_date ON turns(local_date);
  CREATE VIRTUAL TABLE IF NOT EXISTS turns_fts USING fts5(
    question, summary, entities, claims, tokenize = 'porter unicode61'
  );
`);

// Migration for databases created before multi-provider support.
try {
  db.exec("ALTER TABLE turns ADD COLUMN model TEXT");
} catch {
  /* column already exists */
}

type Row = Record<string, unknown>;

function toTurn(r: Row): Turn {
  return {
    id: Number(r.id),
    threadId: String(r.thread_id),
    createdAt: Number(r.created_at),
    localDate: String(r.local_date),
    userText: String(r.user_text),
    promptText: String(r.prompt_text),
    answer: String(r.answer),
    sources: JSON.parse(String(r.sources)),
    searches: JSON.parse(String(r.searches)),
    summary: r.summary == null ? null : String(r.summary),
    claims: JSON.parse(String(r.claims)),
    entities: JSON.parse(String(r.entities)),
    model: r.model == null ? null : String(r.model),
  };
}

function toThread(r: Row): Thread {
  return {
    id: String(r.id),
    title: r.title == null ? null : String(r.title),
    createdAt: Number(r.created_at),
    updatedAt: Number(r.updated_at),
  };
}

export const store = {
  createThread(now: number): Thread {
    const id = randomUUID();
    db.prepare("INSERT INTO threads (id, title, created_at, updated_at) VALUES (?, NULL, ?, ?)").run(id, now, now);
    return { id, title: null, createdAt: now, updatedAt: now };
  },

  getThread(id: string): Thread | null {
    const r = db.prepare("SELECT * FROM threads WHERE id = ?").get(id) as Row | undefined;
    return r ? toThread(r) : null;
  },

  listThreads(): Array<Thread & { turnCount: number; dates: string[] }> {
    const rows = db
      .prepare(
        `SELECT t.*, COUNT(u.id) AS turn_count, GROUP_CONCAT(DISTINCT u.local_date) AS dates
         FROM threads t JOIN turns u ON u.thread_id = t.id
         GROUP BY t.id ORDER BY t.updated_at DESC`,
      )
      .all() as Row[];
    return rows.map((r) => ({
      ...toThread(r),
      turnCount: Number(r.turn_count),
      dates: String(r.dates ?? "").split(",").filter(Boolean).sort(),
    }));
  },

  setThreadTitle(id: string, title: string) {
    db.prepare("UPDATE threads SET title = ? WHERE id = ? AND title IS NULL").run(title, id);
  },

  deleteThread(id: string) {
    const ids = db.prepare("SELECT id FROM turns WHERE thread_id = ?").all(id) as Row[];
    for (const r of ids) db.prepare("DELETE FROM turns_fts WHERE rowid = ?").run(Number(r.id));
    db.prepare("DELETE FROM turns WHERE thread_id = ?").run(id);
    db.prepare("DELETE FROM threads WHERE id = ?").run(id);
  },

  threadTurns(threadId: string): Turn[] {
    return (db.prepare("SELECT * FROM turns WHERE thread_id = ? ORDER BY id").all(threadId) as Row[]).map(toTurn);
  },

  insertTurn(t: Omit<Turn, "id" | "summary" | "claims" | "entities" | "model"> & { model?: string | null }): number {
    const res = db
      .prepare(
        `INSERT INTO turns (thread_id, created_at, local_date, user_text, prompt_text, answer, sources, searches, model)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(t.threadId, t.createdAt, t.localDate, t.userText, t.promptText, t.answer, JSON.stringify(t.sources), JSON.stringify(t.searches), t.model ?? null);
    const id = Number(res.lastInsertRowid);
    // Index immediately with the raw text so recall works even before distillation finishes.
    db.prepare("INSERT INTO turns_fts (rowid, question, summary, entities, claims) VALUES (?, ?, ?, '', '')").run(
      id,
      t.userText,
      t.answer.slice(0, 4000),
    );
    db.prepare("UPDATE threads SET updated_at = ? WHERE id = ?").run(t.createdAt, t.threadId);
    return id;
  },

  saveDistillation(turnId: number, d: { summary: string; claims: Claim[]; entities: string[] }) {
    db.prepare("UPDATE turns SET summary = ?, claims = ?, entities = ? WHERE id = ?").run(
      d.summary,
      JSON.stringify(d.claims),
      JSON.stringify(d.entities),
      turnId,
    );
    db.prepare("UPDATE turns_fts SET summary = ?, entities = ?, claims = ? WHERE rowid = ?").run(
      d.summary,
      d.entities.join(" "),
      d.claims.map((c) => `${c.subject} ${c.fact}`).join(" \n "),
      turnId,
    );
  },

  turnsBetween(from: string, to: string, excludeThread?: string): Turn[] {
    return (
      db
        .prepare("SELECT * FROM turns WHERE local_date BETWEEN ? AND ? AND thread_id IS NOT ? ORDER BY id")
        .all(from, to, excludeThread ?? null) as Row[]
    ).map(toTurn);
  },

  /** BM25-ranked lexical search. `query` must already be a valid FTS5 expression. */
  searchTurns(query: string, limit: number, excludeThread?: string): Array<Turn & { score: number }> {
    const rows = db
      .prepare(
        `SELECT turns.*, bm25(turns_fts, 3.0, 2.0, 2.0, 1.0) AS score
         FROM turns_fts JOIN turns ON turns.id = turns_fts.rowid
         WHERE turns_fts MATCH ? AND turns.thread_id IS NOT ?
         ORDER BY score LIMIT ?`,
      )
      .all(query, excludeThread ?? null, limit) as Row[];
    return rows.map((r) => ({ ...toTurn(r), score: Number(r.score) }));
  },

  firstTurnDate(): string | null {
    const r = db.prepare("SELECT MIN(local_date) AS d FROM turns").get() as Row | undefined;
    return r?.d == null ? null : String(r.d);
  },
};
