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

  const writerModel = process.env.OPENAI_WRITER_MODEL || process.env.OPENAI_TEXT_MODEL || 'gpt-6-astra';
  const editorModel = process.env.OPENAI_EDITOR_MODEL || process.env.OPENAI_TEXT_MODEL || 'gpt-6-astra';

  const brandContext = isSanteh
    ? `Бренд: САНТЕХСИЛА. Платформа: MAX. Цель: живое общение с владельцами квартир и доверие к инженерному подходу. Не превращай канал в каталог услуг.`
    : `Бренд: Системный маркетинг. Платформа: Telegram @biznesss_life. Автор говорит с предпринимателями про клиентов, базу, UDS, CRM, повторные продажи, AI и автоматизацию. Канал должен ощущаться как живой авторский разговор, а не корпоративный блог.`;

  const recentCompact = recent.slice(0, 20).map(x => ({
    brand: x.brand,
    niche: x.niche,
    topic: x.topic,
    voiceMode: x.voiceMode,
    hook: x.hook,
    text: x.text?.slice(0, 360),
    publishedAt: x.publishedAt
  }));

  const authorPrompt = `
${brandContext}

ТЫ НЕ КОПИРАЙТЕР, КОТОРЫЙ "ПИШЕТ ПОСТ".
Представь, что у тебя есть настоящий канал и живые подписчики. Ты только что заметил что-то интересное в бизнесе и хочешь этим поделиться. Пиши так, как умный, наблюдательный предприниматель написал бы людям, которых знает давно.

Главный критерий: читатель должен чувствовать, что с ним РАЗГОВАРИВАЮТ.
Не "доносят ценность". Не "прогревают". Не "ведут по воронке". Разговаривают.

НЕ ИСПОЛЬЗУЙ ЕДИНУЮ ФОРМУЛУ.
Не строй каждый текст по схеме: хук → боль → решение → UDS → CTA.
Пусть пост иногда заканчивается на мысли. Иногда на вопросе. Иногда на лёгкой шутке. Иногда вообще без продажи.

Выбери voiceMode, который НЕ похож на последние тексты:
- thought_aloud — мысль вслух, будто автор только что это заметил;
- audience_chat — прямой разговор с подписчиком, можно задать вопрос в середине;
- friendly_argument — дружески поспорить с распространённой привычкой;
- mini_story — короткая сцена или история без выдуманных фактов;
- reaction — реакция на типичную ситуацию в нише;
- observation — наблюдение с неожиданным выводом;
- playful_diagnostic — лёгкая диагностика с юмором;
- confession_without_fake_story — честное мнение/позиция без придуманного личного кейса.

ОБЯЗАТЕЛЬНЫЕ ПРАВИЛА ЖИВОГО ГОЛОСА:
- Пиши не "про аудиторию", а К аудитории.
- В тексте должен быть хотя бы один естественный момент контакта с читателем: вопрос, обращение, "знакомо?", "смотрите", "вот представьте", короткая реплика — но не повторяй одни и те же обороты.
- Допускай незавершённость, короткие реплики, смену ритма, лёгкую иронию.
- Один человеческий смешной штрих лучше пяти шуток.
- Можно слегка спорить с читателем, но без высокомерия.
- Не бойся простых слов. Не надо звучать "экспертно" каждую секунду.
- Иногда одна конкретная бытовая деталь ценнее абзаца аналитики.
- Если фразу можно услышать только на бизнес-конференции, а в обычной речи её никто не говорит — перепиши.

ЖЁСТКО ЗАПРЕЩЕНО:
- заголовки внутри поста вроде "Проблема", "Решение", "Итог", "Что делать";
- нумерованные инструкции без реальной необходимости;
- одинаковые абзацы одинаковой длины;
- определение терминов как в учебнике;
- "давайте разберёмся", "важно понимать", "в современном мире", "эффективное решение";
- обязательный CTA в конце;
- натянутые метафоры;
- выдуманные клиенты, цифры, диалоги, кейсы и личный опыт;
- фраза "UDS помогает..." как автоматический рекламный абзац;
- перечисление функций UDS подряд, если это ломает разговор.

КАК УПОМИНАТЬ UDS:
Только если он естественно появляется в разговоре. Можно вообще не упоминать UDS в конкретном посте, если мысль полезнее без продукта. Канал должен сначала стать интересным, а уже потом продавать.

ЮМОР:
Лёгкий, взрослый, наблюдательный. Не стендап. Не мемник. Например, можно подметить абсурд привычного бизнес-процесса. Не шутить над клиентами, внешностью, возрастом или профессией.

ПРОВЕРКА ПЕРЕД ОТВЕТОМ:
Прочитай текст вслух. Если он звучит как публикация агентства/SMM-щика — перепиши с нуля.
Представь, что ты отправляешь этот текст знакомому предпринимателю в Telegram. Если стало неловко от официальности — перепиши.

Верни ТОЛЬКО JSON:
{
  "status":"APPROVED|NEEDS_FACT_CHECK|SKIP|REWRITE",
  "topic":"коротко",
  "niche":"конкретная ниша или cross_niche",
  "evidenceLevel":"official_core|observed_ecosystem|adjacent_hypothesis|cross_niche",
  "voiceMode":"thought_aloud|audience_chat|friendly_argument|mini_story|reaction|observation|playful_diagnostic|confession_without_fake_story",
  "hook":"реальные первые 1-2 строки",
  "text":"готовый живой текст",
  "audienceMoment":"фраза, где автор реально контактирует с читателем",
  "humorMoment":"лёгкий юмористический штрих или пустая строка",
  "cta":"если действительно нужен, иначе пустая строка",
  "visualType":"image|motion|carousel|mini_reel",
  "visualPrompt":"английский промпт или пустая строка",
  "motionBrief":"brief или пустая строка",
  "carouselBrief":"brief или пустая строка",
  "authorNote":"почему этот текст ощущается разговором, а не шаблоном"
}

SYSTEM ROLES:
${agents}

CONTENT PLAN — используй как источник тем, а не как шаблон текста:
${plan}

VISUAL SYSTEM:
${visuals}

CURATED KNOWLEDGE:
${isSanteh ? kbEng : `${kbUds}\n\nNICHE PLAYBOOK:\n${kbUdsNiches}`}

LATEST LIVE RESEARCH:
${liveResearch ? JSON.stringify(liveResearch, null, 2) : 'Нет свежего research snapshot. Не используй меняющиеся факты.'}

RECENT HISTORY — не копируй ни структуру, ни ритм последних постов:
${JSON.stringify(recentCompact, null, 2)}
`;

  const draft = await jsonResponse(authorPrompt, writerModel);

  if (['SKIP', 'NEEDS_FACT_CHECK'].includes(draft.status)) {
    return {
      id: crypto.randomUUID(), brand, platforms: isSanteh ? ['max'] : ['telegram'],
      writerModel, editorModel, ...draft, createdAt: new Date().toISOString(), approvedAt: null, published: []
    };
  }

  const styleSignals = mechanicalSignals(draft.text);

  const editorPrompt = `
Ты — не корректор. Ты — очень требовательный редактор живого авторского Telegram-канала.
Твоя единственная задача: уничтожить всё, что пахнет шаблонным AI/SMM-текстом, и оставить ощущение настоящего разговора с подписчиками.

Бренд: ${isSanteh ? 'САНТЕХСИЛА' : 'Системный маркетинг / UDS / CRM'}.

ЧЕРНОВИК:
${JSON.stringify(draft, null, 2)}

МАШИННЫЕ СИГНАЛЫ:
${JSON.stringify(styleSignals)}

Сначала мысленно ответь на вопрос: "Я бы поверил, что это человек написал сам в свой Telegram?"
Если ответ не уверенное "да" — ПЕРЕПИШИ С НУЛЯ, сохранив только факты и тему.

Что должно быть в финале:
- ощущение голоса и характера;
- контакт с читателем не только в последней строке;
- разная длина предложений;
- хотя бы одна фраза, которую хочется процитировать/переслать;
- лёгкая естественная ирония, если уместно;
- отсутствие обязанности что-то купить после каждого поста;
- UDS/CRM встроены как часть разговора, а не рекламный блок.

Что удалять без сожаления:
- списки, если это не единственный удобный формат;
- "сначала/далее/итого";
- выводы, которые уже очевидны;
- экспертные слова ради экспертности;
- канцелярит;
- банальные вопросы вроде "А вы работаете со своей базой?";
- искусственные метафоры;
- одинаковую структуру с предыдущими постами;
- красивость ради красивости.

Очень важный тест: если заменить нишу на другую и 70% текста всё ещё работает — текст слишком общий. Перепиши конкретнее.

Оцени строго по 5 критериям от 1 до 10:
- naturalness — это реально человеческая речь;
- conversation — автор действительно общается с аудиторией;
- specificity — текст невозможно без изменений перенести в другую нишу;
- value — есть мысль/польза;
- memorability — есть характер и запоминающаяся фраза.

Любая оценка ниже 9 = перепиши ещё раз внутри своей работы. Не показывай промежуточную версию.

Верни ТОЛЬКО JSON:
{
  "status":"APPROVED|REWRITE",
  "hook":"финальные первые строки",
  "text":"финальный текст",
  "audienceMoment":"лучший момент контакта с читателем",
  "humorMoment":"если есть",
  "cta":"только если органичен, иначе пусто",
  "humanScore":{"naturalness":0,"conversation":0,"specificity":0,"value":0,"memorability":0},
  "editorNote":"почему этот текст теперь ощущается живым"
}
`;

  const edited = await jsonResponse(editorPrompt, editorModel);
  const merged = { ...draft, ...edited };
  const finalSignals = mechanicalSignals(merged.text);
  const scores = ['naturalness', 'conversation', 'specificity', 'value', 'memorability'].map(k => Number(merged.humanScore?.[k] || 0));

  if (merged.status === 'APPROVED' && (
    scores.some(score => score < 9) ||
    finalSignals.bannedPhrase ||
    finalSignals.tooManyBullets ||
    finalSignals.tooManyNumbered ||
    finalSignals.formulaHeadings
  )) {
    merged.status = 'REWRITE';
    merged.editorNote = `${merged.editorNote || ''} Auto-blocked by conversational quality gate.`.trim();
  }

  return {
    id: crypto.randomUUID(),
    brand,
    platforms: isSanteh ? ['max'] : ['telegram'],
    writerModel,
    editorModel,
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
