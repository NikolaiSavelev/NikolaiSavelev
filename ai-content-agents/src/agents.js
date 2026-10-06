import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import OpenAI from 'openai';
import { listHistory, getResearch, saveResearch } from './store.js';

const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
const ROOT = path.resolve(process.cwd());

async function read(name) {
  return fs.readFile(path.join(ROOT, name), 'utf8');
}

function safeJson(text) {
  const cleaned = text.replace(/^```json\s*/i, '').replace(/```$/i, '').trim();
  return JSON.parse(cleaned);
}

async function jsonResponse(input) {
  const response = await client.responses.create({
    model: process.env.OPENAI_TEXT_MODEL || 'gpt-5',
    input
  });
  return safeJson(response.output_text);
}

function mechanicalSignals(text = '') {
  const lower = text.toLowerCase();
  const banned = [
    'в современном мире',
    'ни для кого не секрет',
    'эффективное решение',
    'уникальное решение',
    'вывести бизнес на новый уровень',
    'наша команда профессионалов',
    'индивидуальный подход',
    'хотите увеличить продажи',
    'сегодня поговорим',
    'давайте разберемся',
    'давайте разберёмся'
  ];
  const bulletCount = (text.match(/(^|\n)\s*[-—•]\s/g) || []).length;
  return {
    bannedPhrase: banned.some(x => lower.includes(x)),
    tooManyBullets: bulletCount >= 5,
    bulletCount
  };
}

export async function refreshResearch(brand) {
  const isSanteh = brand === 'santehsila';
  if (!isSanteh && brand !== 'system_marketing') throw new Error('Unknown brand');

  const prompt = isSanteh
    ? `Ты — research analyst инженерной редакции САНТЕХСИЛА. Выполни свежий веб-поиск по официальным/первичным источникам по внутренним инженерным системам квартир: водоснабжение, канализация, отопление, коллекторные системы, тёплый пол, защита от протечек, материалы и инструкции производителей. Приоритет: официальные сайты и документация производителей (REHAU, VALTEC, STOUT, Oventrop и сопоставимые первичные источники), официальные нормативные ресурсы, если доступны. Не выдавай универсальные технические нормы без прямого подтверждения. Собери только полезные для контента обновления и новые углы. Не копируй длинные тексты. Верни JSON: {"checkedAt":"ISO","summary":"...","facts":[{"claim":"...","sourceUrl":"...","volatile":false,"note":"..."}],"contentIdeas":["..."],"warnings":["..."]}.`
    : `Ты — senior research analyst по UDS, CRM, retention, loyalty marketing и отраслевым сценариям работы с клиентской базой. Выполни широкий свежий веб-поиск.

Цель исследования: не просто перечислить функции UDS, а построить прикладную карту того, как разные B2C-ниши могут работать с клиентской базой, повторными продажами, сегментацией, RFM, рекомендациями, сертификатами, обратной связью, онлайн-продажами и возвратом клиентов.

Приоритет источников:
1) официальные домены uds.app, help.uds.app, blog.uds.app;
2) действующие публичные страницы компаний внутри экосистемы *.uds.app как подтверждение факта использования UDS конкретным бизнесом;
3) качественные вторичные источники — только для общих маркетинговых практик, не для утверждений о функциях UDS.

Обязательно исследуй и разделяй ниши по уровням доказательности:
- official_core — прямо названы UDS в официальных материалах;
- observed_ecosystem — найдены реальные компании/кейсы в экосистеме UDS;
- adjacent_hypothesis — бизнес-модель логично подходит по повторным B2C-покупкам, но UDS не должен быть представлен как официально специализированный в этой нише без доказательства.

Проверь минимум эти направления: retail, beauty/salons/cosmetology/nails, HoReCa/restaurants/cafes/coffee/bakeries, auto service/detailing/car wash, medical/dental clinics, fitness/studios, education/courses/beauty schools, professional services/consulting, e-commerce/direct online sales, hospitality/hotels, malls/large companies, flowers/gifts, pet/grooming, children's centers/entertainment, home/local services, marketplace sellers/direct-channel strategy.

Для каждой найденной ниши собери:
- типичные бизнес-боли;
- какие данные/сегменты клиентской базы реально полезны;
- подходящие механики UDS, подтверждённые источниками;
- что можно делать с новыми, активными, VIP и давно не покупавшими клиентами;
- идеи полезного контента, которые дают ценность даже без продажи UDS;
- идеи человеческих hooks;
- визуальный/motion-угол;
- риски и ограничения.

Отдельно изучи практики CRM/retention: первая → вторая покупка, активная база vs мёртвая база, RFM простыми словами, частота покупок, время между покупками, реактивация, VIP без бесконечной скидки, персонализация без ощущения слежки, employee adoption, referral mechanics, feedback loops, source tracking.

Для фактов о UDS используй в первую очередь официальные домены. Любые цены, акции, состав тарифов и меняющиеся условия помечай volatile=true. Не утверждай наличие интеграции с Ozon или другой площадкой без официального подтверждения. Не обещай финансовый результат.

Верни ТОЛЬКО JSON:
{
  "checkedAt":"ISO",
  "summary":"краткий вывод исследования",
  "facts":[{"claim":"...","sourceUrl":"...","volatile":false,"note":"..."}],
  "niches":[{
    "name":"...",
    "evidenceLevel":"official_core|observed_ecosystem|adjacent_hypothesis",
    "evidenceUrls":["..."],
    "pains":["..."],
    "usefulSegments":["..."],
    "applicableMechanics":["..."],
    "clientBasePlaybook":["..."],
    "contentIdeas":["..."],
    "humanHooks":["..."],
    "visualIdeas":["..."],
    "warnings":["..."]
  }],
  "crossNicheLessons":["..."],
  "contentIdeas":["..."],
  "warnings":["..."]
}.`;

  const response = await client.responses.create({
    model: process.env.OPENAI_TEXT_MODEL || 'gpt-5',
    tools: [{ type: 'web_search' }],
    input: prompt
  });

  const parsed = safeJson(response.output_text);
  const snapshot = {
    ...parsed,
    checkedAt: parsed.checkedAt || new Date().toISOString(),
    brand
  };
  await saveResearch(brand, snapshot);
  return snapshot;
}

