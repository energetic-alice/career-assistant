import type { ClientSummary } from "../../schemas/client-summary.js";
import type { ResumeVersion } from "../../pipeline/intake.js";
import { fetchLinkedinProfile, type LinkedinProfile } from "../linkedin-fetcher.js";
import { loadCachedLinkedin, saveCachedLinkedin } from "../linkedin-pack/build-inputs.js";

/**
 * Сбор входных данных для Resume Pack pipeline.
 *
 * Резюме — **обязательное** входное. Если его нет, кидаем
 * `ResumePackInputError` (в отличие от LinkedIn-пака, где можно
 * запускаться по одному только LinkedIn). Без текста резюме аудит делать
 * нечего.
 *
 * LinkedIn — опциональный дополнительный источник: используется чтобы
 * подсветить расхождения дат/title/Skills между резюме и LinkedIn,
 * и подставить готовый `linkedin.com/in/...` URL в рекомендацию пункта 5.
 * Если LinkedIn не доступен — пайплайн всё равно работает.
 */

export interface ResumePackInput {
  participantId: string;
  nick: string;
  clientSummary: ClientSummary | null;
  /** Текст последней версии резюме + ID версии. */
  resume: {
    text: string;
    versionId: string | null;
  };
  /** LinkedIn-профиль для cross-check (опционально). */
  linkedin: LinkedinProfile | null;
  linkedinUrl: string | null;
}

export interface BuildResumePackInputsArgs {
  participantId: string;
  nick: string;
  /** Может быть null для внешнего человека вне КА-программы. */
  clientSummary: ClientSummary | null;
  resumeVersions: ResumeVersion[];
  activeResumeVersionId?: string | null;
  /** Явный URL, если передаёшь из UI/CLI; иначе берём из clientSummary. */
  linkedinUrlOverride?: string | null;
}

export class ResumePackInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ResumePackInputError";
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

export async function buildResumePackInputs(
  args: BuildResumePackInputsArgs,
): Promise<ResumePackInput> {
  const primary = pickPrimaryResume(args.resumeVersions, args.activeResumeVersionId);
  if (!primary) {
    throw new ResumePackInputError(
      "Нет резюме у клиента. Загрузи резюме (PDF/DOCX/текст) и запусти снова.",
    );
  }

  const linkedinUrl =
    (args.linkedinUrlOverride ?? "").trim() ||
    (args.clientSummary?.linkedinUrl ?? "").trim() ||
    null;

  let linkedin: LinkedinProfile | null = null;
  if (linkedinUrl) {
    // Используем тот же disk-cache, что и LinkedIn-пак (`data/documents/
    // <pid>/linkedin-profile.json`) — один кэш, обновляется любым из двух
    // паков. TTL 180 дней, инвалидируется при смене Apify-актора.
    const cached = loadCachedLinkedin(args.participantId, linkedinUrl);
    if (cached) {
      console.log(
        `[ResumePack] Using cached linkedin profile for ${args.participantId} (${linkedinUrl})`,
      );
      linkedin = cached;
    } else {
      try {
        linkedin = await fetchLinkedinProfile(linkedinUrl);
        if (linkedin) {
          saveCachedLinkedin(args.participantId, linkedin);
        }
      } catch (err) {
        console.warn(
          `[ResumePack] LinkedIn fetch failed for ${linkedinUrl}: ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
        linkedin = null;
      }
    }
  }

  return {
    participantId: args.participantId,
    nick: args.nick,
    clientSummary: args.clientSummary,
    resume: { text: primary.text, versionId: primary.id },
    linkedin,
    linkedinUrl: linkedinUrl || null,
  };
}

/**
 * Краткое summary клиента для промпта (используется в audit). Один в один с
 * `summariseClientSummary` из linkedin-pack — повторяем мини-копию, чтобы
 * не плодить cross-package import; при расхождении методологий рынка/языка
 * проще держать копию здесь.
 */
export function summariseClientSummary(c: ClientSummary | null): string {
  if (!c) {
    return [
      "Клиент пришёл без анкеты КА-программы (внешний человек или probe-запуск).",
      "Target-роль, рынок, грейд и контакты выведи из самого резюме (job title в шапке, последняя позиция, локация, телефон, язык резюме).",
      "Если резюме на английском + локация зарубежная → target abroad.",
      "Если резюме на русском + Москва/+7 → target ru (вероятно HeadHunter).",
    ].join("\n");
  }

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
  if (c.currentProfession && c.currentProfession !== "—") {
    lines.push(`Current profession: ${c.currentProfession}`);
  }
  if (c.yearsExperience && c.yearsExperience !== "—") {
    lines.push(`Years of experience: ${c.yearsExperience}`);
  }
  if (c.currentGrade) lines.push(`Current grade: ${c.currentGrade}`);
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
