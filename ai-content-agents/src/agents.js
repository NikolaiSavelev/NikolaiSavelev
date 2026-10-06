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
- риски и ограничения (персональные данные, медицина, маркетплейсы, дети и т.п.).

Отдельно изучи практики CRM/retention, которые полезно объяснять предпринимателям человеческим языком: первая → вторая покупка, активная база vs мёртвая база, RFM простыми словами, частота покупок, время между покупками, реактивация, VIP без бесконечной скидки, персонализация без ощущения слежки, employee adoption, referral mechanics, feedback loops, source tracking.

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
    : `Бренд: Системный маркетинг. Платформа: Telegram @biznesss_life. Цель: доверие, консультации и мягкая продажа UDS/CRM/автоматизации. Используй UDS KB и нишевую карту. Не зацикливайся на одной нише: ротируй направления и углы.`;

  const prompt = `
${brandContext}

Ты работаешь как объединённая редакция из Strategist + Human Copywriter + Premium Visual/Motion Director + Fact/Human Editor.

КРИТИЧЕСКИ ВАЖНО:
- Текст должен звучать как умный живой человек, а не как AI, пресс-релиз или SEO-статья.
- Первые 1–2 строки обязаны создавать реальную причину читать дальше: наблюдение, конкретная боль, сцена, контраст, честный вопрос или сильная мысль.
- Не начинай с общих фраз и не объясняй очевидное.
- Один пост = одна мысль.
- Не повторяй темы/углы из recent history.
- Для System Marketing чередуй ниши. Не публикуй одну и ту же нишу чаще двух раз в 10 постов, если нет сильного нового угла.
- Перед выбором темы сначала выбери нишу, затем этап клиента, затем механику клиентской базы, затем форму истории.
- Никаких выдуманных кейсов, отзывов, цен, акций, технических норм и интеграций.
- Live research — дополнительный контекст, а не автоматическая истина. Volatile facts нельзя использовать в коммерческом утверждении без свежего подтверждения.
- Если тема требует факта, которого нет в базе или он помечен volatile, верни status NEEDS_FACT_CHECK.
- Если ниша относится к adjacent_hypothesis, пиши как образовательную гипотезу/сценарий, а не как официальное утверждение UDS.
- Каждый пост должен содержать полезную мысль, применимую предпринимателем даже без покупки UDS.
- UDS вводи естественно как возможный инструмент после объяснения проблемы/подхода. Не делай продукт главным героем каждого поста.
- Мягкая продажа, без давления и рекламных штампов.
- Для визуального поста держи основной текст примерно 500–900 символов, но естественность важнее длины.
- После написания прочитай текст мысленно вслух. Если звучит «мертво», перепиши до человеческого звучания.
- Editor обязан поставить humanScore. APPROVED допустим только если hook, naturalness, value и memorability >= 8/10.
- Сам выбери лучший визуальный формат: image, motion, carousel или mini_reel. Для простого сильного тезиса предпочитай image/motion; для последовательного объяснения — carousel; для beauty/lifestyle — premium hero visual или elegant mini_reel.
- Визуал не должен пересказывать весь пост. Одна идея, один фокус, минимум текста.
- Если сегодня нет достаточно сильной темы, можно вернуть status SKIP.

Верни ТОЛЬКО JSON без markdown:
{
  "status":"APPROVED|NEEDS_FACT_CHECK|SKIP|REWRITE",
  "topic":"короткая тема",
  "niche":"конкретная ниша или cross_niche",
  "evidenceLevel":"official_core|observed_ecosystem|adjacent_hypothesis|cross_niche",
  "clientStage":"first_contact|second_purchase|active|vip|at_risk|reactivation|referral",
  "mechanic":"base|segmentation|rfm|loyalty|certificate|referral|feedback|online_store|traffic_source|employee_adoption|other",
  "funnelStage":"expert|trust|diagnostic|offer|engagement",
  "hook":"первые 1-2 строки",
  "text":"готовый живой пост целиком",
  "cta":"короткий CTA или пустая строка",
  "visualType":"image|motion|carousel|mini_reel",
  "visualPrompt":"готовый промпт для статичного изображения на английском или пустая строка, если визуал не статичный",
  "motionBrief":"если visualType motion/mini_reel: краткий production brief с first-frame hook, 2-4 сценами, движением, on-screen text максимум 2-6 слов на сцену, формат и длительность; иначе пустая строка",
  "carouselBrief":"если carousel: 3-5 слайдов, один тезис на слайд, минимум текста; иначе пустая строка",
  "humanScore":{"hook":0,"naturalness":0,"value":0,"memorability":0},
  "editorNote":"почему одобрено/что надо проверить"
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
${liveResearch ? JSON.stringify(liveResearch, null, 2) : 'Пока нет свежего research snapshot. Используй curated knowledge и избегай меняющихся фактов.'}

RECENT HISTORY:
${JSON.stringify(recent.map(x => ({brand:x.brand, niche:x.niche, topic:x.topic, text:x.text?.slice(0,240), publishedAt:x.publishedAt})), null, 2)}
`;

  const response = await client.responses.create({
    model: process.env.OPENAI_TEXT_MODEL || 'gpt-5',
    input: prompt
  });

  const draft = safeJson(response.output_text);

  if (draft.status === 'APPROVED' && draft.humanScore) {
    const scores = ['hook', 'naturalness', 'value', 'memorability'].map(k => Number(draft.humanScore[k] || 0));
    if (scores.some(score => score < 8)) {
      draft.status = 'REWRITE';
      draft.editorNote = `${draft.editorNote || ''} Auto-blocked: humanScore below 8/10.`.trim();
    }
  }

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
