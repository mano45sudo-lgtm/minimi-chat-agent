// Minimal vanilla client: thread list, streaming chat over SSE-on-POST, markdown rendering.
const $ = (s) => document.querySelector(s);
const log = $("#log");
const input = $("#input");
const send = $("#send");

// Optional clock override for testing memory across days: /?now=2026-11-03T10:00
const clockOverride = new URLSearchParams(location.search).get("now");
if (clockOverride) {
  const note = $("#clock-note");
  note.hidden = false;
  note.textContent = `Clock override: ${new Date(clockOverride).toString().slice(0, 21)}`;
}

let threadId = null;
let controller = null;

// ---------- provider picker (only providers with a key on the server are listed) ----------
const picker = $("#provider");
const LABELS = { anthropic: "Claude", openai: "OpenAI", gemini: "Gemini", groq: "Groq" };
async function loadProviders() {
  const providers = await (await fetch("/api/providers")).json();
  let saved = null;
  try { saved = localStorage.getItem("provider"); } catch {}
  picker.replaceChildren(...providers.map((p) => {
    const o = el("option", null, `${LABELS[p.id] ?? p.id} · ${p.model}`);
    o.value = p.id;
    o.selected = saved ? p.id === saved : p.default;
    return o;
  }));
  picker.hidden = providers.length < 2;
}
picker.addEventListener("change", () => { try { localStorage.setItem("provider", picker.value); } catch {} });
loadProviders();

// ---------- rendering helpers ----------
function md(text) {
  const html = DOMPurify.sanitize(marked.parse(text, { gfm: true, breaks: false }));
  const tpl = document.createElement("template");
  tpl.innerHTML = html;
  for (const a of tpl.content.querySelectorAll("a")) {
    a.target = "_blank";
    a.rel = "noopener noreferrer";
    if (/^\d+$/.test(a.textContent.trim())) a.classList.add("cite");
  }
  return tpl.content;
}

function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  return e;
}

function fmtDate(ymd) {
  const d = new Date(ymd + "T00:00:00");
  return d.toLocaleDateString(undefined, { weekday: "short", day: "numeric", month: "short" });
}

function host(url) {
  try { return new URL(url).hostname.replace(/^www\./, ""); } catch { return url; }
}

function addUser(text, when) {
  $("#empty")?.remove();
  const m = el("div", "msg user");
  const wrap = el("div");
  wrap.append(el("div", "bubble", text));
  if (when) wrap.append(el("div", "meta", when));
  m.append(wrap);
  log.append(m);
  scroll();
}

function addAssistant() {
  const m = el("div", "msg assistant");
  const activity = el("div", "activity");
  const status = el("div", "status");
  const answer = el("div", "answer");
  m.append(activity, status, answer);
  log.append(m);
  return { m, activity, status, answer };
}

function renderSources(container, sources) {
  if (!sources?.length) return;
  const d = el("details", "sources");
  d.append(el("summary", null, `${sources.length} source${sources.length > 1 ? "s" : ""}`));
  const ol = el("ol");
  for (const s of sources) {
    const li = el("li");
    const a = el("a", null, s.title || host(s.url));
    a.href = s.url; a.target = "_blank"; a.rel = "noopener noreferrer";
    li.append(a, el("span", "age", ` · ${host(s.url)}${s.pageAge ? ` · ${s.pageAge}` : ""}`));
    ol.append(li);
  }
  d.append(ol);
  container.append(d);
}

function scroll() {
  const nearBottom = log.scrollHeight - log.scrollTop - log.clientHeight < 200;
  if (nearBottom) log.scrollTop = log.scrollHeight;
}

// ---------- threads ----------
async function loadThreads() {
  const threads = await (await fetch("/api/threads")).json();
  const nav = $("#threads");
  nav.replaceChildren();
  let lastGroup = null;
  for (const t of threads) {
    const last = t.dates[t.dates.length - 1];
    const group = groupLabel(last);
    if (group !== lastGroup) { nav.append(el("div", "group", group)); lastGroup = group; }
    const a = el("a", "thread" + (t.id === threadId ? " active" : ""));
    a.href = "#" + t.id;
    a.append(el("span", null, t.title || "Untitled"));
    const del = el("button", "del", "✕");
    del.title = "Delete conversation";
    del.onclick = async (e) => {
      e.preventDefault(); e.stopPropagation();
      if (!confirm("Delete this conversation and its memory?")) return;
      await fetch("/api/threads/" + t.id, { method: "DELETE" });
      if (t.id === threadId) newChat();
      loadThreads();
    };
    a.append(del);
    a.onclick = (e) => { e.preventDefault(); openThread(t.id); document.body.classList.remove("sidebar-open"); };
    nav.append(a);
  }
}

function groupLabel(ymd) {
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const d = new Date(ymd + "T00:00:00");
  const days = Math.round((today - d) / 86400000);
  if (days <= 0) return "Today";
  if (days === 1) return "Yesterday";
  if (days < 7) return "This week";
  return d.toLocaleDateString(undefined, { month: "long", year: "numeric" });
}

