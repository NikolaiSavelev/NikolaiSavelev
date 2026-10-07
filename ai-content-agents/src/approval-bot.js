// Approval workflow в Telegram: черновики приходят владельцу с кнопками,
// владелец публикует / отклоняет / присылает реальные данные и фото.
// Работает через long polling того же бота, что публикует в канал (TELEGRAM_BOT_TOKEN).
// Только для чатов из OWNER_CHAT_ID (через запятую). Без OWNER_CHAT_ID бот не запускается.

import { getPending, listPending, updatePending, saveMedia } from './store.js';

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
  if (item.realMediaRequired) tail.push(`📷 <b>Нужно реальное фото:</b> ${esc(item.realMediaBrief || item.mediaType)}\nОтветьте на это сообщение фотографией.`);
  if (item.ownerMediaFile) tail.push('📷 Ваше фото прикреплено.');
  else if (item.visualPrompt) tail.push('🖼 Картинка будет нарисована при публикации.');
  if (item.status !== 'APPROVED' && item.editorNotes) tail.push(`Редактор: ${esc(item.editorNotes).slice(0, 600)}`);

  const body = esc(item.post || item.text || '');
  const room = 4000 - head.join('\n').length - tail.join('\n\n').length - 20;
  return `${head.join('\n')}\n\n${body.length > room ? `${body.slice(0, room)}…` : body}\n\n${tail.join('\n\n')}`.trim();
}

function draftKeyboard(item) {
  const rows = [];
  if (item.status === 'APPROVED') {
    const publish = [{ text: '✅ Опубликовать', callback_data: `pub:${item.id}` }];
    if (item.visualPrompt || item.realMediaRequired) publish.push({ text: '📝 Без картинки', callback_data: `txt:${item.id}` });
    rows.push(publish);
  } else if (item.status === 'REWRITE') {
    rows.push([{ text: '✅ Всё равно одобрить', callback_data: `force:${item.id}` }]);
  }
  rows.push([
    { text: '🔄 Другой вариант', callback_data: `regen:${item.id}` },
    { text: '❌ Отклонить', callback_data: `rej:${item.id}` }
  ]);
  return { inline_keyboard: rows };
}

export function createApprovalBot({ runBrand, publishItem, maxEnabled }) {
  const enabled = Boolean(process.env.TELEGRAM_BOT_TOKEN && ownerIds().length);
  const isOwner = id => ownerIds().includes(String(id));

  async function notifyOwner(item) {
    if (!enabled || !item || item.status === 'SKIP') return;
    for (const chatId of ownerIds()) {
      try {
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
    const [action, id] = String(cb.data || '').split(':');
    await tg('answerCallbackQuery', { callback_query_id: cb.id }).catch(() => {});
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
    if (!isOwner(message.from?.id)) return;
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
        'Черновики по расписанию приходят сами (Вт/Чт/Сб утром).',
        'Чтобы дать реальные факты или фото — ответьте на сообщение с черновиком.'
      ].join('\n'));
    }
    if (/^\/marketing/.test(text)) return generate(chatId, 'system_marketing');
    if (/^\/santeh/.test(text)) return generate(chatId, 'santehsila');
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
        console.error('APPROVAL_BOT_POLL_FAILED', error.message);
        await new Promise(r => setTimeout(r, error.code === 409 ? 30000 : 5000));
      }
    }
  }

  return {
    enabled,
    notifyOwner,
    start() {
      if (!enabled) {
        console.log('Approval bot disabled: set OWNER_CHAT_ID (and TELEGRAM_BOT_TOKEN) to receive drafts in Telegram');
        return;
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
