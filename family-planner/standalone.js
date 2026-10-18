// Standalone runtime for the family planner: gives the page the same
// window.claude.use("db" | "user" | "sample") surface it has on claude.ai,
// backed by this site's own server, and adds a real microphone button.
(function () {
  const store = new Map(); // collection -> Map(id -> data)
  const listeners = new Set();
  let rev = -1;
  let ai = false;
  let timer = null;

  const snapDoc = (id, d) => ({ id, exists: d !== undefined, data: () => d, metadata: { fromCache: false, hasPendingWrites: false } });
  const deliver = (l) => {
    const m = store.get(l.coll) || new Map();
    if (l.kind === "doc") l.next(snapDoc(l.id, m.get(l.id)));
    else {
      const docs = [...m].map(([id, d]) => snapDoc(id, d));
      l.next({ docs, size: docs.length, empty: !docs.length, docChanges: () => [], metadata: { fromCache: false, hasPendingWrites: false } });
    }
  };
  const emit = () => listeners.forEach(deliver);

  async function refresh() {
    try {
      const r = await fetch("/api/state?rev=" + rev, { cache: "no-store" });
      if (r.status === 401) { location.reload(); return; }
      if (!r.ok) return;
      const j = await r.json();
      if (j.same) return;
      rev = j.rev;
      ai = !!j.ai;
      store.clear();
      for (const x of j.docs) {
        if (!store.has(x.c)) store.set(x.c, new Map());
        store.get(x.c).set(x.id, x.d);
      }
      emit();
    } catch (e) {}
  }
  function schedule() {
    clearTimeout(timer);
    timer = setTimeout(async () => { await refresh(); schedule(); }, document.hidden ? 30000 : 4000);
  }
  document.addEventListener("visibilitychange", () => { if (!document.hidden) { refresh(); schedule(); } });
  const ready = refresh().then(schedule);

  const newId = () => {
    const a = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
    const b = crypto.getRandomValues(new Uint8Array(20));
    return Array.from(b, (n) => a[n % a.length]).join("");
  };

  // Optimistic write; failures roll back and reject with "unavailable" so the page shows a retry toast.
  async function write(op, coll, id, data) {
    const m = store.get(coll) || new Map();
    store.set(coll, m);
    const prev = m.get(id);
    const rollback = () => { if (prev === undefined) m.delete(id); else m.set(id, prev); emit(); };
    if (op === "delete") m.delete(id);
    else if (op === "set") m.set(id, data);
    else if (prev !== undefined) m.set(id, { ...prev, ...data });
    emit();
    let r;
    try {
      r = await fetch("/api/write", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ op, coll, id, data }) });
    } catch (e) { rollback(); throw { code: "unavailable", message: "network" }; }
    if (r.status === 401) { location.reload(); throw { code: "revoked", message: "signed out" }; }
    if (!r.ok) { rollback(); throw { code: "unavailable", message: "HTTP " + r.status }; }
    refresh();
  }

  const db = {
    collection(c) {
      return {
        path: c,
        doc: (id) => db.doc(c + "/" + (id || newId())),
        async add(data) { const id = newId(); await write("set", c, id, data); return db.doc(c + "/" + id); },
        async get() { const m = store.get(c) || new Map(); const docs = [...m].map(([id, d]) => snapDoc(id, d)); return { docs, size: docs.length, empty: !docs.length, docChanges: () => [], metadata: {} }; },
        onSnapshot(next) { const l = { kind: "coll", coll: c, next }; listeners.add(l); if (rev >= 0) setTimeout(() => deliver(l)); return () => listeners.delete(l); },
      };
    },
    doc(path) {
      const [c, id] = path.split("/");
      return {
        id, path,
        set: (d) => write("set", c, id, d),
        update: (d) => write("update", c, id, d),
        delete: () => write("delete", c, id),
        async get() { const m = store.get(c); return snapDoc(id, m && m.get(id)); },
        onSnapshot(next) { const l = { kind: "doc", coll: c, id, next }; listeners.add(l); if (rev >= 0) setTimeout(() => deliver(l)); return () => listeners.delete(l); },
      };
    },
  };

  const user = {
    id: async () => null,
    can: async () => true,
    canEdit: async () => true,
    isOwner: async () => false,
    me: async () => ({ id: null, name: "", avatarUrl: "", color: "", email: null, isOwner: false, canEdit: true }),
    profiles: async () => ({}),
    search: async () => [],
  };

  async function parse(input, opts) {
    const prompt = typeof input === "string" ? input : input.map((m) => m.content).join("\n\n");
    let r;
    try {
      r = await fetch("/api/parse", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ prompt }), signal: opts && opts.signal });
    } catch (e) {
      throw { code: e && e.name === "AbortError" ? "cancelled" : "upstream_error", message: String(e) };
    }
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw { code: j.error || "upstream_error", message: j.error || "HTTP " + r.status, text: j.text };
    return j.value;
  }
  const sample = async (input, opts) => ({ text: JSON.stringify(await parse(input, opts)), truncated: false });
  sample.json = parse;
  sample.limits = async () => ({ maxPromptBytes: 20000 });

  window.claude = {
    async use(name) {
      await ready;
      if (name === "db") return db;
      if (name === "user") return user;
      if (name === "sample") return ai ? sample : null;
      return null;
    },
  };

  // ---- microphone ----
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  const css = document.createElement("style");
  css.textContent = `
    .mic.voice { cursor: pointer; border: 0; transition: transform .15s, background .2s; }
    .mic.voice:hover { transform: scale(1.06); }
    .mic.on, .fab.on { background: var(--c2) !important; animation: micpulse 1.2s ease-out infinite; }
    @keyframes micpulse { 0% { box-shadow: 0 0 0 0 color-mix(in srgb, var(--c2) 55%, transparent); } 100% { box-shadow: 0 0 0 16px transparent; } }
    @media (prefers-reduced-motion: reduce) { .mic.on, .fab.on { animation: none; } }`;
  document.head.appendChild(css);

  function say(msg) {
    const t = document.getElementById("toast");
    if (!t) return;
    t.textContent = msg; t.classList.add("on");
    setTimeout(() => t.classList.remove("on"), 3000);
  }

  // ---- reminders (web push) ----
  const bellCss = document.createElement("style");
  bellCss.textContent = `
    .top-right { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; }
    .bell { border: 0; background: var(--surface); box-shadow: inset 0 0 0 1px var(--line); border-radius: 999px; padding: 6px 14px 6px 10px; cursor: pointer; display: inline-flex; align-items: center; gap: 7px; font: inherit; font-size: 15px; font-weight: 700; color: var(--ink); }
    .bell svg { color: var(--accent); }
    .bell.on { background: var(--accent-soft); box-shadow: none; }
    .bell.on svg { color: var(--accent); }
    .bell.attn { background: var(--sun-soft); box-shadow: none; }
    @media (max-width: 420px) { .bell span { display: none; } .bell { padding: 8px; } }`;
  document.head.appendChild(bellCss);

  const b64ToBytes = (s) => {
    const pad = "=".repeat((4 - (s.length % 4)) % 4);
    const raw = atob((s + pad).replace(/-/g, "+").replace(/_/g, "/"));
    return Uint8Array.from(raw, (c) => c.charCodeAt(0));
  };
  const me = () => { try { return localStorage.getItem("dela:me"); } catch (e) { return null; } };
  const isIOS = /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
  const installed = matchMedia("(display-mode: standalone)").matches || navigator.standalone === true;

  async function setupBell() {
    const who = document.getElementById("whoBox");
    if (!who) return;
    const wrap = document.createElement("div");
    wrap.className = "top-right";
    who.parentNode.insertBefore(wrap, who);
    const bell = document.createElement("button");
    bell.type = "button";
    bell.className = "bell";
    bell.innerHTML = '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M6 9a6 6 0 0 1 12 0c0 6 2.5 7.5 2.5 7.5h-17S6 15 6 9"/><path d="M10 20a2.2 2.2 0 0 0 4 0"/></svg><span></span>';
    wrap.append(bell, who);
    const label = (t, cls) => { bell.querySelector("span").textContent = t; bell.className = "bell" + (cls ? " " + cls : ""); bell.title = t; };

    const pushOk = "serviceWorker" in navigator && "PushManager" in window && "Notification" in window;
    if (!pushOk) {
      if (isIOS && !installed) {
        label("Напоминания", "attn");
        bell.onclick = () => say("На iPhone: «Поделиться» → «На экран Домой», затем откройте сайт с экрана и включите напоминания");
      } else bell.hidden = true;
      return;
    }
    let reg;
    try { reg = await navigator.serviceWorker.register("/sw.js"); } catch (e) { bell.hidden = true; return; }
    let sub = await reg.pushManager.getSubscription();
    const save = (s, test) => fetch("/api/push/subscribe", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ sub: s.toJSON(), person: me(), test: !!test }) });

    const render = () => {
      if (sub && Notification.permission === "granted") label("Напоминания вкл.", "on");
      else if (Notification.permission === "denied") label("Напоминания выкл.", "");
      else label("Включить напоминания", "attn");
    };
    render();
    if (sub && Notification.permission === "granted") save(sub).catch(() => {}); // keeps "who am I" current on the server

    bell.onclick = async () => {
      if (Notification.permission === "denied") { say("Уведомления запрещены в настройках браузера для этого сайта — разрешите их там"); return; }
      try {
        if (!sub) {
          if (!me()) { say("Сначала выберите вверху, кто вы — напоминания придут именно вам"); return; }
          const perm = await Notification.requestPermission();
          if (perm !== "granted") { render(); return; }
          const { key } = await (await fetch("/api/push/key")).json();
          sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: b64ToBytes(key) });
          await save(sub, true);
          say("Готово! Прислал проверочное уведомление");
        } else {
          await save(sub, true);
          say("Напоминания включены. Отправил проверочное уведомление");
        }
      } catch (e) {
        say("Не получилось включить напоминания. Попробуйте ещё раз");
      }
      render();
    };
  }

  document.addEventListener("DOMContentLoaded", () => { setupBell(); });

  document.addEventListener("DOMContentLoaded", () => {
    const mic = document.querySelector(".mic");
    const ta = document.getElementById("dictation");
    const fab = document.getElementById("fab");
    const sub = document.querySelector(".cap-sub");
    if (!SR || !mic || !ta) return;

    mic.classList.add("voice");
    mic.setAttribute("role", "button");
    mic.setAttribute("tabindex", "0");
    mic.removeAttribute("aria-hidden");
    mic.setAttribute("aria-label", "Начать диктовку");
    if (sub) sub.textContent = "Нажмите на микрофон и говорите: дела, траты, доходы, цели. Нажмите ещё раз, чтобы закончить.";

    let rec = null;
    const sync = () => ta.dispatchEvent(new Event("input", { bubbles: true }));
    function toggle() {
      if (rec) { rec.stop(); return; }
      rec = new SR();
      rec.lang = "ru-RU";
      rec.interimResults = true;
      rec.continuous = true;
      const base = ta.value.trim() ? ta.value.trim() + " " : "";
      let finals = "";
      rec.onresult = (e) => {
        let interim = "";
        for (let i = e.resultIndex; i < e.results.length; i++) {
          const t = e.results[i][0].transcript;
          if (e.results[i].isFinal) finals += t.trim() + ". "; else interim += t;
        }
        ta.value = base + finals + interim;
        sync();
      };
      rec.onerror = (e) => {
        if (e.error === "not-allowed" || e.error === "service-not-allowed") say("Разрешите доступ к микрофону в настройках браузера");
        else if (e.error === "no-speech") say("Ничего не услышал. Нажмите на микрофон и говорите");
      };
      rec.onend = () => {
        rec = null;
        mic.classList.remove("on"); mic.setAttribute("aria-label", "Начать диктовку");
        if (fab) fab.classList.remove("on");
        ta.value = ta.value.trim(); sync();
      };
      try { rec.start(); } catch (e) { rec = null; return; }
      mic.classList.add("on"); mic.setAttribute("aria-label", "Закончить диктовку");
      if (fab) fab.classList.add("on");
    }
    mic.addEventListener("click", toggle);
    mic.addEventListener("keydown", (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); toggle(); } });
    if (fab) {
      // the floating button starts listening right away instead of opening the keyboard
      document.addEventListener("click", (e) => {
        if (!e.target.closest || !e.target.closest("#fab")) return;
        e.stopPropagation();
        document.getElementById("capture").scrollIntoView({ behavior: "smooth", block: "start" });
        toggle();
      }, true);
    }
  });
})();
