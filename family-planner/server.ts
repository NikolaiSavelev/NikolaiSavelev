// Family planner server: serves the page, keeps the family's data in SQLite,
// gates everything behind one family code, and parses dictation with Claude.
import Anthropic from "@anthropic-ai/sdk";
import webpush from "web-push";
import { Database } from "bun:sqlite";
import { existsSync, mkdirSync, unlinkSync } from "node:fs";
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

const PORT = Number(Bun.env.PORT || 3000);
const DATA_DIR = Bun.env.DATA_DIR || "./data";
const PIN = (Bun.env.FAMILY_PIN || "").trim();
if (!PIN) {
  console.error("FAMILY_PIN is not set — refusing to start without a family code");
  process.exit(1);
}

// ---- storage ----
mkdirSync(DATA_DIR, { recursive: true });
const db = new Database(`${DATA_DIR}/family.sqlite`, { create: true });
db.exec("PRAGMA journal_mode = WAL;");
db.exec(`
  CREATE TABLE IF NOT EXISTS docs (
    coll TEXT NOT NULL,
    id TEXT NOT NULL,
    data TEXT NOT NULL,
    updated_at INTEGER NOT NULL,
    PRIMARY KEY (coll, id)
  );
  CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS push_subs (endpoint TEXT PRIMARY KEY, person TEXT, sub TEXT NOT NULL, created_at INTEGER NOT NULL);
  CREATE TABLE IF NOT EXISTS notif_sent (key TEXT PRIMARY KEY, at INTEGER NOT NULL);
`);
const getMeta = db.query<{ v: string }, [string]>("SELECT v FROM meta WHERE k = ?");
const setMeta = db.query("INSERT INTO meta (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v");
const getDoc = db.query<{ data: string }, [string, string]>("SELECT data FROM docs WHERE coll = ? AND id = ?");
const upsertDoc = db.query(
  "INSERT INTO docs (coll, id, data, updated_at) VALUES (?, ?, ?, ?) ON CONFLICT(coll, id) DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at",
);
const deleteDoc = db.query("DELETE FROM docs WHERE coll = ? AND id = ?");
const allDocs = db.query<{ coll: string; id: string; data: string }, []>("SELECT coll, id, data FROM docs");

let secret = getMeta.get("secret")?.v;
if (!secret) {
  secret = randomBytes(32).toString("hex");
  setMeta.run("secret", secret);
}
let rev = Number(getMeta.get("rev")?.v || 0);
const bumpRev = () => { rev += 1; setMeta.run("rev", String(rev)); };
// the family photo lives only on the data volume, never in the repository
const PHOTO_PATH = `${DATA_DIR}/photo.jpg`;
let photoRev = Number(getMeta.get("photoRev")?.v || 0);
const MAX_PHOTO = 6 * 1024 * 1024;
// changing FAMILY_PIN signs everyone out
const TOKEN = createHmac("sha256", secret).update("family:" + PIN).digest("hex");

const COLLECTIONS = new Set(["tasks", "goals", "money", "funds", "family", "budget"]);
const ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
const MAX_BODY = 64 * 1024;

type Op = { op: "set" | "update" | "delete"; coll: string; id: string; data?: Record<string, unknown> };

const applyWrite = db.transaction((w: Op) => {
  const now = Date.now();
  if (w.op === "delete") {
    deleteDoc.run(w.coll, w.id);
  } else if (w.op === "set") {
    upsertDoc.run(w.coll, w.id, JSON.stringify(w.data), now);
  } else {
    const cur = getDoc.get(w.coll, w.id);
    if (!cur) return false;
    upsertDoc.run(w.coll, w.id, JSON.stringify({ ...JSON.parse(cur.data), ...w.data }), now);
  }
  rev += 1;
  setMeta.run("rev", String(rev));
  return true;
});

// ---- Claude ----
const anthropic = Bun.env.ANTHROPIC_API_KEY ? new Anthropic() : null;
const MODEL = Bun.env.CLAUDE_MODEL || "claude-opus-5-5";
const FALLBACK_MODELS = new Set(["claude-opus-5-5", "claude-opus-5", "claude-sonnet-5-5", "claude-fable-5-1"]);

