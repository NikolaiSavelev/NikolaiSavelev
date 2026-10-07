import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import OpenAI from 'openai';
import { listMemory, getResearch, saveResearch } from './store.js';

const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
const ROOT = path.resolve(process.cwd());

export const BRANDS = {
  system_marketing: {
    title: 'Системный маркетинг',
    platform: 'telegram',
    platforms: ['telegram'],
    planFile: 'content-plan-system-marketing.md',
    knowledge: ['knowledge-system-marketing.md', 'knowledge-uds.md', 'knowledge-uds-niches.md'],
    context: 'Бренд: «Системный маркетинг». Платформа: Telegram @biznesss_life. Читатель — владельцы и управляющие B2C-бизнеса. Автор говорит про клиентов, базу, повторные продажи, удержание, сегментацию, AI и автоматизацию. Канал — живой авторский разговор, а не рекламный канал UDS.'
  },
  santehsila: {
    title: 'САНТЕХСИЛА',
    platform: 'max',
    platforms: ['max'],
    planFile: 'content-plan-santehsila.md',
    knowledge: ['knowledge-santehsila.md', 'knowledge-engineering.md'],
    context: 'Бренд: САНТЕХСИЛА. Платформа: MAX. Монтаж инженерной сантехники в Москве и МО. Читатель — владельцы квартир и домов. Автор — мастер, который объясняет инженерку простым языком. Не каталог услуг.'
  }
};

// Пороги quality gate (по редакционному заданию)
const CRITICAL_THRESHOLDS = { humanNaturalness: 9, nonAIStyle: 9, trust: 9, originality: 8 };
const DEFAULT_THRESHOLD = 8;
const MAX_REWRITES = 2;
const AI_MEDIA = new Set(['AI_IMAGE', 'VISUAL_METAPHOR', 'SCHEME', 'INFOGRAPHIC', 'CAROUSEL']);

async function read(name) {
  return fs.readFile(path.join(ROOT, name), 'utf8');
}

function brandConfig(brand) {
  const cfg = BRANDS[brand];
  if (!cfg) throw new Error('Unknown brand');
  return cfg;
}

function safeJson(text) {
  const cleaned = String(text || '').replace(/^```json\s*/i, '').replace(/```\s*$/i, '').trim();
  try {
    return JSON.parse(cleaned);
  } catch {
    const match = cleaned.match(/\{[\s\S]*\}/);
    if (!match) throw new Error(`Model did not return JSON: ${cleaned.slice(0, 200)}`);
    return JSON.parse(match[0]);
  }
}

