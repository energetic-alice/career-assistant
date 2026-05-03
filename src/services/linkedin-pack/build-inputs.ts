import type { ClientSummary } from "../../schemas/client-summary.js";
import type { ResumeVersion } from "../../pipeline/intake.js";
import { fetchLinkedinProfile, type LinkedinProfile } from "../linkedin-fetcher.js";
import { loadDocument, saveDocument } from "../state-store.js";

/**
 * Имя файла-кеша на диске: `data/documents/<participantId>/linkedin-profile.json`.
 * Храним ТУ ЖЕ структуру, что возвращает `fetchLinkedinProfile` — готовый
 * LinkedinProfile-объект (url, source, headline, location, fetchedAt, text),
 * где `text` — pretty-printed JSON от Apify (basic_info / experience / education /
 * languages). Имя фиксировано, по одному файлу на клиента.
 */
const LINKEDIN_CACHE_FILENAME = "linkedin-profile.json";

/**
 * Сколько живёт кеш по умолчанию. LinkedIn данные редко меняются; Apify —
 * платный, не хочется дёргать каждый запуск LinkedIn-пака. Если клиент
 * обновил профиль — куратор удалит файл вручную или мы добавим «Обновить
 * LinkedIn» кнопку позже.
 */
const LINKEDIN_CACHE_TTL_DAYS = 180;

/**
 * Сбор входных данных для LinkedIn Pack pipeline.
 *
 * Требование: хотя бы что-то одно — LinkedIn ИЛИ резюме. Если ни того, ни
 * другого нет, кидаем `LinkedinPackInputError`, вызыватель покажет tost'ом
 * «нужна или ссылка на LinkedIn, или резюме».
 *
 * LinkedIn fetch не critical: если упал — продолжаем с резюме и помечаем
 * `usedLinkedinProfile=false`. Аудит в этом случае выдаст `unknown` для
 * всех пунктов что живут только на LinkedIn (фото, баннер, URL, endorsements
 * и т.п.) — модель сама пропишет «проверь руками».
 */

export interface LinkedinPackInput {
  participantId: string;
  nick: string;
  clientSummary: ClientSummary;
  linkedin: LinkedinProfile | null;
  linkedinUrl: string | null;
  resume: {
    text: string;
    versionId: string | null;
  } | null;
}

export interface BuildLinkedinPackInputsArgs {
  participantId: string;
  nick: string;
  clientSummary: ClientSummary;
  resumeVersions: ResumeVersion[];
  activeResumeVersionId?: string | null;
  /** Явный URL, если передаёшь из UI/CLI; иначе берём из clientSummary. */
  linkedinUrlOverride?: string | null;
}

export class LinkedinPackInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LinkedinPackInputError";
  }
}

function pickPrimaryResume(
  versions: ResumeVersion[],
  activeId?: string | null,
): ResumeVersion | null {
  if (!Array.isArray(versions) || versions.length === 0) return null;
  if (activeId) {
    const active = versions.find((v) => v.id === activeId);
    if (active) return active;
  }
  return versions[versions.length - 1];
}

