/**
 * Canonical list of snake_case role slugs with scraped market data
 * (hh.ru + itjobswatch). Single source of truth, extracted into its own
 * file to avoid circular imports (schemas/analysis-outputs → market-data-service
 * → schemas/analysis-outputs).
 *
 * Used as:
 *   - `z.enum(KNOWN_ROLES)` in `directionSchema` (role-slug validation)
 *   - keys of `RU_TITLE_VARIANTS` / `ITJW_SEARCH_MAP`
 *   - filenames: `ru_<slug>.md`, `uk_<slug>.md`
 *   - `REGISTRY` in `build-market-index.ts`
 *
 * DevOps cluster (SRE / MLOps / Platform Engineer) is intentionally collapsed
 * into the single `devops` slug.
 */
export const KNOWN_ROLES = [
  // Backend
  "backend_python", "backend_java", "backend_go", "backend_nodejs",
  "backend_net", "backend_php", "backend_ruby", "backend_rust", "backend_cplusplus",
  // Frontend + Fullstack
  "frontend_react", "frontend_vue", "frontend_angular", "fullstack",
  // Mobile
  "mobileapp_swift", "mobileapp_kotlin", "mobileapp_flutter", "mobileapp_react_native",
  // Infra (DevOps / SRE / Platform Engineer — merged cluster)
  "devops",
  // Data / ML (ml_engineer merged with data_scientist)
  "data_engineer", "ml_engineer", "data_analyst", "product_analyst",
  // QA
  "qa_engineer", "manual_testing",
  // Management / Architecture
  "product_manager", "project_manager", "tech_lead",
  "software_architect",
  // Analysis (non-data)
  "business_analyst", "systems_analyst",
  // Design / Marketing / HR / Docs
  "ui_ux_designer", "marketing_manager", "recruiter", "technical_writer",
  // Security
  "infosecspec",
  // Infra / Support
  "system_admin", "tech_support_manager",
  // Other
  "1c_developer", "gamedev_unity", "web3_developer",
] as const;

export type KnownRoleSlug = (typeof KNOWN_ROLES)[number];
