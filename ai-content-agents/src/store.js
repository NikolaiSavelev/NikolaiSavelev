import fs from 'node:fs/promises';
import path from 'node:path';

const DATA_DIR = process.env.DATA_DIR || './data';

async function ensure() {
  await fs.mkdir(DATA_DIR, { recursive: true });
}

async function readJson(name, fallback = []) {
  await ensure();
  const p = path.join(DATA_DIR, name);
  try {
    return JSON.parse(await fs.readFile(p, 'utf8'));
  } catch {
    return fallback;
  }
}

async function writeJson(name, value) {
  await ensure();
  const p = path.join(DATA_DIR, name);
  await fs.writeFile(p, JSON.stringify(value, null, 2), 'utf8');
}

export async function listPending() {
  return readJson('pending.json', []);
}

export async function addPending(item) {
  const items = await listPending();
  items.unshift(item);
  await writeJson('pending.json', items.slice(0, 200));
  return item;
}

export async function updatePending(id, patch) {
  const items = await listPending();
  const idx = items.findIndex(x => x.id === id);
  if (idx === -1) return null;
  items[idx] = { ...items[idx], ...patch };
  await writeJson('pending.json', items);
  return items[idx];
}

export async function getPending(id) {
  const items = await listPending();
  return items.find(x => x.id === id) || null;
}

export async function listHistory(limit = 30) {
  const items = await readJson('history.json', []);
  return items.slice(0, limit);
}

export async function addHistory(item) {
  const items = await readJson('history.json', []);
  items.unshift(item);
  await writeJson('history.json', items.slice(0, 1000));
  return item;
}

// ---------- Content memory: защита от повторов ----------
// Хранит минимум: topic, opening, dramaturgy, mediaType, niche, ctaType, commercialRole, mainThought, phrases.

export async function listMemory(brand, limit = 30) {
  const items = await readJson('content-memory.json', []);
  return items.filter(x => !brand || x.brand === brand).slice(0, limit);
}

export async function addMemory(entry) {
  const items = await readJson('content-memory.json', []);
  items.unshift(entry);
  await writeJson('content-memory.json', items.slice(0, 500));
  return entry;
}

export async function updateMemory(itemId, patch) {
  const items = await readJson('content-memory.json', []);
  const idx = items.findIndex(x => x.itemId === itemId);
  if (idx === -1) return null;
  items[idx] = { ...items[idx], ...patch };
  await writeJson('content-memory.json', items);
  return items[idx];
}

// ---------- Performance analyst ----------

export async function addPerformance(record) {
  const items = await readJson('performance.json', []);
  const idx = items.findIndex(x => x.itemId === record.itemId);
  if (idx === -1) items.unshift(record);
  else items[idx] = { ...items[idx], ...record, updatedAt: new Date().toISOString() };
  await writeJson('performance.json', items.slice(0, 2000));
  return record;
}

export async function listPerformance() {
  return readJson('performance.json', []);
}

// ---------- Реальные медиа от владельца ----------

export async function saveMedia(itemId, buffer, ext = 'jpg') {
  await ensure();
  const dir = path.join(DATA_DIR, 'media');
  await fs.mkdir(dir, { recursive: true });
  const safeId = String(itemId).replace(/[^a-zA-Z0-9-]/g, '');
  const file = path.join(dir, `${safeId}.${ext}`);
  await fs.writeFile(file, buffer);
  return file;
}

export async function readMedia(file) {
  if (!file) return null;
  try {
    return await fs.readFile(file);
  } catch {
    return null;
  }
}

export async function getResearch(brand) {
  const all = await readJson('research.json', {});
  return all[brand] || null;
}

export async function saveResearch(brand, snapshot) {
  const all = await readJson('research.json', {});
  all[brand] = snapshot;
  await writeJson('research.json', all);
  return snapshot;
}