export async function buildLinkedinPackInputs(
  args: BuildLinkedinPackInputsArgs,
): Promise<LinkedinPackInput> {
  const linkedinUrl =
    (args.linkedinUrlOverride ?? "").trim() ||
    (args.clientSummary.linkedinUrl ?? "").trim() ||
    null;

  let linkedin: LinkedinProfile | null = null;
  if (linkedinUrl) {
    try {
      linkedin = await fetchLinkedinProfile(linkedinUrl);
    } catch (err) {
      console.warn(
        `[LinkedinPack] LinkedIn fetch failed for ${linkedinUrl}: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
      linkedin = null;
    }
  }

  const primary = pickPrimaryResume(args.resumeVersions, args.activeResumeVersionId);
  const resume = primary
    ? { text: primary.text, versionId: primary.id }
    : null;

  if (!linkedin && !resume) {
    throw new LinkedinPackInputError(
      "Нужна или ссылка на LinkedIn, или резюме. Добавь хотя бы что-то одно в карточке клиента и запусти снова.",
    );
  }

  return {
    participantId: args.participantId,
    nick: args.nick,
    clientSummary: args.clientSummary,
    linkedin,
    linkedinUrl: linkedinUrl || null,
    resume,
  };
}

/* ── LinkedIn cache on disk ────────────────────────────────────────────── */

/**
 * Нормализуем для сравнения: убираем query/hash, trailing slash, lowercase.
 * LinkedIn URL часто приходят то со слэшем, то без, то с `?trackingId=` —
 * всё это один и тот же профиль.
 */
function normalizeUrlForCompare(u: string): string {
  try {
    const parsed = new URL(u.trim());
    parsed.search = "";
    parsed.hash = "";
    return parsed.toString().replace(/\/$/, "").toLowerCase();
  } catch {
    return u.trim().replace(/\/$/, "").toLowerCase();
  }
}

export function loadCachedLinkedin(
  participantId: string,
  url: string,
): LinkedinProfile | null {
  const doc = loadDocument(participantId, LINKEDIN_CACHE_FILENAME);
  if (!doc) return null;

  let parsed: LinkedinProfile;
  try {
    parsed = JSON.parse(doc.content) as LinkedinProfile;
  } catch {
    console.warn(
      `[LinkedinPack] Cached linkedin-profile.json is not valid JSON for ${participantId}, ignoring`,
    );
    return null;
  }

  if (!parsed || typeof parsed !== "object") return null;
  if (typeof parsed.text !== "string" || parsed.text.length < 200) return null;
  if (
    typeof parsed.url !== "string" ||
    normalizeUrlForCompare(parsed.url) !== normalizeUrlForCompare(url)
  ) {
    console.log(
      `[LinkedinPack] Cached linkedin URL mismatch (${parsed.url} vs ${url}), refetching`,
    );
    return null;
  }

  const ageMs = Date.now() - doc.mtime.getTime();
  const ageDays = ageMs / (1000 * 60 * 60 * 24);
  if (ageDays > LINKEDIN_CACHE_TTL_DAYS) {
    console.log(
      `[LinkedinPack] Cached linkedin is ${ageDays.toFixed(1)}d old (> ${LINKEDIN_CACHE_TTL_DAYS}), refetching`,
    );
    return null;
  }

  return parsed;
}

export function saveCachedLinkedin(
  participantId: string,
  profile: LinkedinProfile,
): void {
  try {
    saveDocument(
      participantId,
      LINKEDIN_CACHE_FILENAME,
      JSON.stringify(profile, null, 2),
    );
  } catch (err) {
    console.warn(
      `[LinkedinPack] Failed to cache linkedin-profile.json for ${participantId}:`,
      err,
    );
  }
}

/**
 * Краткое текстовое summary для промпта (используется и в audit, и в headline).
 */
export function summariseClientSummary(c: ClientSummary): string {
  const lines: string[] = [];
  const fullNameLatin =
    [c.firstNameLatin, c.lastNameLatin].filter(Boolean).join(" ").trim();
  const fullNameNative =
    [c.firstName, c.lastName].filter(Boolean).join(" ").trim();
  if (fullNameLatin) lines.push(`Name (Latin): ${fullNameLatin}`);
  if (fullNameNative) lines.push(`Name (native): ${fullNameNative}`);
  lines.push(`Telegram: @${c.telegramNick}`);
  if (c.location && c.location !== "—") lines.push(`Location: ${c.location}`);
  if (c.physicalCountry) lines.push(`Physical country: ${c.physicalCountry}`);
  if (c.citizenships?.length) lines.push(`Citizenships: ${c.citizenships.join(", ")}`);
  if (c.englishLevel && c.englishLevel !== "—") lines.push(`English: ${c.englishLevel}`);
  if (c.linkedinSSI && c.linkedinSSI !== "—") lines.push(`Current SSI: ${c.linkedinSSI}`);
  if (c.currentProfession && c.currentProfession !== "—") {
    lines.push(`Current profession: ${c.currentProfession}`);
  }
  if (c.yearsExperience && c.yearsExperience !== "—") {
    lines.push(`Years of experience: ${c.yearsExperience}`);
  }
  if (c.currentGrade) {
    lines.push(`Current grade: ${c.currentGrade}`);
  }
  if (c.goal && c.goal !== "—") lines.push(`Career goal: ${c.goal}`);
  if (c.desiredDirections && c.desiredDirections !== "—") {
    lines.push(`Desired directions: ${c.desiredDirections}`);
  }
  const regions = c.targetMarketRegions ?? [];
  if (regions.length) lines.push(`Target market regions: ${regions.join(", ")}`);
  const selectedRoles = (c.selectedTargetRoles ?? [])
    .map((r) => r.title || r.id)
    .filter(Boolean);
  if (selectedRoles.length) {
    lines.push(`Selected target roles: ${selectedRoles.join(", ")}`);
  }
  if (c.highlights?.length) {
    lines.push(`Highlights:`);
    for (const h of c.highlights.slice(0, 5)) lines.push(`- ${h}`);
  }
  return lines.join("\n");
}
