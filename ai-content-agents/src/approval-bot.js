// Approval workflow в Telegram: черновики приходят владельцу с кнопками,
// владелец публикует / отклоняет / присылает реальные данные и фото.
// Работает через long polling того же бота, что публикует в канал (TELEGRAM_BOT_TOKEN).
// Только для чатов из OWNER_CHAT_ID (через запятую). Без OWNER_CHAT_ID бот не запускается.

import { getPending, listPending, updatePending, saveMedia, readMedia } from './store.js';

const BRAND_LABEL = { system_marketing: 'Системный маркетинг (Telegram)', santehsila: 'САНТЕХСИЛА (MAX)' };
const STATUS_LABEL = {
  APPROVED: '✅ Редактор одобрил',
  REWRITE: '⚠️ Редактор не принял ни одну версию — лучшая из попыток',
  OWNER_DATA_REQUIRED: '📎 Нужны ваши данные',
  SKIP: '⏭ Стратег пропустил слот'
};

const ownerIds = () => String(process.env.OWNER_CHAT_ID || '').split(',').map(s => s.trim()).filter(Boolean);

async function tg(method, body) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
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

async function tgPhoto(chatId, buffer, caption = '') {
  const form = new FormData();
  form.append('chat_id', String(chatId));
  form.append('photo', new Blob([buffer], { type: 'image/jpeg' }), 'draft.jpg');
  if (caption) form.append('caption', caption);
  const res = await fetch(`https://api.telegram.org/bot${process.env.TELEGRAM_BOT_TOKEN}/sendPhoto`, { method: 'POST', body: form });
  const json = await res.json();
  if (!json.ok) throw new Error(`Telegram sendPhoto: ${json.description}`);
  return json.result;
}