async function jsonResponse(input, model) {
  let lastError;
  for (let attempt = 0; attempt < 2; attempt++) {
    const response = await client.responses.create({
      model: model || process.env.OPENAI_TEXT_MODEL || 'gpt-5',
      input
    });
    try {
      return safeJson(response.output_text);
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError;
}

// ---------- Знания и промпты ----------

export function extractRole(masterPrompt, role) {
  const re = new RegExp(`## ROLE: ${role}\\s*\\n([\\s\\S]*?)(?=\\n## ROLE: |$)`);
  const match = masterPrompt.match(re);
  if (!match) throw new Error(`Role ${role} not found in master-content-prompt.md`);
  return match[1].trim();
}

export function parsePlan(markdown) {
  const match = markdown.match(/```json\s*([\s\S]*?)```/);
  if (!match) return [];
  return JSON.parse(match[1]);
}

async function loadContext(brand) {
  const cfg = brandConfig(brand);
  const [master, human, media, planMd, ...kb] = await Promise.all([
    read('master-content-prompt.md'),
    read('knowledge-human-writing.md'),
    read('knowledge-media-strategy.md'),
    read(cfg.planFile),
    ...cfg.knowledge.map(f => read(f).catch(() => ''))
  ]);
  return {
    cfg,
    master,
    human,
    media,
    plan: parsePlan(planMd),
    knowledge: kb.filter(Boolean).join('\n\n---\n\n'),
    memory: await listMemory(brand, 30),
    research: await getResearch(brand)
  };
}

// ---------- Similarity check ----------

function words(text = '') {
  return String(text).toLowerCase().replace(/<[^>]+>/g, ' ').match(/[a-zа-яё0-9]+/gi) || [];
}

function shingles(text, n = 3) {
  const w = words(text);
  const set = new Set();
  for (let i = 0; i + n <= w.length; i++) set.add(w.slice(i, i + n).join(' '));
  return set;
}

function jaccard(a, b) {
  if (!a.size || !b.size) return 0;
  let inter = 0;
  for (const x of a) if (b.has(x)) inter++;
  return inter / (a.size + b.size - inter);
}

function topicSet(text) {
  return new Set(words(text).filter(w => w.length > 3));
}

export function similarityCheck(candidate, memory) {
  const issues = [];
  const opening = shingles(candidate.opening || String(candidate.post || '').split('\n')[0], 2);
  const body = shingles(candidate.post || '', 3);
  const topic = topicSet(candidate.topic || '');
  for (const m of memory) {
    const label = `«${(m.topic || '').slice(0, 60)}»`;
    if (jaccard(opening, shingles(m.opening || '', 2)) > 0.5) issues.push(`начало похоже на ${label}`);
    if (m.textSample && jaccard(body, shingles(m.textSample, 3)) > 0.25) issues.push(`текст похож на ${label}`);
    if (jaccard(topic, topicSet(m.topic || '')) > 0.6) issues.push(`тема повторяет ${label}`);
    for (const phrase of m.phrases || []) {
      if (phrase && phrase.length > 15 && String(candidate.post || '').toLowerCase().includes(phrase.toLowerCase())) {
        issues.push(`повтор фразы «${phrase}»`);
      }
    }
  }
  return { similar: issues.length > 0, issues: [...new Set(issues)].slice(0, 5) };
}

function recentPatterns(memory) {
  const last = memory.slice(0, 3);
  return {
    lastNiches: last.map(m => m.niche),
    lastDramaturgy: last.map(m => m.dramaturgy),
    lastMediaTypes: last.map(m => m.mediaType),
    lastCtaTypes: last.map(m => m.ctaType)
  };
}

// ---------- Механические сигналы AI-стиля ----------

export function mechanicalSignals(text = '') {
  const lower = text.toLowerCase();
  const banned = [
    'в современном мире', 'ни для кого не секрет', 'эффективное решение', 'уникальное решение',
    'вывести бизнес на новый уровень', 'наша команда профессионалов', 'индивидуальный подход',
    'хотите увеличить продажи', 'сегодня поговорим', 'давайте разберемся', 'давайте разберёмся',
    'важно понимать', 'подведем итог', 'подведём итог', 'подводя итог', 'в заключение',
    'итак, что мы имеем', 'представьте себе', 'сохраняйте, чтобы не потерять',
    'многие предприниматели сталкиваются', 'вы когда-нибудь задумывались', 'в условиях высокой конкуренции'
  ];
  const bulletCount = (text.match(/(^|\n)\s*[-—•]\s/g) || []).length;
  const numberedCount = (text.match(/(^|\n)\s*\d+[.)]\s/g) || []).length;
  const headingCount = (text.match(/(^|\n)\s*(итог|вывод|что делать|решение|проблема|почему это важно)\s*[:—-]/gi) || []).length;
  const emojiCount = (text.match(/\p{Extended_Pictographic}/gu) || []).length;
  const bannedFound = banned.filter(x => lower.includes(x));
  return {
    bannedPhrase: bannedFound.length > 0,
    bannedFound,
    tooManyBullets: bulletCount >= 5,
    tooManyNumbered: numberedCount >= 4,
    formulaHeadings: headingCount >= 2,
    tooManyEmoji: emojiCount > 3,
    bulletCount,
    numberedCount,
    headingCount,
    emojiCount
  };
}

function mechanicalProblems(signals) {
  const problems = [];
  if (signals.bannedPhrase) problems.push(`AI-штампы: ${signals.bannedFound.join(', ')}`);
  if (signals.tooManyBullets || signals.tooManyNumbered) problems.push('слишком много списков');
  if (signals.formulaHeadings) problems.push('шаблонные подзаголовки «проблема/решение/итог»');
  if (signals.tooManyEmoji) problems.push('больше трёх эмодзи');
  return problems;
}

// ---------- Quality gate ----------

export function qualityGate(review, brief) {
  const reasons = [];
  const scores = review.qualityScores || {};
  for (const [key, min] of Object.entries(CRITICAL_THRESHOLDS)) {
    if (Number(scores[key] || 0) < min) reasons.push(`${key} ${scores[key] ?? 0} < ${min}`);
  }
  for (const key of ['hookStrength', 'usefulness', 'specificity', 'memorability', 'brandFit', 'visualPotential']) {
    if (key === 'visualPotential' && brief.mediaType === 'TEXT_ONLY') continue;
    if (Number(scores[key] || 0) < DEFAULT_THRESHOLD) reasons.push(`${key} ${scores[key] ?? 0} < ${DEFAULT_THRESHOLD}`);
  }
  if (brief.commercialRole === 'none' && Number(review.productPressure || 0) > 4) {
    reasons.push(`productPressure ${review.productPressure} > 4 при commercialRole=none`);
  }
  if ((review.autoRejectReasons || []).length) reasons.push(...review.autoRejectReasons);
  return { passed: reasons.length === 0 && review.editorVerdict === 'APPROVED', reasons };
}

// ---------- Research ----------

export async function refreshResearch(brand) {
  const isSanteh = brand === 'santehsila';
  if (!isSanteh && brand !== 'system_marketing') throw new Error('Unknown brand');

  const discipline = `
Для КАЖДОГО пункта разделяй: fact (подтверждённый факт), source (URL первичного/официального источника), date (дата источника или проверки), confidence (high|medium|low), interpretation (что это значит для контента), recommendation (как использовать), hypothesis (гипотеза автора — отдельно, никогда не выдавать за факт).
Временные сведения (цены, тарифы, акции, функции продукта, возможности платформ MAX/Telegram, интеграции, характеристики производителей, нормы) помечай volatile=true — их нужно перепроверять перед публикацией.
Для тренда — минимум 2 независимых сигнала. Один удачный пост конкурента — не доказательство. Учитывай возраст поста, giveaway-механику, рекламу и размер канала.`;

  const prompt = isSanteh
    ? `Ты — Research Agent инженерной редакции САНТЕХСИЛА (Москва и МО). Выполни свежий веб-поиск по официальным/первичным источникам: водоснабжение, канализация, отопление, коллекторные системы, тёплый пол, защита от протечек, опрессовка, материалы и инструкции производителей (REHAU, VALTEC, STOUT, Oventrop и сопоставимые), официальные нормативные ресурсы. Не выдавай универсальные технические нормы без прямого подтверждения. Не копируй длинные тексты.
${discipline}
Верни ТОЛЬКО JSON: {"checkedAt":"ISO","summary":"...","findings":[{"fact":"...","source":"...","date":"...","confidence":"high|medium|low","volatile":false,"interpretation":"...","recommendation":"...","hypothesis":""}],"contentIdeas":["..."],"warnings":["..."]}.`
    : `Ты — Research Agent по UDS, CRM, retention, loyalty marketing и отраслевым сценариям работы с клиентской базой. Выполни широкий свежий веб-поиск.
Приоритет источников: 1) официальные домены uds.app, help.uds.app, blog.uds.app — для фактов о UDS; 2) публичные страницы компаний *.uds.app — только как подтверждение факта использования; 3) качественные вторичные источники — только для общих маркетинговых практик.
Разделяй уровни: official_core, observed_ecosystem, adjacent_hypothesis. Не утверждай интеграцию с Ozon или другой площадкой без официального подтверждения. Не обещай финансовый результат.
Ниши: retail, beauty, HoReCa, auto, medical/dental, fitness, education, professional services, e-commerce, hospitality, flowers/gifts, pet/grooming, children's centers, local services, marketplace sellers / direct-to-customer.
${discipline}
Верни ТОЛЬКО JSON: {"checkedAt":"ISO","summary":"...","findings":[{"fact":"...","source":"...","date":"...","confidence":"high|medium|low","volatile":false,"evidenceLevel":"official_core|observed_ecosystem|adjacent_hypothesis","interpretation":"...","recommendation":"...","hypothesis":""}],"niches":[{"name":"...","evidenceLevel":"...","evidenceUrls":["..."],"pains":["..."],"usefulSegments":["..."],"applicableMechanics":["..."],"humanHooks":["..."],"visualIdeas":["..."],"warnings":["..."]}],"contentIdeas":["..."],"warnings":["..."]}.`;

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

// ---------- Редакционный pipeline ----------

function pickSlot(plan, memory, slotId) {
  if (slotId) return plan.find(s => s.id === slotId) || null;
  const used = new Set(memory.filter(m => m.status !== 'REJECTED').map(m => m.planSlotId).filter(Boolean));
  return plan.find(s => !used.has(s.id)) || null;
}

function compactMemory(memory) {
  return memory.slice(0, 30).map(m => ({
    topic: m.topic, opening: m.opening, dramaturgy: m.dramaturgy, mediaType: m.mediaType,
    niche: m.niche, ctaType: m.ctaType, commercialRole: m.commercialRole, mainThought: m.mainThought,
    phrases: m.phrases, status: m.status
  }));
}

function knowledgeBlock(ctx) {
  return `HUMAN WRITING RULES:\n${ctx.human}\n\nMEDIA STRATEGY:\n${ctx.media}\n\nBRAND KNOWLEDGE:\n${ctx.knowledge}\n\nLATEST RESEARCH (volatile — перепроверять):\n${ctx.research ? JSON.stringify(ctx.research).slice(0, 12000) : 'нет свежего снимка — не использовать меняющиеся факты'}`;
}

export async function generatePost(brand, options = {}) {
  const ctx = await loadContext(brand);
  const { cfg } = ctx;
  const writerModel = process.env.OPENAI_WRITER_MODEL || process.env.OPENAI_TEXT_MODEL || 'gpt-6-astra';
  const editorModel = process.env.OPENAI_EDITOR_MODEL || process.env.OPENAI_TEXT_MODEL || 'gpt-6-astra';
  const strategistModel = process.env.OPENAI_STRATEGIST_MODEL || editorModel;

  const slot = pickSlot(ctx.plan, ctx.memory, options.slotId);
  const memory = compactMemory(ctx.memory);
  const ownerData = options.ownerData ? String(options.ownerData) : '';
  const kb = knowledgeBlock(ctx);
  const log = [];

  // 1. Strategist — бриф и media decision
  const brief = await jsonResponse(`${extractRole(ctx.master, 'STRATEGIST')}

${cfg.context}
Сегодня: ${new Date().toISOString().slice(0, 10)}.

СЛОТ КОНТЕНТ-ПЛАНА:
${slot ? JSON.stringify(slot, null, 2) : 'Свободных слотов нет — предложи новую тему в духе бренда, отличную от памяти.'}

ДАННЫЕ ВЛАДЕЛЬЦА (если есть — их можно использовать как факты):
${ownerData || 'нет'}

ПОСЛЕДНИЕ ПАТТЕРНЫ: ${JSON.stringify(recentPatterns(ctx.memory))}

CONTENT MEMORY (последние публикации бренда):
${JSON.stringify(memory, null, 2)}

${kb}`, strategistModel);
  log.push({ step: 'strategist', status: brief.status });

  const base = {
    id: crypto.randomUUID(),
    brand,
    platform: cfg.platform,
    platforms: cfg.platforms,
    planSlotId: brief.planSlotId || slot?.id || '',
    writerModel,
    editorModel,
    createdAt: new Date().toISOString(),
    approvedAt: null,
    published: []
  };

  if (brief.status === 'SKIP') {
    return { ...base, status: 'SKIP', topic: brief.topic || slot?.topic || '', editorNotes: brief.skipReason || 'Strategist: нет сильного нового угла', pipelineLog: log };
  }

  // 2–4. Writer → Editor → Fact Checker, с переписыванием с нуля
  let best = null;
  let notes = '';
  for (let attempt = 0; attempt <= MAX_REWRITES; attempt++) {
    const draft = await jsonResponse(`${extractRole(ctx.master, 'WRITER')}

${cfg.context}

БРИФ:
${JSON.stringify(brief, null, 2)}

ДАННЫЕ ВЛАДЕЛЬЦА (единственный допустимый источник личных историй, цифр и кейсов):
${ownerData || 'нет — ничего личного и никаких цифр не придумывать'}

${notes ? `ПРЕДЫДУЩАЯ ВЕРСИЯ ЗАБРАКОВАНА. Замечания:\n${notes}\nНапиши ЗАНОВО с другой сцены и другой конструкцией, не правь старый текст.\n` : ''}
НЕ ПОВТОРЯЙ (content memory):
${JSON.stringify(memory.slice(0, 15), null, 2)}

${kb}`, writerModel);

    const candidate = { ...draft, topic: brief.topic };
    const signals = mechanicalSignals(draft.post || '');
    const similarity = similarityCheck(candidate, ctx.memory);

    const review = await jsonResponse(`${extractRole(ctx.master, 'EDITOR')}

${cfg.context}

БРИФ:
${JSON.stringify(brief, null, 2)}

ЧЕРНОВИК:
${JSON.stringify(draft, null, 2)}

МАШИННЫЕ СИГНАЛЫ: ${JSON.stringify(signals)}
ПРОВЕРКА ПОХОЖЕСТИ: ${JSON.stringify(similarity)}
ДАННЫЕ ВЛАДЕЛЬЦА: ${ownerData || 'нет'}

CONTENT MEMORY:
${JSON.stringify(memory, null, 2)}

HUMAN WRITING RULES:
${ctx.human}`, editorModel);

    const fact = await jsonResponse(`${extractRole(ctx.master, 'FACT_CHECKER')}

ТЕКСТ:
${draft.post}

ДАННЫЕ ВЛАДЕЛЬЦА (считаются подтверждёнными): ${ownerData || 'нет'}
ИСТОЧНИКИ ИЗ БРИФА: ${brief.sourceRequirements || ''}

${kb}`, editorModel);

    const gate = qualityGate(review, brief);
    const problems = [...gate.reasons, ...mechanicalProblems(signals), ...similarity.issues];
    if (!fact.factCheckPassed) problems.push(...(fact.issues || []).map(i => `факт: ${i.claim} — ${i.problem}`));

    const needsOwnerData =
      !ownerData && (review.editorVerdict === 'OWNER_DATA_REQUIRED' || fact.ownerDataRequired || brief.ownerDataRequired);
    const passed = problems.length === 0;
    // Для выбора лучшей версии — средняя оценка, со штрафом за выдуманные факты
    const values = Object.values(review.qualityScores || {}).map(Number).filter(Number.isFinite);
    const score = (values.length ? values.reduce((s, v) => s + v, 0) / values.length : 0) - (fact.factCheckPassed ? 0 : 3);

    log.push({ step: `attempt_${attempt + 1}`, verdict: review.editorVerdict, passed, minScore: score, problems });

    const result = { draft, review, fact, signals, similarity, problems, passed, needsOwnerData, score };
    if (!best || (passed && !best.passed) || (!best.passed && score > best.score)) best = result;
    if (passed || needsOwnerData) {
      best = result;
      break;
    }
    notes = [review.editorNotes, ...problems].filter(Boolean).join('\n- ');
  }

  // 5. Visual / Motion director
  const visual = await jsonResponse(`${extractRole(ctx.master, 'VISUAL_DIRECTOR')}

${cfg.context}

БРИФ (mediaType = ${brief.mediaType}):
${JSON.stringify(brief, null, 2)}

ПОСТ:
${best.draft.post}

MEDIA STRATEGY:
${ctx.media}`, editorModel);
  log.push({ step: 'visual', mediaType: visual.mediaType || brief.mediaType });

  const mediaType = visual.mediaType || brief.mediaType || 'TEXT_ONLY';
  const realMediaRequired = Boolean(visual.realMediaRequired || brief.realMediaRequired || !AI_MEDIA.has(mediaType) && mediaType !== 'TEXT_ONLY');

  let status;
  if (best.needsOwnerData) status = 'OWNER_DATA_REQUIRED';
  else if (best.passed) status = 'APPROVED';
  else status = 'REWRITE';

  const ownerDataRequest = [brief.ownerDataRequest, best.review.ownerDataRequest, best.fact.ownerDataRequest]
    .filter(Boolean).join(' ');

  return {
    ...base,
    status,
    editorVerdict: status === 'APPROVED' ? 'APPROVED' : status === 'OWNER_DATA_REQUIRED' ? 'OWNER_DATA_REQUIRED' : 'REWRITE',
    topic: brief.topic,
    contentPillar: brief.contentPillar,
    businessNiche: brief.businessNiche,
    niche: brief.businessNiche,
    dramaturgy: brief.dramaturgy,
    humanAngle: brief.humanAngle,
    conflict: brief.conflict,
    mainThought: brief.mainThought,
    post: best.draft.post,
    text: best.draft.post,
    hook: best.draft.opening,
    opening: best.draft.opening,
    phrases: best.draft.phrases || [],
    commercialRole: brief.commercialRole,
    cta: best.draft.cta || '',
    ctaType: best.draft.ctaType || 'NONE',
    mediaType,
    visualConcept: visual.visualConcept || '',
    visualPrompt: AI_MEDIA.has(mediaType) ? (visual.visualPrompt || '') : '',
    negativePrompt: visual.negativePrompt || '',
    altText: visual.altText || '',
    motionBrief: visual.motionBrief || '',
    carouselBrief: visual.carouselBrief || '',
    realMediaRequired,
    realMediaBrief: visual.realMediaBrief || '',
    ownerDataRequired: status === 'OWNER_DATA_REQUIRED',
    ownerDataRequest: status === 'OWNER_DATA_REQUIRED' ? (ownerDataRequest || 'Нужны реальные данные владельца для этого поста') : '',
    ownerDataUsed: ownerData,
    factCheckRequired: Boolean(brief.factCheckRequired || best.fact.factCheckRequired),
    sources: best.fact.sources || [],
    factIssues: best.fact.issues || [],
    qualityScores: best.review.qualityScores || {},
    productPressure: best.review.productPressure ?? null,
    editorNotes: [best.review.editorNotes, ...best.problems].filter(Boolean).join(' | '),
    similarityIssues: best.similarity.issues,
    pipelineLog: log
  };
}

export function memoryEntry(item) {
  return {
    itemId: item.id,
    brand: item.brand,
    planSlotId: item.planSlotId,
    status: item.status,
    topic: item.topic,
    opening: item.opening,
    dramaturgy: item.dramaturgy,
    mediaType: item.mediaType,
    niche: item.niche,
    ctaType: item.ctaType,
    commercialRole: item.commercialRole,
    mainThought: item.mainThought,
    phrases: item.phrases || [],
    textSample: String(item.post || '').slice(0, 600),
    createdAt: item.createdAt,
    publishedAt: null
  };
}

export async function generateImage(visualPrompt, negativePrompt = '') {
  const model = process.env.OPENAI_IMAGE_MODEL || 'gpt-image-2';
  // 4:5 для Telegram/MAX; произвольные размеры поддерживают gpt-image-2 и новее
  const size = process.env.OPENAI_IMAGE_SIZE || (/^gpt-image-[2-9]/.test(model) ? '1024x1280' : '1024x1536');
  const prompt = negativePrompt ? `${visualPrompt}\n\nAvoid: ${negativePrompt}` : visualPrompt;
  const result = await client.images.generate({ model, prompt, size });

  const b64 = result.data?.[0]?.b64_json;
  if (!b64) throw new Error('Image API did not return base64 image data');
  return Buffer.from(b64, 'base64');
}
