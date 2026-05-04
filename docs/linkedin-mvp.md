# LinkedIn Pack — MVP

Новый артефакт в текущем admin-боте: LinkedIn-аудит по методике Алисы + 5 вариантов headline под конкретного клиента.

## Scope MVP

1. **Аудит профиля** (Phase 1) по чек-листу (**42 балла, 5 блоков, 26 пунктов** — покрывает методологию из `kb/linkedin-methodology.md` + применимые правила из `kb/resume-methodology.md`). Для каждого пункта — галочка (выполнено / нет) + конкретная рекомендация что сделать. Работает в двух сценариях: (a) клиент пришёл с хорошим резюме и пустым LinkedIn, (b) клиент пришёл с голым LinkedIn без/со слабым резюме.
2. **5 вариантов headline** (Phase 2) по формуле `[Грейд] [Должность] | [Стек] | [Индустрии] | [Опыт/достижение] | [Формат]`. Лимит 120 символов. С ключевыми словами под рекрутерский поиск.
3. **Полный конструктор профиля** (Phase 3) — готовый copy-paste для всех секций и инструкции по настройкам: About (с разбивкой на 4 блока), Top Skills (5 закреплённых), переписанные Experience-позиции (с санкционными → нейтральные, target-title, контекст компании, bullets с цифрами), Profile settings (Location / URL / Open to Work / Cover Banner / Contact Info), Education + Languages + Certifications + Volunteering, Action plan (500+ connections, endorsements, recommendations с шаблоном запроса, активность в ленте), 4 темы первых постов под контент-план.

Итоговый артефакт — Google Doc (+ сообщение в админ-чате с ссылкой и кнопкой «Отметить как отправлен клиенту»).

## Вход

Нужно хотя бы одно из:
- LinkedIn URL (`clientSummary.linkedinUrl`) — через существующий `linkedin-fetcher.ts` (cookie → Perplexity fallback)
- Резюме (`stageOutputs.resumeVersions`)

Плюс `clientSummary` (грейд, опыт, target-markets, english, `selectedTargetRoles`) для контекста.

Если нет ни LinkedIn, ни резюме — кнопка отдаёт ошибку «нужна или ссылка на LinkedIn, или резюме».

## Чек-лист аудита (42 балла, 26 пунктов)

Источник — `kb/linkedin-methodology.md` + применимые правила из `kb/resume-methodology.md`. Промпт `01-audit.md` обязан использовать РОВНО этот чек-лист, без отсебятины. Баллы на пункт — **1 или 2** (ограничение схемы).

### Блок 1 — Профиль и контакты (8 баллов, 6 пунктов)

- [ ] 1. Профессиональное фото (деловое, нейтральный фон, не селфи) — **1**
- [ ] 2. Cover-баннер + контакты в нём (email для зарубежа / Telegram для RU) — **1**
- [ ] 3. Локация = крупнейший город target-страны; для зарубежа нет следа РФ в локации и телефоне — **2**
- [ ] 4. Open to Work private (без публичной зелёной плашки) — **1**
- [ ] 5. Connections 500+ — **2**
- [ ] 6. Кастомизированный URL + ссылки на GitHub / портфолио / сайт — **1**

### Блок 2 — Headline (4 балла, 2 пункта)

- [ ] 7. Headline по формуле `grade + target title + стэк + индустрии + B2B/Remote/TZ`, ≤220 символов — **2**
- [ ] 8. Headline содержит target job title слово-в-слово + дублирует 5 Top Skills — **2**

### Блок 3 — Раздел «О себе» (10 баллов, 5 пунктов)

- [ ] 9. About по структуре 4 блоков (summary + достижения + tech skills + CTA) — **2**
- [ ] 10. Первый абзац = полноценное summary как в резюме (target title + grade + годы + индустрии + достижение) — **2**
- [ ] 11. Keyword consistency с Headline и Top Skills — **2**
- [ ] 12. Достижения в цифрах (на каждую цифру есть объяснение «откуда») — **2**
- [ ] 13. CTA + прямой контакт (email/Telegram) в тексте About — **2**

### Блок 4 — Опыт работы (12 баллов, 7 пунктов)

- [ ] 14. Job title текущей позиции = target title (или близко; при перекате — переименован к target) — **2**
- [ ] 15. Опыт полный, в LinkedIn не режем; минимум 3 года релевантного опыта — **1**
- [ ] 16. У каждой компании — контекст (users/top-N/тип); формат Remote; нет Москвы для зарубежа — **2**
- [ ] 17. Достижения с цифрами в каждом месте, не обязанности; target-стэк в описании — **2**
- [ ] 18. Skills внутри каждого Experience заполнены target-ключевиками — **1**
- [ ] 19. Санкционные компании/госпроекты → нейтральные формулировки (`top-10 bank in CIS`) — **2**
- [ ] 20. Нет пробелов > 3 мес без объяснений; куски < 1 года расширены/объединены; нет параллельных работ — **2**

