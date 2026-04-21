import type { RawQuestionnaire } from "../schemas/participant.js";

/**
 * Maps Google Forms column headers (from namedValues) to our internal field names.
 * Order follows the current questionnaire form exactly.
 * Shared between the intake webhook and the XLSX seed importer.
 */
export const COLUMN_MAP: Record<string, keyof RawQuestionnaire> = {
  "Timestamp": "timestamp",
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
  "Почему твой выбор пал именно на работу с Алисой? Что для тебя самое важное, что зацепило?":
    "whyAccelerator",
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
  "Ты больше любишь:": "workPreference",
  "Как ты относишься к рутине? Она тебя успокаивает или угнетает?":
    "routineAttitude",
  "А какие задачи ты терпеть не можешь?": "hatedTasks",
  "Прикрепи свое резюме в любом формате (можно несколько версий)":
    "resumeFileUrl",
  "Прикрепи свое резюме в любом формате (можно несколько версий) 2":
    "resumeFileUrl",
  "Прикрепи ссылку на свой Linkedin (если есть)": "linkedinUrl",
  "Если есть Linkedin, напиши цифру своего SSI-рейтинга, он находится тут справа от большого кружка по ссылке: https://www.linkedin.com/sales/ssi":
    "linkedinSSI",
};

/**
 * Convert Google Forms namedValues (key → string[]) to flat object.
 * Returns:
 *   - mapped:    fields recognised via COLUMN_MAP (used by analysis pipeline)
 *   - rawValues: ALL form fields verbatim {original question header → answer}
 *   - unmapped:  list of headers that we don't know about (so we can fix
 *                COLUMN_MAP later), but their values still land in rawValues
 */
export function parseNamedValues(
  namedValues: Record<string, string[]>,
): {
  mapped: Record<string, string>;
  rawValues: Record<string, string>;
  unmapped: string[];
} {
  const mapped: Record<string, string> = {};
  const rawValues: Record<string, string> = {};
  const unmapped: string[] = [];

  for (const [header, values] of Object.entries(namedValues)) {
    const trimmed = header.trim();
    const firstLine = trimmed.split("\n")[0].trim();
    const key = COLUMN_MAP[trimmed] || COLUMN_MAP[firstLine];
    const value = values.join(", ");

    rawValues[trimmed] = value;

    if (key) {
      mapped[key] = value;
    } else if (trimmed.length > 0) {
      unmapped.push(trimmed);
    }
  }

  return { mapped, rawValues, unmapped };
}
