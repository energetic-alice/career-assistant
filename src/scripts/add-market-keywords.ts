import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * One-off скрипт: добавляет `marketKeywordsTop5` и `marketKeywords`
 * в каждую запись `prompts/kb/roles-catalog.json`. Запускается руками
 * после правки MAPPING ниже — результат нужен LinkedIn Pack'у (Phase 2
 * headline + Phase 3 top skills), чтобы модель не галлюцинировала
 * keyword-ы «по наитию», а опиралась на заранее подобранные top-скиллы.
 *
 * Источник: файл Алисы «Навыки.docx» (hh.ru-подборка). Правило сбора:
 *   - `extended` = все строки из файла в исходном порядке (по частоте).
 *   - `top5`     = первые 5 строк, с ИСКЛЮЧЕНИЕМ Git (он общая база,
 *                  в top-5 засорил бы все роли).
 *
 * Slug-и, для которых в файле Алисы данных НЕТ (backend_ruby, backend_rust,
 * frontend_vue/angular, fullstack, mobileapp_react_native, project_manager,
 * tech_lead, software_architect, ui_ux_designer, marketing_manager,
 * recruiter, technical_writer, infosecspec, system_admin,
 * tech_support_manager, web3_developer) — оставлены без keywords,
 * будут перечислены в warning'е.
 *
 * Запуск:
 *   npx tsx src/scripts/add-market-keywords.ts
 */

interface Entry {
  marketKeywordsTop5?: string[];
  marketKeywords?: string[];
  [k: string]: unknown;
}

interface RoleSkills {
  top5: string[];
  extended: string[];
}

/**
 * MAPPING составлен СТРОГО по файлу «Навыки.docx».
 * Порядок ровно как в файле. top5 = первые 5 без Git.
 */
const MAPPING: Record<string, RoleSkills> = {
  // 1с developer
  "1c_developer": {
    top5: ["1С: Предприятие 8", "Работа с большим объемом информации", "1С: Документооборот", "1С: Управление Торговлей", "1С программирование"],
    extended: ["1С: Предприятие 8", "Работа с большим объемом информации", "1С: Документооборот", "1С: Управление Торговлей", "1С программирование", "1С: Бухгалтерия", "Деловое общение", "1С: Предприятие", "ERP-системы на базе 1С", "1С: Зарплата и управление персоналом"],
  },

  // Android developer
  mobileapp_kotlin: {
    top5: ["Kotlin", "Android", "Java", "Android SDK", "MVVM"],
    extended: ["Kotlin", "Android", "Java", "Android SDK", "Git", "MVVM", "Jetpack Compose", "Coroutines", "Clean Architecture", "RxJava"],
  },

  // Aqa / Automation QA
  qa_engineer: {
    top5: ["Java", "SQL", "Python", "Selenium", "API"],
    extended: ["Java", "Python", "SQL", "Selenium", "Git", "API", "Postman", "QA", "CI/CD", "Docker"],
  },

  // Bussines analyst
  business_analyst: {
    top5: ["Бизнес-анализ", "BPMN", "SQL", "Моделирование бизнес-процессов", "Системный анализ"],
    extended: ["Бизнес-анализ", "BPMN", "SQL", "Моделирование бизнес-процессов", "Системный анализ", "UML", "Оптимизация бизнес-процессов", "MS Excel", "Постановка задач разработчикам", "Разработка бизнес-требований"],
  },

  // С/C++ developer
  backend_cplusplus: {
    top5: ["C++", "Linux", "Qt", "Python", "C"],
    extended: ["C++", "Linux", "Git", "Qt", "Python", "C", "SQL", "STL", "PostgreSQL", "Docker"],
  },

  // C# developer
  backend_net: {
    top5: ["C#", "PostgreSQL", "ASP.NET", "SQL", "Docker"],
    extended: ["C#", "PostgreSQL", "ASP.NET", "Git", "SQL", ".NET", "Docker", "Entity Framework", "RabbitMQ", "MS SQL"],
  },

  // Data analyst
  data_analyst: {
    top5: ["SQL", "Python", "Анализ данных", "Аналитическое мышление", "Power BI"],
    extended: ["SQL", "Python", "Анализ данных", "Аналитическое мышление", "Power BI", "MS Excel", "Визуализация данных", "PostgreSQL", "Clickhouse", "pandas"],
  },

  // Data engineer
  data_engineer: {
    top5: ["Python", "SQL", "PostgreSQL", "ETL", "Big Data"],
    extended: ["Python", "SQL", "PostgreSQL", "ETL", "Big Data", "Clickhouse", "DWH", "Apache Airflow", "pandas", "Greenplum"],
  },

  // Data scientist + ML/AI Engineer — берём ML/AI (более свежие цифры
  // и более покрытый файл), Data scientist как подраздел.
  ml_engineer: {
    top5: ["Python", "Machine Learning", "PyTorch", "Deep Learning", "SQL"],
    extended: ["Python", "Machine Learning", "PyTorch", "Deep Learning", "SQL", "pandas", "Scikit-learn", "Linux", "Docker", "Numpy"],
  },

  // DevOps / SRE
  devops: {
    top5: ["Linux", "Docker", "Kubernetes", "DevOps", "Ansible"],
    extended: ["Linux", "Docker", "Kubernetes", "DevOps", "Ansible", "CI/CD", "Python", "PostgreSQL", "Grafana", "Prometheus"],
  },

  // Flutter developer
  mobileapp_flutter: {
    top5: ["Flutter", "Dart", "Android", "iOS", "REST API"],
    extended: ["Flutter", "Dart", "Git", "Android", "iOS", "REST API", "Kotlin", "Java", "Clean Architecture", "ООП"],
  },

  // Frontend developer
  frontend_react: {
    top5: ["JavaScript", "TypeScript", "React", "HTML", "CSS"],
    extended: ["JavaScript", "TypeScript", "React", "Git", "HTML", "CSS", "Redux", "REST API", "Node.js", "Webpack"],
  },

  // Golang developer
  backend_go: {
    top5: ["Go", "PostgreSQL", "Docker", "Kafka", "Kubernetes"],
    extended: ["Go", "PostgreSQL", "Docker", "Kafka", "Kubernetes", "SQL", "Git", "Redis", "Linux", "REST API"],
  },

  // iOS developer
  mobileapp_swift: {
    top5: ["iOS", "Swift", "UIKit", "MVVM", "REST API"],
    extended: ["iOS", "Swift", "UIKit", "Git", "MVVM", "REST API", "Objective-C", "Xcode", "SOLID", "SwiftUI"],
  },

  // Product manager
  product_manager: {
    top5: ["Продуктовые метрики", "Аналитическое мышление", "Английский язык", "Анализ конкурентной среды", "A/B тесты"],
    extended: ["Продуктовые метрики", "Аналитическое мышление", "Английский язык", "Анализ конкурентной среды", "A/B тесты", "Product Management", "Анализ рынка", "Unit-экономика", "Roadmap", "CustDev"],
  },

  // Java developer
  backend_java: {
    top5: ["Java", "Spring Framework", "PostgreSQL", "SQL", "Apache Kafka"],
    extended: ["Java", "Spring Framework", "PostgreSQL", "SQL", "Apache Kafka", "Spring Boot", "Git", "Docker", "REST API", "Hibernate"],
  },

  // Node.js developer
  backend_nodejs: {
    top5: ["Node.js", "PostgreSQL", "JavaScript", "TypeScript", "Docker"],
    extended: ["Node.js", "PostgreSQL", "Git", "JavaScript", "TypeScript", "Docker", "REST API", "MySQL", "Redis", "SQL"],
  },

  // PHP developer
  backend_php: {
    top5: ["PHP", "MySQL", "Laravel", "Docker", "PostgreSQL"],
    extended: ["PHP", "MySQL", "Git", "Laravel", "Docker", "PostgreSQL", "JavaScript", "Symfony", "Redis", "HTML"],
  },

  // Product analyst
  product_analyst: {
    top5: ["SQL", "Python", "A/B тесты", "Power BI", "Анализ данных"],
    extended: ["SQL", "Python", "A/B тесты", "Power BI", "Анализ данных", "Tableau", "PostgreSQL", "Математическая статистика", "MS Excel", "Clickhouse"],
  },

  // Python developer
  backend_python: {
    top5: ["Python", "PostgreSQL", "Docker", "SQL", "FastAPI"],
    extended: ["Python", "PostgreSQL", "Docker", "Git", "SQL", "FastAPI", "Django", "Linux", "REST API", "Redis"],
  },

  // Qa engineer / Тестировщик (manual)
  manual_testing: {
    top5: ["SQL", "Postman", "Функциональное тестирование", "Ручное тестирование", "QA"],
    extended: ["SQL", "Postman", "Функциональное тестирование", "Ручное тестирование", "Git", "QA", "Регрессионное тестирование", "Jira", "Linux", "REST API"],
  },

  // System analyst
  systems_analyst: {
    top5: ["SQL", "Системный анализ", "BPMN", "UML", "REST API"],
    extended: ["SQL", "Системный анализ", "BPMN", "UML", "REST API", "Бизнес-анализ", "Постановка задач разработчикам", "SOAP", "REST", "API"],
  },

  // Unity developer
  gamedev_unity: {
    top5: ["Unity", "C#", "Game Programming", "Android", "ООП"],
    extended: ["Unity", "C#", "Game Programming", "Git", "Android", "ООП", "Английский язык", "iOS", "UI", "ECS"],
  },
};

