import 'dotenv/config';
import express from 'express';
import cron from 'node-cron';
import fs from 'node:fs/promises';
import { generatePost, generateImage, refreshResearch, memoryEntry, parsePlan, BRANDS } from './agents.js';
import { publishTelegram, publishMax, discoverMaxChannel, verifyMaxBot } from './publishers.js';
import { createApprovalBot } from './approval-bot.js';
import {
  addPending, addHistory, getPending, listPending, updatePending,
  addMemory, updateMemory, listMemory, addPerformance, listPerformance, saveMedia, readMedia
} from './store.js';

const app = express();
app.use(express.json({ limit: '1mb' }));

const TZ = process.env.TZ || 'Europe/Moscow';
const approvalMode = () => String(process.env.APPROVAL_MODE || 'true').toLowerCase() !== 'false';
const maxEnabled = () => String(process.env.ENABLE_MAX || 'false').toLowerCase() === 'true';

function requireAdmin(req, res, next) {
  const key = process.env.ADMIN_KEY;
  if (!key) return res.status(503).json({ error: 'ADMIN_KEY must be configured before admin endpoints are exposed' });
  const supplied = req.headers.authorization?.replace(/^Bearer\s+/i, '') || req.headers['x-admin-key'];
  if (supplied !== key) return res.status(401).json({ error: 'Unauthorized' });
  next();
}

async function publishItem(item, options = {}) {
  if (item.status !== 'APPROVED') throw new Error(`Item status is ${item.status}, not APPROVED`);
  if (item.published?.length) return item;

  // MEDIA DECISION: реальное медиа владельца > AI-визуал (только для AI-форматов) > без картинки
  let imageBuffer = await readMedia(item.ownerMediaFile);
  if (!imageBuffer && item.realMediaRequired && !options.textOnly) {
    throw new Error(`Post requires real media (${item.mediaType}). Upload it via POST /media/${item.id} or approve with {"textOnly":true}.`);
  }
  if (!imageBuffer && item.visualPrompt && !options.textOnly) {
    imageBuffer = await generateImage(item.visualPrompt, item.negativePrompt);
  }
  const published = [];

  for (const platform of item.platforms || []) {
    if (platform === 'telegram') {
      const result = await publishTelegram({ text: item.text, imageBuffer });
      published.push({ platform, result, publishedAt: new Date().toISOString() });
    } else if (platform === 'max') {
      if (!maxEnabled()) throw new Error('MAX publishing is disabled. Set ENABLE_MAX=true only when MAX is configured.');
      const result = await publishMax({ text: item.text, imageBuffer });
      published.push({ platform, result, publishedAt: new Date().toISOString() });
    }
  }

  const completed = {
    ...item,
    approvedAt: item.approvedAt || new Date().toISOString(),
    published,
    publishedAt: new Date().toISOString()
  };

  await updatePending(item.id, completed);
  await addHistory(completed);
  await updateMemory(item.id, { status: 'PUBLISHED', publishedAt: completed.publishedAt });
  return completed;
}

async function runBrand(brand, options = {}) {
  if (brand === 'santehsila' && !maxEnabled()) {
    throw new Error('Santehsila/MAX agent is disabled while Telegram-only mode is active');
  }

  const item = await generatePost(brand, options);

  if (item.status === 'SKIP') {
    await addHistory({ ...item, publishedAt: null });
    return item;
  }

  await addPending(item);
  await addMemory(memoryEntry(item));

  if (!approvalMode() && item.status === 'APPROVED') {
    return publishItem({ ...item, approvedAt: new Date().toISOString() });
  }

  await approvalBot.notifyOwner(item);
  return item;
}

const approvalBot = createApprovalBot({ runBrand, publishItem, maxEnabled });

app.get('/health', (_req, res) => {
  res.json({
    ok: true,
    approvalMode: approvalMode(),
    approvalBot: approvalBot.enabled,
    approvalBotInfo: approvalBot.info,
    telegramEnabled: true,
    maxEnabled: maxEnabled(),
    maxTokenConfigured: Boolean(process.env.MAX_ACCESS_TOKEN),
    maxChannelConfigured: Boolean(process.env.MAX_CHANNEL_ID),
    timezone: TZ,
    editorialSystem: 'v2',
    schedule: 'Tue/Thu/Sat',
    now: new Date().toISOString()
  });
});

app.get('/pending', requireAdmin, async (_req, res) => {
  res.json(await listPending());
});

