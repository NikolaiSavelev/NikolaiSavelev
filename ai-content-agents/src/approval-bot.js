// Separate Telegram approval bots per brand.
// system_marketing: TELEGRAM_MARKETING_BOT_TOKEN (fallback: TELEGRAM_BOT_TOKEN)
// santehsila:       TELEGRAM_SANTEH_BOT_TOKEN
// Owner IDs can be brand-specific, with OWNER_CHAT_ID as fallback.

import { getPending, listPending, updatePending, saveMedia, readMedia } from './store.js';

const BRAND_LABEL = {
  system_marketing: 'Системный маркетинг',
  santehsila: 'САНТЕХСИЛА'
};

const STATUS_LABEL = {
  APPROVED: '✅ Редактор одобрил',
  REWRITE: '⚠️ Нужна доработка',
  OWNER_DATA_REQUIRED: '📎 Нужны ваши данные',
  SKIP: '⏭ Стратег пропустил слот'
};

const BOT_DEFS = {
  system_marketing: {
    tokenEnv: 'TELEGRAM_MARKETING_BOT_TOKEN',
    fallbackTokenEnv: 'TELEGRAM_BOT_TOKEN',
    ownerEnv: 'MARKETING_OWNER_CHAT_ID',
    command: 'marketing',
    intro: 'Редакция «Системный маркетинг». Здесь только маркетинг, CRM, UDS, клиентская база, AI и автоматизация.'
  },
  santehsila: {
    tokenEnv: 'TELEGRAM_SANTEH_BOT_TOKEN',
    fallbackTokenEnv: null,
    ownerEnv: 'SANTEH_OWNER_CHAT_ID',
    command: 'santeh',
    intro: 'Редакция «САНТЕХСИЛА». Здесь только сантехника, отопление, водоснабжение, инженерные системы и объекты.'
  }
};

function ids(value = '') {
  return String(value).split(',').map(s => s.trim()).filter(Boolean);
}