const __dirname = dirname(fileURLToPath(import.meta.url));
const CATALOG_PATH = join(__dirname, "..", "prompts", "kb", "roles-catalog.json");

function main(): void {
  const raw = readFileSync(CATALOG_PATH, "utf-8");
  const catalog = JSON.parse(raw) as Entry[];

  let updated = 0;
  const missing: string[] = [];

  for (const entry of catalog) {
    const slug = entry.slug as string;
    const skills = MAPPING[slug];
    if (!skills) {
      missing.push(slug);
      continue;
    }

    if (skills.top5.length !== 5) {
      throw new Error(`[${slug}] top5 must have exactly 5 items, got ${skills.top5.length}`);
    }
    if (skills.extended.length < 5 || skills.extended.length > 20) {
      throw new Error(`[${slug}] extended must be 5..20 items, got ${skills.extended.length}`);
    }
    const extSet = new Set(skills.extended);
    for (const kw of skills.top5) {
      if (!extSet.has(kw)) {
        throw new Error(`[${slug}] top5 keyword "${kw}" not in extended list`);
      }
    }

    entry.marketKeywordsTop5 = skills.top5;
    entry.marketKeywords = skills.extended;
    updated += 1;
  }

  writeFileSync(CATALOG_PATH, JSON.stringify(catalog, null, 2) + "\n", "utf-8");
  console.log(
    `[add-market-keywords] updated ${updated}/${catalog.length} entries -> ${CATALOG_PATH}`,
  );

  if (missing.length > 0) {
    console.warn(
      `\n[add-market-keywords] ВНИМАНИЕ: ${missing.length} slug-ов БЕЗ данных в файле «Навыки.docx» — оставлены без marketKeywords (надо добить отдельно):`,
    );
    for (const s of missing) console.warn(`  - ${s}`);
  }
}

main();