app.get('/max/verify', requireAdmin, async (_req, res) => {
  try {
    res.json(await verifyMaxBot());
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get('/max/discover', requireAdmin, async (_req, res) => {
  try {
    res.json(await discoverMaxChannel());
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post('/research/:brand', requireAdmin, async (req, res) => {
  try {
    if (req.params.brand === 'santehsila' && !maxEnabled()) {
      return res.status(409).json({ error: 'MAX/Santehsila research is disabled in Telegram-only mode' });
    }
    res.json(await refreshResearch(req.params.brand));
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: error.message });
  }
});

app.post('/generate/:brand', requireAdmin, async (req, res) => {
  try {
    const item = await runBrand(req.params.brand);
    res.json(item);
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: error.message });
  }
});

app.post('/approve/:id', requireAdmin, async (req, res) => {
  try {
    const item = await getPending(req.params.id);
    if (!item) return res.status(404).json({ error: 'Not found' });
    if (item.status !== 'APPROVED') return res.status(409).json({ error: `Cannot publish item with status ${item.status}` });
    const marked = await updatePending(item.id, { approvedAt: new Date().toISOString() });
    res.json(await publishItem(marked, { textOnly: Boolean(req.body?.textOnly) }));
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: error.message });
  }
});

app.post('/reject/:id', requireAdmin, async (req, res) => {
  const item = await updatePending(req.params.id, {
    rejectedAt: new Date().toISOString(),
    rejectionReason: req.body?.reason || ''
  });
  if (!item) return res.status(404).json({ error: 'Not found' });
  await updateMemory(item.id, { status: 'REJECTED' });
  res.json(item);
});

// OWNER_DATA_REQUIRED: владелец присылает реальные данные — пост пишется заново с ними
app.post('/owner-data/:id', requireAdmin, async (req, res) => {
  try {
    const item = await getPending(req.params.id);
    if (!item) return res.status(404).json({ error: 'Not found' });
    const data = String(req.body?.data || '').trim();
    if (!data) return res.status(400).json({ error: 'Body must contain {"data":"реальные факты владельца"}' });
    await updatePending(item.id, { status: 'SUPERSEDED', supersededAt: new Date().toISOString() });
    await updateMemory(item.id, { status: 'REJECTED' });
    const next = await runBrand(item.brand, { slotId: item.planSlotId || undefined, ownerData: data });
    if (item.ownerMediaFile && next.id) await updatePending(next.id, { ownerMediaFile: item.ownerMediaFile });
    res.json(next);
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: error.message });
  }
});

// Реальное фото владельца к посту: {"imageUrl":"https://..."} или {"imageBase64":"..."}
app.post('/media/:id', requireAdmin, express.json({ limit: '15mb' }), async (req, res) => {
  try {
    const item = await getPending(req.params.id);
    if (!item) return res.status(404).json({ error: 'Not found' });
    let buffer;
    if (req.body?.imageBase64) buffer = Buffer.from(req.body.imageBase64, 'base64');
    else if (req.body?.imageUrl) {
      const r = await fetch(req.body.imageUrl);
      if (!r.ok) throw new Error(`Cannot download image: ${r.status}`);
      buffer = Buffer.from(await r.arrayBuffer());
    } else return res.status(400).json({ error: 'Provide imageUrl or imageBase64' });
    const file = await saveMedia(item.id, buffer);
    res.json(await updatePending(item.id, { ownerMediaFile: file, ownerMediaAt: new Date().toISOString() }));
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: error.message });
  }
});

