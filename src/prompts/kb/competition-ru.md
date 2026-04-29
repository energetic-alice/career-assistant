# Справочник конкуренции - РФ/СНГ рынок

Последнее обновление: Q1 2026
Источник: hh.ru (вакансии + резюме), stats.hh.ru, Хабр Карьера

## Методика
- Вакансий на 100 специалистов = (число вакансий / число активных резюме) * 100
- >= 10 = низкая конкуренция (рынок кандидата)
- 3-9 = средняя конкуренция
- < 3 = высокая конкуренция (рынок работодателя)
- Индекс hh.ru IT = 16.1 (сильно в пользу работодателя, vs 8.2 в 2023)

## Матрица конкуренции по направлениям (РФ, remote включен)

Колонка `Slug(s)` - canonical slugs из `app/data/market-index.json` (см. также `app/src/scripts/build-market-index.ts`). При parsing-е build-скрипт берет `Ratio` и раскладывает по всем перечисленным slug-ам одинаковым значением. Если slug в каталоге нет - строка игнорируется (помечена `-`).

| Направление | Slug(s) | Вакансий | Резюме | Ratio (вак/100 спец) | Динамика YoY | Конкуренция |
|---|---|---|---|---|---|---|
| Backend Java | `backend_java` | ~8000 | ~55000 | ~1.5 | -5% | Высокая |
| Backend Go | `backend_go` | ~3500 | ~12000 | ~3.0 | +20% | Средняя |
| Backend Python | `backend_python` | ~6000 | ~40000 | ~1.5 | +5% | Высокая |
| Backend Node.js | `backend_nodejs` | ~3000 | ~18000 | ~1.7 | 0% | Высокая |
| Backend C#/.NET | `backend_net` | ~3500 | ~25000 | ~1.4 | -10% | Высокая |
| Backend PHP | `backend_php` | ~2500 | ~20000 | ~1.3 | -15% | Высокая |
| Frontend React | `frontend_react` | ~5000 | ~35000 | ~1.4 | -10% | Высокая |
| Frontend Vue | `frontend_vue` | ~2000 | ~10000 | ~2.0 | -5% | Высокая |
| Frontend Angular | `frontend_angular` | ~1500 | ~8000 | ~1.9 | -15% | Высокая |
| DevOps / SRE | `devops, sre` | ~4000 | ~8000 | ~5.0 | +15% | Средняя |
| DevSecOps | - | ~800 | ~1500 | ~5.3 | +30% | Средняя |
| Platform Engineering | `platform_engineer` | ~600 | ~1000 | ~6.0 | +40% | Низкая |
| MLOps | `mlops` | ~400 | ~600 | ~6.7 | +50% | Низкая |
| Data Analyst | `data_analyst` | ~4500 | ~30000 | ~1.5 | 0% | Высокая |
| Data Engineer | `data_engineer` | ~3000 | ~8000 | ~3.8 | +20% | Средняя |
| Data Scientist / ML | `data_scientist, ml_engineer` | ~2000 | ~15000 | ~1.3 | -5% | Высокая |
| Analytics Engineer | - | ~500 | ~1200 | ~4.2 | +35% | Средняя |
| Системный аналитик | `systems_analyst` | ~3500 | ~20000 | ~1.8 | +5% | Высокая |
| Бизнес-аналитик | `business_analyst` | ~2500 | ~18000 | ~1.4 | 0% | Высокая |
| Product Manager | `product_manager` | ~2000 | ~12000 | ~1.7 | -5% | Высокая |
| QA Automation | `qa_engineer` | ~2500 | ~10000 | ~2.5 | +5% | Высокая |
| QA Manual | `manual_testing` | ~1500 | ~25000 | ~0.6 | -20% | Очень высокая |
| Mobile iOS | `mobileapp_swift` | ~1500 | ~5000 | ~3.0 | -5% | Средняя |
| Mobile Android | `mobileapp_kotlin` | ~1800 | ~6000 | ~3.0 | -5% | Средняя |
| React Native / Flutter | `mobileapp_react_native, mobileapp_flutter` | ~800 | ~3000 | ~2.7 | +10% | Средняя |
| Engineering Manager | `engineering_manager` | ~1000 | ~3000 | ~3.3 | +10% | Средняя |
| Tech Lead | `tech_lead` | ~1200 | ~4000 | ~3.0 | +5% | Средняя |
| FinOps / Cloud Cost | - | ~200 | ~300 | ~6.7 | +40% | Низкая |
| Product Analyst | `product_analyst` | ~1500 | ~8000 | ~1.9 | +10% | Высокая |
| Solution Architect | `software_architect` | ~400 | ~3000 | ~1.3 | +5% | Очень высокая |

Slug-и из каталога, которых нет в справочнике (competition component будет пропущен до следующего обновления справочника):
`backend_ruby`, `backend_rust`, `backend_cplusplus`, `fullstack`, `appsec`, `project_manager`, `ui_ux_designer`, `marketing_manager`, `recruiter`, `technical_writer`, `infosecspec`, `1c_developer`, `gamedev_unity`, `web3_developer`, `system_admin`, `tech_support_manager`.

## Эталонные значения (из реальных кейсов)
- UK DevOps: ratio ~10/100 (рынок кандидата)
- РФ Backend Java: ratio ~1.5/100 (рынок работодателя)
- РФ DevOps: ratio ~5/100 (средняя конкуренция)
- РФ QA Manual: ratio ~0.6/100 (рынок мертв для входа)

## Рекомендации по использованию
- Ratio >= 6 -> приоритизировать (Platform Eng, MLOps, FinOps)
- Ratio 3-5 -> нормально с хорошим позиционированием (DevOps, DE, Go)
- Ratio < 3 -> только при явном конкурентном преимуществе (Java с доменом)
- Ratio < 1 -> красный флаг, не рекомендовать вход (QA Manual)

## Дата обновления
Обновлять раз в 3-6 месяцев. Следующее обновление: Q3 2026.
Скрипт сбора: HH.ru API (/vacancies + /resumes count по professional_role).
