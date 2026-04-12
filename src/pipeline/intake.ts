import crypto from "node:crypto";
import type { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import {
  rawQuestionnaireSchema,
  toAnalysisInput,
  type RawQuestionnaire,
  type AnalysisInput,
} from "../schemas/participant.js";
import type { PipelineState } from "../schemas/pipeline-state.js";
import {
  downloadFromGoogleDrive,
  extractResumeText,
} from "../services/file-service.js";
import {
  runAnalysisPhase1,
  type AnalysisPipelineInput,
} from "./run-analysis.js";
import { sendReviewToAdmin } from "../bot/admin-review.js";
import { getBot } from "../bot/bot-instance.js";

/**
 * Maps Google Forms column headers (from namedValues) to our internal field names.
 * Order follows the questionnaire form exactly.
 */
const COLUMN_MAP: Record<string, keyof RawQuestionnaire> = {
  "Timestamp": "timestamp",
  "Отметка времени": "timestamp",
  "Твой ник в телеграм": "telegramNick",
  "Где ты сейчас?": "itStatus",
  "Какое у тебя гражданство?": "citizenship",
  "В какой стране и каком городе ты живешь сейчас?": "currentLocation",
  "На какую страну или страны ты планируешь работать?": "targetCountries",
  "Твой идеальный формат работы": "workFormat",
  "А как у тебя с английским?": "englishLevel",
  "Какое у тебя высшее образование?": "education",
  "Чем ты занимаешься сейчас?": "currentOccupation",
  "Кем ты работаешь сейчас и сколько зарабатываешь? (до налогов)":
    "currentJobAndSalary",
  "Сколько у тебя опыта в текущей профессии?": "yearsExperience",
  "А сколько хочешь зарабатывать и в какой валюте?": "desiredSalary",
  "А сколько хочешь зарабатывать через 3-5 лет?": "desiredSalary3to5y",
  "Почему твой выбор пал именно на Карьерный акселератор? Что для тебя самое важное в программе, что зацепило?":
    "whyAccelerator",
  "Почему твой выбор пал именно на работу с Алисой? Что для тебя самое важное, что зацепило?":
    "whyAccelerator",
  "Какой результат ты хочешь получить на программе?": "desiredResult",
  "Какой результат ты хочешь получить от работы с Алисой?": "desiredResult",
  "Есть ли у тебя уже пожелания или интерес какими направлениями хотелось бы заниматься?":
    "directionInterest",
  "Расскажи подробно, почему именно это направление? Что в нем привлекает?":
    "whyThisDirection",
  "Насколько ты готов(а) к переобучению?": "retrainingReadiness",
  "Сколько времени можешь уделять поиску работы и переквалификации (при необходимости)? В часах в неделю":
    "weeklyHours",
  "Опиши свою текущую карьерную ситуацию максимально подробно - что не нравится и какой главный затык":
    "currentSituation",
  "Какие карьерные цели для тебя наиболее важны в ближайший год? (рост дохода, смена работы, повышение квалификации и т. д.)":
    "careerGoals",
  "Были ли уже попытки что-то изменить в текущей ситуации, поменять работу, что-то доучить? Напиши максимально подробно":
    "previousAttempts",
  "Как ты относишься к коммуникации и созвонам?": "communicationStyle",
  "К какому уровню ты интуитивно стремишься в горизонте 3-5 лет: сильный индивидуальный специалист, тимлид/менеджер, эксперт‑консультант (без команды), свой продукт/бизнес? Почему?":
    "aspirationLevel",
  "Как ты относишься к рутине? Она тебя успокаивает или угнетает?":
    "routineAttitude",
  "Ты больше любишь:": "workPreference",
  "А какие задачи ты терпеть не можешь?": "hatedTasks",
  "Любые дополнения и мысли по теме карьеры, что не уместилось в прошлые ответы, но чем хочется еще поделиться и что может быть важным":
    "additionalThoughts",
  "Прикрепи свое резюме в любом формате (можно несколько версий)":
    "resumeFileUrl",
  "Прикрепи ссылку на свой Linkedin (если есть)": "linkedinUrl",
  "Если есть Linkedin, напиши цифру своего SSI-рейтинга": "linkedinSSI",
  "Если есть Linkedin, напиши цифру своего SSI-рейтинга, он находится тут справа от большого кружка по ссылке: https://www.linkedin.com/sales/ssi":
    "linkedinSSI",
  "Если есть Linkedin, прикрепи скриншот своего SSI-рейтинга, он находится тут:":
    "linkedinSSI",
};

/**
 * Convert Google Forms namedValues (key → string[]) to flat object.
 */
function parseNamedValues(
  namedValues: Record<string, string[]>,
): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [header, values] of Object.entries(namedValues)) {
    const trimmed = header.trim();
    const firstLine = trimmed.split("\n")[0].trim();
    const key = COLUMN_MAP[trimmed] || COLUMN_MAP[firstLine];
    if (key) {
      result[key] = values.join(", ");
    }
  }
  return result;
}

/**
 * In-memory store (will be replaced with DB later).
 */
export const pipelineStates = new Map<string, PipelineState>();

export function getPipelineState(id: string): PipelineState | undefined {
  return pipelineStates.get(id);
}

export function getAllPipelineStates(): PipelineState[] {
  return Array.from(pipelineStates.values());
}

/**
 * Register intake webhook routes.
 */
