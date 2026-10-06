# Visual system

## Общий принцип

Визуал должен выглядеть как контент сильного современного бренда, а не как случайная нейросетевая картинка. Один визуал = одна мысль + одна эмоция. Если смысл можно показать проще — показывать проще.

### Правило остановки взгляда
Первый кадр/обложка должен быть понятен за 1 секунду:
- один главный объект;
- один сильный контраст;
- чистый фон;
- максимум 2–6 слов текста, если текст вообще нужен;
- никакой попытки «впихнуть весь пост» в изображение.

### Выбор формата
- `image` — сильная статичная сцена;
- `motion` — 5–10 секунд системной анимации;
- `carousel` — 3–5 экранов для последовательного объяснения;
- `mini_reel` — 8–15 секунд, когда движение усиливает идею.

## Motion system

### Визуальный язык
- clean kinetic typography;
- мягкие reveal/mask переходы;
- лёгкий camera push-in / parallax;
- morphing простых форм;
- плавная сборка схем/узлов;
- аккуратные data dots/lines;
- motion blur только очень умеренно;
- 2–4 сцены максимум;
- финальный кадр должен быть чистым и запоминающимся.

### Что запрещено
- бешеные переходы;
- glitch ради glitch;
- 10 объектов одновременно;
- мелкий текст;
- длинные предложения внутри ролика;
- кислотный неон без причины;
- stock-looking corporate animation;
- визуальные клише «AI brain», робот, голографические панели.

### Шаблон motion brief

`Core idea: [ONE IDEA]. First-frame hook: [WHAT STOPS THE EYE]. Duration: 6–10s. Format: 9:16 or 4:5. Scene 1: [simple visual setup]. Scene 2: [single transformation]. Scene 3: [payoff/result]. Motion language: clean kinetic typography, soft masks, subtle parallax, premium easing, minimal objects, elegant lighting. On-screen text: max 2–6 words per scene. No clutter, no fake UI, no generic AI visuals, no noisy transitions.`

## Beauty / lifestyle direction

### Арт-направление
- tactile luxury;
- стекло, металл, перламутр, кремовые текстуры;
- macro beauty;
- мягкий directional light;
- clean premium composition;
- кожа/волосы/упаковка как главный объект;
- ощущение дорогой beauty-кампании, а не рекламного баннера.

### Motion для beauty
- медленный поворот продукта;
- мягкий световой sweep;
- macro detail → reveal;
- капля/текстура/шелковая поверхность;
- плавное появление одного короткого тезиса;
- finish на чистом hero-shot.

### Текст на экране
Обычно 2–6 слов. Примеры структуры:
- «Клиент вернулся»
- «Не скидка. Система.»
- «Красиво — это мало»
- «Своя база клиентов»

## САНТЕХСИЛА

### Арт-направление
- фотореализм;
- современная квартира/техпомещение;
- аккуратные инженерные трассы;
- правильная геометрия и чистый монтаж;
- крупные планы коллекторов, труб, узлов;
- премиальный предметный свет;
- натуральные материалы и реалистичная фактура;
- минимум визуального шума.

### Motion идеи
- трасса собирается слой за слоем;
- коллекторный узел раскрывается по функциональным зонам;
- water-flow animation по реальной схеме;
- before/after: хаос → аккуратная система;
- «что скрывается за стеной» через clean cutaway.

### Запрещено
- невозможные соединения труб;
- абсурдная геометрия фитингов;
- случайные манометры/краны;
- мокрые/аварийные сцены как постоянный способ запугивания;
- текст, встроенный генератором в картинку;
- логотипы брендов, если модель искажает их.

### Шаблон промпта

`Premium photorealistic editorial image for a professional plumbing engineering company in Moscow. [SUBJECT]. Clean modern apartment engineering cabinet, accurate realistic pipe routing, well-organized manifolds, premium workmanship, architectural lighting, calm confident mood, high-detail materials, realistic proportions, professional DSLR photography, 4:5 vertical composition, clear focal point, negative space in upper third for optional headline. No text, no watermark, no distorted fittings, no impossible pipe connections, no clutter, no flooding, no exaggerated cinematic effects.`

## Системный маркетинг / UDS

### Арт-направление
- premium business editorial;
- современный предприниматель;
- clean data visualization motifs;
- клиентские сегменты, повторные покупки, CRM-потоки;
- тёплый бизнес-контекст: кафе, магазин, салон, услуги;
- tasteful 3D/isometric только когда полезно для объяснения.

### Motion идеи
- один покупатель → база → сегмент → повторное касание → возврат;
- несколько чеков → понятные группы клиентов;
- «поток продаж» превращается в структурированную базу;
- одна хаотичная линия → чистая система;
- один короткий тезис на каждый motion beat.

### Запрещено
- робот в костюме;
- светящийся мозг;
- неоновая голова с микросхемами;
- бесконечные голограммы;
- фальшивые интерфейсы UDS с выдуманными цифрами;
- кричащие «SALE» и купюры.

### Шаблон промпта

`Premium business editorial visual about [TOPIC]. Modern small-business owner using a clear customer-retention system, subtle visual metaphor for customer segments and repeat purchases, sophisticated contemporary brand aesthetic, clean composition, natural light, realistic business environment, restrained data motifs, high-end commercial photography, 4:5 vertical, negative space for optional headline. No text, no logos, no fake dashboards, no robots, no neon AI brain, no money rain.`

## Карточки с текстом

Текст лучше накладывать программно после генерации изображения.

Правила:
- один заголовок до 6 слов;
- крупная типографика;
- не больше одной мысли на карточке;
- safe-area 10% по краям;
- высокий контраст;
- брендовый логотип добавлять отдельным слоем, а не генерировать моделью.

## Выбор формата

- Экспертный пост: фото/реалистичная сцена.
- Простая сильная мысль: image или 5–7s motion.
- Чек-лист: carousel 3–5 экранов.
- Кейс: реальное фото объекта всегда выше генерации.
- Сложная механика: минимальная инфографика или motion.
- Продажа: результат/процесс/человек, а не рекламный баннер.
- Beauty: hero visual или elegant mini-reel; не перегруженная карточка.