export async function generatePost(brand) {
  const [agents, kbUds, kbUdsNiches, kbEng, plan, visuals, recent, liveResearch] = await Promise.all([
    read('agents.md'),
    read('knowledge-uds.md'),
    read('knowledge-uds-niches.md').catch(() => ''),
    read('knowledge-engineering.md'),
    read('content-plan-30-days.md'),
    read('visual-style.md'),
    listHistory(30),
    getResearch(brand)
  ]);

  const isSanteh = brand === 'santehsila';
  if (!isSanteh && brand !== 'system_marketing') throw new Error('Unknown brand');

  const brandContext = isSanteh
    ? `Бренд: САНТЕХСИЛА. Платформа: MAX. Цель: заявки на инженерные работы в Москве и МО. Используй engineering KB.`
    : `Бренд: Системный маркетинг. Платформа: Telegram @biznesss_life. Цель: доверие, консультации и мягкая продажа UDS/CRM/автоматизации. Используй UDS KB и нишевую карту.`;

  const recentCompact = recent.slice(0, 18).map(x => ({
    brand: x.brand,
    niche: x.niche,
    topic: x.topic,
    storyForm: x.storyForm,
    hook: x.hook,
    text: x.text?.slice(0, 260),
    publishedAt: x.publishedAt
  }));

  const authorPrompt = `
${brandContext}

Ты — автор сильного авторского Telegram/MAX-медиа. Не пиши "контент". Напиши пост, который человек реально захочет дочитать.

ГЛАВНОЕ:
1. Начни с конкретной сцены, детали, парадокса или наблюдения ИМЕННО из выбранной ниши.
2. Первые две строки должны быть настолько конкретными, чтобы их нельзя было без изменений вставить в пост про другую нишу.
3. Покажи напряжение: где бизнес теряет клиента, деньги, внимание, повторный визит или понимание базы.
4. Дай один полезный вывод, который можно применить без покупки продукта.
5. Только потом, если уместно, естественно свяжи решение с UDS/CRM.
6. Не превращай пост в инструкцию из 7 пунктов. Список допустим только если без него действительно хуже.
7. Не пиши как преподаватель. Не объясняй термин раньше проблемы.
8. Не используй рекламные слова: "эффективный", "уникальный", "современное решение", "индивидуальный подход", "увеличьте продажи".
9. Не пиши "клиенты — это...", "база — это..." как словарное определение, если можно показать это сценой.
10. Не выдумывай личный опыт, цифры, клиента или кейс.

ЖИВОЙ РИТМ:
- абзацы 1–3 предложения;
- смесь коротких и средних фраз;
- допускается одна фраза из 2–6 слов отдельным абзацем;
- разговорность без фамильярности;
- максимум 0–2 эмодзи и только если естественно;
- не ставь CTA в каждом посте: иногда сильный финальный вопрос лучше продажи.

ОБЯЗАТЕЛЬНО выбери storyForm из:
scene | observation | contrast | mini_story | dialogue_fragment | myth_break | diagnostic | checklist
Не повторяй тот же storyForm, что доминирует в последних постах.

ПРОВЕРКА ПЕРВОГО ЭКРАНА:
Если первые 180 символов можно заменить на "Бизнесу важно работать с клиентской базой" без потери смысла — начало слабое, перепиши.

ПРИМЕР ПРИНЦИПА, НЕ КОПИРОВАТЬ:
Слабое: "Важно работать с постоянными клиентами."
Сильнее: "Бариста уже знает, что Илье нужен капучино без сахара. А система каждый раз видит Илью как нового человека."

Слабое: "Салонам важно возвращать клиентов."
Сильнее: "Администратор узнаёт клиентку по голосу. Но если она пропала на три месяца — бизнес замечает это слишком поздно."

Верни ТОЛЬКО JSON:
{
  "status":"APPROVED|NEEDS_FACT_CHECK|SKIP|REWRITE",
  "topic":"короткая тема",
  "niche":"конкретная ниша или cross_niche",
  "evidenceLevel":"official_core|observed_ecosystem|adjacent_hypothesis|cross_niche",
  "clientStage":"first_contact|second_purchase|active|vip|at_risk|reactivation|referral",
  "mechanic":"base|segmentation|rfm|loyalty|certificate|referral|feedback|online_store|traffic_source|employee_adoption|other",
  "funnelStage":"expert|trust|diagnostic|offer|engagement",
  "storyForm":"scene|observation|contrast|mini_story|dialogue_fragment|myth_break|diagnostic|checklist",
  "hook":"первые 1-2 строки",
  "text":"готовый пост",
  "cta":"CTA или пустая строка",
  "visualType":"image|motion|carousel|mini_reel",
  "visualPrompt":"английский промпт для image или пустая строка",
  "motionBrief":"brief для motion/mini_reel или пустая строка",
  "carouselBrief":"brief для carousel или пустая строка",
  "authorNote":"какое человеческое напряжение держит пост"
}

SYSTEM ROLES:
${agents}

CONTENT PLAN:
${plan}

VISUAL SYSTEM:
${visuals}

CURATED KNOWLEDGE:
${isSanteh ? kbEng : `${kbUds}\n\nNICHE PLAYBOOK:\n${kbUdsNiches}`}

LATEST LIVE RESEARCH:
${liveResearch ? JSON.stringify(liveResearch, null, 2) : 'Нет свежего research snapshot. Избегай меняющихся фактов.'}

RECENT HISTORY:
${JSON.stringify(recentCompact, null, 2)}
`;

  const draft = await jsonResponse(authorPrompt);

  if (['SKIP', 'NEEDS_FACT_CHECK'].includes(draft.status)) {
    return {
      id: crypto.randomUUID(),
      brand,
      platforms: isSanteh ? ['max'] : ['telegram'],
      ...draft,
      createdAt: new Date().toISOString(),
      approvedAt: null,
      published: []
    };
  }

  const styleSignals = mechanicalSignals(draft.text);

  const editorPrompt = `
Ты — независимый главный редактор. Перед тобой черновик другого автора. Твоя работа — не похвалить его, а сделать текст таким, чтобы он звучал как живой умный предприниматель/маркетолог, а не как нейросеть.

Бренд: ${isSanteh ? 'САНТЕХСИЛА' : 'Системный маркетинг / UDS / CRM'}.

ЧЕРНОВИК:
${JSON.stringify(draft, null, 2)}

АВТОМАТИЧЕСКИЕ СИГНАЛЫ:
${JSON.stringify(styleSignals)}

РЕДАКТОРСКИЕ ПРАВИЛА:
- Перепиши текст, даже если он уже "нормальный". Финальная версия должна быть заметно живее.
- Сохрани все проверяемые факты и не добавляй новые неподтверждённые факты.
- Первые 2 строки: конкретика выбранной ниши. Никаких универсальных фраз.
- Убери канцелярит, определения, симметричные "AI-абзацы" и одинаковые конструкции.
- Если в черновике 4+ буллета — попробуй превратить их в историю/наблюдение. Список оставляй только если он действительно нужен.
- Не используй фразы "вопрос не в..., вопрос в..." чаще одного раза и только если она реально сильная. Лучше вообще обойтись без шаблона.
- Не злоупотребляй "Вот где...", "И тут...", "На практике...".
- Не повторяй слово "клиент" в каждом предложении.
- Не делай UDS героем текста. Сначала ситуация и смысл.
- Если продукт можно убрать, а пост всё равно полезен — это плюс.
- Финал должен либо оставлять мысль, либо вызывать желание ответить. Не обязательно продавать.
- Длина ориентир 650–1200 знаков для Telegram. Можно короче, если сильнее.

ПРОВЕРКА "ЖИВОЙ ЧЕЛОВЕК":
1) Есть ли в первых 180 символах конкретная деталь ниши?
2) Есть ли хотя бы одна фраза, которую хочется запомнить или переслать?
3) Нет ли ощущения учебника/чек-листа?
4) Нет ли рекламного пафоса?
5) Можно ли прочитать вслух без ощущения, что это презентация?

Оцени строго. 9/10 ставь только действительно сильному тексту. Если naturalness или memorability < 8 — перепиши ещё раз внутри своей работы и верни только финальную версию.

Верни ТОЛЬКО JSON:
{
  "status":"APPROVED|REWRITE",
  "hook":"финальные первые 1-2 строки",
  "text":"финальный пост",
  "cta":"финальный CTA или пустая строка",
  "humanScore":{"hook":0,"naturalness":0,"value":0,"memorability":0},
  "editorNote":"коротко: что было исправлено и почему текст теперь работает"
}
`;

  const edited = await jsonResponse(editorPrompt);
  const merged = { ...draft, ...edited };
  const finalSignals = mechanicalSignals(merged.text);

  const scores = ['hook', 'naturalness', 'value', 'memorability'].map(k => Number(merged.humanScore?.[k] || 0));
  if (merged.status === 'APPROVED' && (scores.some(score => score < 8) || finalSignals.bannedPhrase || finalSignals.tooManyBullets)) {
    merged.status = 'REWRITE';
    merged.editorNote = `${merged.editorNote || ''} Auto-blocked by final human-style gate.`.trim();
  }

  return {
    id: crypto.randomUUID(),
    brand,
    platforms: isSanteh ? ['max'] : ['telegram'],
    ...merged,
    createdAt: new Date().toISOString(),
    approvedAt: null,
    published: []
  };
}

export async function generateImage(visualPrompt) {
  const result = await client.images.generate({
    model: process.env.OPENAI_IMAGE_MODEL || 'gpt-image-2',
    prompt: visualPrompt,
    size: '1024x1536'
  });

  const b64 = result.data?.[0]?.b64_json;
  if (!b64) throw new Error('Image API did not return base64 image data');
  return Buffer.from(b64, 'base64');
}
