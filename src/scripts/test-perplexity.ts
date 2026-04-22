/**
 * Test Perplexity market data integration with mock directions.
 * 
 * Usage: npx tsx src/scripts/test-perplexity.ts [case]
 * Cases: backend, analyst, devops, all
 */
import "dotenv/config";
import { fetchMarketDataForDirections } from "../services/perplexity-service.js";
import type { CandidateProfile, Direction } from "../schemas/analysis-outputs.js";

interface TestCase {
  name: string;
  directions: Direction[];
  profile: Pick<CandidateProfile, "careerGoals">;
}

const CASES: Record<string, TestCase> = {
  backend: {
    name: "Backend-разработчик (Ruby → Go/Python), EU remote",
    directions: [
      {
        title: "Backend Developer for distributed systems in fintech (Go)",
        roleSlug: "backend_go",
        bucket: "abroad",
        whyFits: "test",
        transferableSkills: ["Ruby", "SQL"],
        skillsToLearn: ["Go", "gRPC"],
        adjacencyScorePercent: 70, score: 70,
        searchQueries: ["go backend developer eu remote 2026"],
      },
      {
        title: "Backend Developer with data focus (Python/Java)",
        roleSlug: "backend_python",
        bucket: "abroad",
        whyFits: "test",
        transferableSkills: ["SQL", "REST API"],
        skillsToLearn: ["Python", "Spark"],
        adjacencyScorePercent: 65, score: 65,
        searchQueries: ["python backend developer eu remote 2026"],
      },
      {
        title: "DevOps Engineer for cloud infrastructure (AWS/Kubernetes)",
        roleSlug: "devops",
        bucket: "abroad",
        whyFits: "test",
        transferableSkills: ["Linux", "Docker"],
        skillsToLearn: ["Terraform", "CI/CD"],
        adjacencyScorePercent: 55, score: 55,
        searchQueries: ["devops engineer eu remote 2026"],
      },
    ],
    profile: {
      careerGoals: {
        desiredSalaryNow: "60-80K EUR",
        desiredSalary3to5y: "100-120K EUR",
        targetCountries: "EU remote, Nordic countries",
        workFormat: "remote",
        targetMarketRegions: ["eu"],
        retrainingReadiness: "Да, 10 ч/нед",
        weeklyHours: "10",
        desiredResult: "Переход из Ruby в более востребованный стек",
        careerGoalsYear: "Оффер на новом стеке",
      },
    } as TestCase["profile"],
  },

  analyst: {
    name: "Data Analyst pharma/biotech, Finland + EU remote",
    directions: [
      {
        title: "Data Analyst in pharma/biotech companies (EU remote)",
        roleSlug: "data_analyst",
        bucket: "abroad",
        whyFits: "test",
        transferableSkills: ["SQL", "Power BI", "Statistics"],
        skillsToLearn: ["Python", "Tableau"],
        adjacencyScorePercent: 75, score: 75,
        searchQueries: ["data analyst pharma biotech eu 2026"],
      },
      {
        title: "Backend Developer with data focus (Python/SQL)",
        roleSlug: "backend_python",
        bucket: "abroad",
        whyFits: "test",
        transferableSkills: ["SQL", "Data modeling"],
        skillsToLearn: ["Python", "FastAPI"],
        adjacencyScorePercent: 50, score: 50,
        searchQueries: ["python backend developer data eu 2026"],
      },
      {
        title: "Data Engineer for life sciences platforms (Python/SQL focus)",
        roleSlug: "data_engineer",
        bucket: "abroad",
        whyFits: "test",
        transferableSkills: ["SQL", "ETL"],
        skillsToLearn: ["Airflow", "dbt", "Spark"],
        adjacencyScorePercent: 55, score: 55,
        searchQueries: ["data engineer life sciences eu 2026"],
      },
    ],
    profile: {
      careerGoals: {
        desiredSalaryNow: "45-60K EUR",
        desiredSalary3to5y: "70-90K EUR",
        targetCountries: "Finland, EU remote, Nordic countries",
        workFormat: "remote",
        targetMarketRegions: ["eu"],
        retrainingReadiness: "Да, 5 ч/нед",
        weeklyHours: "5",
        desiredResult: "Карьерный рост в data analytics",
        careerGoalsYear: "Оффер в pharma/biotech",
      },
    } as TestCase["profile"],
  },

  devops: {
    name: "PLC/SCADA Engineer → ML/DevOps, EU + Asia-Pacific",
    directions: [
      {
        title: "MLOps Engineer for production ML systems (Python/Kubernetes)",
        roleSlug: "devops",
        bucket: "abroad",
        whyFits: "test",
        transferableSkills: ["Docker", "Python", "AWS"],
        skillsToLearn: ["MLflow", "Kubeflow"],
        adjacencyScorePercent: 55, score: 55,
        searchQueries: ["mlops engineer eu remote 2026"],
      },
      {
        title: "DevOps Engineer for cloud-native platforms (AWS/GCP)",
        roleSlug: "devops",
        bucket: "abroad",
        whyFits: "test",
        transferableSkills: ["Linux", "Docker", "CI/CD"],
        skillsToLearn: ["Terraform", "Kubernetes"],
        adjacencyScorePercent: 60, score: 60,
        searchQueries: ["devops engineer cloud eu remote 2026"],
      },
      {
        title: "Elixir Developer for IoT platforms",
        roleSlug: "elixir_developer",
        offIndex: true,
        marketEvidence: "Test mock: Elixir developer — нишевая off-index роль, только для testing",
        bucket: "abroad",
        whyFits: "test",
        transferableSkills: ["Real-time systems", "Sensors"],
        skillsToLearn: ["Elixir", "Phoenix"],
        adjacencyScorePercent: 35, score: 35,
        searchQueries: ["elixir developer iot 2026"],
      },
    ],
    profile: {
      careerGoals: {
        desiredSalaryNow: "50-60K EUR",
        desiredSalary3to5y: "80-100K EUR",
        targetCountries: "Europe, Singapore, Malaysia — remote only",
        workFormat: "remote",
        targetMarketRegions: ["eu", "asia-pacific"],
        retrainingReadiness: "Да, 10 ч/нед",
        weeklyHours: "10",
        desiredResult: "Переход из automation в ML/DevOps",
        careerGoalsYear: "Первый оффер в новой роли",
      },
    } as TestCase["profile"],
  },
};

