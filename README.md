# Career Assistant

Автоматизация карьерного анализа: от анкеты участника до готового документа с рекомендациями.

## Как это работает

```
Google Form  ──>  Google Apps Script  ──>  Webhook  ──>  Fastify Server
                                                              │
                                                    ┌─────────┴──────────┐
                                                    │  AI Pipeline       │
                                                    │  (4 шага Claude)   │
                                                    └─────────┬──────────┘
                                                              │
                                                     Telegram Bot
                                                  (Review Summary)
                                                      │       │
                                              [Утвердить]  [Правки]
                                                  │           │
                                            Google Doc    Перезапуск
                                            со ссылкой    анализа
```

**Пайплайн анализа (4 шага):**

1. **Profile Extraction** — извлечение структурированного профиля из анкеты и резюме
2. **Direction Generation** — формулировка суперсилы и 3 карьерных направлений
3. **Direction Analysis** — глубокий анализ каждого направления (рынок, конкуренция, AI-риски, план перехода)
4. **Final Compilation** — сборка финального документа для участника

Между шагами 3 и 4 — человеческая проверка через Telegram-бота.

## Быстрый старт (локально)

```bash
# Установить зависимости
npm install

# Скопировать и заполнить .env
cp .env.example .env

# Запустить в dev-режиме (polling для Telegram, hot-reload)
npm run dev
```

**Telegram-бот:** если `APP_URL` задан — работает через webhook; если нет — через long-polling (удобно для локальной разработки).

## Деплой на Render

