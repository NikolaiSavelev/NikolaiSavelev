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

async function jsonResponse(input, model) {
  const response = await client.responses.create({
    model: model || process.env.OPENAI_TEXT_MODEL || 'gpt-5',
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
    'давайте разберёмся',
    'важно понимать',
    'подведем итог',
    'подведём итог',
    'в заключение',
    'итак, что мы имеем'
  ];
  const bulletCount = (text.match(/(^|\n)\s*[-—•]\s/g) || []).length;
  const numberedCount = (text.match(/(^|\n)\s*\d+[.)]\s/g) || []).length;
  const headingCount = (text.match(/(^|\n)\s*(итог|вывод|что делать|решение|проблема|почему это важно)\s*[:—-]/gi) || []).length;
  return {
    bannedPhrase: banned.some(x => lower.includes(x)),
    tooManyBullets: bulletCount >= 4,
    tooManyNumbered: numberedCount >= 3,
    formulaHeadings: headingCount >= 2,
    bulletCount,
    numberedCount,
    headingCount
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

Разделяй ниши по уровням доказательности: official_core, observed_ecosystem, adjacent_hypothesis.
Проверь минимум: retail, beauty, HoReCa, auto, medical/dental, fitness, education, professional services, e-commerce, hospitality, flowers/gifts, pet/grooming, children's centers, local services, marketplace sellers/direct-channel strategy.

Для каждой ниши собери боли, полезные сегменты клиентской базы, подтверждённые механики UDS, сценарии возврата/удержания, идеи человеческих постов, визуальные идеи и ограничения.

Для фактов о UDS используй в первую очередь официальные домены. Любые цены, акции, состав тарифов и меняющиеся условия помечай volatile=true. Не утверждай наличие интеграции с Ozon или другой площадкой без официального подтверждения. Не обещай финансовый результат.

Верни ТОЛЬКО JSON:
{"checkedAt":"ISO","summary":"...","facts":[{"claim":"...","sourceUrl":"...","volatile":false,"note":"..."}],"niches":[{"name":"...","evidenceLevel":"official_core|observed_ecosystem|adjacent_hypothesis","evidenceUrls":["..."],"pains":["..."],"usefulSegments":["..."],"applicableMechanics":["..."],"clientBasePlaybook":["..."],"contentIdeas":["..."],"humanHooks":["..."],"visualIdeas":["..."],"warnings":["..."]}],"crossNicheLessons":["..."],"contentIdeas":["..."],"warnings":["..."]}.`;

  const response = await client.responses.create({
    model: process.env.OPENAI_TEXT_MODEL || 'gpt-5',
    tools: [{ type: 'web_search' }],
    input: prompt
  });

  const parsed = safeJson(response.output_text);
  const snapshot = { ...parsed, checkedAt: parsed.checkedAt || new Date().toISOString(), brand };
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

  const strategistModel = process.env.OPENAI_STRATEGIST_MODEL || process.env.OPENAI_WRITER_MODEL || process.env.OPENAI_TEXT_MODEL || 'gpt-6-astra';
  const writerModel = process.env.OPENAI_WRITER_MODEL || process.env.OPENAI_TEXT_MODEL || 'gpt-6-astra';
  const editorModel = process.env.OPENAI_EDITOR_MODEL || process.env.OPENAI_TEXT_MODEL || 'gpt-6-astra';

  const brandContext = isSanteh
    ? `Бренд: САНТЕХСИЛА. Платформа: MAX. Аудитория: владельцы квартир и домов в Москве и МО. Цель: доверие к инженерному подходу и входящие обращения без превращения канала в каталог услуг.`
    : `Бренд: Системный маркетинг. Платформа: Telegram @biznesss_life. Аудитория: предприниматели и владельцы B2C-бизнеса. Темы: клиентская база, UDS, CRM, повторные продажи, AI и автоматизация. Цель: интересный авторский канал, доверие, диалог и мягкая коммерция.`;

  const recentCompact = recent.slice(0, 20).map(x => ({
    brand: x.brand,
    niche: x.niche,
    topic: x.topic,
    voiceMode: x.voiceMode,
    humanAngle: x.humanAngle,
    commercialRole: x.commercialRole,
    visualType: x.visualType,
    hook: x.hook,
    text: x.text?.slice(0, 360),
    publishedAt: x.publishedAt
  }));

  const knowledge = isSanteh ? kbEng : `${kbUds}\n\nNICHE PLAYBOOK:\n${kbUdsNiches}`;

  // 1) STRATEGIST: chooses what to say and how to say it. Does NOT write the post.
  const strategistPrompt = `
${brandContext}

Ты — ГЛАВНЫЙ РЕДАКТОР-СТРАТЕГ и руководитель всей контент-команды.
Ты работаешь ПЕРВЫМ. Автор не имеет права сам выбирать случайную тему или формулу поста.

Твоя задача — выбрать ОДНУ сильную редакционную идею на сейчас: тему, человеческое напряжение, угол разговора, коммерческую роль и лучший медиаформат.

Ты НЕ пишешь финальный пост. Ты создаёшь редакционное задание для автора и арт-директора.

Главные принципы:
- Канал должен ощущаться как живой автор, а не как контент-машина.
- Не выбирай тему только потому, что она "полезная". Должна быть причина остановиться и прочитать.
- Проверяй последние 20 публикаций: не повторяй тему, конфликт, нишу, voiceMode, визуальную идею или коммерческий ход, если можно найти свежий угол.
- Не строй обязательную воронку хук → боль → решение → CTA.
- Некоторые публикации должны быть просто хорошими мыслями без продажи.
- Для Системного маркетинга UDS не обязан появляться в каждом посте.
- Для САНТЕХСИЛЫ не каждый пост должен заканчиваться призывом заказать монтаж.
- Не придумывай кейсы, личный опыт, цифры, объекты или разговоры.
- Если хорошая тема требует реальной фотографии, объекта или личной истории, поставь ownerDataRequired=true вместо выдумки.
- Если тема требует свежего технического/продуктового факта, поставь factCheckRequired=true.

Выбери voiceMode:
thought_aloud | audience_chat | friendly_argument | mini_story | reaction | observation | playful_diagnostic | confession_without_fake_story | practical_teardown | backstage_note

Выбери commercialRole:
none | trust | soft | direct

Выбери mediaType:
text_only | real_photo | photo_plus_text | ai_image | before_after | carousel | scheme | infographic | screencast | talking_head | backstage_video | mini_reel | motion | visual_metaphor

Верни ТОЛЬКО JSON:
{
  "status":"READY|SKIP|OWNER_DATA_REQUIRED",
  "topic":"короткая тема",
  "niche":"конкретная ниша или cross_niche",
  "evidenceLevel":"official_core|observed_ecosystem|adjacent_hypothesis|cross_niche|engineering",
  "voiceMode":"...",
  "humanAngle":"что человек узнает в себе/своём бизнесе",
  "conflict":"где напряжение или противоречие",
  "coreThought":"одна мысль, которая должна остаться после чтения",
  "audienceContact":"как естественно вступить в контакт с читателем",
  "humorDirection":"какая лёгкая ирония уместна или пустая строка",
  "commercialRole":"none|trust|soft|direct",
  "productRole":"none|background|natural_mention|focus",
  "mediaType":"...",
  "visualConcept":"конкретная идея кадра/ролика, а не общие слова",
  "factCheckRequired":false,
  "ownerDataRequired":false,
  "ownerDataRequest":"что нужно получить от владельца или пустая строка",
  "sourceRequirements":["..."],
  "strategistNote":"почему именно эта идея сейчас и чем она отличается от последних"
}

SYSTEM ROLES:
${agents}

CONTENT PLAN — это пул направлений, а не обязательная последовательность:
${plan}

VISUAL SYSTEM:
${visuals}

KNOWLEDGE:
${knowledge}

LATEST LIVE RESEARCH:
${liveResearch ? JSON.stringify(liveResearch, null, 2) : 'Нет свежего research snapshot. Не опирайся на меняющиеся факты.'}

RECENT HISTORY:
${JSON.stringify(recentCompact, null, 2)}
`;

  const strategy = await jsonResponse(strategistPrompt, strategistModel);

  if (strategy.status === 'SKIP' || strategy.status === 'OWNER_DATA_REQUIRED' || strategy.ownerDataRequired) {
    return {
      id: crypto.randomUUID(),
      brand,
      platforms: isSanteh ? ['max'] : ['telegram'],
      strategistModel,
      writerModel,
      editorModel,
      ...strategy,
      status: strategy.status === 'SKIP' ? 'SKIP' : 'OWNER_DATA_REQUIRED',
      createdAt: new Date().toISOString(),
      approvedAt: null,
      published: []
    };
  }

  // 2) WRITER: receives strategy and writes. It does not invent a new strategy.
  const authorPrompt = `
${brandContext}

Ты — ЖИВОЙ АВТОР канала. Перед тобой редакционное задание главного SMM-стратега.
Не меняй тему на более удобную и не превращай её в стандартную SMM-формулу.

РЕДАКЦИОННОЕ ЗАДАНИЕ:
${JSON.stringify(strategy, null, 2)}

ТЫ НЕ "ПИШЕШЬ КОНТЕНТ".
Ты разговариваешь с людьми. Представь, что пишешь знакомым подписчикам в свой настоящий канал.

Главный критерий: читатель должен чувствовать голос, характер и контакт с ним.
Не "доноси ценность", не "прогревай", не "веди по воронке".

Правила:
- Следуй humanAngle, conflict, coreThought и voiceMode из стратегии.
- Контакт с читателем должен возникнуть естественно, а не только в последнем вопросе.
- Разная длина предложений, живые паузы, короткие реплики разрешены.
- Лёгкая ирония только если она органична. Одна улыбка лучше пяти шуток.
- Не бойся простых слов и недосказанности.
- Не обязан давать CTA. Если commercialRole=none — не подсовывай продажу в финале.
- Если productRole=none/background — не превращай текст в рекламу UDS/услуг.
- Не выдумывай клиента, кейс, цифру, личный опыт, диалог или факт.
- Если стратегия требует факт, которого нет в проверенных данных, верни NEEDS_FACT_CHECK.

ЖЁСТКО ЗАПРЕЩЕНО:
- "Проблема / Решение / Итог / Что делать" как подзаголовки;
- обязательная схема хук → боль → решение → CTA;
- нумерованные инструкции без необходимости;
- одинаковые абзацы одинаковой длины;
- определения терминов как в учебнике;
- "давайте разберёмся", "важно понимать", "в современном мире", "эффективное решение";
- натянутые метафоры и искусственный пафос;
- рекламный блок с перечнем функций продукта;
- банальный вопрос в конце просто ради комментариев.

Проверка: прочитай вслух. Если это похоже на пост SMM-агентства, перепиши с нуля.

Верни ТОЛЬКО JSON:
{
  "status":"APPROVED|NEEDS_FACT_CHECK|REWRITE",
  "hook":"реальные первые 1-2 строки",
  "text":"готовый живой текст",
  "audienceMoment":"лучший момент контакта с читателем",
  "humorMoment":"лёгкий юмористический штрих или пустая строка",
  "cta":"только если органичен, иначе пустая строка",
  "visualType":"${strategy.mediaType}",
  "visualPrompt":"английский промпт для AI image, только если mediaType=ai_image или visual_metaphor; иначе пусто",
  "motionBrief":"конкретный brief, если mediaType=motion|mini_reel|backstage_video; иначе пусто",
  "carouselBrief":"конкретный brief, если mediaType=carousel; иначе пусто",
  "authorNote":"как текст реализует редакционное задание без шаблонности"
}

KNOWLEDGE:
${knowledge}

LATEST LIVE RESEARCH:
${liveResearch ? JSON.stringify(liveResearch, null, 2) : 'Нет свежего research snapshot. Не используй меняющиеся факты.'}
`;

  const draft = await jsonResponse(authorPrompt, writerModel);

  if (['NEEDS_FACT_CHECK', 'REWRITE'].includes(draft.status)) {
    return {
      id: crypto.randomUUID(),
      brand,
      platforms: isSanteh ? ['max'] : ['telegram'],
      strategistModel,
      writerModel,
      editorModel,
      strategy,
      topic: strategy.topic,
      niche: strategy.niche,
      voiceMode: strategy.voiceMode,
      humanAngle: strategy.humanAngle,
      commercialRole: strategy.commercialRole,
      ...draft,
      createdAt: new Date().toISOString(),
      approvedAt: null,
      published: []
    };
  }

  const styleSignals = mechanicalSignals(draft.text);

  // 3) INDEPENDENT EDITOR: can rewrite wording, but must preserve the chosen strategy and facts.
  const editorPrompt = `
Ты — НЕЗАВИСИМЫЙ главный редактор. Ты не автор и не SMM-стратег.
Твоя задача — проверить, что автор реально выполнил стратегию и текст звучит как живой человек, а не как контент-машина.

Бренд: ${isSanteh ? 'САНТЕХСИЛА' : 'Системный маркетинг / UDS / CRM'}.

СТРАТЕГИЯ:
${JSON.stringify(strategy, null, 2)}

ЧЕРНОВИК АВТОРА:
${JSON.stringify(draft, null, 2)}

МАШИННЫЕ СИГНАЛЫ:
${JSON.stringify(styleSignals)}

Первый вопрос: "Я бы поверил, что это человек сам написал в свой Telegram/MAX?"
Второй: "Это действительно тот humanAngle и conflict, который выбрал стратег, или автор скатился в общий полезный пост?"

Если хотя бы один ответ не уверенное "да" — ПЕРЕПИШИ ТЕКСТ С НУЛЯ, сохранив только проверенные факты и стратегический замысел.

Финал должен иметь:
- живой голос и характер;
- реальный контакт с читателем;
- конкретику выбранной ниши;
- разный ритм;
- хотя бы одну запоминающуюся фразу;
- отсутствие рекламного давления, если commercialRole не direct;
- отсутствие выдуманных фактов/кейсов;
- точное попадание в coreThought.

Удалять без сожаления:
- канцелярит;
- очевидные выводы;
- списки ради списка;
- "сначала/далее/итого";
- бизнес-жаргон ради солидности;
- банальные CTA;
- одинаковую структуру с предыдущими текстами;
- красивость ради красивости.

Тест специфичности: если заменить нишу на другую и 70% текста всё ещё работает — перепиши конкретнее.

Оцени строго от 1 до 10:
- naturalness — человеческая речь;
- conversation — реальный контакт с аудиторией;
- specificity — невозможно без изменений перенести в другую нишу;
- value — есть мысль/польза;
- memorability — есть характер и фраза, которая остаётся;
- strategyFit — реализован замысел SMM-стратега, а не случайная формула.

Любая оценка ниже 9 = перепиши ещё раз внутри своей работы. Не показывай промежуточную версию.

Верни ТОЛЬКО JSON:
{
  "status":"APPROVED|REWRITE",
  "hook":"финальные первые строки",
  "text":"финальный текст",
  "audienceMoment":"лучший момент контакта с читателем",
  "humorMoment":"если есть",
  "cta":"только если органичен, иначе пусто",
  "humanScore":{"naturalness":0,"conversation":0,"specificity":0,"value":0,"memorability":0,"strategyFit":0},
  "editorNote":"что пришлось изменить и почему финал соответствует стратегии"
}
`;

  const edited = await jsonResponse(editorPrompt, editorModel);
  const merged = { ...draft, ...edited };
  const finalSignals = mechanicalSignals(merged.text);
  const scores = ['naturalness', 'conversation', 'specificity', 'value', 'memorability', 'strategyFit']
    .map(k => Number(merged.humanScore?.[k] || 0));

  if (merged.status === 'APPROVED' && (
    scores.some(score => score < 9) ||
    finalSignals.bannedPhrase ||
    finalSignals.tooManyBullets ||
    finalSignals.tooManyNumbered ||
    finalSignals.formulaHeadings
  )) {
    merged.status = 'REWRITE';
    merged.editorNote = `${merged.editorNote || ''} Auto-blocked by strategist/editor quality gate.`.trim();
  }

  return {
    id: crypto.randomUUID(),
    brand,
    platforms: isSanteh ? ['max'] : ['telegram'],
    strategistModel,
    writerModel,
    editorModel,
    strategy,
    topic: strategy.topic,
    niche: strategy.niche,
    evidenceLevel: strategy.evidenceLevel,
    voiceMode: strategy.voiceMode,
    humanAngle: strategy.humanAngle,
    conflict: strategy.conflict,
    coreThought: strategy.coreThought,
    commercialRole: strategy.commercialRole,
    productRole: strategy.productRole,
    factCheckRequired: Boolean(strategy.factCheckRequired),
    ownerDataRequired: Boolean(strategy.ownerDataRequired),
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
