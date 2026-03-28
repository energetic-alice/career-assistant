/**
 * E2E test script: runs the full analysis pipeline on a sample candidate.
 *
 * Usage: npx tsx src/scripts/test-e2e.ts
 *
 * Requires ANTHROPIC_API_KEY in .env
 */
import "dotenv/config";
import { writeFile, mkdir } from "node:fs/promises";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { runAnalysisPipeline } from "../pipeline/run-analysis.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const OUTPUT_DIR = join(__dirname, "..", "..", "test-output");

const TEST_CASES: Record<string, { questionnaire: string; resumeText: string; linkedinUrl: string; linkedinSSI: string }> = {
  tatiana_sizykh: {
    questionnaire: `Имя: Татьяна Сизых
Текущая должность: Системный аналитик
Опыт в IT: 20 лет (15 лет Java-разработка, 5 лет системная аналитика)
Работодатели: Сбербанк, БФТ/Ростелеком, госсектор
Стек: REST/gRPC, Kafka, Camunda, DMN, ELK+Grafana, Java
Английский: 0 (не владею)
Текущая зарплата: ~250K руб
Желаемая зарплата сейчас: 300K+
Желаемая зарплата через 3-5 лет: 500K+
Локация: Россия, удаленно
Готовность к переобучению: Да, 3-5 ч/нед
Интерес: DevOps или возврат в разработку (Java)
Причина: Выгорание от роли аналитика, устала от бесконечных согласований
Коммуникации: Не люблю долгие созвоны и согласования, предпочитаю работать самостоятельно
Предыдущие попытки: Пробовала курсы DevOps, но не дошла до конца
LinkedIn: нет
Какой результат хочешь: Понять куда двигаться, чтобы не выгореть и зарабатывать больше`,
    resumeText: `Татьяна Сизых
Системный аналитик | 5 лет

Опыт работы:
2019-2024: Системный аналитик, БФТ (подрядчик Ростелеком, Минфин)
- Проектирование REST и gRPC API для госсистем
- Интеграция с СМЭВ 3.0, ЕБС
- Kafka: проектирование топиков и потоков данных
- Camunda BPM: моделирование бизнес-процессов
- ELK + Grafana: настройка мониторинга
- Управление требованиями в Confluence/Jira

2004-2019: Java-разработчик, несколько компаний
- 15 лет разработки на Java (J2EE, Spring)
- Пенсионный фонд РФ: модернизация legacy-систем
- Банковские системы: процессинг платежей
- Госсектор: электронный документооборот

Образование: Высшее техническое (информатика)`,
    linkedinUrl: "нет",
    linkedinSSI: "0",
  },

  djanibek: {
    questionnaire: `Name: Djanibek Khudaybergenov
Current role: PLC/SCADA Automation Engineer
Experience: 5+ years (Volvo, Chrysler, Stellantis)
Education: MSc Politecnico di Torino, Mechatronics
Location: Italy, EU permanent residence
English: C1 (TOEFL 98)
Current salary: EUR 35K/year
Desired salary now: EUR 50-60K
Desired salary 3-5 years: EUR 80-100K
Work format: Remote or hybrid in EU
Retraining readiness: Yes, 5-10 h/week
Interest: ML Engineering, MLOps, Data Science
Reason: PLC/SCADA has a salary ceiling, want to move into AI/ML
Communication style: Prefer async, comfortable with documentation
Previous attempts: Built ML portfolio projects (FastAPI, Docker, MLflow, AWS), freelance ML work
LinkedIn: linkedin.com/in/djanibek
What result do you want: Clear career transition plan from automation to ML/AI`,
    resumeText: `Djanibek Khudaybergenov
PLC/SCADA Automation Engineer

Experience:
2021-present: Automation Engineer, Stellantis (Italy)
- PLC programming (Siemens S7, Allen Bradley)
- SCADA system development and maintenance
- Production line automation for automotive manufacturing
- Integration of sensor data systems

2019-2021: Automation Engineer, Volvo/Chrysler (contract)
- Real-time control systems
- Industrial IoT sensor integration
- Factory floor automation

ML Portfolio:
- End-to-end ML pipeline with FastAPI + Docker + MLflow
- AWS deployment (SageMaker, EC2)
- Predictive maintenance model for industrial equipment
- Image classification for quality control

Education: MSc Mechatronics Engineering, Politecnico di Torino
Certifications: AWS Cloud Practitioner
Languages: English C1 (TOEFL 98), Russian, Italian, Turkish`,
    linkedinUrl: "linkedin.com/in/djanibek",
    linkedinSSI: "35",
  },
};

async function main() {
  const caseName = process.argv[2] || "tatiana_sizykh";
  const testCase = TEST_CASES[caseName];

  if (!testCase) {
    console.error(`Unknown test case: ${caseName}`);
    console.log(`Available: ${Object.keys(TEST_CASES).join(", ")}`);
    process.exit(1);
  }

  console.log(`\n=== E2E Test: ${caseName} ===\n`);

  try {
    const result = await runAnalysisPipeline(testCase);

    await mkdir(OUTPUT_DIR, { recursive: true });

    const outputPath = join(OUTPUT_DIR, `${caseName}_${Date.now()}.md`);
    await writeFile(outputPath, result.finalDocument, "utf-8");
    console.log(`\n[Output] Final document saved to: ${outputPath}`);

    const summaryPath = join(OUTPUT_DIR, `${caseName}_summary_${Date.now()}.json`);
    await writeFile(
      summaryPath,
      JSON.stringify(
        {
          profile: result.profile,
          directions: result.directions,
          analysis: result.analysis,
          timings: result.timings,
        },
        null,
        2,
      ),
      "utf-8",
    );
    console.log(`[Output] Structured data saved to: ${summaryPath}`);

    console.log("\n=== Review Summary (for TG bot) ===");
    console.log(result.reviewSummaryText.replace(/<\/?b>/g, "**"));
    console.log("\n=== Timings ===");
    for (const [step, ms] of Object.entries(result.timings)) {
      console.log(`  ${step}: ${(ms / 1000).toFixed(1)}s`);
    }
  } catch (err) {
    console.error("Pipeline failed:", err);
    process.exit(1);
  }
}

main();
