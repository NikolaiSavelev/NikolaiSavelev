# Production architecture

## Поток

`Scheduler -> Strategist -> Research context -> Copywriter -> Visual Director -> Fact/Brand Editor -> Pending Queue -> Approval -> Image generation -> Publisher -> Analytics log`

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

- `GET /health` — состояние.
- `GET /pending` — очередь на согласование.
- `POST /generate/:brand` — вручную создать новый пост-пакет.
- `POST /approve/:id` — подтвердить и опубликовать.
- `POST /reject/:id` — отклонить.

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

## Расписание MVP

- Системный маркетинг: Пн–Пт 09:20 — генерация одного кандидата.
- СантехСила: Пн–Пт 10:10 — генерация одного кандидата.

Это не означает 10 автоматических публикаций в неделю: в approval-mode это очередь. Стратег может поставить `SKIP`, если тема повторяется или нет достаточно сильного материала.

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
