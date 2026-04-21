import XLSX from "xlsx";
import {
  rawQuestionnaireSchema,
  type RawQuestionnaire,
} from "../schemas/participant.js";
import { parseNamedValues } from "./intake-mapper.js";

/**
 * Normalize a Telegram nickname:
 *   "@Foo"              → "foo"
 *   "https://t.me/bar"  → "bar"
 *   " BAZ "             → "baz"
 */
export function normalizeNick(raw: string): string {
  return raw
    .trim()
    .replace(/^https?:\/\/t\.me\//i, "")
    .replace(/^@/, "")
    .toLowerCase();
}

/**
 * Map of headers from the OLD (legacy) questionnaire → internal RawQuestionnaire fields.
 * Fields unique to the legacy form (диагнозы, форматы обучения и т.д.) не попадают
 * в RawQuestionnaire, но сохраняются в rawNamedValues верхним уровнем.
 */
export const LEGACY_COLUMN_MAP: Record<string, keyof RawQuestionnaire> = {
  "Timestamp": "timestamp",
  "Твой ник в телеграм": "telegramNick",
  "Где ты сейчас?": "itStatus",
  "Какое у тебя гражданство?": "citizenship",
  "В какой стране и каком городе ты живешь сейчас?": "currentLocation",
  "На какую страну или страны ты планируешь работать?": "targetCountries",
  "Твой идеальный формат работы": "workFormat",
  "А как у тебя с английским?": "englishLevel",
  "Какое у тебя образование?": "education",
  "Чем ты занимаешься сейчас?": "currentOccupation",
  "Кем ты работаешь сейчас и сколько зарабатываешь? (до налогов)":
    "currentJobAndSalary",
  "Сколько у тебя опыта в текущей профессии?": "yearsExperience",
  "А сколько хочешь зарабатывать и в какой валюте?": "desiredSalary",
  "А сколько хочешь зарабатывать через 3-5 лет?": "desiredSalary3to5y",
  "Почему твой выбор пал именно на Карьерный акселератор PRO? Что для тебя самое важное в программе, что зацепило?":
    "whyAccelerator",
  "Какой результат ты хочешь получить на программе?": "desiredResult",
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
  "Если есть Linkedin, прикрепи скриншот своего SSI-рейтинга, он находится тут:":
    "linkedinSSI",
};

export interface ParsedXlsxRow {
  questionnaire: RawQuestionnaire;
  rawNamedValues: Record<string, string>;
  unmapped: string[];
  /** Row data indexed by full header (used for legacy-specific fields). */
  raw: Record<string, string>;
}

/** Read an XLSX file and return rows as flat Record<header, string>. */
export function readXlsxRows(file: string): Array<Record<string, string>> {
  const wb = XLSX.readFile(file);
  const sheet = wb.Sheets[wb.SheetNames[0]];
  const rows = XLSX.utils.sheet_to_json<Record<string, unknown>>(sheet, {
    defval: "",
    raw: false,
  });
  return rows.map((r) => {
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(r)) {
      out[k] = v == null ? "" : String(v);
    }
    return out;
  });
}

/** Parse a row from the NEW questionnaire using the production COLUMN_MAP. */
export function parseNewRow(row: Record<string, string>): ParsedXlsxRow {
  const namedValues: Record<string, string[]> = {};
  for (const [k, v] of Object.entries(row)) namedValues[k] = [v];
  const parsed = parseNamedValues(namedValues);
  const questionnaire = rawQuestionnaireSchema.parse(parsed.mapped);
  return {
    questionnaire,
    rawNamedValues: parsed.rawValues,
    unmapped: parsed.unmapped,
    raw: row,
  };
}

/** Parse a row from the OLD questionnaire using LEGACY_COLUMN_MAP. */
export function parseLegacyRow(row: Record<string, string>): ParsedXlsxRow {
  const mapped: Record<string, string> = {};
  const rawNamedValues: Record<string, string> = {};
  const unmapped: string[] = [];

  for (const [header, value] of Object.entries(row)) {
    const trimmed = header.trim();
    const firstLine = trimmed.split("\n")[0].trim();
    rawNamedValues[trimmed] = value;
    const key = LEGACY_COLUMN_MAP[trimmed] || LEGACY_COLUMN_MAP[firstLine];
    if (key) {
      mapped[key] = value;
    } else if (trimmed.length > 0) {
      unmapped.push(trimmed);
    }
  }

  const questionnaire = rawQuestionnaireSchema.parse(mapped);
  return { questionnaire, rawNamedValues, unmapped, raw: row };
}