// ---- speech to text (Whisper via Groq or OpenAI) ----
const STT = Bun.env.GROQ_API_KEY
  ? { url: Bun.env.STT_URL || "https://api.groq.com/openai/v1/audio/transcriptions", key: Bun.env.GROQ_API_KEY, model: Bun.env.STT_MODEL || "whisper-large-v3-turbo" }
  : Bun.env.OPENAI_API_KEY
    ? { url: Bun.env.STT_URL || "https://api.openai.com/v1/audio/transcriptions", key: Bun.env.OPENAI_API_KEY, model: Bun.env.STT_MODEL || "whisper-1" }
    : null;
const MAX_AUDIO = 15 * 1024 * 1024;
const AUDIO_EXT: Record<string, string> = { "audio/webm": "webm", "audio/mp4": "m4a", "audio/x-m4a": "m4a", "audio/aac": "m4a", "audio/ogg": "ogg", "audio/mpeg": "mp3", "audio/wav": "wav" };
// a short hint keeps names, money and the plain style right
const STT_HINT = "Николай, Светлана. Купить продукты, оплатить интернет. Потратил 3 500 рублей на продукты. Пришла зарплата 80 000. Отложили 10 000 на отпуск.";

function extractJson(text: string): unknown {
  try { return JSON.parse(text); } catch {}
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fence) { try { return JSON.parse(fence[1]); } catch {} }
  const start = text.search(/[[{]/);
  const end = Math.max(text.lastIndexOf("]"), text.lastIndexOf("}"));
  if (start >= 0 && end > start) { try { return JSON.parse(text.slice(start, end + 1)); } catch {} }
  throw new Error("no JSON in reply");
}

// ---- tiny per-IP rate limits ----
const buckets = new Map<string, { n: number; reset: number }>();
function limited(key: string, max: number, windowMs: number) {
  const now = Date.now();
  const b = buckets.get(key);
  if (!b || b.reset < now) { buckets.set(key, { n: 1, reset: now + windowMs }); return false; }
  b.n += 1;
  return b.n > max;
}

// ---- helpers ----
const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", ...headers } });

function authed(req: Request) {
  const m = (req.headers.get("cookie") || "").match(/(?:^|;\s*)fam=([a-f0-9]{64})/);
  if (!m) return false;
  return timingSafeEqual(Buffer.from(m[1]), Buffer.from(TOKEN));
}
const clientIp = (req: Request, server: ReturnType<typeof Bun.serve>) =>
  (req.headers.get("x-forwarded-for") || "").split(",")[0].trim() || server.requestIP(req)?.address || "?";

async function readJson(req: Request): Promise<any> {
  if (!(req.headers.get("content-type") || "").includes("application/json")) throw new Error("json only");
  const text = await req.text();
  if (text.length > MAX_BODY) throw new Error("too large");
  return JSON.parse(text);
}

// ---- notifications ----
// Times are in the family's time zone; override with TZ_NAME / MORNING_AT / EVENING_AT.
const TZ = Bun.env.TZ_NAME || "Asia/Yekaterinburg";
const MORNING_AT = Bun.env.MORNING_AT || "08:00";
const EVENING_AT = Bun.env.EVENING_AT || "21:00";
const REMIND_BEFORE_MIN = Number(Bun.env.REMIND_BEFORE_MIN || 15);

let vapid = (() => { const v = getMeta.get("vapid")?.v; return v ? JSON.parse(v) : null; })();
if (!vapid) {
  vapid = webpush.generateVAPIDKeys();
  setMeta.run("vapid", JSON.stringify(vapid));
}
webpush.setVapidDetails(Bun.env.VAPID_SUBJECT || "mailto:family-planner@users.noreply.github.com", vapid.publicKey, vapid.privateKey);

const subsAll = db.query<{ endpoint: string; person: string | null; sub: string }, []>("SELECT endpoint, person, sub FROM push_subs");
const subUpsert = db.query("INSERT INTO push_subs (endpoint, person, sub, created_at) VALUES (?, ?, ?, ?) ON CONFLICT(endpoint) DO UPDATE SET person = excluded.person, sub = excluded.sub");
const subDelete = db.query("DELETE FROM push_subs WHERE endpoint = ?");
const sentInsert = db.query("INSERT OR IGNORE INTO notif_sent (key, at) VALUES (?, ?)");
const sentPrune = db.query("DELETE FROM notif_sent WHERE at < ?");
const docsOf = db.query<{ id: string; data: string }, [string]>("SELECT id, data FROM docs WHERE coll = ?");
const listOf = (coll: string): any[] => docsOf.all(coll).map((r) => ({ id: r.id, ...JSON.parse(r.data) }));
const once = (key: string) => sentInsert.run(key, Date.now()).changes > 0;

function localNow() {
  const p = Object.fromEntries(new Intl.DateTimeFormat("en-CA", {
    timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23",
  }).formatToParts(new Date()).map((x) => [x.type, x.value]));
  return { date: `${p.year}-${p.month}-${p.day}`, minutes: Number(p.hour) * 60 + Number(p.minute) };
}
const toMin = (hm: string) => { const [h, m] = hm.split(":").map(Number); return h * 60 + (m || 0); };
const addDaysIso = (iso: string, n: number) => { const d = new Date(iso + "T12:00:00Z"); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
const daysBetween = (a: string, b: string) => Math.round((Date.parse(a + "T12:00:00Z") - Date.parse(b + "T12:00:00Z")) / 864e5);
const plural = (n: number, f: [string, string, string]) => { const a = Math.abs(n) % 100, b = a % 10; return a > 10 && a < 20 ? f[2] : b > 1 && b < 5 ? f[1] : b === 1 ? f[0] : f[2]; };
const forPerson = (who: string, person: string | null) => !person || who === person || who === "both";

async function pushTo(person: string | null, payload: { title: string; body: string; tag?: string }, onlyEndpoint?: string) {
  for (const s of subsAll.all()) {
    if (onlyEndpoint ? s.endpoint !== onlyEndpoint : !(person === null || s.person === null || s.person === person)) continue;
    try {
      await webpush.sendNotification(JSON.parse(s.sub), JSON.stringify({ ...payload, url: "/" }), { TTL: 6 * 3600 });
    } catch (e: any) {
      if (e && (e.statusCode === 404 || e.statusCode === 410)) subDelete.run(s.endpoint);
      else console.error("push failed:", e?.statusCode || e?.message || e);
    }
  }
}
const subscribedPeople = () => [...new Set(subsAll.all().map((s) => s.person))];

function morningText(person: string | null, date: string) {
  const tasks = listOf("tasks").filter((t) => !t.done && t.date && t.date <= date && forPerson(t.who, person));
  const late = tasks.filter((t) => t.date < date).length;
  tasks.sort((a, b) => (a.time || "99").localeCompare(b.time || "99"));
  const lines: string[] = [];
  if (tasks.length) {
    const top = tasks.slice(0, 3).map((t) => (t.time ? `${t.time} ` : "") + t.title).join(", ");
    lines.push(`${tasks.length} ${plural(tasks.length, ["дело", "дела", "дел"])}: ${top}${tasks.length > 3 ? "…" : ""}`);
    if (late) lines.push(`Просрочено: ${late}`);
  }
  const soon = (d: string | null) => d && [0, 1, 3, 7].includes(daysBetween(d, date));
  for (const g of listOf("goals")) if (!g.done && forPerson(g.who, person) && soon(g.deadline)) {
    const n = daysBetween(g.deadline, date);
    lines.push(n === 0 ? `Сегодня срок цели «${g.title}»` : `До цели «${g.title}» ${n} ${plural(n, ["день", "дня", "дней"])}`);
  }
  const saves = listOf("money").filter((m) => m.type === "save");
  for (const f of listOf("funds")) if (forPerson(f.who, person) && soon(f.deadline)) {
    const saved = saves.filter((m) => m.fund === f.id).reduce((s, m) => s + (+m.amount || 0), 0);
    if (saved < +f.target) lines.push(`Копилка «${f.title}»: собрано ${Math.round(saved / +f.target * 100)}%, срок через ${daysBetween(f.deadline, date)} дн.`);
  }
  return lines.length ? lines.join("\n") : null;
}

function eveningText(person: string | null, date: string) {
  const tomorrow = addDaysIso(date, 1);
  const tasks = listOf("tasks").filter((t) => !t.done && t.date === tomorrow && forPerson(t.who, person))
    .sort((a, b) => (a.time || "99").localeCompare(b.time || "99"));
  const lines: string[] = [];
  if (tasks.length) lines.push(`Завтра ${tasks.length} ${plural(tasks.length, ["дело", "дела", "дел"])}: ${tasks.slice(0, 3).map((t) => (t.time ? `${t.time} ` : "") + t.title).join(", ")}${tasks.length > 3 ? "…" : ""}`);
  if (!listOf("money").some((m) => m.date === date)) lines.push("Сегодня трат не записано — скажите их голосом, это пара секунд.");
  return lines.length ? lines.join("\n") : null;
}

let ticking = false;
async function tick() {
  if (ticking || !subsAll.all().length) return;
  ticking = true;
  try {
    const { date, minutes } = localNow();
    for (const t of listOf("tasks")) {
      if (t.done || t.date !== date || typeof t.time !== "string" || !/^\d\d:\d\d$/.test(t.time)) continue;
      const at = toMin(t.time);
      if (minutes >= at - REMIND_BEFORE_MIN && minutes <= at + 5 && once(`t:${t.id}:${date}:${t.time}`)) {
        await pushTo(t.who === "both" ? null : t.who, { title: `В ${t.time}: ${t.title}`, body: t.who === "both" ? "Дело для всей семьи" : "Скоро по плану", tag: "t-" + t.id });
      }
    }
    const m0 = toMin(MORNING_AT), e0 = toMin(EVENING_AT);
    for (const person of subscribedPeople()) {
      if (minutes >= m0 && minutes < m0 + 180 && once(`m:${date}:${person}`)) {
        const body = morningText(person, date);
        if (body) await pushTo(person, { title: "Доброе утро! План на сегодня", body, tag: "morning" });
      }
      if (minutes >= e0 && minutes < e0 + 120 && once(`e:${date}:${person}`)) {
        const body = eveningText(person, date);
        if (body) await pushTo(person, { title: "Вечерняя сводка", body, tag: "evening" });
      }
    }
    sentPrune.run(Date.now() - 40 * 864e5);
  } catch (e) {
    console.error("tick failed:", e);
  } finally {
    ticking = false;
  }
}
setInterval(tick, 60_000);

// ---- page ----
const HEAD =`<!doctype html><html lang="ru"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<meta name="theme-color" content="#123A30">
<meta name="apple-mobile-web-app-capable" content="yes">
<meta name="apple-mobile-web-app-title" content="Дела">
<link rel="manifest" href="/manifest.webmanifest">
<link rel="icon" href="/icon.svg" type="image/svg+xml">
<link rel="apple-touch-icon" href="/icon-192.png">
<style>:root{padding-top:env(safe-area-inset-top,0px);padding-bottom:env(safe-area-inset-bottom,0px)}body{margin:0}img{max-width:100%}</style>`;

async function buildPage() {
  const app = await Bun.file(new URL("./index.html", import.meta.url)).text();
  return `${HEAD}<script src="/standalone.js"></script></head><body>${app}</body></html>`;
}
const PAGE = await buildPage();
const STANDALONE_JS = await Bun.file(new URL("./standalone.js", import.meta.url)).text();
const SW_JS = await Bun.file(new URL("./sw.js", import.meta.url)).text();
const CREST_SVG: Record<string, string> = {};
for (const k of ["a", "b", "c", "d"]) CREST_SVG[k] = await Bun.file(new URL(`./crests/${k}.svg`, import.meta.url)).text();
const crestChoice = () => { try { const r = getDoc.get("family", "crest"); const v = r && JSON.parse(r.data).v; return CREST_SVG[v] ? v : "b"; } catch { return "b"; } };
const PNG = { "/icon-192.png": new URL("./icon-192.png", import.meta.url), "/icon-512.png": new URL("./icon-512.png", import.meta.url) } as Record<string, URL>;

const ICON = CREST_SVG.b.replace('viewBox="0 0 240 316"', 'viewBox="34 0 172 236"');
const MANIFEST = JSON.stringify({
  name: "Дела Савельевых", short_name: "Дела", start_url: "/", display: "standalone",
  background_color: "#F5F1E8", theme_color: "#123A30", lang: "ru",
  icons: [
    { src: "/icon-192.png", sizes: "192x192", type: "image/png" },
    { src: "/icon-512.png", sizes: "512x512", type: "image/png" },
    { src: "/icon.svg", sizes: "any", type: "image/svg+xml" },
  ],
});

const loginPage = () => `${HEAD}<title>Дела Савельевых</title>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Cormorant+Garamond:ital,wght@0,600;0,700;1,500&family=Manrope:wght@500;700;800&display=swap">
<style>
:root{--bg:#F5F1E8;--surface:#FFFDF8;--ink:#17211D;--muted:#555E59;--accent:#1C4A3E;--line:#E4DCCB;--warn:#B0521D;--gold:#B8913F}
@media (prefers-color-scheme:dark){:root{--bg:#0B110F;--surface:#131C18;--ink:#F1ECE1;--muted:#AEB5AE;--accent:#86CBB0;--line:#26312B;--warn:#EE9A62;--gold:#DDBE74;color-scheme:dark}}
body{background:radial-gradient(60vmax 50vmax at 108% -8%,rgba(184,145,63,.16),transparent 62%),radial-gradient(60vmax 55vmax at -12% 108%,rgba(28,74,62,.14),transparent 62%),var(--bg);color:var(--ink);font-family:Manrope,system-ui,sans-serif;min-height:100vh;display:grid;place-items:center;padding:16px;box-sizing:border-box}
form{box-sizing:border-box;background:var(--surface);border-radius:30px;padding:30px 24px 26px;max-width:380px;width:100%;box-shadow:0 0 0 1px rgba(184,145,63,.35),0 30px 60px -30px rgba(30,44,24,.45);display:flex;flex-direction:column;gap:14px;text-align:center}
.crest{height:190px;margin:-4px auto 0;display:block;filter:drop-shadow(0 10px 14px rgba(11,36,29,.3))}.crest svg{height:100%;width:auto}
h1{font-family:'Cormorant Garamond',Georgia,serif;margin:2px 0 0;font-size:34px;line-height:1;font-weight:700;letter-spacing:-.005em}p{margin:0;color:var(--muted)}
.rule{height:1px;background:linear-gradient(90deg,transparent,var(--gold),transparent);border:0;margin:0}
input{font:inherit;font-size:22px;text-align:center;letter-spacing:.2em;padding:13px;border-radius:16px;border:0;box-shadow:inset 0 0 0 1.5px var(--line);background:var(--bg);color:var(--ink)}
input:focus{outline:none;box-shadow:inset 0 0 0 2px var(--accent),0 0 0 4px rgba(184,145,63,.22)}
button{font:inherit;font-weight:800;letter-spacing:.02em;border:0;border-radius:999px;padding:14px;background:linear-gradient(180deg,#266050,#143F34);color:#F3E2B0;cursor:pointer;box-shadow:inset 0 0 0 1px rgba(233,212,154,.45),0 14px 24px -12px rgba(11,36,29,.7)}
.err{color:var(--warn);min-height:1.4em}
.motto{font-family:'Cormorant Garamond',Georgia,serif;font-style:italic;color:var(--ink);line-height:1.4;font-size:19px}.motto small{font-family:Manrope,sans-serif;font-style:normal;font-weight:800;color:var(--gold);letter-spacing:.14em;text-transform:uppercase;font-size:11px}
</style></head><body>
<form id="f"><div class="crest">${CREST_SVG[crestChoice()]}</div>
<h1>Дела Савельевых</h1><hr class="rule"><p class="motto">«Двоим лучше, нежели одному… и нитка, втрое скрученная, нескоро порвётся»<br><small>Екклесиаст 4:9, 12</small></p><p>Введите семейный код</p>
<label for="pin" style="position:absolute;left:-9999px">Семейный код</label>
<input id="pin" type="password" autocomplete="current-password" autofocus required>
<button type="submit">Войти</button><div class="err" id="err" role="status"></div></form>
<script>
document.getElementById("f").addEventListener("submit", async (e) => {
  e.preventDefault();
  const err = document.getElementById("err"); err.textContent = "";
  try {
    const r = await fetch("/api/login", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ pin: document.getElementById("pin").value }) });
    if (r.ok) location.reload();
    else err.textContent = r.status === 429 ? "Слишком много попыток. Подождите 15 минут." : "Код не подошёл. Попробуйте ещё раз.";
  } catch { err.textContent = "Нет связи. Проверьте интернет."; }
});
</script></body></html>`;

const html = (body: string) => new Response(body, { headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" } });

// ---- routes ----
const server = Bun.serve({
  port: PORT,
  async fetch(req, srv) {
    const url = new URL(req.url);
    const path = url.pathname;

    if (path === "/health") return new Response("ok");
    if (path === "/icon.svg") return new Response(ICON, { headers: { "content-type": "image/svg+xml", "cache-control": "public, max-age=86400" } });
    if (PNG[path]) return new Response(Bun.file(PNG[path]), { headers: { "content-type": "image/png", "cache-control": "public, max-age=86400" } });
    if (path === "/sw.js") return new Response(SW_JS, { headers: { "content-type": "text/javascript; charset=utf-8", "cache-control": "no-cache" } });
    if (path === "/manifest.webmanifest") return new Response(MANIFEST, { headers: { "content-type": "application/manifest+json" } });

    const cm = path.match(/^\/crests\/([a-d])\.svg$/);
    if (cm) return new Response(CREST_SVG[cm[1]], { headers: { "content-type": "image/svg+xml", "cache-control": "public, max-age=86400" } });

    if (path === "/api/login" && req.method === "POST") {
      const ip = clientIp(req, srv);
      if (limited("login:" + ip, 10, 15 * 60_000)) return json({ error: "rate_limited" }, 429);
      let pin = "";
      try { pin = String((await readJson(req)).pin || "").trim(); } catch { return json({ error: "bad_request" }, 400); }
      const a = createHmac("sha256", secret!).update("family:" + pin).digest();
      const ok = timingSafeEqual(a, Buffer.from(TOKEN, "hex"));
      if (!ok) return json({ error: "wrong_code" }, 401);
      buckets.delete("login:" + ip);
      return json({ ok: true }, 200, { "set-cookie": `fam=${TOKEN}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=31536000` });
    }

    if (!authed(req)) {
      if (path === "/" || path === "/index.html") return html(loginPage());
      return json({ error: "unauthorized" }, 401);
    }

    if (path === "/" || path === "/index.html") return html(PAGE);
    if (path === "/standalone.js") return new Response(STANDALONE_JS, { headers: { "content-type": "text/javascript; charset=utf-8", "cache-control": "no-store" } });

    if (path === "/api/state" && req.method === "GET") {
      const since = Number(url.searchParams.get("rev") ?? -1);
      if (since === rev) return json({ rev, same: true });
      const docs = allDocs.all().map((r) => ({ c: r.coll, id: r.id, d: JSON.parse(r.data) }));
      return json({ rev, docs, ai: !!anthropic, stt: !!STT, photo: photoRev && existsSync(PHOTO_PATH) ? `/api/photo?v=${photoRev}` : null });
    }

    if (path === "/api/photo") {
      if (req.method === "GET") {
        if (!existsSync(PHOTO_PATH)) return json({ error: "not_found" }, 404);
        return new Response(Bun.file(PHOTO_PATH), { headers: { "content-type": "image/jpeg", "cache-control": "private, max-age=31536000, immutable" } });
      }
      if (req.method === "POST") {
        const type = (req.headers.get("content-type") || "").split(";")[0].trim();
        if (type !== "image/jpeg") return json({ error: "jpeg_only" }, 415);
        const buf = new Uint8Array(await req.arrayBuffer());
        if (!buf.length || buf.length > MAX_PHOTO || buf[0] !== 0xff || buf[1] !== 0xd8) return json({ error: "bad_image" }, 400);
        await Bun.write(PHOTO_PATH, buf);
        photoRev = Date.now(); setMeta.run("photoRev", String(photoRev)); bumpRev();
        return json({ ok: true, photo: `/api/photo?v=${photoRev}` });
      }
      if (req.method === "DELETE") {
        try { unlinkSync(PHOTO_PATH); } catch {}
        photoRev = 0; setMeta.run("photoRev", "0"); bumpRev();
        return json({ ok: true });
      }
    }

    if (path === "/api/write" && req.method === "POST") {
      let w: Op;
      try { w = await readJson(req); } catch { return json({ error: "invalid_argument" }, 400); }
      const okShape = w && ["set", "update", "delete"].includes(w.op) && COLLECTIONS.has(w.coll) && ID_RE.test(String(w.id || ""))
        && (w.op === "delete" || (w.data && typeof w.data === "object" && !Array.isArray(w.data)));
      if (!okShape) return json({ error: "invalid_argument" }, 400);
      if (!applyWrite(w)) return json({ error: "invalid_argument", message: "document does not exist" }, 400);
      return json({ rev });
    }

    if (path === "/api/transcribe" && req.method === "POST") {
      if (!STT) return json({ error: "stt_disabled" }, 501);
      if (limited("stt:" + clientIp(req, srv), 20, 60_000)) return json({ error: "rate_limited" }, 429);
      const type = (req.headers.get("content-type") || "audio/webm").split(";")[0].trim().toLowerCase();
      const ext = AUDIO_EXT[type];
      if (!ext) return json({ error: "unsupported_audio" }, 415);
      const audio = await req.arrayBuffer();
      if (!audio.byteLength || audio.byteLength > MAX_AUDIO) return json({ error: "bad_size" }, 413);
      const form = new FormData();
      form.append("file", new Blob([audio], { type }), "voice." + ext);
      form.append("model", STT.model);
      form.append("language", "ru");
      form.append("temperature", "0");
      form.append("response_format", "json");
      form.append("prompt", STT_HINT);
      try {
        const r = await fetch(STT.url, { method: "POST", headers: { authorization: "Bearer " + STT.key }, body: form, signal: AbortSignal.timeout(60_000) });
        if (!r.ok) {
          console.error("transcription failed:", r.status, (await r.text()).slice(0, 300));
          return json({ error: r.status === 429 ? "rate_limited" : "upstream_error" }, r.status === 429 ? 429 : 502);
        }
        const j: any = await r.json();
        return json({ text: String(j.text || "").trim() });
      } catch (e) {
        console.error("transcription failed:", e);
        return json({ error: "upstream_error" }, 502);
      }
    }

    if (path === "/api/parse" && req.method === "POST") {
      if (!anthropic) return json({ error: "sampling_disabled" }, 501);
      if (limited("parse:" + clientIp(req, srv), 30, 60_000)) return json({ error: "rate_limited" }, 429);
      let prompt = "";
      try { prompt = String((await readJson(req)).prompt || ""); } catch { return json({ error: "invalid_request" }, 400); }
      if (!prompt || prompt.length > 20_000) return json({ error: "invalid_request" }, 400);
      try {
        const params: any = {
          model: MODEL,
          max_tokens: 4000,
          output_config: { effort: "low" },
          messages: [{ role: "user", content: prompt }],
        };
        if (FALLBACK_MODELS.has(MODEL)) { params.betas = ["server-side-fallback-2026-07-01"]; params.fallbacks = "default"; }
        const res = await anthropic.beta.messages.create(params);
        if (res.stop_reason === "refusal") return json({ error: "refused" }, 422);
        const text = res.content.map((b: any) => (b.type === "text" ? b.text : "")).join("");
        try { return json({ value: extractJson(text) }); } catch { return json({ error: "invalid_json", text }, 422); }
      } catch (e) {
        if (e instanceof Anthropic.RateLimitError) return json({ error: "rate_limited" }, 429);
        if (e instanceof Anthropic.AuthenticationError) { console.error("Claude API key rejected"); return json({ error: "sampling_disabled" }, 501); }
        console.error("Claude call failed:", e instanceof Anthropic.APIError ? `${e.status} ${e.message}` : e);
        return json({ error: "upstream_error" }, 502);
      }
    }

    if (path === "/api/push/key" && req.method === "GET") return json({ key: vapid.publicKey });

    if (path === "/api/push/subscribe" && req.method === "POST") {
      let b: any;
      try { b = await readJson(req); } catch { return json({ error: "invalid_argument" }, 400); }
      const sub = b && b.sub;
      if (!sub || typeof sub.endpoint !== "string" || !sub.endpoint.startsWith("https://") || sub.endpoint.length > 1000 || !sub.keys) return json({ error: "invalid_argument" }, 400);
      const person = typeof b.person === "string" && ID_RE.test(b.person) ? b.person : null;
      subUpsert.run(sub.endpoint, person, JSON.stringify({ endpoint: sub.endpoint, keys: sub.keys }), Date.now());
      if (b.test) await pushTo(null, { title: "Напоминания включены", body: "Утром — план на день, вечером — сводка, перед делами со временем — напоминание.", tag: "test" }, sub.endpoint);
      return json({ ok: true });
    }

    if (path === "/api/push/unsubscribe" && req.method === "POST") {
      try { const b = await readJson(req); subDelete.run(String(b.endpoint || "")); } catch { return json({ error: "invalid_argument" }, 400); }
      return json({ ok: true });
    }

    return json({ error: "not_found" }, 404);
  },
});

console.log(`Family planner on :${server.port}, data in ${DATA_DIR}, rev ${rev}, Claude ${anthropic ? MODEL : "off"}, speech ${STT ? STT.model : "off"}`);