async function runTest(caseName: string) {
  const tc = CASES[caseName];
  if (!tc) {
    console.error(`Unknown case: ${caseName}. Available: ${Object.keys(CASES).join(", ")}`);
    return;
  }

  console.log(`\n${"=".repeat(60)}`);
  console.log(`TEST: ${tc.name}`);
  console.log(`${"=".repeat(60)}\n`);

  const t0 = Date.now();
  try {
    const result = await fetchMarketDataForDirections(
      tc.directions,
      tc.profile as CandidateProfile,
    );
    const elapsed = Date.now() - t0;

    console.log(`\n--- Formatted marketData (${elapsed}ms) ---\n`);
    console.log(result.formattedText);

    console.log(`\n--- Raw data summary ---`);
    for (const dir of result.rawData) {
      console.log(`\n${dir.directionTitle}:`);
      for (const r of dir.results) {
        console.log(`  [${r.key.level}] ${r.key.cacheKey}: ${r.data.vacancyCount} vac, ${r.data.vacanciesPer100Specialists} vac/100, ${r.data.salaryRange}`);
      }
    }
  } catch (err) {
    console.error(`FAILED (${Date.now() - t0}ms):`, err);
  }
}

async function main() {
  if (!process.env.PERPLEXITY_API_KEY) {
    console.error("PERPLEXITY_API_KEY not set");
    process.exit(1);
  }

  const arg = process.argv[2] || "all";

  if (arg === "all") {
    for (const name of Object.keys(CASES)) {
      await runTest(name);
    }
  } else {
    await runTest(arg);
  }
}

main();
