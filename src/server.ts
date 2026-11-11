// HTTP layer: static UI + a small JSON API + one streaming endpoint (SSE over POST).
// Plain node:http - the surface is five routes, a framework would add nothing.
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, normalize } from "node:path";
import { config } from "./config.ts";
import { describeError, runTurn, type AgentEvent } from "./agent.ts";
import { store } from "./db.ts";
import { listProviders } from "./providers/index.ts";

const PUBLIC = join(process.cwd(), "public");
const VENDOR: Record<string, string> = {
  "/vendor/marked.js": "node_modules/marked/lib/marked.umd.js",
  "/vendor/purify.js": "node_modules/dompurify/dist/purify.min.js",
};
const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
};

const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url ?? "/", "http://localhost");
    const path = url.pathname;

    if (req.method === "POST" && path === "/api/chat") return await chat(req, res);
    if (req.method === "GET" && path === "/api/threads") return json(res, store.listThreads());
    if (req.method === "GET" && path === "/api/providers") return json(res, listProviders());
    const m = path.match(/^\/api\/threads\/([\w-]+)$/);
    if (m && req.method === "GET") {
      const thread = store.getThread(m[1]!);
      if (!thread) return json(res, { error: "not found" }, 404);
      const turns = store.threadTurns(thread.id).map(({ promptText: _p, ...t }) => t);
      return json(res, { thread, turns });
    }
    if (m && req.method === "DELETE") {
      store.deleteThread(m[1]!);
      return json(res, { ok: true });
    }
    if (req.method === "GET") return await serveStatic(path, res);
    json(res, { error: "not found" }, 404);
  } catch (err) {
    console.error(err);
    if (!res.headersSent) json(res, { error: "internal error" }, 500);
    else res.end();
  }
});

async function chat(req: IncomingMessage, res: ServerResponse) {
  const body = JSON.parse(await readBody(req)) as {
    threadId?: string | null;
    message?: string;
    timeZone?: string;
    offsetMin?: number;
    provider?: string; // anthropic | openai | gemini | groq
    effort?: string; // low | medium | high
    now?: string; // optional clock override, for demos/tests of memory over time
  };
  const message = (body.message ?? "").trim();
  if (!message) return json(res, { error: "message is required" }, 400);

  res.writeHead(200, {
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
  });
  const abort = new AbortController();
  res.on("close", () => abort.abort()); // user hit stop / closed the tab
  const emit = (e: AgentEvent) => {
    if (!res.writableEnded) res.write(`data: ${JSON.stringify(e)}\n\n`);
  };

  try {
    await runTurn({
      threadId: body.threadId ?? null,
      message,
      clock: {
        now: body.now ? new Date(body.now) : new Date(),
        offsetMin: Number.isFinite(body.offsetMin) ? Number(body.offsetMin) : 0,
        timeZone: body.timeZone,
      },
      provider: body.provider,
      effort: body.effort === "low" || body.effort === "medium" || body.effort === "high" ? body.effort : undefined,
      signal: abort.signal,
      emit,
    });
  } catch (err) {
    if (!abort.signal.aborted) {
      console.error("[chat]", err);
      emit({ type: "error", message: describeError(err, body.provider) });
    }
  }
  res.end();
}

async function serveStatic(path: string, res: ServerResponse) {
  const file = VENDOR[path] ?? join(PUBLIC, normalize(path === "/" ? "/index.html" : path));
  if (!VENDOR[path] && !file.startsWith(PUBLIC)) return json(res, { error: "not found" }, 404);
  try {
    const data = await readFile(file);
    res.writeHead(200, { "Content-Type": TYPES[extname(file)] ?? "application/octet-stream" });
    res.end(data);
  } catch {
    json(res, { error: "not found" }, 404);
  }
}

function json(res: ServerResponse, data: unknown, status = 200) {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(data));
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", (c) => {
      data += c;
      if (data.length > 1_000_000) reject(new Error("body too large"));
    });
    req.on("end", () => resolve(data || "{}"));
    req.on("error", reject);
  });
}

server.listen(config.port, () => {
  const providers = listProviders()
    .map((p) => `${p.id} (${p.model})${p.default ? " [default]" : ""}`)
    .join(", ");
  console.log(`\n  Minimi is running → http://localhost:${config.port}\n  providers: ${providers || "none - set an API key in .env"}\n`);
});
