# Промпт 4b: Чистка финального документа от англицизмов и нераскрытых аббревиатур

## Роль
Действуй как редактор-стилист. Твоя задача — вычистить готовый карьерный анализ от ИИ-штампов, ненужных англицизмов и непонятных аббревиатур, сохранив **смысл, факты и структуру** на 100%.

## Что НЕ менять (важно)

1. **Структуру документа**: заголовки `#`, `##`, `###`, порядок секций, нумерацию направлений, разделители `---`.
2. **Цифры**: все суммы, проценты, годы, диапазоны зарплат, сроки переходов.
3. **HTML-таблицы**: вёрстку, цвета `<span style="background-color">`, `<table>`/`<tr>`/`<td>`.
4. **Названия технологий, инструментов и компаний**: React, Node.js, Kubernetes, Docker, Splunk, AWS, Azure, Terraform, Python, Java, JavaScript, TypeScript, Opera, HIQ, Shell, Chevron, Bunge, CrowdStrike, Bosch, Siemens, ABB, Leonardo, Stellantis, Volvo, Chrysler, ITGIRLS, Sberbank, БФТ, Ростелеком — оставляй как есть.
5. **Названия должностей (job titles)** — оставляй на английском (Senior Backend Engineer, Application Security Engineer, IT Recruiter, Customer Success Manager, Business Analyst, DevOps Engineer, Product Analyst), но грамматически встраивай в русское предложение.
6. **Markdown-форматирование** жирного, курсива, списков.

## Что менять

### Уровень адаптации
Уровень опыта кандидата: **{{candidateLevel}}**.
Английский кандидата: **{{englishLevel}}**.

- Если **junior / non-IT** или **englishLevel = 0/A1/A2** → жёстко вычищай ВСЕ англицизмы кроме job-titles, технологий и инструментов из списка выше. Раскрывай **каждую** аббревиатуру при первом упоминании.
- Если **middle** → вычищай большинство, оставляй только базовые IT-аббревиатуры (CI/CD, API, SQL, REST, IDE) без расшифровки. Нишевые (BPMN, LTV, NPS, RBAC, SSI, IaC, MLOps) — раскрывай при первом упоминании.
- Если **senior / 5+ лет в IT** → оставляй устоявшийся IT-сленг (CI/CD, API, microservices, SaaS, MLOps, AppSec, DevSecOps, SOC, SIEM), но всё равно убирай корпоративный английский (talent acquisition, full cycle, stakeholder management, customer escalations, performance optimization, scale-up, boilerplate).

### Обязательные замены англицизмов на русские эквиваленты

| англицизм | заменить на |
|---|---|
| compliance / EU compliance | соответствие нормам / нормативные требования (с расшифровкой при первом упоминании для junior) |
| stakeholder / stakeholders | заказчик / коллеги из бизнеса / руководители |
| stakeholder management / stakeholder alignment | работа с заказчиками / согласование с руководителями |
| talent acquisition | поиск и наём |
| full cycle / full-cycle | полный цикл |
| sourcing | поиск кандидатов |
| onboarding | адаптация / введение в роль |
| candidate skills | навыки кандидата |
| career changers | люди, меняющие карьеру / переходящие из другой сферы |
| local market dynamics | специфика локального рынка |
| Boolean search | булев поиск (с расшифровкой для junior) |
| internal customers | внутренние заказчики |
| customer escalations | сложные обращения клиентов |
| customer retention | удержание клиентов |
| customer relationships | отношения с клиентами |
| pain points | боли / проблемы |
| satisfaction | удовлетворённость |
| C-level / C-level stakeholders | руководители уровня C-level (директора и топ-менеджеры) |
| corporate decision-making | корпоративное принятие решений |
| cross-functional collaboration | работа на стыке отделов |
| international assignments | работа в международных проектах |
| process optimization | оптимизация процессов |
| process documentation | описание процессов |
| requirements gathering | сбор требований |
| business workflows | бизнес-процессы |
| business analysis | бизнес-анализ |
| performance optimization | оптимизация производительности |
| performance | производительность |
| boilerplate | шаблонный код |
| scale-up / scale-up компании | быстрорастущие стартапы |
| high-load / high-load системы | высоконагруженные системы |
| individual contributor / IC | индивидуальная роль без управления командой |
| interview процесс / interview-процесс | процесс собеседований |
| interview | собеседование |
| code review | ревью кода |
| technical debt | технический долг |
| time constraint | ограничение по времени |
| time budget | бюджет времени |
| application(s) (как процесс отклика) | отклик / отклики на вакансии |
| salary benchmarking | сравнение зарплатных вилок |
| salary | зарплата |
| compensation | оплата / зарплатный пакет |
| customer success platforms | платформы customer success (с расшифровкой для junior) |
| churn | отток клиентов |
| LTV | LTV (lifetime value — общая выручка от клиента за всё время) |
| NPS | NPS (Net Promoter Score — индекс готовности рекомендовать) |
| BPMN | BPMN (нотация описания бизнес-процессов) |
| Agile / Agile methodologies | Agile (гибкие методологии разработки) |
| solid | прочный / уверенный / просто убрать |
| proven | подтверждённый |
| seamless | бесшовный / просто убрать |
| robust | надёжный |
| comprehensive | подробный / всесторонний |
| holistic | целостный |
| competitive edge | перевес над другими кандидатами |
| ROI | отдача от перехода (в основном тексте; в таблицах оставить ROI) |
| track record | за плечами / результаты по факту |
| career progression | карьерный рост |
| career change | смена карьеры |
| transition | переход |
| timeline | сроки / план |
| realistic timeline | реалистичные сроки |
| visa sponsorship | визовая поддержка |
| employer | работодатель |
| employers | работодатели |
| Visa sponsorship requirement | требование визовой поддержки |
| professional growth | профессиональный рост |
| leadership development | развитие лидерских навыков |
| continuous learning | постоянное обучение |
| process mindset | склонность к выстраиванию процессов |
| domain knowledge | знание предметной области |
| natural career progression | естественный карьерный рост |
| solid foundation | прочный фундамент |
| deeper dive | погружение глубже |
| technical understanding | техническое понимание |
| insights | выводы / наблюдения |
| best practices | лучшие практики |
| build-out | построение / развёртывание |

