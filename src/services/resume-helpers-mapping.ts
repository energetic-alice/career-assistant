import type { KnownRoleSlug } from "./known-roles.js";

/**
 * Maps folder names inside `resume_helpers/*.zip` (HH top-10 dumps) to
 * canonical role slugs from `KNOWN_ROLES`.
 *
 * Several source folders may map to the same canonical slug — that's OK,
 * we just get a bigger sample for that role (e.g. Data Scientist + ML
 * → both feed `ml_engineer`).
 *
 * Roles from `KNOWN_ROLES` not listed here have no HH base (e.g. fullstack,
 * tech_lead, software_architect, ui_ux_designer, …). For them the
 * resume-pattern step gracefully degrades.
 */
export const RESUME_HELPERS_MAPPING: Record<string, KnownRoleSlug> = {
  "1С": "1c_developer",
  AQA: "qa_engineer",
  Android: "mobileapp_kotlin",
  "Bussines Analyst": "business_analyst",
  "C#": "backend_net",
  "C++": "backend_cplusplus",
  "Data Analyst": "data_analyst",
  "Data Engineer": "data_engineer",
  "Data Scientist": "ml_engineer",
  DevOps: "devops",
  Flutter: "mobileapp_flutter",
  Frontend: "frontend_react",
  Golang: "backend_go",
  IOS: "mobileapp_swift",
  Java: "backend_java",
  ML: "ml_engineer",
  NodeJS: "backend_nodejs",
  PHP: "backend_php",
  "Product Analyst": "product_analyst",
  "Product Manager": "product_manager",
  Python: "backend_python",
  QA: "manual_testing",
  "System Analyst": "systems_analyst",
};

/** Reverse lookup: slug → list of source folder names that feed it. */
export function sourceFoldersForSlug(slug: KnownRoleSlug): string[] {
  return Object.entries(RESUME_HELPERS_MAPPING)
    .filter(([, value]) => value === slug)
    .map(([key]) => key);
}
