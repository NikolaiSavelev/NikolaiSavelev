import 'dotenv/config';
import express from 'express';
import cron from 'node-cron';
import { generatePost, generateImage, refreshResearch } from './agents.js';
import { publishTelegram, publishMax } from './publishers.js';
import { addPending, addHistory, getPending, listPending, updatePending } from './store.js';

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

async function publishItem(item) {
  if (item.status !== 'APPROVED') throw new Error(`Item status is ${item.status}, not APPROVED`);
  if (item.published?.length) return item;

  const imageBuffer = item.visualPrompt ? await generateImage(item.visualPrompt) : null;
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
  return completed;
}

async function runBrand(brand) {
  if (brand === 'santehsila' && !maxEnabled()) {
    throw new Error('Santehsila/MAX agent is disabled while Telegram-only mode is active');
  }

  const item = await generatePost(brand);

  if (item.status === 'SKIP') {
    await addHistory({ ...item, publishedAt: null });
    return item;
  }

  await addPending(item);

  if (!approvalMode() && item.status === 'APPROVED') {
    return publishItem({ ...item, approvedAt: new Date().toISOString() });
  }

  return item;
}

app.get('/health', (_req, res) => {
  res.json({
    ok: true,
    approvalMode: approvalMode(),
    telegramEnabled: true,
    maxEnabled: maxEnabled(),
    timezone: TZ,
    now: new Date().toISOString()
  });
});

app.get('/pending', requireAdmin, async (_req, res) => {
  res.json(await listPending());
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
    res.json(await publishItem(marked));
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
  res.json(item);
});

cron.schedule('30 7 * * 0', () => refreshResearch('system_marketing').catch(console.error), { timezone: TZ });
cron.schedule('20 9 * * 1-5', () => runBrand('system_marketing').catch(console.error), { timezone: TZ });

if (maxEnabled()) {
  cron.schedule('50 7 * * 0', () => refreshResearch('santehsila').catch(console.error), { timezone: TZ });
  cron.schedule('10 10 * * 1-5', () => runBrand('santehsila').catch(console.error), { timezone: TZ });
}

const port = Number(process.env.PORT || 3000);
app.listen(port, async () => {
  console.log(`AI Content Agents listening on :${port}; TZ=${TZ}; approval=${approvalMode()}; max=${maxEnabled()}`);

  if (String(process.env.TEST_ON_START || 'false').toLowerCase() === 'true') {
    try {
      const item = await runBrand('system_marketing');
      console.log(`TEST_DRAFT_CREATED ${JSON.stringify({ id: item.id, status: item.status, topic: item.topic, text: item.text, visualPrompt: item.visualPrompt })}`);
    } catch (error) {
      console.error('TEST_DRAFT_FAILED', error);
    }
  }
});