export function registerIntakeRoutes(app: FastifyInstance) {
  app.post(
    "/api/webhook/new-participant",
    async (request: FastifyRequest, reply: FastifyReply) => {
      const secret = request.headers["x-webhook-secret"];
      if (secret !== process.env.WEBHOOK_SECRET) {
        return reply.status(401).send({ error: "Invalid webhook secret" });
      }

      try {
        const body = request.body as {
          namedValues?: Record<string, string[]>;
          [key: string]: unknown;
        };

        request.log.info({ bodyKeys: Object.keys(body) }, "Webhook received");

        let rawData: Record<string, string>;

        if (body.namedValues) {
          const unmapped: string[] = [];
          for (const header of Object.keys(body.namedValues)) {
            if (!COLUMN_MAP[header] && !COLUMN_MAP[header.trim()]) {
              unmapped.push(header);
            }
          }
          if (unmapped.length > 0) {
            request.log.warn({ unmapped }, "Unmapped form headers");
          }
          rawData = parseNamedValues(body.namedValues);
          request.log.info({ mappedFields: Object.keys(rawData) }, "Parsed fields");
        } else {
          rawData = body as Record<string, string>;
        }

        const questionnaire = rawQuestionnaireSchema.parse(rawData);
        const analysisInput = toAnalysisInput(questionnaire);

        const participantId = crypto.randomUUID();
        const now = new Date().toISOString();

        const state: PipelineState = {
          participantId,
          telegramNick: questionnaire.telegramNick,
          stage: "intake_received",
          createdAt: now,
          updatedAt: now,
          stageOutputs: {
            rawQuestionnaire: questionnaire,
            analysisInput,
          },
        };

        pipelineStates.set(participantId, state);

        request.log.info(
          { participantId, nick: questionnaire.telegramNick },
          "New participant intake received",
        );

        processResumeAndRunAnalysis(participantId, questionnaire.resumeFileUrl);

        return reply.status(200).send({
          success: true,
          participantId,
          stage: state.stage,
        });
      } catch (err) {
        request.log.error(err, "Intake webhook error");
        return reply.status(400).send({
          error: "Invalid questionnaire data",
          details: err instanceof Error ? err.message : String(err),
        });
      }
    },
  );

  app.get(
    "/api/participants",
    async (_request: FastifyRequest, reply: FastifyReply) => {
      const states = getAllPipelineStates();
      return reply.send(states);
    },
  );

  app.get(
    "/api/participants/:id",
    async (request: FastifyRequest, reply: FastifyReply) => {
      const { id } = request.params as { id: string };
      const state = getPipelineState(id);
      if (!state) {
        return reply.status(404).send({ error: "Participant not found" });
      }
      return reply.send(state);
    },
  );
}

function buildPipelineInput(analysisInput: AnalysisInput, resumeFileUrl?: string): AnalysisPipelineInput {
  const { resumeText, linkedinUrl, linkedinSSI, ...questionnaireFields } = analysisInput;
  return {
    questionnaire: JSON.stringify(questionnaireFields, null, 2),
    resumeText: resumeText || "",
    linkedinUrl: linkedinUrl || "",
    linkedinSSI: linkedinSSI || "",
    resumeUrl: resumeFileUrl,
  };
}

async function notifyAdminError(participantId: string, error: string): Promise<void> {
  try {
    const bot = getBot();
    const chatId = process.env.TELEGRAM_ADMIN_CHAT_ID;
    if (!chatId) return;
    await bot.telegram.sendMessage(
      chatId,
      `Ошибка в пайплайне для ${participantId}:\n${error}`,
    );
  } catch {
    console.error("[Intake] Failed to notify admin about error");
  }
}

/**
 * Download and parse resume in the background, then run analysis Phase 1
 * and send review to admin via Telegram.
 */
async function processResumeAndRunAnalysis(
  participantId: string,
  resumeFileUrl?: string,
) {
  const state = pipelineStates.get(participantId);
  if (!state) return;

  const outputs = (state.stageOutputs ?? {}) as Record<string, unknown>;
  const analysisInput = outputs.analysisInput as AnalysisInput;

  const alreadyHasResume = !!analysisInput.resumeText;

  if (resumeFileUrl && !alreadyHasResume) {
    try {
      const { buffer, mimeType } = await downloadFromGoogleDrive(resumeFileUrl);
      const resumeText = await extractResumeText(buffer, mimeType);
      (analysisInput as Record<string, unknown>).resumeText = resumeText;

      state.stage = "resume_parsed";
      state.updatedAt = new Date().toISOString();
    } catch (err) {
      const msg = `Resume processing failed: ${err instanceof Error ? err.message : String(err)}`;
      console.error(`[Intake] ${msg}`);
      state.error = msg;
      state.updatedAt = new Date().toISOString();
      await notifyAdminError(participantId, msg);
      return;
    }
  }

  try {
    const pipelineInput = buildPipelineInput(analysisInput, resumeFileUrl);

    console.log(`[Intake] Starting Phase 1 for ${participantId}...`);
    const phase1 = await runAnalysisPhase1(pipelineInput);

    state.stage = "admin_review_pending";
    state.updatedAt = new Date().toISOString();
    outputs.phase1Result = phase1;

    await sendReviewToAdmin(participantId, phase1, pipelineInput);
    console.log(`[Intake] Review sent to admin for ${participantId}`);
  } catch (err) {
    const msg = `Analysis pipeline failed: ${err instanceof Error ? err.message : String(err)}`;
    console.error(`[Intake] ${msg}`);
    state.error = msg;
    state.updatedAt = new Date().toISOString();
    await notifyAdminError(participantId, msg);
  }
}