async function openThread(id) {
  if (controller) controller.abort();
  const data = await (await fetch("/api/threads/" + id)).json();
  if (data.error) return newChat();
  threadId = id;
  $("#title").textContent = data.thread.title || "Untitled";
  log.replaceChildren();
  for (const t of data.turns) {
    const when = new Date(t.createdAt).toLocaleString(undefined, { weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
    addUser(t.userText, when);
    const a = addAssistant();
    if (t.searches.length) for (const q of t.searches) a.activity.append(el("div", "chip", "⌕ " + q));
    a.answer.append(md(t.answer));
    renderSources(a.m, t.sources);
    if (t.model) a.m.append(el("div", "answer-meta", t.model.split("/").pop()));
  }
  log.scrollTop = log.scrollHeight;
  history.replaceState(null, "", location.search + "#" + id);
  loadThreads();
}

function newChat() {
  if (controller) controller.abort();
  threadId = null;
  $("#title").textContent = "New chat";
  log.replaceChildren(emptyState.cloneNode(true));
  wireExamples();
  history.replaceState(null, "", location.pathname + location.search);
  loadThreads();
  input.focus();
}

// ---------- chat ----------
async function submit(text) {
  if (!text.trim() || controller) return;
  input.value = ""; autosize();
  addUser(text);
  const a = addAssistant();
  a.answer.classList.add("streaming");
  let raw = "";
  let liveChip = null;
  controller = new AbortController();
  send.classList.add("stop"); send.textContent = "■";

  const handle = (e) => {
    switch (e.type) {
      case "thread":
        if (threadId !== e.threadId) { threadId = e.threadId; history.replaceState(null, "", location.search + "#" + e.threadId); }
        break;
      case "recall": {
        const n = e.turns.length;
        const label = n
          ? `↺ Recalled ${n} past message${n > 1 ? "s" : ""} · ${[...new Set(e.turns.map((t) => fmtDate(t.date)))].join(", ")}`
          : `↺ No conversation on record for ${e.dates.map((d) => d.split("..").map(fmtDate).join(" – ")).join(" or ")}`;
        a.activity.append(el("div", "chip recall", label));
        break;
      }
      case "status":
        a.status.textContent = e.text;
        break;
      case "checks": {
        // One live row per recorded fact; each fills in as its parallel check lands.
        const box = el("div", "checks");
        for (const c of e.items) {
          const row = el("div", "check pending");
          row.dataset.id = c.id;
          row.append(
            el("span", "check-icon", "⟳"),
            el("span", "check-subject", c.subject),
            el("span", "check-then", `${c.then} · ${fmtDate(c.date)}`),
            el("span", "check-now", "checking…"),
          );
          box.append(row);
        }
        a.checks = box;
        a.m.insertBefore(box, a.answer);
        break;
      }
      case "check": {
        const row = a.checks?.querySelector(`[data-id="${e.id}"]`);
        if (!row) break;
        const icon = { unchanged: "✓", changed: "Δ", unverified: "?" }[e.status];
        row.className = `check ${e.status}`;
        row.querySelector(".check-icon").textContent = icon;
        const now = row.querySelector(".check-now");
        now.replaceChildren();
        const label = e.status === "unverified" ? "not verified" : e.now + (e.changedOn ? ` (changed ${e.changedOn})` : "");
        if (e.sources[0]) {
          const link = el("a", null, label);
          link.href = e.sources[0].url; link.target = "_blank"; link.rel = "noopener noreferrer";
          now.append(link);
        } else now.textContent = label;
        break;
      }
      case "search":
        liveChip?.classList.remove("live");
        liveChip = el("div", "chip live", "⌕ " + e.query);
        a.activity.append(liveChip);
        break;
      case "results":
        liveChip?.classList.remove("live");
        break;
      case "text":
        raw += e.delta;
        a.status.textContent = "";
        a.answer.replaceChildren(md(raw));
        break;
      case "final":
        a.answer.replaceChildren(md(e.answer));
        renderSources(a.m, e.sources);
        a.m.append(el("div", "answer-meta", e.model));
        break;
      case "error":
        a.answer.append(el("p", "error", e.message));
        break;
    }
    scroll();
  };

  try {
    const res = await fetch("/api/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      signal: controller.signal,
      body: JSON.stringify({
        threadId,
        message: text,
        provider: picker.value || undefined,
        timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
        offsetMin: -new Date(clockOverride || Date.now()).getTimezoneOffset(),
        now: clockOverride ? new Date(clockOverride).toISOString() : undefined,
      }),
    });
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buf = "";
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      let i;
      while ((i = buf.indexOf("\n\n")) >= 0) {
        const chunk = buf.slice(0, i); buf = buf.slice(i + 2);
        if (chunk.startsWith("data: ")) handle(JSON.parse(chunk.slice(6)));
      }
    }
  } catch (err) {
    if (err.name !== "AbortError") a.answer.append(el("p", "error", "Connection lost. " + err.message));
  } finally {
    a.answer.classList.remove("streaming");
    a.status.textContent = "";
    liveChip?.classList.remove("live");
    controller = null;
    send.classList.remove("stop"); send.textContent = "↑";
    loadThreads();
    // Title is distilled in the background; refresh once it is likely ready.
    setTimeout(() => threadId && refreshTitle(), 4000);
  }
}

async function refreshTitle() {
  const data = await (await fetch("/api/threads/" + threadId)).json();
  if (data.thread?.title) $("#title").textContent = data.thread.title;
  loadThreads();
}

// ---------- wiring ----------
function autosize() {
  input.style.height = "auto";
  input.style.height = Math.min(input.scrollHeight, 200) + "px";
}
input.addEventListener("input", autosize);
input.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey && !e.isComposing) { e.preventDefault(); submit(input.value); }
});
$("#composer").addEventListener("submit", (e) => {
  e.preventDefault();
  if (controller) controller.abort();
  else submit(input.value);
});
$("#new-chat").onclick = newChat;
$("#toggle-sidebar").onclick = () => document.body.classList.toggle("sidebar-open");
const emptyState = $("#empty").cloneNode(true);
function wireExamples() {
  for (const b of document.querySelectorAll("#examples button")) b.onclick = () => submit(b.textContent);
}
wireExamples();

window.addEventListener("DOMContentLoaded", () => {
  const id = location.hash.slice(1);
  if (id) openThread(id); else loadThreads();
});
