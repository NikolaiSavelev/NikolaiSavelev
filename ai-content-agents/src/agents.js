import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import OpenAI from 'openai';
import { listHistory } from './store.js';

const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
const ROOT = path.resolve(process.cwd());

async function read(name) {
  return fs.readFile(path.join(ROOT, name), 'utf8');
}

function safeJson(text) {
  const cleaned = text.replace(/^```json\s*/i, '').replace(/```$/i, '').trim();
  return JSON.parse(cleaned);
}

export async function generatePost(brand) {
  const [agents, kbUds, kbEng, plan, visuals, recent] = await Promise.all([
    read('agents.md'),
    read('knowledge-uds.md'),
    read('knowledge-engineering.md'),
    read('content-plan-30-days.md'),
    read('visual-style.md'),
    listHistory(30)
  ]);

  const isSanteh = brand === 'santehsila';
  if (!isSanteh && brand !== 'system_marketing') throw new Error('Unknown brand');

  const brandContext = isSanteh
    ? `Бренд: САНТЕХСИЛА. Платформа: MAX. Цель: заявки на инженерные работы в Москве и МО. Используй engineering KB.`
    : `Бренд: Системный маркетинг. Платформа: Telegram @biznesss_life. Цель: доверие, консультации и мягкая продажа UDS/CRM/автоматизации. Используй UDS KB.`;

  const prompt = `
${brandContext}

Ты работаешь как объединённая редакция из Strategist + Copywriter + Visual Director + Fact Editor.

ВАЖНО:
- Один пост = одна мысль.
- Не повторяй темы/углы из recent history.
- Никаких выдуманных кейсов, отзывов, цен, акций, технических норм и интеграций.
- Если тема требует факта, которого нет в базе, верни status NEEDS_FACT_CHECK.
- Текст живой, профессиональный, по-русски, без AI-штампов.
- Мягкая продажа, без давления.
- Для визуального поста держи основной текст примерно 600–1000 символов, чтобы он хорошо работал в канале.
- Если сегодня нет достаточно сильной темы, можно вернуть status SKIP.

Верни ТОЛЬКО JSON без markdown:
{
  "status":"APPROVED|NEEDS_FACT_CHECK|SKIP",
  "topic":"короткая тема",
  "funnelStage":"expert|trust|diagnostic|offer",
  "text":"готовый пост",
  "cta":"короткий CTA или пустая строка",
  "visualPrompt":"готовый промпт для изображения на английском, 4:5, без текста",
  "editorNote":"почему одобрено/что надо проверить"
}

SYSTEM ROLES:
${agents}

CONTENT PLAN:
${plan}

VISUAL SYSTEM:
${visuals}

RELEVANT KNOWLEDGE:
${isSanteh ? kbEng : kbUds}

RECENT HISTORY:
${JSON.stringify(recent.map(x => ({brand:x.brand, topic:x.topic, text:x.text?.slice(0,240), publishedAt:x.publishedAt})), null, 2)}
`;

  const response = await client.responses.create({
    model: process.env.OPENAI_TEXT_MODEL || 'gpt-5',
    input: prompt
  });

  const draft = safeJson(response.output_text);
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
