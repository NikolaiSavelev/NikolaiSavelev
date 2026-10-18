// Standalone runtime for the family planner: gives the page the same
// window.claude.use("db" | "user" | "sample") surface it has on claude.ai,
// backed by this site's own server, and adds a real microphone button.
(function () {
  const store = new Map(); // collection -> Map(id -> data)
  const listeners = new Set();
  let rev = -1;
  let ai = false;
  let stt = false;
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
      stt = !!j.stt;
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

  // ---- voice recording ----
  // Tap the mic to start, tap «Готово» to finish (or hold the mic like a walkie-talkie).
  // The whole clip goes to the server for Whisper transcription; without a speech key
  // the browser's own recognizer runs quietly in the background and its text is used.
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  const voiceCss = document.createElement("style");
  voiceCss.textContent = `
    .mic.voice { cursor: pointer; border: 0; transition: transform .15s, background .2s; touch-action: none; -webkit-user-select: none; user-select: none; }
    .mic.voice:hover { transform: scale(1.06); }
    .mic.on, .fab.on { background: var(--c2) !important; animation: micpulse 1.2s ease-out infinite; }
    @keyframes micpulse { 0% { box-shadow: 0 0 0 0 color-mix(in srgb, var(--c2) 55%, transparent); } 100% { box-shadow: 0 0 0 16px transparent; } }
    .rec-bar { display: flex; flex-wrap: wrap; align-items: center; gap: 10px 12px; padding: 12px 14px; border-radius: 18px; background: color-mix(in srgb, var(--c2) 10%, var(--surface)); box-shadow: inset 0 0 0 2px color-mix(in srgb, var(--c2) 35%, transparent); }
    .rec-dot { width: 12px; height: 12px; border-radius: 50%; background: var(--c2); flex: none; animation: recblink 1s steps(2, start) infinite; }
    @keyframes recblink { to { opacity: .25; } }
    .rec-time { font-family: var(--f-display); font-weight: 700; font-size: 20px; font-variant-numeric: tabular-nums; min-width: 3.2em; }
    .rec-level { flex: 1 1 140px; display: flex; align-items: center; gap: 3px; height: 32px; min-width: 0; overflow: hidden; }
    .rec-level i { flex: 1; max-width: 6px; min-width: 3px; border-radius: 3px; background: var(--c2); height: 4px; transition: height .08s; }
    .rec-bar .btn { min-height: 44px; }
    @media (max-width: 480px) { .rec-bar .btn.primary { flex: 1 1 auto; } }
    .rec-hint { font-size: 13px; color: var(--muted); }
    @media (prefers-reduced-motion: reduce) { .mic.on, .fab.on, .rec-dot { animation: none; } }`;
  document.head.appendChild(voiceCss);

  // Removes hesitation sounds, a leading "ну", and words said twice in a row.
  function cleanSpeech(text) {
    const FILLER = /^(э+|э+м+|м{2,}|хм+|а{2,}|у{2,}|ну{2,}|ээ+|ммм+|эх+)$/i;
    let words = String(text || "").replace(/\s+/g, " ").trim().split(" ");
    words = words.filter((w) => !FILLER.test(w.replace(/[.,!?;:…«»"()-]/g, "")));
    const out = [];
    for (const w of words) {
      const core = w.toLowerCase().replace(/[.,!?;:…«»"()]/g, "");
      const prev = out.length ? out[out.length - 1].toLowerCase().replace(/[.,!?;:…«»"()]/g, "") : null;
      if (core && core === prev && core.length > 1) continue;
      out.push(w);
    }
    let s = out.join(" ")
      .replace(/(^|[.!?]\s+)ну,?\s+/gi, "$1")
      .replace(/(^|[.!?]\s+)(вот|так|значит|короче|в общем|слушай),?\s+/gi, "$1")
      .replace(/\s+([.,!?;:…])/g, "$1")
      .replace(/([,;:])(?=[^\s\d])/g, "$1 ")
      .replace(/,\s*,+/g, ",")
      .replace(/^[,.\s]+/, "")
      .trim();
    s = s.replace(/(^|[.!?]\s+)([а-яёa-z])/g, (m, p, c) => p + c.toUpperCase());
    return s;
  }
  window.__cleanSpeech = cleanSpeech;

  function pickMime() {
    if (!window.MediaRecorder) return null;
    for (const t of ["audio/webm;codecs=opus", "audio/mp4", "audio/ogg;codecs=opus", "audio/webm"]) {
      try { if (MediaRecorder.isTypeSupported(t)) return t; } catch (e) {}
    }
    return "";
  }

  document.addEventListener("DOMContentLoaded", () => {
    const mic = document.querySelector(".mic");
    const ta = document.getElementById("dictation");
    const fab = document.getElementById("fab");
    const sub = document.querySelector(".cap-sub");
    const capture = document.getElementById("capture");
    const statusEl = document.getElementById("capStatus");
    const canRecord = !!(navigator.mediaDevices && navigator.mediaDevices.getUserMedia && window.MediaRecorder);
    if (!mic || !ta || (!canRecord && !SR)) return;

    const status = (msg, err, busy) => {
      if (!statusEl) return;
      statusEl.textContent = msg || "";
      statusEl.classList.toggle("err", !!err);
      statusEl.classList.toggle("busy", !!busy);
    };
    const sync = () => ta.dispatchEvent(new Event("input", { bubbles: true }));
    const insert = (text) => {
      const t = cleanSpeech(text);
      if (!t) return false;
      const cur = ta.value.trim();
      ta.value = cur ? cur + (/[.!?]$/.test(cur) ? " " : ". ") + t : t;
      sync();
      return true;
    };

    mic.classList.add("voice");
    mic.setAttribute("role", "button");
    mic.setAttribute("tabindex", "0");
    mic.removeAttribute("aria-hidden");
    mic.setAttribute("aria-label", "Начать запись");
    if (sub) sub.textContent = "Нажмите на микрофон, скажите всё подряд и нажмите «Готово». Можно держать кнопку, как рацию.";

    const bar = document.createElement("div");
    bar.className = "rec-bar";
    bar.hidden = true;
    bar.innerHTML = '<span class="rec-dot" aria-hidden="true"></span><span class="rec-time" aria-live="off">0:00</span><div class="rec-level" aria-hidden="true">' + "<i></i>".repeat(24) + '</div><button class="btn primary small" type="button" data-rec="done">Готово</button><button class="btn ghost small" type="button" data-rec="cancel">Отмена</button>';
    ta.insertAdjacentElement("afterend", bar);
    const timeEl = bar.querySelector(".rec-time");
    const levels = [...bar.querySelectorAll(".rec-level i")];

    const MAX_MS = 3 * 60 * 1000;
    let rec = null; // { stream, recorder, chunks, ctx, raf, started, sr, srText, cancelled, timer }

    async function start() {
      if (rec) return;
      status("");
      if (!canRecord) return startSpeechOnly();
      let stream;
      try {
        stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true, channelCount: 1 } });
      } catch (e) {
        status("Нет доступа к микрофону. Разрешите его в настройках браузера для этого сайта.", true);
        return;
      }
      const mime = pickMime();
      let recorder;
      try { recorder = mime ? new MediaRecorder(stream, { mimeType: mime, audioBitsPerSecond: 64000 }) : new MediaRecorder(stream); }
      catch (e) { recorder = new MediaRecorder(stream); }
      rec = { stream, recorder, chunks: [], started: Date.now(), srText: "", cancelled: false };
      recorder.ondataavailable = (e) => { if (e.data && e.data.size) rec && rec.chunks.push(e.data); };
      recorder.onstop = () => finish();
      recorder.start(1000);

      // level meter
      try {
        const Ctx = window.AudioContext || window.webkitAudioContext;
        const ctx = new Ctx();
        const src = ctx.createMediaStreamSource(stream);
        const an = ctx.createAnalyser();
        an.fftSize = 512;
        src.connect(an);
        const buf = new Uint8Array(an.fftSize);
        const hist = new Array(levels.length).fill(0);
        let last = 0;
        const draw = (t) => {
          if (!rec) return;
          rec.raf = requestAnimationFrame(draw);
          if (t - last < 70) return;
          last = t;
          an.getByteTimeDomainData(buf);
          let peak = 0;
          for (const v of buf) peak = Math.max(peak, Math.abs(v - 128));
          hist.shift(); hist.push(Math.min(1, peak / 70));
          levels.forEach((el, i) => { el.style.height = Math.max(4, Math.round(hist[i] * 32)) + "px"; });
          const s = Math.floor((Date.now() - rec.started) / 1000);
          timeEl.textContent = Math.floor(s / 60) + ":" + String(s % 60).padStart(2, "0");
        };
        rec.ctx = ctx;
        rec.raf = requestAnimationFrame(draw);
      } catch (e) {}

      // without a speech key, the browser recognizer listens in parallel as a fallback
      if (!stt && SR) {
        try {
          const sr = new SR();
          sr.lang = "ru-RU"; sr.continuous = true; sr.interimResults = false;
          sr.onresult = (e) => { for (let i = e.resultIndex; i < e.results.length; i++) if (e.results[i].isFinal && rec) rec.srText += e.results[i][0].transcript + ". "; };
          sr.onend = () => { if (rec && rec.recorder.state === "recording") { try { sr.start(); } catch (err) {} } };
          sr.start();
          rec.sr = sr;
        } catch (e) {}
      }

      rec.timer = setTimeout(() => stop(), MAX_MS);
      bar.hidden = false;
      mic.classList.add("on"); mic.setAttribute("aria-label", "Закончить запись");
      if (fab) fab.classList.add("on");
      capture.scrollIntoView({ behavior: "smooth", block: "nearest" });
      if (navigator.vibrate) navigator.vibrate(30);
    }

    function stop(cancel) {
      if (!rec) return;
      rec.cancelled = !!cancel;
      clearTimeout(rec.timer);
      if (rec.sr) { const sr = rec.sr; rec.sr = null; try { sr.stop(); } catch (e) {} }
      try { rec.recorder.state !== "inactive" ? rec.recorder.stop() : finish(); } catch (e) { finish(); }
    }

    async function finish() {
      const r = rec;
      if (!r) return;
      rec = null;
      cancelAnimationFrame(r.raf);
      try { r.ctx && r.ctx.close(); } catch (e) {}
      r.stream && r.stream.getTracks().forEach((t) => t.stop());
      bar.hidden = true;
      levels.forEach((el) => { el.style.height = "4px"; });
      timeEl.textContent = "0:00";
      mic.classList.remove("on"); mic.setAttribute("aria-label", "Начать запись");
      if (fab) fab.classList.remove("on");
      if (r.cancelled) { status("Запись отменена"); setTimeout(() => status(""), 1500); return; }
      const secs = (Date.now() - r.started) / 1000;
      if (secs < 0.8) { status("Слишком коротко. Нажмите на микрофон и говорите, потом «Готово».", true); return; }

      if (stt) {
        status("Распознаю запись…", false, true);
        const blob = new Blob(r.chunks, { type: (r.recorder.mimeType || "audio/webm").split(";")[0] });
        try {
          const res = await fetch("/api/transcribe", { method: "POST", headers: { "content-type": blob.type || "audio/webm" }, body: blob });
          const j = await res.json().catch(() => ({}));
          if (!res.ok) throw new Error(j.error || "HTTP " + res.status);
          if (insert(j.text)) { status("Готово — проверьте текст и нажмите «Разобрать на дела»"); setTimeout(() => status(""), 4000); }
          else status("Не расслышал слов. Попробуйте ещё раз поближе к микрофону.", true);
        } catch (e) {
          if (r.srText && insert(r.srText)) status("Сервер распознавания не ответил, вставил черновой текст — проверьте его.", true);
          else status("Не получилось распознать. Проверьте интернет и попробуйте ещё раз.", true);
        }
      } else if (r.srText.trim()) {
        insert(r.srText);
        status("Готово. Для более точного распознавания подключите ключ Whisper в настройках сервера.");
        setTimeout(() => status(""), 5000);
      } else {
        status("Распознавание речи на сервере не подключено, а браузер ничего не распознал. Используйте микрофон на клавиатуре телефона.", true);
      }
    }

    // fallback for browsers without MediaRecorder: recognizer only, text appears on stop
    function startSpeechOnly() {
      const sr = new SR();
      sr.lang = "ru-RU"; sr.continuous = true; sr.interimResults = false;
      rec = { started: Date.now(), srText: "", cancelled: false, recorder: { state: "recording", stop() { this.state = "inactive"; try { sr.stop(); } catch (e) {} finish(); } }, chunks: [] };
      sr.onresult = (e) => { for (let i = e.resultIndex; i < e.results.length; i++) if (e.results[i].isFinal && rec) rec.srText += e.results[i][0].transcript + ". "; };
      sr.onerror = (e) => { if (e.error === "not-allowed") { status("Нет доступа к микрофону.", true); stop(true); } };
      try { sr.start(); } catch (e) { rec = null; return; }
      bar.hidden = false;
      mic.classList.add("on");
      if (fab) fab.classList.add("on");
      const tick = () => { if (!rec) return; const s = Math.floor((Date.now() - rec.started) / 1000); timeEl.textContent = Math.floor(s / 60) + ":" + String(s % 60).padStart(2, "0"); setTimeout(tick, 500); };
      tick();
    }

    // tap = start/stop; hold for 0.4 s = record while held
    let holdTimer = null, held = false, pressStartedRec = false;
    const down = (e) => {
      if (e.button > 0) return;
      e.preventDefault();
      held = false;
      pressStartedRec = !rec;
      if (pressStartedRec) { start(); holdTimer = setTimeout(() => { held = true; }, 400); }
    };
    const up = () => {
      clearTimeout(holdTimer);
      if (pressStartedRec) { if (held) stop(); }
      else stop();
      pressStartedRec = false; held = false;
    };
    mic.addEventListener("pointerdown", down);
    mic.addEventListener("pointerup", up);
    mic.addEventListener("pointercancel", up);
    mic.addEventListener("keydown", (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); rec ? stop() : start(); } });
    bar.addEventListener("click", (e) => {
      const b = e.target.closest("[data-rec]");
      if (b) stop(b.dataset.rec === "cancel");
    });
    if (fab) {
      // the floating button records right away instead of opening the keyboard
      document.addEventListener("click", (e) => {
        if (!e.target.closest || !e.target.closest("#fab")) return;
        e.stopPropagation();
        rec ? stop() : start();
      }, true);
    }
  });
})();