app.get('/plan/:brand', requireAdmin, async (req, res) => {
  try {
    const cfg = BRANDS[req.params.brand];
    if (!cfg) return res.status(404).json({ error: 'Unknown brand' });
    const plan = parsePlan(await fs.readFile(cfg.planFile, 'utf8'));
    const memory = await listMemory(req.params.brand, 500);
    const used = new Map(memory.filter(m => m.planSlotId).map(m => [m.planSlotId, m.status]));
    res.json(plan.map(slot => ({ ...slot, usedStatus: used.get(slot.id) || null })));
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get('/memory/:brand', requireAdmin, async (req, res) => {
  res.json(await listMemory(req.params.brand, 30));
});

// Performance analyst: метрики поста после публикации
app.post('/performance/:id', requireAdmin, async (req, res) => {
  const item = await getPending(req.params.id);
  if (!item) return res.status(404).json({ error: 'Not found' });
  const num = k => (req.body?.[k] === undefined ? null : Number(req.body[k]));
  const record = {
    itemId: item.id, brand: item.brand, platform: item.platform, topic: item.topic,
    contentPillar: item.contentPillar, dramaturgy: item.dramaturgy, mediaType: item.mediaType,
    commercialRole: item.commercialRole, niche: item.niche, publishedAt: item.publishedAt || null,
    views: num('views'), reach: num('reach'), reactions: num('reactions'), comments: num('comments'),
    forwards: num('forwards'), clicks: num('clicks'), leads: num('leads'), subscriberDelta: num('subscriberDelta'),
    notes: String(req.body?.notes || ''), recordedAt: new Date().toISOString()
  };
  res.json(await addPerformance(record));
});

app.get('/performance-summary', requireAdmin, async (_req, res) => {
  const rows = await listPerformance();
  const metrics = ['views', 'reactions', 'comments', 'forwards', 'clicks', 'leads'];
  const group = key => {
    const out = {};
    for (const r of rows) {
      const g = r[key] || 'unknown';
      out[g] ??= { posts: 0, ...Object.fromEntries(metrics.map(m => [m, 0])) };
      out[g].posts++;
      for (const m of metrics) out[g][m] += Number(r[m] || 0);
    }
    for (const o of Object.values(out)) {
      const per1000 = v => (o.views ? Math.round((v / o.views) * 10000) / 10 : null);
      o.engagementPer1000 = per1000(o.reactions + o.comments + o.forwards);
      o.commentsPer1000 = per1000(o.comments);
      o.leadsPer1000 = per1000(o.leads);
    }
    return out;
  };
  res.json({
    posts: rows.length,
    note: 'Не оптимизировать только под просмотры: смотреть комментарии, пересылки, обращения и качество диалога.',
    byMediaType: group('mediaType'),
    byDramaturgy: group('dramaturgy'),
    byContentPillar: group('contentPillar'),
    byCommercialRole: group('commercialRole'),
    byBrand: group('brand')
  });
});

// 3 публикации в неделю на бренд: Вт / Чт / Сб. В approval-mode это кандидаты в очередь, не публикации.
cron.schedule('30 7 * * 0', () => refreshResearch('system_marketing').catch(console.error), { timezone: TZ });
cron.schedule('20 9 * * 2,4,6', () => runBrand('system_marketing').catch(console.error), { timezone: TZ });

if (maxEnabled()) {
  cron.schedule('50 7 * * 0', () => refreshResearch('santehsila').catch(console.error), { timezone: TZ });
  cron.schedule('10 10 * * 2,4,6', () => runBrand('santehsila').catch(console.error), { timezone: TZ });
}

const port = Number(process.env.PORT || 3000);
app.listen(port, async () => {
  console.log(`AI Content Agents listening on :${port}; TZ=${TZ}; approval=${approvalMode()}; max=${maxEnabled()}`);
  approvalBot.start();

  if (String(process.env.RESEARCH_ON_START || 'false').toLowerCase() === 'true') {
    try {
      const snapshot = await refreshResearch('system_marketing');
      console.log(`RESEARCH_REFRESH_CREATED ${JSON.stringify({ checkedAt: snapshot.checkedAt, summary: snapshot.summary, niches: snapshot.niches?.map(n => ({ name: n.name, evidenceLevel: n.evidenceLevel })) })}`);
    } catch (error) {
      console.error('RESEARCH_REFRESH_FAILED', error);
    }
  }

  if (String(process.env.TEST_ON_START || 'false').toLowerCase() === 'true') {
    try {
      const item = await runBrand('system_marketing');
      console.log(`TEST_DRAFT_CREATED ${JSON.stringify({ id: item.id, status: item.status, topic: item.topic, text: item.text, visualPrompt: item.visualPrompt })}`);
    } catch (error) {
      console.error('TEST_DRAFT_FAILED', error);
    }
  }

  if (String(process.env.TELEGRAM_TEST_ON_START || 'false').toLowerCase() === 'true') {
    try {
      const text = 'Тест AI-контент агента ✅\n\nСвязка с Telegram работает. Михалыч на связи — следующий шаг: живые полезные посты, визуалы и контент по расписанию.';
      const result = await publishTelegram({ text, imageBuffer: null });
      console.log(`TELEGRAM_TEST_SENT ${JSON.stringify(result)}`);
    } catch (error) {
      console.error('TELEGRAM_TEST_FAILED', error);
    }
  }

  if (String(process.env.MAX_DISCOVER_ON_START || 'false').toLowerCase() === 'true') {
    try {
      const discovery = await discoverMaxChannel();
      console.log(`MAX_DISCOVERY_RESULT ${JSON.stringify(discovery)}`);
    } catch (error) {
      console.error('MAX_DISCOVERY_FAILED', error);
    }
  }
});
