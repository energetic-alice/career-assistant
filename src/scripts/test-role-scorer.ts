import type { ClientSummary } from "../schemas/client-summary.js";
import { rankRoles, type ScoredRole } from "../services/role-scorer.js";

/**
 * Sanity-check для role-scorer на 7 синтетических fixture'ах.
 * Запуск: `npx tsx src/scripts/test-role-scorer.ts`
 *
 * Acceptance:
 *  — raumfahrer (non-IT + ML): data_scientist / ml_engineer / data_engineer в топ-5 abroad.
 *  — flutter_dev_ru: mobileapp_flutter гарантированно в RU топе, не болтается в чужих топах.
 *  — php_ru: backend_php в топе, manual_testing отсечён (aiRisk=extreme).
 *  — ruby_ru_to_eu: backend_ruby гарантированно в обоих рынках; abroad топ — backend_go / rust.
 *  — fullstack_cloud: fullstack + devops + платформенные роли наверху abroad.
 *  — pm_without_work: product_manager в обоих, product_analyst / business_analyst близко.
 *  — manual_qa_ru: manual_testing guaranteed (current), qa_engineer в топе; вне guaranteed
 *    manual_testing нигде не должен появляться.
 */

function baseSummary(partial: Partial<ClientSummary>): ClientSummary {
  return {
    firstName: "—", lastName: "—", firstNameLatin: "—", lastNameLatin: "—",
    telegramNick: "—",
    citizenships: [],
    location: "—", physicalCountry: "", englishLevel: "B1", linkedinSSI: "—",
    targetMarketRegions: [],
    accessibleMarkets: [],
    currentProfession: "—", yearsExperience: "—", currentSalary: "—",
    goal: "—",
    desiredSalary: "—", desiredSalary3to5y: "—",
    desiredDirections: "—", targetFieldExperience: "—",
    retrainingReadiness: "—", weeklyHours: "—",
    highlights: [],
    resumeUrls: [],
    linkedinUrl: null,
    ...partial,
    selectedTargetRoles: partial.selectedTargetRoles ?? [],
  };
}

