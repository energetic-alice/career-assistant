import { matchRoleToSlug, matchMultiple } from "../services/role-matcher.js";

/**
 * Fixture-based sanity check for role-matcher.
 *
 *   npx tsx src/scripts/test-role-matcher.ts
 *
 * Exits non-zero if precision < 0.8.
 */

type Case = { input: string; expect: string | null };

const SINGLE: Case[] = [
  // backend
  { input: "Python разработчик", expect: "backend_python" },
  { input: "Backend Python", expect: "backend_python" },
  { input: "Python developer", expect: "backend_python" },
  { input: "FastAPI разработчик", expect: "backend_python" },
  { input: "Golang разработчик", expect: "backend_go" },
  { input: "Go Developer", expect: "backend_go" },
  { input: "Java разработчик", expect: "backend_java" },
  { input: "C# .NET разработчик", expect: "backend_net" },

  // frontend
  { input: "React разработчик", expect: "frontend_react" },
  { input: "React Frontend", expect: "frontend_react" },
  { input: "Vue.js developer", expect: "frontend_vue" },
  { input: "Angular инженер", expect: "frontend_angular" },
  { input: "Фронтенд React", expect: "frontend_react" },

  // management / analyst
  { input: "Менеджер проектов", expect: "project_manager" },
  { input: "Project Manager", expect: "project_manager" },
  { input: "Руководитель проекта", expect: "project_manager" },
  { input: "Product Manager", expect: "product_manager" },
  { input: "Менеджер продукта", expect: "product_manager" },
  { input: "Продакт менеджер", expect: "product_manager" },
  { input: "Системный аналитик", expect: "systems_analyst" },
  { input: "Бизнес-аналитик", expect: "business_analyst" },
  { input: "Аналитик данных", expect: "data_analyst" },
  { input: "Data Scientist", expect: "ml_engineer" },
  { input: "ML инженер", expect: "ml_engineer" },
  { input: "DevOps инженер", expect: "devops" },
  { input: "SRE", expect: "devops" },

  // mobile
  { input: "iOS разработчик Swift", expect: "mobileapp_swift" },
  { input: "Android kotlin developer", expect: "mobileapp_kotlin" },
  { input: "React Native developer", expect: "mobileapp_react_native" },
  { input: "Flutter developer", expect: "mobileapp_flutter" },

  // EM vs TL
  { input: "Тимлид", expect: "tech_lead" },
  { input: "Tech Lead", expect: "tech_lead" },
  { input: "Engineering Manager", expect: "tech_lead" },
  { input: "Head of Engineering", expect: "tech_lead" },

  // design / qa
  { input: "UX/UI дизайнер", expect: "ui_ux_designer" },
  { input: "Product Designer", expect: "ui_ux_designer" },
  { input: "Автоматизатор тестирования", expect: "qa_engineer" },
  { input: "Тестировщик", expect: "manual_testing" },

  // adjacent (no market data, but canonical slug still exists)
  { input: "Системный администратор", expect: "system_admin" },
  { input: "Sysadmin", expect: "system_admin" },
  { input: "Инженер техподдержки", expect: "tech_support_manager" },
  { input: "IT support", expect: "tech_support_manager" },

  // typos / shortened
  { input: "Python разарботчик", expect: "backend_python" }, // typo
  { input: "devops", expect: "devops" },

  // non-IT → null (leave raw)
  { input: "Doctoral researcher in neuroscience", expect: null },
  { input: "Врач-невролог", expect: null },
  { input: "Юрист", expect: null },
  { input: "Маникюрша", expect: null },
  { input: "Повар", expect: null },
];

async function main(): Promise<void> {
  let pass = 0;
  let fail = 0;
  const failures: string[] = [];
  for (const { input, expect } of SINGLE) {
    const hit = await matchRoleToSlug(input);
    const got = hit?.slug ?? null;
    const ok = got === expect;
    if (ok) {
      pass++;
      console.log(
        `  OK  "${input}" → ${got ?? "<none>"} (${hit ? hit.confidence : "-"}, via "${hit?.matchedAlias ?? "-"}")`,
      );
    } else {
      fail++;
      failures.push(`  FAIL  "${input}" → got ${got ?? "<none>"}, expected ${expect ?? "<none>"}`);
    }
  }

  console.log("\n— Multi-match —");
  const multi = await matchMultiple("Backend Python, React Frontend и Data Analyst");
  console.log("Input: 'Backend Python, React Frontend и Data Analyst'");
  for (const m of multi) {
    console.log(`  → ${m.slug} (${m.confidence}, "${m.matchedAlias}" from "${m.raw}")`);
  }
  const multiSlugs = new Set(multi.map((m) => m.slug));
  const multiOk =
    multiSlugs.has("backend_python") &&
    multiSlugs.has("frontend_react") &&
    multiSlugs.has("data_analyst");
  if (multiOk) {
    pass++;
    console.log("  OK multi-match");
  } else {
    fail++;
    failures.push("  FAIL multi-match");
  }

  const total = pass + fail;
  const ratio = pass / total;
  console.log(`\nResult: ${pass}/${total} (${Math.round(ratio * 100)}%)`);
  if (failures.length) {
    console.log("\nFailures:");
    for (const f of failures) console.log(f);
  }
  if (ratio < 0.8) {
    console.error(`\nFAILED: precision ${Math.round(ratio * 100)}% < 80%`);
    process.exit(1);
  }
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
