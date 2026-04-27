/**
 * Локальный smoke на M1+M4: проверяем, что
 *   - `directionKey` не клонирует ключ для разных title под одним slug;
 *   - `extractKeywords`/`anyCitationRelevant` правильно отсеивают мусорные
 *     citations типа `talent.com/digital+technician` для "Security AppSec".
 *
 * Без сети, без прод-state. Чисто проверка чистых функций.
 *
 *   npx tsx src/scripts/probe-market-research-units.ts
 */

import { directionKey } from "../services/deep-research-service.js";
import {
  anyCitationRelevant,
  extractKeywords,
  isCitationRelevant,
} from "../services/market-research/validate-relevance.js";

let pass = 0;
let fail = 0;

function assert(cond: boolean, name: string, detail?: string): void {
  if (cond) {
    pass++;
    console.log(`  ✓ ${name}`);
  } else {
    fail++;
    console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

console.log("== directionKey: per-direction уникальность ==");

const daria = [
  { title: "Security Engineer, AppSec", roleSlug: "infosecspec", bucket: "abroad" as const },
  { title: "DevSecOps Engineer", roleSlug: "infosecspec", bucket: "abroad" as const },
  { title: "Security Analyst, SOC", roleSlug: "infosecspec", bucket: "abroad" as const },
];
const keys = daria.map(directionKey);
assert(new Set(keys).size === 3, "Daria: 3 разные title под одним slug → 3 разных key", `keys=${JSON.stringify(keys)}`);
assert(
  directionKey({ title: "DevOps Engineer", roleSlug: "devops", bucket: "ru" }) !==
  directionKey({ title: "DevOps Engineer", roleSlug: "devops", bucket: "abroad" }),
  "одинаковый title в разных bucket → разные ключи",
);
assert(
  directionKey({ title: "  Foo  ", roleSlug: "x", bucket: "ru" }) ===
  directionKey({ title: "foo", roleSlug: "x", bucket: "ru" }),
  "title нормализуется (trim+lowercase)",
);
assert(
  directionKey({ title: "", roleSlug: "frontend_react", bucket: "ru" }) === "frontend_react|ru",
  "пустой title → fallback на slug|bucket",
);

console.log("\n== extractKeywords ==");

const kwAppsec = extractKeywords("Security Engineer, AppSec (senior)");
assert(kwAppsec.includes("security"), "AppSec: 'security' в keywords", JSON.stringify(kwAppsec));
assert(kwAppsec.includes("appsec"), "AppSec: 'appsec' в keywords", JSON.stringify(kwAppsec));
assert(!kwAppsec.includes("senior"), "AppSec: 'senior' отсеивается как стоп-слово");

const kwSoc = extractKeywords("Security Analyst, SOC");
assert(kwSoc.includes("soc"), "SOC: 'soc' остаётся keyword'ом");

const kwDevops = extractKeywords("DevSecOps Engineer");
assert(kwDevops.includes("devsecops"), "DevSecOps: 'devsecops' в keywords");

const kwRu = extractKeywords("Аналитик данных");
assert(kwRu.length > 0, "русский title даёт хоть какие-то keywords (translit)", JSON.stringify(kwRu));

console.log("\n== isCitationRelevant ==");

const appsecKeywords = extractKeywords("Security Engineer, AppSec (senior)");
assert(
  !isCitationRelevant(
    "https://www.talent.com/salary?job=digital+technician",
    undefined,
    appsecKeywords,
  ),
  "Daria-like мусорный citation 'digital+technician' для AppSec → НЕ релевантен",
);
assert(
  isCitationRelevant(
    "https://www.itjobswatch.co.uk/jobs/uk/application%20security%20engineer.do",
    undefined,
    appsecKeywords,
  ),
  "itjobswatch /application security/ → релевантен",
);
assert(
  isCitationRelevant(
    "https://glassdoor.com/Salaries/security-engineer-salary",
    undefined,
    appsecKeywords,
  ),
  "glassdoor security-engineer → релевантен",
);

const socKeywords = extractKeywords("Security Analyst, SOC");
assert(
  isCitationRelevant("https://example.com/soc-analyst-salary", undefined, socKeywords),
  "soc-analyst URL → релевантен для SOC",
);
assert(
  !isCitationRelevant(
    "https://www.ziprecruiter.com/Salaries/Digital-Technology-Salary",
    undefined,
    socKeywords,
  ),
  "ziprecruiter Digital-Technology → НЕ релевантен для SOC",
);

console.log("\n== anyCitationRelevant ==");

assert(
  !anyCitationRelevant(
    [
      "https://www.talent.com/salary?job=digital+technician",
      "https://www.ziprecruiter.com/Salaries/Digital-Technology-Salary",
    ],
    appsecKeywords,
  ),
  "вся группа мусорных citations → НЕ проходит gate",
);
assert(
  anyCitationRelevant(
    [
      "https://www.talent.com/salary?job=digital+technician",
      "https://www.itjobswatch.co.uk/jobs/uk/appsec.do",
    ],
    appsecKeywords,
  ),
  "хотя бы один релевантный → проходит gate",
);
assert(
  !anyCitationRelevant([], extractKeywords("Security role")),
  "пустой массив citations с известными keywords → gate false (нет ни одной релевантной); валидатор отдельно решает не дропать числа когда citations.length===0",
);
assert(
  anyCitationRelevant(["http://random.com"], []),
  "пустые keywords → gate всегда true (защита от слишком общих заголовков)",
);

console.log("\n");
console.log(`Result: ${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