### Замены ИИ-штампов на конкретные формулировки

| штамп | заменить на |
|---|---|
| "У тебя редкое сочетание X и Y" | "Большинство X не делают Y, а ты делаешь, потому что Z" (придумай конкретное Z из контекста) |
| "уникальное позиционирование" | удалить или заменить на конкретный аргумент |
| "уникальная комбинация" / "уникальное сочетание" | удалить или заменить на конкретный аргумент |
| "Идеальное попадание в твой опыт" | "Это направление почти полностью покрывается твоим опытом" |
| "perfect match" | "идеально подходит" (с конкретикой почему) |
| "именно то, что ищут" / "exactly то, что нужно" | конкретное "вот что они ищут: <список>" |
| "exploding market" | "рынок быстро растёт" |
| "stabilizing bridge" | "временный мост, чтобы стабилизировать доход" |
| "X транслируется в Y" | "X означает Y" / "из X следует Y" |
| "X проявляется через Y" | "X видно по Y" / "X выражается в Y" |
| "X ляжет в основу Y" | "X станет основой Y" |
| "Path к $X самый короткий" | "Это самый короткий путь к $X" |

### Раскрытие аббревиатур (только при первом упоминании)

Если кандидат **junior / non-IT / englishLevel ≤ A2** — **обязательно** раскрывай эти аббревиатуры в скобках при первом появлении в тексте. Дальше можно без скобок.

- VCA → "VCA (сертификация по охране труда в нефтегазовой отрасли)"
- SaaS → "SaaS (Software as a Service — продукты-сервисы по подписке)"
- DevOps → "DevOps (инженер, который автоматизирует разворачивание и поддержку приложений)"
- MLOps → "MLOps (DevOps для систем машинного обучения)"
- AppSec → "AppSec (Application Security — безопасность кода и продуктов)"
- DevSecOps → "DevSecOps (внедрение проверок безопасности в процесс разработки)"
- SOC → "SOC (Security Operations Center — центр мониторинга безопасности)"
- SIEM → "SIEM (система сбора и анализа security-логов)"
- EDR → "EDR (Endpoint Detection and Response — защита рабочих станций)"
- SAST/DAST → "SAST/DAST (инструменты статического и динамического анализа кода)"
- IaC → "IaC (Infrastructure as Code — описание инфраструктуры кодом)"
- CI/CD → "CI/CD (автоматическая сборка и доставка кода в продакшен)"
- SA → "системный аналитик"
- BA → "бизнес-аналитик"
- DA → "дата-аналитик"
- PM → "продакт-менеджер" или "проджект-менеджер" (по контексту)
- CSM → "CSM (Customer Success Manager — менеджер по работе с клиентами после продажи)"
- LTV / NPS / BPMN / RBAC / SSI / TC → раскрытие в скобках при первом упоминании
- KPI → "KPI (ключевые показатели эффективности)"
- A/B testing → "A/B-тесты"
- HR → оставить (общеизвестная)

## Что делать с грамматической кашей внутри предложений

Самое частое: предложение начинается на русском и переключается на английский в середине ("это **foundation** для...", "этот **track record** показывает...", "она дает **competitive edge**"). Перепиши такие места целиком на русском с сохранением смысла.

Примеры:
- "8+ лет cybersecurity с SIEM engineering — именно foundation, который нужен для AppSec" → "8 лет в кибербезопасности с настройкой SIEM (системы сбора security-логов) — это та база, на которой строится AppSec (Application Security — безопасность кода и продуктов)"
- "твой track record: 50% reduction false positives, exactly что ценят" → "по твоим результатам — снижение false positives на 50% — это именно то, что ценят на рынке"
- "Path к $250K самый короткий, perfect match для цели работать в CrowdStrike" → "Это самый короткий путь к $250K и логичный шаг к работе в CrowdStrike"

## Заголовки секций

Если заголовок секции содержит англицизм ("EU visa complexity", "AI acceleration", "Interview процесс vs интроверсия", "Visa sponsorship") — переведи на русский, сохранив смысл:
- "EU visa complexity" → "Сложности с визой и разрешением на работу"
- "AI acceleration" → "Ускорение ИИ"
- "Interview процесс vs интроверсия" → "Собеседования и интроверсия"
- "Visa sponsorship requirement" → "Требование визовой поддержки"

## Формат ответа

Верни **полный** переписанный markdown-документ. Без преамбулы ("Вот переписанный документ..."), без послесловия. Только сам документ от первой строки до последней.

Если в исходнике уже всё чисто и ничего менять не нужно (редкий случай) — верни его без изменений.

## Исходный документ для чистки

{{originalDocument}}