const FIXTURES: { name: string; summary: ClientSummary }[] = [
  {
    name: "raumfahrer — non-IT + ML (EU only)",
    summary: baseSummary({
      firstNameLatin: "Raum", lastNameLatin: "Fahrer",
      citizenships: ["Germany"], location: "Berlin, Germany", physicalCountry: "Germany",
      englishLevel: "B2", targetMarketRegions: ["eu"],
      currentProfession: "Doctoral researcher in neuroscience",
      currentProfessionSlug: null,
      currentSalary: "2500 EUR", currentSalaryEur: 2500,
      desiredSalary: "4000 EUR", desiredSalaryEur: 4000,
      desiredDirections: "Data Science, ML, Backend Python",
      desiredDirectionSlugs: [
        { slug: "ml_engineer", confidence: 0.95, raw: "Data Science" },
        { slug: "ml_engineer", confidence: 0.9, raw: "ML" },
        { slug: "backend_python", confidence: 0.7, raw: "Backend Python" },
      ],
    }),
  },
  {
    name: "flutter_dev_ru — mobile Flutter (RU only)",
    summary: baseSummary({
      firstNameLatin: "Flutter", lastNameLatin: "Dev",
      citizenships: ["Russia"], location: "Москва, Россия", physicalCountry: "Russia",
      englishLevel: "B1", targetMarketRegions: ["ru"],
      currentProfession: "Flutter разработчик",
      currentProfessionSlug: "mobileapp_flutter",
      currentSalary: "250000 RUB", currentSalaryRub: 250000,
      desiredSalary: "350000 RUB", desiredSalaryRub: 350000,
      desiredDirections: "Flutter, Android",
      desiredDirectionSlugs: [
        { slug: "mobileapp_flutter", confidence: 1.0, raw: "Flutter" },
        { slug: "mobileapp_kotlin", confidence: 0.7, raw: "Android" },
      ],
    }),
  },
  {
    name: "php_ru — PHP backend (RU only)",
    summary: baseSummary({
      firstNameLatin: "Eva", lastNameLatin: "Titova",
      citizenships: ["Russia"], location: "СПб, Россия", physicalCountry: "Russia",
      englishLevel: "A2", targetMarketRegions: ["ru"],
      currentProfession: "PHP разработчик",
      currentProfessionSlug: "backend_php",
      currentSalary: "220000 RUB", currentSalaryRub: 220000,
      desiredSalary: "300000 RUB", desiredSalaryRub: 300000,
      desiredDirections: "PHP backend, Node.js",
      desiredDirectionSlugs: [
        { slug: "backend_php", confidence: 1.0, raw: "PHP backend" },
        { slug: "backend_nodejs", confidence: 0.7, raw: "Node.js" },
      ],
    }),
  },
  {
    name: "ruby_ru_to_eu — Ruby, RU+EU",
    summary: baseSummary({
      firstNameLatin: "Aa", lastNameLatin: "Voron",
      citizenships: ["Russia"], location: "Москва, Россия", physicalCountry: "Russia",
      englishLevel: "B2", targetMarketRegions: ["ru", "eu"],
      currentProfession: "Ruby разработчик",
      currentProfessionSlug: "backend_ruby",
      currentSalary: "280000 RUB", currentSalaryRub: 280000,
      desiredSalary: "400000 RUB / 4500 EUR",
      desiredSalaryRub: 400000, desiredSalaryEur: 4500,
      desiredDirections: "Ruby, Go",
      desiredDirectionSlugs: [
        { slug: "backend_ruby", confidence: 1.0, raw: "Ruby" },
        { slug: "backend_go", confidence: 0.7, raw: "Go" },
      ],
    }),
  },
  {
    name: "fullstack_cloud — fullstack+cloud (EU only)",
    summary: baseSummary({
      firstNameLatin: "La", lastNameLatin: "Kookoo",
      citizenships: ["Germany"], location: "Berlin, Germany", physicalCountry: "Germany",
      englishLevel: "C1", targetMarketRegions: ["eu"],
      currentProfession: "Full-stack Developer",
      currentProfessionSlug: "fullstack",
      currentSalary: "5000 EUR", currentSalaryEur: 5000,
      desiredSalary: "7000 EUR", desiredSalaryEur: 7000,
      desiredDirections: "Fullstack, DevOps, Backend Python",
      desiredDirectionSlugs: [
        { slug: "fullstack", confidence: 1.0, raw: "Fullstack" },
        { slug: "devops", confidence: 0.8, raw: "DevOps" },
        { slug: "backend_python", confidence: 0.7, raw: "Backend Python" },
      ],
    }),
  },
  {
    name: "pm_without_work — Product Manager (RU+EU)",
    summary: baseSummary({
      firstNameLatin: "Gora", lastNameLatin: "Lena",
      citizenships: ["Russia"], location: "Москва, Россия", physicalCountry: "Russia",
      englishLevel: "B2", targetMarketRegions: ["ru", "eu"],
      currentProfession: "Product Manager",
      currentProfessionSlug: "product_manager",
      currentSalary: "—",
      desiredSalary: "300000 RUB / 4000 EUR",
      desiredSalaryRub: 300000, desiredSalaryEur: 4000,
      desiredDirections: "Product Manager, Product Analyst",
      desiredDirectionSlugs: [
        { slug: "product_manager", confidence: 1.0, raw: "Product Manager" },
        { slug: "product_analyst", confidence: 0.8, raw: "Product Analyst" },
      ],
    }),
  },
  {
    name: "manual_qa_ru — Manual QA (RU only, extreme AI risk)",
    summary: baseSummary({
      firstNameLatin: "Manu", lastNameLatin: "QA",
      citizenships: ["Russia"], location: "Москва, Россия", physicalCountry: "Russia",
      englishLevel: "A2", targetMarketRegions: ["ru"],
      currentProfession: "Manual QA",
      currentProfessionSlug: "manual_testing",
      currentSalary: "120000 RUB", currentSalaryRub: 120000,
      desiredSalary: "200000 RUB", desiredSalaryRub: 200000,
      desiredDirections: "QA Automation",
      desiredDirectionSlugs: [
        { slug: "qa_engineer", confidence: 0.9, raw: "QA Automation" },
      ],
    }),
  },
];

function pad(s: string, n: number): string {
  if (s.length >= n) return s.slice(0, n);
  return s + " ".repeat(n - s.length);
}

function fmtRow(i: number, r: ScoredRole): string {
  const tag = r.guaranteed ? " ✱" : "  ";
  const slug = pad(r.slug, 24);
  const s = pad(String(r.score), 4);
  const parts: string[] = [
    `m${r.components.market}`,
    `c${r.components.competition ?? "—"}`,
    `s${r.components.salary}`,
    `ai${r.components.aiRisk}`,
    `adj${r.components.adjacency}`,
  ];
  const comps = pad(parts.join(" "), 32);
  return `    ${String(i + 1).padStart(2)}. ${tag} ${slug} ${s} ${comps} ${r.reasons.join(", ")}`;
}

async function main() {
  for (const { name, summary } of FIXTURES) {
    console.log(`\n━━━ ${name} ━━━`);
    const { ru, abroad, buckets } = await rankRoles(summary, 15);
    console.log(`  buckets: ${JSON.stringify({ ru: buckets.ru, abroad: buckets.abroad })}  (${buckets.reason})`);

    if (ru.length) {
      console.log(`  RU top-${ru.length}:`);
      ru.forEach((r, i) => console.log(fmtRow(i, r)));
    } else {
      console.log("  RU: — (bucket off)");
    }

    if (abroad.length) {
      console.log(`  abroad top-${abroad.length}:`);
      abroad.forEach((r, i) => console.log(fmtRow(i, r)));
    } else {
      console.log("  abroad: — (bucket off)");
    }
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
