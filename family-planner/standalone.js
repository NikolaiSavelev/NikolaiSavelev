// Standalone runtime for the family planner: gives the page the same
// window.claude.use("db" | "user" | "sample") surface it has on claude.ai,
// backed by this site's own server, and adds a real microphone button.
(function () {
  window.__standalone = true;
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

  // ---- local parser: turns dictated Russian into tasks, goals and money without any AI key ----
  const LP = (() => {
    const pad = (n) => String(n).padStart(2, "0");
    const iso = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
    const plusDays = (n) => { const d = new Date(); d.setDate(d.getDate() + n); return iso(d); };
    const MONTHS = ["январ", "феврал", "март", "апрел", "ма[йя]", "июн", "июл", "август", "сентябр", "октябр", "ноябр", "декабр"];
    const WEEKDAYS = [["воскресень"], ["понедельник"], ["вторник"], ["сред"], ["четверг"], ["пятниц"], ["суббот"]];
    const WORDNUM = { "одну": 1, "один": 1, "две": 2, "два": 2, "три": 3, "четыре": 4, "пять": 5, "шесть": 6, "семь": 7, "восемь": 8, "девять": 9, "десять": 10, "полторы": 1.5, "полтора": 1.5 };
    const OUT_CATS = [
      ["Продукты", /продукт|магазин|пят[её]рочк|магнит|перекр[её]ст|ашан|лент[аеуы]|еда|еду|хлеб|молок|овощ|фрукт|мяс/],
      ["Кафе и доставка", /кафе|ресторан|доставк|кофе|пицц|суши|роллы|бургер|обед в|столов/],
      ["Дом и ЖКХ", /квартир|жкх|коммунал|квартплат|свет(?:(?<![а-яёА-ЯЁa-zA-Z0-9])(?=[а-яёА-ЯЁa-zA-Z0-9])|(?<=[а-яёА-ЯЁa-zA-Z0-9])(?![а-яёА-ЯЁa-zA-Z0-9]))|электричеств|газ(?:(?<![а-яёА-ЯЁa-zA-Z0-9])(?=[а-яёА-ЯЁa-zA-Z0-9])|(?<=[а-яёА-ЯЁa-zA-Z0-9])(?![а-яёА-ЯЁa-zA-Z0-9]))|вод[аеуы](?:(?<![а-яёА-ЯЁa-zA-Z0-9])(?=[а-яёА-ЯЁa-zA-Z0-9])|(?<=[а-яёА-ЯЁa-zA-Z0-9])(?![а-яёА-ЯЁa-zA-Z0-9]))|аренд|ремонт|мебел/],
      ["Транспорт", /бензин|топлив|заправк|такси|метро|автобус|машин|парковк|шиномонтаж|проезд/],
      ["Дети", /дет(ям|ей|и)|ребён|ребен|сын|доч|школ|садик|детск|кружок|секци|игрушк/],
      ["Здоровье", /аптек|врач|лекарств|клиник|стоматолог|анализ|больниц/],
      ["Одежда", /одежд|обув|куртк|джинс|кроссовк|плать|футболк|ботин/],
      ["Связь и подписки", /телефон|интернет|связь|мобильн|подписк|тариф/],
      ["Развлечения", /кино|театр|концерт|игр[аыу]|развлеч|боулинг|парк/],
      ["Подарки", /подар/],
      ["Кредиты", /кредит|ипотек|долг|рассрочк/],
    ];
    const IN_CATS = [["Зарплата", /зарплат|аванс|оклад|преми/], ["Подработка", /подработ|халтур|заказ/], ["Возвраты и кэшбэк", /вернул|возврат|кэшб[эе]к|кешб[эе]к/], ["Подарки", /подар/]];

    function amountOf(s) {
      const t = s.toLowerCase().replace(/(\d)\s+(?=\d{3}(?:(?<![а-яёА-ЯЁa-zA-Z0-9])(?=[а-яёА-ЯЁa-zA-Z0-9])|(?<=[а-яёА-ЯЁa-zA-Z0-9])(?![а-яёА-ЯЁa-zA-Z0-9])))/g, "$1");
      let m = t.match(/(\d+(?:[.,]\d+)?)\s*(тысяч[аиу]?|тыс\.?|к(?:(?<![а-яёА-ЯЁa-zA-Z0-9])(?=[а-яёА-ЯЁa-zA-Z0-9])|(?<=[а-яёА-ЯЁa-zA-Z0-9])(?![а-яёА-ЯЁa-zA-Z0-9]))|т\.р|млн|миллион[аов]*)?/);
      if (m) {
        let n = parseFloat(m[1].replace(",", "."));
        if (m[2]) n *= /млн|миллион/.test(m[2]) ? 1e6 : 1000;
        if (n > 0) return { value: Math.round(n), raw: m[0] };
      }
      m = t.match(new RegExp("(" + Object.keys(WORDNUM).join("|") + ")\\s+(тысяч[аиу]?|тыщ[иу]?)"));
      if (m) return { value: Math.round(WORDNUM[m[1]] * 1000), raw: m[0] };
      m = t.match(/(?:(?<![а-яёА-ЯЁa-zA-Z0-9])(?=[а-яёА-ЯЁa-zA-Z0-9])|(?<=[а-яёА-ЯЁa-zA-Z0-9])(?![а-яёА-ЯЁa-zA-Z0-9]))тысяч[уа](?:(?<![а-яёА-ЯЁa-zA-Z0-9])(?=[а-яёА-ЯЁa-zA-Z0-9])|(?<=[а-яёА-ЯЁa-zA-Z0-9])(?![а-яёА-ЯЁa-zA-Z0-9]))/);
      if (m) return { value: 1000, raw: m[0] };
      return null;
    }

    function dateOf(s) {
      const t = s.toLowerCase();
      const DAT = ["январю", "февралю", "марту", "апрелю", "маю", "июню", "июлю", "августу", "сентябрю", "октябрю", "ноябрю", "декабрю"];
      let k = t.match(new RegExp("к\\s+(" + DAT.join("|") + ")"));
      if (k) { const mi = DAT.indexOf(k[1]); const d = new Date(); let y = d.getFullYear(); if (mi <= d.getMonth()) y++; return { date: iso(new Date(y, mi, 1)), raw: new RegExp(k[0]) }; }
      const SEASON = { "лету": 5, "осени": 8, "зиме": 11, "весне": 2 };
      k = t.match(/к\s+(лету|осени|зиме|весне)/);
      if (k) { const mi = SEASON[k[1]]; const d = new Date(); let y = d.getFullYear(); if (mi <= d.getMonth()) y++; return { date: iso(new Date(y, mi, 1)), raw: new RegExp(k[0]) }; }
      if (/к нов(ому|ый) год/.test(t)) { const d = new Date(); return { date: d.getFullYear() + "-12-31", raw: /к нов(ому|ый) году?/ }; }
      if (/послезавтра/.test(t)) return { date: plusDays(2), raw: /послезавтра/ };
      if (/завтра/.test(t)) return { date: plusDays(1), raw: /завтра/ };
      if (/сегодня/.test(t)) return { date: plusDays(0), raw: /сегодня/ };
      if (/вчера/.test(t)) return { date: plusDays(-1), raw: /вчера/ };
      let m = t.match(/через\s+(\d+|одну|один|два|две|три|неделю|месяц)\s*(дн[яей]*|день|недел[юиь]*|месяц[аев]*)?/);
      if (m) {
        const n = WORDNUM[m[1]] || parseInt(m[1], 10) || 1;
        const unit = (m[2] || m[1]);
        const days = /недел/.test(unit) ? n * 7 : /месяц/.test(unit) ? n * 30 : n;
        return { date: plusDays(days), raw: new RegExp(m[0]) };
      }
      m = t.match(new RegExp("(\\d{1,2})(?:-?го)?\\s+(" + MONTHS.join("|") + ")[а-я]*"));
      if (m) {
        const mi = MONTHS.findIndex((x) => new RegExp("^" + x).test(m[2]));
        const d = new Date(); let y = d.getFullYear();
        const cand = new Date(y, mi, +m[1]);
        if (cand < new Date(d.getFullYear(), d.getMonth(), d.getDate())) y++;
        return { date: iso(new Date(y, mi, +m[1])), raw: new RegExp(m[0]) };
      }
      for (let wd = 0; wd < 7; wd++) {
        const re = new RegExp("(?:в|во|до|к|на|в эт[оу]т?)?\\s*" + WEEKDAYS[wd][0] + "[а-я]*");
        if (re.test(t)) {
          const d = new Date(); let add = (wd - d.getDay() + 7) % 7; if (add === 0) add = 7;
          return { date: plusDays(add), raw: re };
        }
      }
      m = t.match(/до\s+(\d{1,2})(?:-?го)?(?:(?<![а-яёА-ЯЁa-zA-Z0-9])(?=[а-яёА-ЯЁa-zA-Z0-9])|(?<=[а-яёА-ЯЁa-zA-Z0-9])(?![а-яёА-ЯЁa-zA-Z0-9]))/);
      if (m && +m[1] <= 31) {
        const d = new Date(); let mo = d.getMonth(), y = d.getFullYear();
        if (+m[1] < d.getDate()) { mo++; if (mo > 11) { mo = 0; y++; } }
        return { date: iso(new Date(y, mo, +m[1])), raw: new RegExp(m[0]) };
      }
      return null;
    }

    function timeOf(s) {
      const t = s.toLowerCase();
      const m = t.match(/(?:(?<![а-яёА-ЯЁa-zA-Z0-9])(?=[а-яёА-ЯЁa-zA-Z0-9])|(?<=[а-яёА-ЯЁa-zA-Z0-9])(?![а-яёА-ЯЁa-zA-Z0-9]))в\s+(\d{1,2})(?:[:.](\d{2}))?\s*(час[аов]*|утра|вечера|дня|ночи)?(?=\s|$|[,.!?])/);
      if (!m) return null;
      let h = +m[1]; const mm = m[2] ? +m[2] : 0;
      if (h > 23 || mm > 59) return null;
      if (!m[2] && !m[3] && (h > 23)) return null;
      if (/вечера|дня/.test(m[3] || "") && h < 12) h += 12;
      return { time: `${pad(h)}:${pad(mm)}`, raw: new RegExp(m[0].replace(/[.*+?^${}()|[\]\\]/g, "\\$&")) };
    }

    // assignee: "Светлане/Свете купить" (dative) or the name opening the sentence; "забрать Светлану" is not an assignee
    const NB = "(?<![а-яёa-z])", NE = "(?![а-яёa-z])";
    function whoOf(s, people, me) {
      const t = s.toLowerCase();
      if (new RegExp(NB + "(мы|нам|вместе|хотим|всей семь[её]й|с семь[её]й|всем вместе)" + NE).test(t)) return { who: "both", raw: new RegExp(NB + "(вместе|всей семь[её]й|с семь[её]й|всем вместе)" + NE) };
      for (const p of people) {
        const name = (p.name || "").toLowerCase();
        if (name.length < 3) continue;
        const stems = [name.slice(0, Math.max(3, name.length - 1))];
        if (name.startsWith("светл")) stems.push("свет");
        if (name.startsWith("никол")) stems.push("кол", "никол");
        for (const st of stems) {
          const dat = new RegExp(NB + st + "[а-яё]*(е|ю|и)" + NE + "\\s*(надо|нужно|необходимо)?\\s*");
          const head = new RegExp("^\\s*" + st + "[а-яё]*" + NE + ",?\\s*(надо|нужно|должн[аы]?)?\\s*");
          if (dat.test(t)) return { who: p.id, raw: dat };
          if (head.test(t)) return { who: p.id, raw: head };
        }
      }
      const other = people.find((p) => p.id !== me);
      const rel = new RegExp(NB + "(жене|супруге|мужу|супругу)" + NE + "\\s*(надо|нужно)?\\s*");
      if (other && rel.test(t)) return { who: other.id, raw: rel };
      return null;
    }

    const clean = (s) => s.replace(/\s{2,}/g, " ").replace(/^[\s,.;:—-]+|[\s,.;:—-]+$/g, "").trim();
    const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);

    // a period for goals: "с 18 по 25 октября", "с 18.10 по 25.10", "за неделю", "в ноябре", "до конца месяца"
    const MONTH_GEN = ["января", "февраля", "марта", "апреля", "мая", "июня", "июля", "августа", "сентября", "октября", "ноября", "декабря"];
    const MONTH_PREP = ["январе", "феврале", "марте", "апреле", "мае", "июне", "июле", "августе", "сентябре", "октябре", "ноябре", "декабре"];
    const MONTH_NOM = ["январь", "февраль", "март", "апрель", "май", "июнь", "июль", "август", "сентябрь", "октябрь", "ноябрь", "декабрь"];
    function rangeOf(s) {
      const t = s.toLowerCase(), now = new Date(), y = now.getFullYear();
      const day = (yy, mi, d) => iso(new Date(yy, mi, d));
      const yearFor = (mi, d) => (new Date(y, mi, d) < new Date(y, now.getMonth(), now.getDate() - 1) ? y + 1 : y);
      let m = t.match(new RegExp("с\\s+(\\d{1,2})(?:-?го)?(?:\\s+(" + MONTH_GEN.join("|") + "))?\\s+(?:по|до)\\s+(\\d{1,2})(?:-?го|-?е)?\\s+(" + MONTH_GEN.join("|") + ")"));
      if (m) {
        const m2 = MONTH_GEN.indexOf(m[4]), m1 = m[2] ? MONTH_GEN.indexOf(m[2]) : m2;
        const yy = yearFor(m2, +m[3]);
        return { start: day(m1 > m2 ? yy - 1 : yy, m1, +m[1]), end: day(yy, m2, +m[3]), raw: new RegExp(m[0]) };
      }
      m = t.match(/с\s+(\d{1,2})[./](\d{1,2})(?:[./]\d{2,4})?\s+(?:по|до)\s+(\d{1,2})[./](\d{1,2})(?:[./]\d{2,4})?/);
      if (m) { const yy = yearFor(+m[4] - 1, +m[3]); return { start: day(yy, +m[2] - 1, +m[1]), end: day(yy, +m[4] - 1, +m[3]), raw: new RegExp(m[0].replace(/[.]/g, "\\.")) }; }
      if (/на этой неделе|до конца недели/.test(t)) { const add = (7 - now.getDay()) % 7; return { start: plusDays(0), end: plusDays(add), raw: /на этой неделе|до конца недели/ }; }
      if (/(за|на|в течение)\s+(неделю|недели)/.test(t)) return { start: plusDays(0), end: plusDays(6), raw: /(за|на|в течение)\s+(неделю|недели)/ };
      if (/(за|на|в течение)\s+(две недели|2 недели)/.test(t)) return { start: plusDays(0), end: plusDays(13), raw: /(за|на|в течение)\s+(две недели|2 недели)/ };
      if (/в этом месяце|до конца месяца/.test(t)) return { start: plusDays(0), end: day(y, now.getMonth() + 1, 0), raw: /в этом месяце|до конца месяца/ };
      if (/(за|на|в течение)\s+месяц/.test(t)) return { start: plusDays(0), end: plusDays(29), raw: /(за|на|в течение)\s+месяц/ };
      if (/в этом году|до конца года|(за|на|в течение)\s+год/.test(t)) return { start: plusDays(0), end: y + "-12-31", raw: /в этом году|до конца года|(за|на|в течение)\s+год/ };
      m = t.match(new RegExp("(?:в|за)\\s+(" + MONTH_PREP.concat(MONTH_NOM).join("|") + ")"));
      if (m) {
        let mi = MONTH_PREP.indexOf(m[1]); if (mi < 0) mi = MONTH_NOM.indexOf(m[1]);
        const yy = mi < now.getMonth() ? y + 1 : y;
        const start = mi === now.getMonth() && yy === y ? plusDays(0) : day(yy, mi, 1);
        return { start, end: day(yy, mi + 1, 0), raw: new RegExp(m[0]) };
      }
      return null;
    }
    const GOAL_TITLE = { income: "Заработать", expense: "Траты не больше", save: "Отложить" };
    const fmtRub = (n) => new Intl.NumberFormat("ru-RU").format(Math.round(n)) + " ₽";

    function parse(text, ctx) {
      const people = ctx.people || [], me = ctx.me || null, funds = ctx.funds || [];
      const parts = String(text || "").replace(/\n+/g, ". ").split(/(?<=[.!?;])\s+|\s+(?:а ещё|а еще|ещё нужно|еще нужно|потом|и ещё|и еще)\s+/i).map((x) => x.trim()).filter(Boolean);
      const items = [];
      for (let s of parts) {
        s = s.replace(/[.!?;]+$/, "");
        const low = s.toLowerCase();
        if (!low.replace(/[^а-яёa-z0-9]/g, "")) continue;
        const dt = dateOf(s);
        const tm = timeOf(s);
        const wh = whoOf(s, people, me);
        // strip date/time first so "25 июня" or "в 10" never count as money
        let work = s.replace(/(\d)\s+(?=\d{3}(?!\d))/g, "$1");
        if (dt) work = work.replace(new RegExp(dt.raw.source, "i"), " ");
        if (tm) work = work.replace(new RegExp(tm.raw.source, "i"), " ");
        const amt = amountOf(work);
        const spentPast = /потратил|купил[аи]?(?![а-яё])|заплатил|оплатил[аи]?(?![а-яё])|отдал[аи]?(?![а-яё])|стоил|ушло|обошл/.test(low);
        const planned = /(купить|оплатить|заплатить|отдать|перевести|потратить)(?![а-яё])/.test(low) && !spentPast;
        const catHit = OUT_CATS.find(([, re]) => re.test(low));
        let kind = "task";
        if (/отлож|в копилк|накопил|положил[аи]? на сч[её]т/.test(low) && amt) kind = "save";
        else if (/взял[аи]? из копилк|снял[аи]? с копилк|из копилки/.test(low) && amt) kind = "save";
        else if (amt && /зарплат|аванс|преми|получил|пришл[аио]|пришел|пришёл|заработал|вернул|кэшб|кешб|доход|подработ|перевел[аи]? нам|подарил[аи]? нам/.test(low)) kind = "income";
        else if (/(?:(?<![а-яёА-ЯЁa-zA-Z0-9])(?=[а-яёА-ЯЁa-zA-Z0-9])|(?<=[а-яёА-ЯЁa-zA-Z0-9])(?![а-яёА-ЯЁa-zA-Z0-9]))цель(?:(?<![а-яёА-ЯЁa-zA-Z0-9])(?=[а-яёА-ЯЁa-zA-Z0-9])|(?<=[а-яёА-ЯЁa-zA-Z0-9])(?![а-яёА-ЯЁa-zA-Z0-9]))|хочу|хотим|мечта|накопить|научиться|к лету|к новому году|за год/.test(low)) kind = "goal";
        else if (amt && !planned && amt.value >= 10 && (spentPast || catHit || /расход|покупк|рубл|₽/.test(low))) kind = "expense";

        const mode = ctx.mode || "all";
        const rg = rangeOf(s);
        if (mode === "goals") kind = "goal";
        else if (mode === "tasks") kind = "task";
        else if (mode === "money" && !(kind === "expense" || kind === "income" || kind === "save")) kind = /зарплат|аванс|преми|получил|пришл|заработал|вернул|доход/.test(low) ? "income" : "expense";
        let title = work;
        if (wh) title = title.replace(new RegExp(wh.raw.source, "i"), " ");
        title = title.replace(/^(мне|нам|надо|нужно|не забыть|обязательно|пожалуйста)\s+/i, "").replace(/\s+(надо|нужно)\s+/i, " ");
        const item = { kind, who: wh ? wh.who : (me || "both"), date: dt ? dt.date : null, time: tm ? tm.time : null, goal: null, amount: null, category: null, fund: null };

        if (kind === "goal") {
          let gw = rg ? work.replace(new RegExp(rg.raw.source, "i"), " ") : work;
          let gamt = amountOf(gw);
          if (gamt && gamt.value < 100 && !/рубл|₽|тыс|заработ|доход|отлож|накоп|трат|бюджет|лимит|копил/.test(low)) gamt = null;
          item.metric = !gamt ? "steps"
            : /не больше|не более|уложит|лимит|максимум|тратить|потратить/.test(low) ? "expense"
            : /отлож|накоп|копить|сбере/.test(low) ? "save"
            : /заработ|доход|получ|выручк|продаж|продать/.test(low) ? "income" : "income";
          item.target = gamt ? gamt.value : null;
          item.start = rg ? rg.start : (dt ? plusDays(0) : null);
          item.end = rg ? rg.end : (dt ? dt.date : null);
          item.date = item.end;
          if (item.metric !== "steps") {
            const what = gw.match(/(?:на|для)\s+([а-яё][а-яё\s-]{2,40})$/i);
            item.title = GOAL_TITLE[item.metric] + " " + fmtRub(item.target) + (what && item.metric !== "income" ? " на " + clean(what[1]) : "");
          } else {
            gw = gw.replace(/^\s*(наша\s+|моя\s+)?цель\s*[—:-]?\s*/i, "").replace(/^\s*(я\s+|мы\s+)?(хочу|хотим)\s+/i, "");
            if (wh) gw = gw.replace(new RegExp(wh.raw.source, "i"), " ");
            item.title = cap(clean(gw));
          }
          if (!item.title) continue;
          items.push(item);
          continue;
        }
        if ((kind === "expense" || kind === "income" || kind === "save") && !amt) {
          const table = kind === "income" ? IN_CATS : OUT_CATS;
          const hit = table.find(([, re]) => re.test(low));
          item.category = hit ? hit[0] : "Другое";
          item.date = item.date || plusDays(0);
          item.title = cap(clean(title)) || item.category;
          items.push(item);
          continue;
        }
        if (kind === "expense" || kind === "income" || kind === "save") {
          item.amount = kind === "save" && /взял|снял|из копилк/.test(low) ? -amt.value : amt.value;
          item.date = item.date || plusDays(0);
          let note = title.replace(new RegExp(amt.raw.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i"), " ")
            .replace(/(?:(?<![а-яёА-ЯЁa-zA-Z0-9])(?=[а-яёА-ЯЁa-zA-Z0-9])|(?<=[а-яёА-ЯЁa-zA-Z0-9])(?![а-яёА-ЯЁa-zA-Z0-9]))(я|мы|сегодня|вчера|потратил[аи]?|купил[аи]?|заплатил[аи]?|оплатил[аи]?|отдал[аи]?|отложил[аи]?|получил[аи]?|пришл[аио]|пришел|пришёл|заработал[аи]?|вернули|получила|взяли|сняли|ушло|ушли|рубл[ейя]*|руб\.?|₽|тысяч[аиу]?|тыс\.?)(?:(?<![а-яёА-ЯЁa-zA-Z0-9])(?=[а-яёА-ЯЁa-zA-Z0-9])|(?<=[а-яёА-ЯЁa-zA-Z0-9])(?![а-яёА-ЯЁa-zA-Z0-9]))/gi, " ")
            .replace(/^\s*(на|за|в)\s+/i, "");
          note = clean(note.replace(/\s+(на|за)\s*$/i, ""));
          if (kind === "save") {
            const f = funds.find((x) => { const st = (x.title || "").toLowerCase().slice(0, 5); return st.length >= 3 && low.includes(st); });
            item.fund = f ? f.id : (funds.length === 1 ? funds[0].id : null);
            note = clean(note.replace(/(в|из)\s+копилк[уиа]/i, ""));
          } else {
            const table = kind === "income" ? IN_CATS : OUT_CATS;
            const hit = table.find(([, re]) => re.test(low));
            item.category = hit ? hit[0] : "Другое";
          }
          item.title = note ? cap(note) : (item.category || "");
        } else {
          if (kind === "goal") title = title.replace(/^\s*(наша\s+|моя\s+)?цель\s*[—:-]?\s*/i, "").replace(/^\s*(я\s+|мы\s+)?(хочу|хотим)\s+/i, "");
          item.title = cap(clean(title));
          if (!item.title) continue;
        }
        items.push(item);
      }
      return items;
    }
    return { parse };
  })();
  window.__localParse = LP.parse;

  // without a Claude key the page's "Разобрать" runs the local parser on the dictated text
  function localSample(input) {
    const prompt = typeof input === "string" ? input : input.map((m) => m.content).join("\n\n");
    const m = prompt.match(/"""([\s\S]*)"""\s*$/);
    const fam = store.get("family") && store.get("family").get("members");
    const people = (fam && Array.isArray(fam.people) ? fam.people : []);
    const funds = [...(store.get("funds") || new Map())].map(([id, d]) => ({ id, ...d }));
    let me = null; try { me = localStorage.getItem("dela:me"); } catch (e) {}
    const mm = prompt.match(/Режим раздела:\s*(\w+)/);
    return LP.parse(m ? m[1] : prompt, { people, me, funds, mode: mm ? mm[1] : "all" });
  }

  async function parse(input, opts) {
    if (!ai) return localSample(input);
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
      if (name === "sample") return sample;
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
    .cap-how { display: block; margin-top: 4px; font-weight: 700; color: var(--accent) !important; }
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

    // after a recording, go straight to "what I understood" so there is one less button to find
    const autoParse = () => {
      const b = document.getElementById("parseBtn");
      if (b && !b.hidden && !b.disabled) b.click();
      else status("Готово — проверьте текст и добавьте его");
    };

    mic.classList.add("voice");
    mic.setAttribute("role", "button");
    mic.setAttribute("tabindex", "0");
    mic.removeAttribute("aria-hidden");
    mic.setAttribute("aria-label", "Начать запись");
    if (sub && !document.getElementById("capHow")) {
      const how = document.createElement("span");
      how.id = "capHow"; how.className = "cap-sub cap-how";
      how.textContent = "Нажмите на микрофон, говорите и нажмите «Готово». Можно держать кнопку, как рацию.";
      sub.insertAdjacentElement("afterend", how);
    }

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
          if (insert(j.text)) autoParse();
          else status("Не расслышал слов. Попробуйте ещё раз поближе к микрофону.", true);
        } catch (e) {
          if (r.srText && insert(r.srText)) status("Сервер распознавания не ответил, вставил черновой текст — проверьте его.", true);
          else status("Не получилось распознать. Проверьте интернет и попробуйте ещё раз.", true);
        }
      } else if (r.srText.trim()) {
        insert(r.srText);
        autoParse();
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
