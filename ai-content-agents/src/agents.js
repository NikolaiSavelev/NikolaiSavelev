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
    : `Ты — senior research analyst по UDS, CRM, retention и loyalty marketing. Выполни свежий веб-поиск. Для фактов о UDS используй в первую очередь официальные домены uds.app и help.uds.app. Проверь актуальные возможности: клиентская база, сегментация, RFM, программа лояльности, push/Telegram-коммуникации, сертификаты, реферальные механики, онлайн-продажи, тарифные различия. Любые цены, акции и состав тарифов помечай volatile=true. Не утверждай наличие интеграции с Ozon без официального подтверждения. Верни JSON: {"checkedAt":"ISO","summary":"...","facts":[{"claim":"...","sourceUrl":"...","volatile":false,"note":"..."}],"contentIdeas":["..."],"warnings":["..."]}.`;

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
  const [agents, kbUds, kbEng, plan, visuals, recent, liveResearch] = await Promise.all([
    read('agents.md'),
    read('knowledge-uds.md'),
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
    : `Бренд: Системный маркетинг. Платформа: Telegram @biznesss_life. Цель: доверие, консультации и мягкая продажа UDS/CRM/автоматизации. Используй UDS KB.`;

  const prompt = `
${brandContext}

Ты работаешь как объединённая редакция из Strategist + Human Copywriter + Premium Visual/Motion Director + Fact/Human Editor.

КРИТИЧЕСКИ ВАЖНО:
- Текст должен звучать как умный живой человек, а не как AI, пресс-релиз или SEO-статья.
- Первые 1–2 строки обязаны создавать реальную причину читать дальше: наблюдение, конкретная боль, сцена, контраст, честный вопрос или сильная мысль.
- Не начинай с общих фраз и не объясняй очевидное.
- Один пост = одна мысль.
- Не повторяй темы/углы из recent history.
- Никаких выдуманных кейсов, отзывов, цен, акций, технических норм и интеграций.
- Live research — дополнительный контекст, а не автоматическая истина. Volatile facts нельзя использовать в коммерческом утверждении без свежего подтверждения.
- Если тема требует факта, которого нет в базе или он помечен volatile, верни status NEEDS_FACT_CHECK.
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
${isSanteh ? kbEng : kbUds}

LATEST LIVE RESEARCH:
${liveResearch ? JSON.stringify(liveResearch, null, 2) : 'Пока нет свежего research snapshot. Используй curated knowledge и избегай меняющихся фактов.'}

RECENT HISTORY:
${JSON.stringify(recent.map(x => ({brand:x.brand, topic:x.topic, text:x.text?.slice(0,240), publishedAt:x.publishedAt})), null, 2)}
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