Сервис работает на [Render](https://render.com) (Web Service, Starter plan).

**Настройки Render:**
- Build Command: `npm install && npm run build`
- Start Command: `npm start`
- Auto-deploy из GitHub при push в `main`

**Что нужно настроить после деплоя:**
1. Добавить все env vars (см. таблицу выше)
2. `APP_URL` — URL сервиса, который Render покажет после создания
3. Расшарить папку с файлами Google Forms сервисному аккаунту (Viewer)

## Google Forms: автоматический триггер

В таблице ответов формы настроен Google Apps Script (`src/scripts/google-apps-script.js`), который при каждом новом ответе отправляет POST-запрос на сервер.

**Настройка:**
1. Google Sheets → Extensions → Apps Script
2. Вставить код из `src/scripts/google-apps-script.js`
3. Заменить `WEBHOOK_URL` и `WEBHOOK_SECRET`
4. Triggers → Add Trigger → `onFormSubmit` → From spreadsheet → On form submit

## Ручной запуск анализа (без формы)

Если данные пришли не через форму (например, из переписки в Telegram), можно отправить webhook вручную:

```bash
curl -X POST "https://<server>/api/webhook/new-participant" \
  -H "Content-Type: application/json" \
  -H "x-webhook-secret: <WEBHOOK_SECRET>" \
  -d '{
    "namedValues": {
      "Timestamp": ["..."],
      "Твой ник в телеграм": ["@username"],
      "Где ты сейчас?": ["Уже в IT, и хочу оставаться в IT"],
      "Какое у тебя гражданство?": ["..."],
      "В какой стране и каком городе ты живешь сейчас?": ["..."],
      "На какую страну или страны ты планируешь работать?": ["..."],
      "Твой идеальный формат работы": ["..."],
      "Чем ты занимаешься сейчас?": ["Работаю в найме"],
      "Кем ты работаешь сейчас и сколько зарабатываешь? (до налогов)": ["..."],
      "Сколько у тебя опыта в текущей профессии?": ["5+ лет опыта"],
      "А сколько хочешь зарабатывать и в какой валюте?": ["..."],
      "А сколько хочешь зарабатывать через 3-5 лет?": ["..."],
      "Какой результат ты хочешь получить от работы с Алисой?": ["..."],
      "Есть ли у тебя уже пожелания или интерес какими направлениями хотелось бы заниматься?": ["..."],
      "Расскажи подробно, почему именно это направление? Что в нем привлекает?": ["..."],
      "Насколько ты готов(а) к переобучению?": ["..."],
      "Сколько времени можешь уделять поиску работы и переквалификации (при необходимости)? В часах в неделю": ["..."],
      "Опиши свою текущую карьерную ситуацию максимально подробно - что не нравится и какой главный затык": ["..."],
      "Какие карьерные цели для тебя наиболее важны в ближайший год? (рост дохода, смена работы, повышение квалификации и т. д.)": ["..."],
      "Были ли уже попытки что-то изменить в текущей ситуации, поменять работу, что-то доучить? Напиши максимально подробно": ["..."],
      "Как ты относишься к рутине? Она тебя успокаивает или угнетает?": ["..."],
      "Ты больше любишь:": ["..."],
      "А какие задачи ты терпеть не можешь?": ["..."],
      "Прикрепи свое резюме в любом формате (можно несколько версий)": [""],
      "Прикрепи ссылку на свой Linkedin (если есть)": ["..."],
      "resumeTextDirect": ["Текст резюме целиком, если нет файла"]
    }
  }'
```

**Ключевое поле:** `resumeTextDirect` — позволяет передать текст резюме напрямую, без загрузки файла из Google Drive. Используй его, когда данные приходят не из формы.

Необязательные поля можно пропустить или оставить пустыми — пайплайн обработает то, что есть.

## API

| Endpoint | Метод | Описание |
|---|---|---|
| `/health` | GET | Проверка что сервер жив |
| `/api/webhook/new-participant` | POST | Webhook для новых анкет (требует `x-webhook-secret`) |
| `/api/participants` | GET | Список всех участников в очереди |
| `/api/participants/:id` | GET | Статус конкретного участника |
| `/api/telegram-webhook` | POST | Telegram webhook (автоматически) |

## Скрипты

```bash
npm run dev        # Разработка (tsx watch, polling)
npm run build      # Сборка (tsc + копирование промптов)
npm start          # Запуск production-билда
npm run typecheck  # Проверка типов без сборки
npm run test:e2e   # Запуск E2E теста на тестовых данных
```

## Рыночные данные (обновлять регулярно!)

Фаза 1A (role-scorer) опирается на `app/data/market-index.json`, который
собирается из двух источников:

- **UK** → `app/src/prompts/market-data/uk_<slug>.md` — itjobswatch.co.uk
  (HTML-парсинг: live jobs, median salary, 2-year trend).
- **RU** → `app/src/prompts/market-data/ru_<slug>.md` — hh.ru search HTML
  (число вакансий на remote) + career.habr.com JSON API (медианы по грейдам
  Middle/Senior/Lead по Москве).

> ⚠️ **`api.hh.ru` без OAuth закрыт** (возвращает 403 / bad_user_agent).
> Поэтому RU-данные снимаются парсингом обычной search-страницы hh.ru
> с браузерным User-Agent. Не пытайся звать api.hh.ru напрямую.

Данные **устаревают** (вакансии и медианы ЗП меняются ежеквартально).
**Обновлять ~раз в квартал** (или при сомнениях в выдаче scorer'а —
если какая-то роль выпала или вылезла неожиданно высоко).

### Как обновить

#### UK (itjobswatch.co.uk)

```bash
# все роли (~3-5 мин):
npx tsx src/scripts/probe-uk-market.ts all

# одна роль:
npx tsx src/scripts/probe-uk-market.ts backend_python
```

Сохраняется в `uk_<slug>.md`. Настройки поиска — в
`ITJW_SEARCH_MAP` внутри `probe-uk-market.ts`: для каждого slug'а `query`
(что искать на itjobswatch) + `filter` (regex, которым отбираем только
релевантные тайтлы из выдачи).

> **ВАЖНО про filter:** он должен быть достаточно узким. Исторический кейс
> `manual_testing`: `\bqa\b` тянул "QA Automation" + "Senior QA Engineer"
> с £55-63k, хотя реальный manual-tester — £30-35k.

#### RU (hh.ru HTML + career.habr.com)

Каждая роль запрашивается отдельно, потому что нужны конкретные
`--spec` (spec_alias Хабра) и опционально `--skill`. Между запросами
к hh пауза 15±5 сек — иначе словим ban.

```bash
# роль с точным habr-алиасом, без skill-фильтра:
npx tsx src/scripts/probe-ru-market.ts --spec=devops --out=devops \
  "DevOps инженер" "DevOps engineer" "DevOps" "SRE" "Platform Engineer" "MLOps"

# роль через spec+skill (бэкенд + python):
npx tsx src/scripts/probe-ru-market.ts --spec=backend --skill=python \
  --out=backend_python "Python разработчик" "Python developer" "Python инженер"

# "размытая" роль с фильтром IT-отрасли (чтобы не цеплять заводы/школы):
npx tsx src/scripts/probe-ru-market.ts --spec=system_admin --it \
  --out=system_admin "Системный администратор" "Sysadmin" "Linux-администратор"

# роль без habr-алиаса (только число вакансий с hh, без зарплат):
npx tsx src/scripts/probe-ru-market.ts --no-habr --out=<slug> "<вариант1>" ...
```

Где взять `--spec`:

- основной список — поле `habrSpec` у каждой роли в
  `src/scripts/build-market-index.ts` (REGISTRY).
- `--skill` — поле `habrSkill` там же.
- Признак "роль размытая, нужен `--it`" — роль из `GENERIC_ROLES` в REGISTRY
  (product_manager, project_manager, manual_testing, marketing_manager,
  system_admin, tech_support_manager и т.п.).

Если Хабр вернул title `"По всем IT-специалистам ..."` — это silent-fallback
(spec_alias не распознан). Скрипт это ловит и помечает зарплату как "—",
чтобы не подмешивать общую IT-статистику в конкретную роль.

#### После скрейпа

```bash
# 1. Пересобрать market-index.json
npx tsx src/scripts/build-market-index.ts

# 2. Sanity-check scorer на продовых юзерах
npx tsx src/scripts/scorer-on-prod.ts
```

### Troubleshooting

- Роль показывает явно завышенную/заниженную UK-ЗП → проверь выдачу
  `uk_<slug>.md`: топ-1 по `Live Now` может оказаться generic-тайтлом, не
  вашей ролью. Чинить через `filter` в `ITJW_SEARCH_MAP`.
- Роль совсем не попадает в scorer-топы в abroad → проверь `vacancies`
  в `market-index.json` для неё. Если очень мало — отсекается hard-filter'ом.
- `probe-ru-market.ts` спамит `403 / 502` → hh включил анти-бот. Подожди
  1-2 минуты, запусти снова. Параллельно запускать скрипт **нельзя** —
  забанят ещё агрессивнее.
