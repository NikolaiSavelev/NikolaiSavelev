# Production architecture

## Поток

`Cron (Вт/Чт/Сб) → Strategist (план + content memory + media decision) → Writer → Independent Editor → Fact Checker → (до 2 переписываний с нуля) → Visual Director → Pending Queue → Telegram approval → Image generation / owner photo → Publisher → Content memory → Performance`

## Режимы

### Approval mode (по умолчанию)

1. Планировщик создаёт пакет поста.
2. Editor ставит статус.
3. `APPROVED` сохраняется в очередь `pending`.
4. Николай подтверждает через API/будущую CRM-кнопку.
5. Только после подтверждения генерируется финальный визуал и происходит публикация.

Это снижает расходы на ненужные изображения и защищает от случайной публикации.

### Autopilot

После 7–10 дней качественной работы можно установить `APPROVAL_MODE=false`. Тогда статус `APPROVED` публикуется автоматически.

## Данные одного поста

```json
{
  "id": "uuid",
  "brand": "santehsila|system_marketing",
  "platforms": ["max"],
  "topic": "...",
  "funnelStage": "expert|trust|diagnostic|offer",
  "text": "...",
  "visualPrompt": "...",
  "cta": "...",
  "factStatus": "APPROVED",
  "createdAt": "ISO",
  "scheduledFor": "ISO",
  "approvedAt": null,
  "published": []
}
```

## API сервиса

Все, кроме `/health`, требуют `ADMIN_KEY` (заголовок `x-admin-key` или `Authorization: Bearer`).

- `GET /health` — состояние.
- `GET /pending` — очередь на согласование.
- `POST /generate/:brand` — вручную создать пост-пакет.
- `POST /approve/:id` — подтвердить и опубликовать (`{"textOnly":true}` — без картинки).
- `POST /reject/:id` — отклонить.
- `POST /owner-data/:id` — `{"data":"..."}` реальные факты владельца → пост переписывается.
- `POST /media/:id` — `{"imageUrl":"..."}` или `{"imageBase64":"..."}` реальное фото к посту.
- `GET /plan/:brand` — месячный план и какие слоты уже использованы.
- `GET /memory/:brand` — content memory.
- `POST /performance/:id` — метрики поста (views, reach, reactions, comments, forwards, clicks, leads, subscriberDelta).
- `GET /performance-summary` — сводка по mediaType / dramaturgy / contentPillar / commercialRole.

Основной интерфейс владельца — Telegram-бот (`OWNER_CHAT_ID`), см. README.

## Переменные среды

```env
PORT=3000
OPENAI_API_KEY=
OPENAI_TEXT_MODEL=gpt-5
OPENAI_IMAGE_MODEL=gpt-image-2
APPROVAL_MODE=true
DATA_DIR=/data

TELEGRAM_BOT_TOKEN=
TELEGRAM_CHANNEL=@biznesss_life

MAX_ACCESS_TOKEN=
MAX_CHANNEL_ID=

# Cron в timezone сервера; в production лучше выставить TZ=Europe/Moscow
TZ=Europe/Moscow
```

## Расписание

- Системный маркетинг: Вт / Чт / Сб 09:20 — один кандидат.
- СантехСила: Вт / Чт / Сб 10:10 — один кандидат (только при ENABLE_MAX=true).
- Research: воскресенье 07:30 / 07:50.

В approval-mode это очередь черновиков, которые приходят владельцу в Telegram, а не публикации.

## Telegram

Бот должен быть администратором канала с правом публикации. Текст и изображения отправляются через Bot API.

## MAX

Бот должен быть администратором канала с правом `write`. Для изображений используется текущий официальный поток MAX: `POST /uploads?type=image` -> загрузка файла -> `POST /messages?chat_id=...`.

## Хранилище

MVP использует JSONL в `/data`. Для Railway рекомендуется persistent volume. На следующем этапе можно заменить на PostgreSQL без изменения логики агентов.

## Защита от дублей

Перед генерацией Strategist получает последние 30 записей журнала. Он обязан либо предложить новый угол, либо вернуть `SKIP`. Publisher также сохраняет platform message ID и не повторяет успешную отправку.

## Исследование

MVP работает на curated knowledge files в репозитории. Следующий production-слой — scheduled research job, который:
- ищет только разрешённые источники;
- сохраняет URL, дату и выдержку;
- не перезаписывает knowledge автоматически без Editor;
- помечает volatile facts.

Такой подход безопаснее, чем позволить агенту бесконтрольно считать любую найденную страницу правдой.