function esc(text = '') {
  return String(text).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function draftCard(item) {
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
  if (item.ownerDataRequired) tail.push(`📎 <b>Что нужно от вас:</b> ${esc(item.ownerDataRequest)}\nОтветьте на это сообщение текстом с фактами — пост перепишется с ними.`);
  if (item.ownerMediaFile) tail.push('📷 В пост пойдёт ваше фото.');
  else if (item.realMediaRequired) tail.push(`📷 <b>Лучше реальное фото:</b> ${esc(item.realMediaBrief || item.mediaType)}\nОтветьте на это сообщение фотографией — оно заменит картинку. Иначе пойдёт картинка выше.`);
  if (item.aiImageError) tail.push(`🖼 Картинку нарисовать не удалось: ${esc(item.aiImageError).slice(0, 200)}`);
  if (item.status !== 'APPROVED' && item.editorNotes) tail.push(`Редактор: ${esc(item.editorNotes).slice(0, 600)}`);

  const body = esc(item.post || item.text || '');
  const room = 4000 - head.join('\n').length - tail.join('\n\n').length - 20;
  return `${head.join('\n')}\n\n${body.length > room ? `${body.slice(0, room)}…` : body}\n\n${tail.join('\n\n')}`.trim();
}

function draftKeyboard(item) {
  const rows = [];
  if (item.status === 'APPROVED') {
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

export function createApprovalBot({ runBrand, publishItem, maxEnabled, regenerateImage }) {
  const enabled = Boolean(process.env.TELEGRAM_BOT_TOKEN && ownerIds().length);
  const isOwner = id => ownerIds().includes(String(id));
  const topics = new Map();
  let topicSeq = 0;

  async function notifyOwner(item) {
    if (!enabled || !item || item.status === 'SKIP') return;
    for (const chatId of ownerIds()) {
      try {
        const image = (await readMedia(item.ownerMediaFile)) || (await readMedia(item.aiImageFile));
        if (image) await tgPhoto(chatId, image).catch(error => console.error('OWNER_PHOTO_FAILED', error.message));
        const msg = await tg('sendMessage', {
          chat_id: chatId,
          text: draftCard(item),
          parse_mode: 'HTML',
          disable_web_page_preview: true,
          reply_markup: draftKeyboard(item)
        });
        await updatePending(item.id, { ownerMessage: { chatId, messageId: msg.message_id } });
      } catch (error) {
        console.error('OWNER_NOTIFY_FAILED', error.message);
      }
    }
  }

  async function say(chatId, text) {
    return tg('sendMessage', { chat_id: chatId, text, disable_web_page_preview: true }).catch(e => console.error(e.message));
  }

  async function findByReply(message) {
    const replyId = message.reply_to_message?.message_id;
    if (!replyId) return null;
    const items = await listPending();
    return items.find(x => x.ownerMessage?.messageId === replyId && String(x.ownerMessage?.chatId) === String(message.chat.id)) || null;
  }

  // Долгие операции (генерация 1–3 мин.) не блокируют приём обновлений
  function background(chatId, label, fn) {
    say(chatId, label);
    fn().catch(error => {
      console.error(error);
      say(chatId, `Ошибка: ${error.message}`);
    });
  }

  function generate(chatId, brand, options = {}) {
    if (brand === 'santehsila' && !maxEnabled()) return say(chatId, 'САНТЕХСИЛА выключена (ENABLE_MAX=false).');
    background(chatId, '✍️ Редакция работает: стратег → автор → редактор → факт-чекер. Это 1–3 минуты…', async () => {
      const item = await runBrand(brand, options);
      if (item.status === 'SKIP') await say(chatId, `Стратег пропустил: ${item.editorNotes || 'нет сильного нового угла'}`);
    });
  }

  async function onCallback(cb) {
    const chatId = cb.message?.chat?.id;
    if (!isOwner(cb.from?.id)) return tg('answerCallbackQuery', { callback_query_id: cb.id, text: 'Нет доступа' });
    const [action, id, brandArg] = String(cb.data || '').split(':');
    await tg('answerCallbackQuery', { callback_query_id: cb.id }).catch(() => {});
    if (action === 'topic') {
      const topic = topics.get(id);
      if (!topic) return say(chatId, 'Тема устарела — напишите её ещё раз.');
      await tg('editMessageReplyMarkup', { chat_id: chatId, message_id: cb.message.message_id, reply_markup: { inline_keyboard: [] } }).catch(() => {});
      return generate(chatId, brandArg, { topic });
    }
    const item = await getPending(id);
    if (!item) return say(chatId, 'Черновик не найден (возможно, очередь была очищена).');
    if (item.published?.length) return say(chatId, 'Этот пост уже опубликован.');
    const removeButtons = () => tg('editMessageReplyMarkup', { chat_id: chatId, message_id: cb.message.message_id, reply_markup: { inline_keyboard: [] } }).catch(() => {});

    if (action === 'pub' || action === 'txt' || action === 'force') {
      await removeButtons();
      background(chatId, '⏳ Публикую…', async () => {
        let current = await updatePending(item.id, { approvedAt: new Date().toISOString(), ...(action === 'force' ? { status: 'APPROVED', ownerOverride: true } : {}) });
        current = await publishItem(current, { textOnly: action === 'txt' });
        const where = (current.published || []).map(p => p.platform).join(', ');
        await say(chatId, `✅ Опубликовано: ${where}`);
      });
    } else if (action === 'img') {
      await removeButtons();
      background(chatId, '🖼 Рисую другую картинку…', async () => {
        const updated = await regenerateImage(item.id);
        await notifyOwner(updated);
      });
    } else if (action === 'rej') {
      await removeButtons();
      await updatePending(item.id, { status: 'REJECTED', rejectedAt: new Date().toISOString() });
      await say(chatId, '❌ Отклонено.');
    } else if (action === 'regen') {
      await removeButtons();
      await updatePending(item.id, { status: 'REJECTED', rejectedAt: new Date().toISOString(), rejectionReason: 'owner asked for another version' });
      generate(chatId, item.brand, { slotId: item.planSlotId || undefined });
    }
  }

  async function onMessage(message) {
    const chatId = message.chat.id;
    if (!isOwner(message.from?.id)) {
      console.log(`APPROVAL_BOT_FOREIGN_MESSAGE from=${message.from?.id} chat=${chatId}`);
      if (message.chat.type === 'private') {
        await say(chatId, `Это бот редакции. Ваш Telegram ID: ${message.from?.id}. Если вы владелец — добавьте его в OWNER_CHAT_ID на Railway.`);
      }
      return;
    }
    console.log(`APPROVAL_BOT_OWNER_MESSAGE ${String(message.text || '[media]').slice(0, 40)}`);
    const text = String(message.text || message.caption || '').trim();

    const target = await findByReply(message);
    if (target && message.photo?.length) {
      const file = await tg('getFile', { file_id: message.photo.at(-1).file_id });
      const res = await fetch(`https://api.telegram.org/file/bot${process.env.TELEGRAM_BOT_TOKEN}/${file.file_path}`);
      const saved = await saveMedia(target.id, Buffer.from(await res.arrayBuffer()));
      const updated = await updatePending(target.id, { ownerMediaFile: saved, ownerMediaAt: new Date().toISOString() });
      await say(chatId, '📷 Фото прикреплено к черновику.');
      if (text) return generate(chatId, target.brand, { slotId: target.planSlotId || undefined, ownerData: text });
      return notifyOwner(updated);
    }
    if (target && text && !text.startsWith('/')) {
      await updatePending(target.id, { status: 'SUPERSEDED', supersededAt: new Date().toISOString() });
      return generate(chatId, target.brand, { slotId: target.planSlotId || undefined, ownerData: text });
    }

    if (/^\/(start|help)/.test(text)) {
      return say(chatId, [
        'Редакция AI Content Agents.',
        '',
        '/marketing — новый черновик для «Системного маркетинга»',
        '/santeh — новый черновик для САНТЕХСИЛЫ',
        '/queue — черновики, ждущие решения',
        '',
        'Или просто напишите тему поста — бот спросит канал.',
        'Черновики по расписанию приходят сами (Вт/Чт/Сб утром).',
        'Чтобы дать реальные факты или фото — ответьте на сообщение с черновиком.'
      ].join('\n'));
    }
    if (/^\/marketing/.test(text)) return generate(chatId, 'system_marketing');
    if (/^\/santeh/.test(text)) return generate(chatId, 'santehsila');
    if (text && !text.startsWith('/')) {
      // Свободный текст = тема поста от владельца
      const key = String(++topicSeq);
      topics.set(key, text);
      if (topics.size > 50) topics.delete(topics.keys().next().value);
      return tg('sendMessage', {
        chat_id: chatId,
        text: `Тема: «${text.slice(0, 200)}»\nДля какого канала написать пост?`,
        reply_markup: {
          inline_keyboard: [[
            { text: 'Системный маркетинг', callback_data: `topic:${key}:system_marketing` },
            { text: 'САНТЕХСИЛА', callback_data: `topic:${key}:santehsila` }
          ]]
        }
      });
    }
    if (/^\/queue/.test(text)) {
      const waiting = (await listPending()).filter(x => !x.published?.length && ['APPROVED', 'REWRITE', 'OWNER_DATA_REQUIRED'].includes(x.status) && !x.rejectedAt).slice(0, 5);
      if (!waiting.length) return say(chatId, 'Очередь пуста.');
      for (const item of waiting) await notifyOwner(item);
    }
  }

  async function poll() {
    let offset = 0;
    while (true) {
      try {
        const updates = await tg('getUpdates', { offset, timeout: 50, allowed_updates: ['message', 'callback_query'] });
        info.lastPollOk = new Date().toISOString();
        for (const u of updates) {
          offset = u.update_id + 1;
          try {
            if (u.callback_query) await onCallback(u.callback_query);
            else if (u.message) await onMessage(u.message);
          } catch (error) {
            console.error('APPROVAL_BOT_UPDATE_FAILED', error);
          }
        }
      } catch (error) {
        // 409 — тот же бот запущен где-то ещё (например, локальный channel-agent)
        info.lastPollError = `${new Date().toISOString()} ${error.message}`;
        console.error('APPROVAL_BOT_POLL_FAILED', error.message);
        await new Promise(r => setTimeout(r, error.code === 409 ? 30000 : 5000));
      }
    }
  }

  const info = { username: null, ownerReachable: null, lastPollOk: null, lastPollError: null };

  return {
    enabled,
    notifyOwner,
    info,
    async start() {
      if (!enabled) {
        console.log('Approval bot disabled: set OWNER_CHAT_ID (and TELEGRAM_BOT_TOKEN) to receive drafts in Telegram');
        return;
      }
      try {
        info.username = (await tg('getMe', {})).username;
        console.log(`Approval bot is @${info.username}`);
      } catch (error) {
        console.error('APPROVAL_BOT_GETME_FAILED', error.message);
      }
      for (const chatId of ownerIds()) {
        try {
          await tg('getChat', { chat_id: chatId });
          info.ownerReachable = true;
        } catch (error) {
          info.ownerReachable = false;
          console.error(`APPROVAL_BOT_OWNER_UNREACHABLE ${chatId}: ${error.message} — владелец должен нажать /start у @${info.username}`);
        }
      }
      tg('deleteWebhook', {}).catch(() => {});
      tg('setMyCommands', {
        commands: [
          { command: 'marketing', description: 'Черновик: Системный маркетинг' },
          { command: 'santeh', description: 'Черновик: САНТЕХСИЛА' },
          { command: 'queue', description: 'Черновики на согласовании' },
          { command: 'help', description: 'Как пользоваться' }
        ]
      }).catch(() => {});
      poll();
      console.log(`Approval bot started for ${ownerIds().length} owner(s)`);
    }
  };
}