function esc(text = '') {
  return String(text).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function draftCard(item, canPublish) {
  const head = [
    `<b>${esc(BRAND_LABEL[item.brand] || item.brand)}</b> · ${esc(STATUS_LABEL[item.status] || item.status)}`,
    `Тема: ${esc(item.topic || '')}`,
    `Форма: ${esc(item.dramaturgy || '—')} · медиа: ${esc(item.mediaType || '—')} · продажа: ${esc(item.commercialRole || '—')}`
  ];

  const scores = item.qualityScores || {};
  if (Object.keys(scores).length) {
    head.push(`Оценки: человечность ${scores.humanNaturalness ?? '?'}, не-AI ${scores.nonAIStyle ?? '?'}, доверие ${scores.trust ?? '?'}, оригинальность ${scores.originality ?? '?'}`);
  }

  const tail = [];
  if (item.ownerDataRequired) {
    tail.push(`📎 <b>Что нужно от вас:</b> ${esc(item.ownerDataRequest)}\nОтветьте на это сообщение текстом с фактами — пост перепишется с ними.`);
  }
  if (item.ownerMediaFile) {
    tail.push('📷 В пост пойдёт ваше реальное фото.');
  } else if (item.realMediaRequired) {
    tail.push(`📷 <b>Лучше реальное фото:</b> ${esc(item.realMediaBrief || item.mediaType)}\nОтветьте на черновик фотографией — она заменит AI-визуал.`);
  }
  if (item.aiImageError) tail.push(`🖼 Визуал не создался: ${esc(item.aiImageError).slice(0, 220)}`);
  if (!canPublish && item.brand === 'santehsila') tail.push('ℹ️ MAX пока не включён для публикации. Черновики и картинки можно готовить отдельно.');
  if (item.status !== 'APPROVED' && item.editorNotes) tail.push(`Редактор: ${esc(item.editorNotes).slice(0, 600)}`);

  const body = esc(item.post || item.text || '');
  const room = 4000 - head.join('\n').length - tail.join('\n\n').length - 40;
  return `${head.join('\n')}\n\n${body.length > room ? `${body.slice(0, Math.max(300, room))}…` : body}\n\n${tail.join('\n\n')}`.trim();
}

function draftKeyboard(item, canPublish) {
  const rows = [];

  if (item.status === 'APPROVED' && canPublish) {
    rows.push([
      { text: '✅ Опубликовать', callback_data: `pub:${item.id}` },
      { text: '📝 Без картинки', callback_data: `txt:${item.id}` }
    ]);
  } else if (item.status === 'REWRITE') {
    rows.push([{ text: '✅ Всё равно одобрить', callback_data: `force:${item.id}` }]);
  }

  if (item.visualPrompt) rows.push([{ text: '🖼 Другая картинка', callback_data: `img:${item.id}` }]);

  rows.push([
    { text: '🔄 Другой текст', callback_data: `regen:${item.id}` },
    { text: '❌ Отклонить', callback_data: `rej:${item.id}` }
  ]);

  return { inline_keyboard: rows };
}

function createBrandBot(brand, deps) {
  const def = BOT_DEFS[brand];
  const token = process.env[def.tokenEnv] || (def.fallbackTokenEnv ? process.env[def.fallbackTokenEnv] : '');
  const ownerIds = ids(process.env[def.ownerEnv] || process.env.OWNER_CHAT_ID || '');
  const enabled = Boolean(token && ownerIds.length);
  const isOwner = id => ownerIds.includes(String(id));
  const info = {
    brand,
    tokenEnv: token ? (process.env[def.tokenEnv] ? def.tokenEnv : def.fallbackTokenEnv) : def.tokenEnv,
    username: null,
    ownerReachable: null,
    lastPollOk: null,
    lastPollError: null
  };

  async function tg(method, body) {
    if (!token) throw new Error(`${def.tokenEnv} is not configured`);
    const res = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });
    const json = await res.json();
    if (!json.ok) {
      const error = new Error(`Telegram ${method}: ${json.description}`);
      error.code = json.error_code;
      throw error;
    }
    return json.result;
  }

  async function tgPhoto(chatId, buffer) {
    const form = new FormData();
    form.append('chat_id', String(chatId));
    form.append('photo', new Blob([buffer], { type: 'image/jpeg' }), 'draft.jpg');
    const res = await fetch(`https://api.telegram.org/bot${token}/sendPhoto`, { method: 'POST', body: form });
    const json = await res.json();
    if (!json.ok) throw new Error(`Telegram sendPhoto: ${json.description}`);
    return json.result;
  }

  async function say(chatId, text) {
    return tg('sendMessage', { chat_id: chatId, text, disable_web_page_preview: true })
      .catch(error => console.error(`${brand.toUpperCase()}_BOT_SEND_FAILED`, error.message));
  }

  async function notifyOwner(item) {
    if (!enabled || !item || item.brand !== brand || item.status === 'SKIP') return;
    const canPublish = item.brand !== 'santehsila' || deps.maxEnabled();

    for (const chatId of ownerIds) {
      try {
        const image = (await readMedia(item.ownerMediaFile)) || (await readMedia(item.aiImageFile));
        if (image) await tgPhoto(chatId, image).catch(error => console.error(`${brand.toUpperCase()}_BOT_PHOTO_FAILED`, error.message));

        const msg = await tg('sendMessage', {
          chat_id: chatId,
          text: draftCard(item, canPublish),
          parse_mode: 'HTML',
          disable_web_page_preview: true,
          reply_markup: draftKeyboard(item, canPublish)
        });

        await updatePending(item.id, {
          ownerMessage: { chatId, messageId: msg.message_id, brand, botUsername: info.username || null }
        });
      } catch (error) {
        console.error(`${brand.toUpperCase()}_BOT_NOTIFY_FAILED`, error.message);
      }
    }
  }

  async function findByReply(message) {
    const replyId = message.reply_to_message?.message_id;
    if (!replyId) return null;
    const items = await listPending();
    return items.find(x =>
      x.brand === brand &&
      x.ownerMessage?.messageId === replyId &&
      String(x.ownerMessage?.chatId) === String(message.chat.id)
    ) || null;
  }

  function background(chatId, label, fn) {
    say(chatId, label);
    fn().catch(error => {
      console.error(`${brand.toUpperCase()}_BOT_BACKGROUND_FAILED`, error);
      say(chatId, `Ошибка: ${error.message}`);
    });
  }

  function generate(chatId, options = {}) {
    background(chatId, '✍️ Стратег → автор → редактор → факт-чекер → визуальный директор. Готовлю черновик и картинку…', async () => {
      const item = await deps.runBrand(brand, options);
      if (item.status === 'SKIP') await say(chatId, `Стратег пропустил: ${item.editorNotes || 'нет сильного нового угла'}`);
    });
  }

  async function onCallback(cb) {
    const chatId = cb.message?.chat?.id;
    if (!isOwner(cb.from?.id)) return tg('answerCallbackQuery', { callback_query_id: cb.id, text: 'Нет доступа' });

    const [action, id] = String(cb.data || '').split(':');
    await tg('answerCallbackQuery', { callback_query_id: cb.id }).catch(() => {});

    const item = await getPending(id);
    if (!item || item.brand !== brand) return say(chatId, 'Черновик этого бота не найден.');
    if (item.published?.length) return say(chatId, 'Этот пост уже опубликован.');

    const removeButtons = () => tg('editMessageReplyMarkup', {
      chat_id: chatId,
      message_id: cb.message.message_id,
      reply_markup: { inline_keyboard: [] }
    }).catch(() => {});

    if (action === 'pub' || action === 'txt' || action === 'force') {
      if (brand === 'santehsila' && !deps.maxEnabled()) {
        return say(chatId, 'MAX пока выключен. Черновик сохранён, но публикацию я не запускаю.');
      }
      await removeButtons();
      background(chatId, '⏳ Публикую…', async () => {
        let current = await updatePending(item.id, {
          approvedAt: new Date().toISOString(),
          ...(action === 'force' ? { status: 'APPROVED', ownerOverride: true } : {})
        });
        current = await deps.publishItem(current, { textOnly: action === 'txt' });
        const where = (current.published || []).map(p => p.platform).join(', ');
        await say(chatId, `✅ Опубликовано: ${where}`);
      });
      return;
    }

    if (action === 'img') {
      await removeButtons();
      background(chatId, '🖼 Делаю другой визуал — меняю композицию и ракурс, а не просто повторяю тот же кадр…', async () => {
        const updated = await deps.regenerateImage(item.id);
        await notifyOwner(updated);
      });
      return;
    }

    if (action === 'rej') {
      await removeButtons();
      await updatePending(item.id, { status: 'REJECTED', rejectedAt: new Date().toISOString() });
      await say(chatId, '❌ Отклонено.');
      return;
    }

    if (action === 'regen') {
      await removeButtons();
      await updatePending(item.id, {
        status: 'REJECTED',
        rejectedAt: new Date().toISOString(),
        rejectionReason: 'owner asked for another version'
      });
      generate(chatId, { slotId: item.planSlotId || undefined });
    }
  }

  async function onMessage(message) {
    const chatId = message.chat.id;
    if (!isOwner(message.from?.id)) {
      console.log(`${brand.toUpperCase()}_BOT_FOREIGN_MESSAGE from=${message.from?.id} chat=${chatId}`);
      if (message.chat.type === 'private') {
        await say(chatId, `Это закрытый бот редакции. Ваш Telegram ID: ${message.from?.id}.`);
      }
      return;
    }

    const text = String(message.text || message.caption || '').trim();
    console.log(`${brand.toUpperCase()}_BOT_OWNER_MESSAGE ${String(text || '[media]').slice(0, 60)}`);

    const target = await findByReply(message);
    if (target && message.photo?.length) {
      const file = await tg('getFile', { file_id: message.photo.at(-1).file_id });
      const res = await fetch(`https://api.telegram.org/file/bot${token}/${file.file_path}`);
      const saved = await saveMedia(target.id, Buffer.from(await res.arrayBuffer()));
      const updated = await updatePending(target.id, { ownerMediaFile: saved, ownerMediaAt: new Date().toISOString() });
      await say(chatId, '📷 Фото прикреплено к черновику.');
      if (text) return generate(chatId, { slotId: target.planSlotId || undefined, ownerData: text });
      return notifyOwner(updated);
    }

    if (target && text && !text.startsWith('/')) {
      await updatePending(target.id, { status: 'SUPERSEDED', supersededAt: new Date().toISOString() });
      return generate(chatId, { slotId: target.planSlotId || undefined, ownerData: text });
    }

    if (/^\/(start|help)/.test(text)) {
      return say(chatId, [
        def.intro,
        '',
        '/generate — новый черновик + картинка',
        '/queue — показать черновики этого направления',
        '/help — помощь',
        '',
        'Можно просто написать тему обычным сообщением — я сразу подготовлю пост именно для этого направления.',
        'Чтобы дать реальные факты или фото — ответьте на сообщение с черновиком.'
      ].join('\n'));
    }

    if (/^\/(generate|marketing|santeh)/.test(text)) return generate(chatId);

    if (/^\/queue/.test(text)) {
      const waiting = (await listPending())
        .filter(x => x.brand === brand && !x.published?.length && ['APPROVED', 'REWRITE', 'OWNER_DATA_REQUIRED'].includes(x.status) && !x.rejectedAt)
        .slice(0, 5);
      if (!waiting.length) return say(chatId, 'Очередь этого направления пуста.');
      for (const item of waiting) await notifyOwner(item);
      return;
    }

    if (text && !text.startsWith('/')) {
      return generate(chatId, { topic: text });
    }
  }

  async function poll() {
    let offset = 0;
    while (true) {
      try {
        const updates = await tg('getUpdates', { offset, timeout: 50, allowed_updates: ['message', 'callback_query'] });
        info.lastPollOk = new Date().toISOString();
        info.lastPollError = null;
        for (const update of updates) {
          offset = update.update_id + 1;
          try {
            if (update.callback_query) await onCallback(update.callback_query);
            else if (update.message) await onMessage(update.message);
          } catch (error) {
            console.error(`${brand.toUpperCase()}_BOT_UPDATE_FAILED`, error);
          }
        }
      } catch (error) {
        info.lastPollError = `${new Date().toISOString()} ${error.message}`;
        console.error(`${brand.toUpperCase()}_BOT_POLL_FAILED`, error.message);
        await new Promise(resolve => setTimeout(resolve, error.code === 409 ? 30000 : 5000));
      }
    }
  }

  return {
    brand,
    enabled,
    info,
    notifyOwner,
    async start() {
      if (!enabled) {
        console.log(`${BRAND_LABEL[brand]} approval bot disabled: set ${def.tokenEnv} and ${def.ownerEnv || 'OWNER_CHAT_ID'}`);
        return;
      }

      try {
        info.username = (await tg('getMe', {})).username;
        console.log(`${BRAND_LABEL[brand]} approval bot is @${info.username}`);
      } catch (error) {
        console.error(`${brand.toUpperCase()}_BOT_GETME_FAILED`, error.message);
      }

      for (const chatId of ownerIds) {
        try {
          await tg('getChat', { chat_id: chatId });
          info.ownerReachable = true;
        } catch (error) {
          info.ownerReachable = false;
          console.error(`${brand.toUpperCase()}_BOT_OWNER_UNREACHABLE ${chatId}: ${error.message}`);
        }
      }

      await tg('deleteWebhook', {}).catch(() => {});
      await tg('setMyCommands', {
        commands: [
          { command: 'generate', description: `Новый черновик: ${BRAND_LABEL[brand]}` },
          { command: 'queue', description: 'Черновики на согласовании' },
          { command: 'help', description: 'Как пользоваться' }
        ]
      }).catch(() => {});

      poll();
      console.log(`${BRAND_LABEL[brand]} approval bot started for ${ownerIds.length} owner(s)`);
    }
  };
}

// Backward-compatible export name: index.js does not need to know that there are now two bots.
export function createApprovalBot(deps) {
  const marketing = createBrandBot('system_marketing', deps);
  const santeh = createBrandBot('santehsila', deps);
  const bots = { system_marketing: marketing, santehsila: santeh };

  return {
    enabled: marketing.enabled || santeh.enabled,
    info: {
      mode: 'separate_brand_bots',
      system_marketing: marketing.info,
      santehsila: santeh.info
    },
    async notifyOwner(item) {
      return bots[item?.brand]?.notifyOwner(item);
    },
    start() {
      marketing.start();
      santeh.start();
    }
  };
}
