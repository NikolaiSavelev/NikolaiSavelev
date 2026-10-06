async function telegramApi(method, body, multipart = false) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) throw new Error('TELEGRAM_BOT_TOKEN is missing');
  const url = `https://api.telegram.org/bot${token}/${method}`;
  const res = await fetch(url, multipart ? { method: 'POST', body } : {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });
  const json = await res.json();
  if (!res.ok || !json.ok) throw new Error(`Telegram ${method} failed: ${JSON.stringify(json)}`);
  return json.result;
}

export async function publishTelegram({ text, imageBuffer }) {
  const chatId = process.env.TELEGRAM_CHANNEL || '@biznesss_life';
  const published = [];

  if (imageBuffer) {
    const form = new FormData();
    form.append('chat_id', chatId);
    form.append('photo', new Blob([imageBuffer], { type: 'image/png' }), 'post.png');

    if (text.length <= 1000) {
      form.append('caption', text);
      const msg = await telegramApi('sendPhoto', form, true);
      published.push({ type: 'photo', messageId: msg.message_id });
      return published;
    }

    const photo = await telegramApi('sendPhoto', form, true);
    published.push({ type: 'photo', messageId: photo.message_id });
  }

  const msg = await telegramApi('sendMessage', {
    chat_id: chatId,
    text,
    disable_web_page_preview: false
  });
  published.push({ type: 'text', messageId: msg.message_id });
  return published;
}

async function maxRequest(path, options = {}) {
  const token = process.env.MAX_ACCESS_TOKEN;
  if (!token) throw new Error('MAX_ACCESS_TOKEN is missing');
  const res = await fetch(`https://platform-api2.max.ru${path}`, {
    ...options,
    headers: {
      Authorization: token,
      ...(options.headers || {})
    }
  });
  const raw = await res.text();
  let json;
  try { json = JSON.parse(raw); } catch { json = { raw }; }
  if (!res.ok) throw new Error(`MAX request failed ${res.status}: ${raw}`);
  return json;
}

export async function verifyMaxBot() {
  return maxRequest('/me', { method: 'GET' });
}

export async function discoverMaxChannel() {
  const result = await maxRequest('/updates?limit=100&timeout=0&types=bot_added,bot_admin_permissions_changed', { method: 'GET' });
  const updates = Array.isArray(result?.updates) ? result.updates : [];
  const channelUpdates = updates.filter(update => update?.is_channel === true || update?.chat_id);
  const latest = [...channelUpdates].reverse().find(update => update?.chat_id != null);

  return {
    marker: result?.marker ?? null,
    bot: await verifyMaxBot(),
    latestChannelId: latest?.chat_id ?? null,
    latestUpdateType: latest?.update_type ?? null,
    updates: channelUpdates.map(update => ({
      updateType: update?.update_type,
      chatId: update?.chat_id,
      isChannel: update?.is_channel,
      timestamp: update?.timestamp
    }))
  };
}

async function uploadMaxImage(imageBuffer) {
  const init = await maxRequest('/uploads?type=image', { method: 'POST' });
  if (!init.url) throw new Error(`MAX upload URL missing: ${JSON.stringify(init)}`);

  const form = new FormData();
  form.append('data', new Blob([imageBuffer], { type: 'image/png' }), 'post.png');
  const uploadRes = await fetch(init.url, {
    method: 'POST',
    headers: process.env.MAX_ACCESS_TOKEN ? { Authorization: process.env.MAX_ACCESS_TOKEN } : {},
    body: form
  });
  const raw = await uploadRes.text();
  if (!uploadRes.ok) throw new Error(`MAX media upload failed ${uploadRes.status}: ${raw}`);

  let parsed = {};
  try { parsed = JSON.parse(raw); } catch {}

  return init.token
    || parsed.token
    || Object.values(parsed.photos || {})?.[0]?.token
    || Object.values(parsed.photos || {})?.flatMap(x => Object.values(x || {})).find(x => x?.token)?.token;
}

export async function publishMax({ text, imageBuffer }) {
  const chatId = process.env.MAX_CHANNEL_ID;
  if (!chatId) throw new Error('MAX_CHANNEL_ID is missing');

  const body = { text, format: 'markdown' };
  if (imageBuffer) {
    const token = await uploadMaxImage(imageBuffer);
    if (!token) throw new Error('Could not extract MAX media token after upload');
    body.attachments = [{ type: 'image', payload: { token } }];
  }

  const msg = await maxRequest(`/messages?chat_id=${encodeURIComponent(chatId)}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });

  return [{
    type: 'post',
    messageId: msg?.message?.body?.mid || msg?.message?.id || msg?.body?.mid || msg?.id || null,
    link: msg?.message?.link || msg?.link || null
  }];
}