### Блок 5 — Навыки, рекомендации, образование, активность (8 баллов, 6 пунктов)

- [ ] 21. Top Skills = 5 pinned + общий Skills ≥ 10 + очевидные target-keyword'ы — **1**
- [ ] 22. Endorsements на Top-3 + Recommendations ≥ 2 от коллег/руководителей — **2**
- [ ] 23. Certifications ≥ 1 релевантный (для перекатов — обязательно) — **1**
- [ ] 24. Languages: English на первом месте, уровень ≥ B2 (правило +1 ступень); язык страны проживания — **1**
- [ ] 25. Education: степень + вуз, без года (ageism); для клиентов за рубежом — локальный вуз по возможности — **1**
- [ ] 26. Активность: ≥ 4 постов + регулярная работа с лентой; без токсичных лайков/комментов — **2**

**Максимум: 42 балла.**

## Формула headline

```
[Грейд (если есть)] [Должность (самое популярное название)] | [Стек или 2-4 ключевые технологии] | [Индустрии] | [Число лет опыта ИЛИ самое крутое достижение] | [Формат: например B2B Remote — при отсутствии разрешения на работу в EU при желаемом зарубежном рынке]
```

Требования:
- **≤ 120 символов**. Если Claude вернул больше — регенерим до 2 раз.
- Ключевые слова для поиска рекрутерами (используй популярные формулировки из вакансий target-роли).
- 5 вариантов с разным акцентом, чтобы клиент мог выбрать:
  1. классика: грейд + должность + стек
  2. с крутым достижением вместо стажа
  3. с акцентом на индустрию
  4. B2B / Remote (если target-рынок ≠ страны, где клиент может работать)
  5. keyword-heavy — под ATS и фильтры рекрутеров

## Архитектура

```
Карточка клиента ──кнопка──> runLinkedinPack ──> fetchInputs (LI + резюме + summary)
                                             ──> phase1_audit      (чеклист + рекомендации)
                                             ──> phase2_headline   (5 вариантов, валидация 120 симв)
                                             ──> phase3_profile    (About + Top Skills + Experience + настройки + план + контент)
                                             ──> renderer → markdown
                                             ──> createGoogleDoc
                                             ──> сохранение в stageOutputs.linkedinPack
                                             ──> сообщение куратору со ссылкой
```

### Файлы

- `src/prompts/linkedin/01-audit.md`
- `src/prompts/linkedin/02-headline.md`
- `src/prompts/linkedin/03-profile-content.md`
- `src/prompts/kb/linkedin-methodology.md` + `src/prompts/kb/resume-methodology.md`
- `src/schemas/linkedin-pack.ts` — Zod: `LinkedinAudit`, `HeadlinePack`, `ProfileContent`, `LinkedinPack`
- `src/services/linkedin-pack/build-inputs.ts`
- `src/services/linkedin-pack/run-pack.ts` — фазы audit → headline → profile-content, с `onProgress` callback
- `src/services/linkedin-pack/renderer.ts`
- `src/bot/linkedin-pack.ts` — кнопки, callbacks, Google Doc
- Правки: `schemas/pipeline-state.ts` (новые stages), `services/review-summary.ts` (STAGE_LABELS), `bot/admin-review.ts` (кнопка в карточке), `bot/telegram-bot.ts` (регистрация), `bot/run-lock.ts` (`linkedin` kind)

### Pipeline stages

- `linkedin_generating` — запущен
- `linkedin_ready` — Google Doc создан, ждёт отправки
- `linkedin_sent` — куратор отправил клиенту (необратимо, как `final_sent`)
- `linkedin_failed` — упало

## Roadmap (вне MVP)

- **v2 — расширенный контент-план**: 4-8 недель темы по target-role + экспертиза + «человеческие» посты (вместо сегодняшних 4 для старта).
- **v3 — генерация постов**: draft + 2-3 варианта по выбранному пункту плана.
- **v4 — self-service**: отдельный client-facing entry point, если зайдёт у клиентов.
- **v5 — интеграция с Canva** для автоматического баннера по шаблону.

## Ограничения и риски

- LinkedIn profile фетчится через Apify — актор иногда возвращает stale данные; фоллбэк — работать по резюме + помечать unknown.
- Headline > 120 симв — в коде ловим Zod-refine'ом и регенерим (максимум 2 раза).
- Profile-content фаза тяжёлая (до 10K output tokens). При schema-fail — одна retry-попытка. Если падает дважды — Phase 3 помечается как failed, но Phase 1+2 всё равно попадают в Google Doc.
- Часть пунктов чеклиста (фото, баннер, кастом URL, endorsements, активность) не проверяется автоматически по тексту — модель ставит `unknown` и пишет «проверь руками».
