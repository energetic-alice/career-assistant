# Справочник конкуренции - EU рынок

Последнее обновление: Q1 2026
Источник: LinkedIn Talent Insights, ITJobsWatch (UK), Glassdoor, Indeed EU

## Методика
- Оценка на основе LinkedIn job postings vs candidate profiles в регионе
- ITJobsWatch: позиции и постоянные вакансии в UK
- >= 10 вак/100 спец = низкая конкуренция (рынок кандидата)
- 3-9 = средняя
- < 3 = высокая (рынок работодателя)

## Матрица конкуренции по направлениям (EU, remote included)

Колонка `Slug(s)` - canonical slugs из `app/data/market-index.json`. Эти ratio применяются build-скриптом ко всем abroad-buckets (UK, EU, US) одинаково - per-country отклонения описаны текстом ниже. Строки без slug (`-`) игнорируются.

| Направление | Slug(s) | Примерн. вакансий (EU) | Оценка ratio | Динамика YoY | Конкуренция |
|---|---|---|---|---|---|
| Backend Java | `backend_java` | ~45000 | ~2.5 | -5% | Высокая |
| Backend Go | `backend_go` | ~12000 | ~6.0 | +25% | Низкая |
| Backend Python | `backend_python` | ~35000 | ~3.0 | +10% | Средняя |
| Backend Node.js | `backend_nodejs` | ~18000 | ~3.5 | +5% | Средняя |
| Backend Rust | `backend_rust` | ~3000 | ~8.0 | +40% | Низкая |
| Backend Ruby/Rails | `backend_ruby` | ~5000 | ~5.0 | -10% | Средняя (legacy niche) |
| Frontend React | `frontend_react` | ~30000 | ~2.0 | -10% | Высокая |
| DevOps / SRE | `devops, sre` | ~25000 | ~8.0 | +15% | Низкая |
| DevSecOps | - | ~6000 | ~10.0 | +30% | Низкая |
| Platform Engineering | `platform_engineer` | ~8000 | ~12.0 | +40% | Низкая |
| MLOps | `mlops` | ~4000 | ~10.0 | +50% | Низкая |
| Data Analyst | `data_analyst` | ~61000 | ~3.0 | +5% | Средняя |
| Data Engineer | `data_engineer` | ~22000 | ~6.0 | +20% | Низкая |
| Analytics Engineer | - | ~5000 | ~8.0 | +35% | Низкая |
| Data Scientist / ML | `data_scientist` | ~15000 | ~3.0 | +5% | Средняя |
| ML Engineer | `ml_engineer` | ~8000 | ~5.0 | +25% | Средняя |
| Системный аналитик / BA | `systems_analyst, business_analyst` | ~20000 | ~3.0 | +5% | Средняя |
| Product Manager | `product_manager` | ~18000 | ~2.5 | -5% | Высокая |
| Growth Manager / PMM | `marketing_manager` | ~6000 | ~5.0 | +15% | Средняя |
| QA Automation | `qa_engineer` | ~12000 | ~4.0 | +5% | Средняя |
| Mobile (iOS + Android) | `mobileapp_swift, mobileapp_kotlin` | ~10000 | ~3.5 | -5% | Средняя |
| React Native / Flutter | `mobileapp_react_native, mobileapp_flutter` | ~5000 | ~4.0 | +10% | Средняя |
| Engineering Manager | `engineering_manager` | ~8000 | ~5.0 | +10% | Средняя |
| Cloud Architect | - | ~6000 | ~8.0 | +15% | Низкая |
| Industrial IoT / MLOps | - | ~2000 | ~15.0 | +30% | Очень низкая |
| IT/Tech Recruiter / Talent Acquisition | `recruiter` | ~1200 | ~3.5 | +5-10% | Средняя |
| UX/UI / Product Designer (senior+) | `ui_ux_designer` | ~1500 EU (узко) | ~2.0 | -50% за 2 года | Высокая |

Примечание по UX/UI: рынок прошел серьезное сжатие в 2024-2026 из-за AI-инструментов (Figma AI, Midjourney, автогенерация дизайн-систем). Junior/middle позиции закрываются в разы быстрее, чем открываются новые. Senior+ с опытом дизайн-систем, B2B-продуктов и лидерства команд защищены лучше, но общий рынок сузился - UK itjobswatch показывает падение с ~1000 до ~250 вакансий за 2 года. AI-риск = high по данным market-index, смягчать не надо.

Slug-и из каталога, которых нет в справочнике: `backend_net`, `backend_php`, `backend_cplusplus`, `frontend_vue`, `frontend_angular`, `fullstack`, `appsec`, `manual_testing`, `project_manager`, `tech_lead`, `software_architect`, `product_analyst`, `technical_writer`, `infosecspec`, `1c_developer`, `gamedev_unity`, `web3_developer`, `system_admin`, `tech_support_manager`.

## По регионам (отклонения от EU-среднего)

### DACH (Германия, Австрия, Швейцария)
- Выше спрос: DevOps (+20% к EU avg), Backend Go, Industrial IoT
- Ниже спрос: Remote-friendly позиции (-30% vs Нидерланды/UK)
- Немецкий язык: premium для on-site, не critical для remote

### UK
- DevOps ratio ~10/100 (эталонный рынок кандидата)
- Backend Java ratio ~2/100 (высокая конкуренция)
- Fintech hub: специализация в fintech дает +20-30% к зп и +50% к ratio
- ITJobsWatch: отличный источник для трендов навыков

### Nordics (Финляндия, Швеция, Дания, Норвегия)
- Высокие зарплаты, но маленький рынок
- Fintech, Healthtech, GreenTech - нишевые домены
- English достаточен для большинства ролей

### CEE (Польша, Чехия, Балтия)
- Растущий рынок, но зарплаты 40-60% от DACH
- B2B контракты: стандарт в Польше
- EU remote из CEE: доступ к DACH зарплатам через remote

## Нишевые направления с низкой конкуренцией
1. **Industrial IoT / Manufacturing AI**: ratio ~15/100, промышленный бэкграунд = суперсила
2. **Platform Engineering**: ratio ~12/100, Internal Developer Platforms
3. **DevSecOps**: ratio ~10/100, security shift-left
4. **MLOps**: ratio ~10/100, production ML infrastructure
5. **FinOps**: ratio ~8/100, cloud cost optimization

## Дата обновления
Обновлять раз в 3-6 месяцев. Следующее обновление: Q3 2026.
Источники данных: LinkedIn Talent Insights, ITJobsWatch, batch Perplexity queries.
