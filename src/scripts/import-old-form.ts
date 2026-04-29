/**
 * One-off импорт двух клиентов, заполнивших СТАРУЮ Google-форму вместо новой.
 *
 * Старая форма имела другие headers и порядок вопросов, поэтому стандартный
 * intake-webhook их не подхватит автоматически (большая часть полей уйдёт в
 * unmapped, runClientSummary не соберёт нормальный профиль). Здесь маппим
 * вручную по позициям и при этом сохраняем оригинальные старые формулировки
 * в `rawNamedValues`, чтобы анкета-HTML в чате показывала именно те вопросы,
 * на которые клиент отвечал.
 *
 * Действия:
 *   1) для каждого inline-клиента собираем RawQuestionnaire / rawNamedValues
 *   2) скачиваем первое резюме из Drive (downloadFromGoogleDrive + extract)
 *   3) runClientSummary (Phase 0) — карточка в /clients получит имя/локацию/таргет
 *   4) собираем pipelineInput, ставим stage="awaiting_analysis"
 *   5) DRY_RUN=1 → пишет JSON в test-output/import-old/{nick}.json
 *      иначе  → POST /api/admin/upsert-states (x-webhook-secret).
 *
 * Telegram-уведомление "🆕 Новая анкета" НЕ шлётся (это backfill, не свежий
 * intake); куратор увидит клиентов через /clients или /client @nick.
 */

import "dotenv/config";
import crypto from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import {
  downloadFromGoogleDrive,
  extractResumeText,
} from "../services/file-service.js";
import { runClientSummary } from "../pipeline/run-analysis.js";
import type { PipelineState } from "../schemas/pipeline-state.js";
import {
  rawQuestionnaireSchema,
  toAnalysisInput,
  type RawQuestionnaire,
  type AnalysisInput,
} from "../schemas/participant.js";
import { normalizeNick } from "../services/intake-mapper.js";

const PROD_URL =
  process.env.PROD_URL ?? "https://career-assistant-w7z3.onrender.com";
const WEBHOOK_SECRET = process.env.WEBHOOK_SECRET ?? "";
const DRY_RUN = process.env.DRY_RUN === "1";

interface AnalysisPipelineInput {
  questionnaire: string;
  resumeText: string;
  linkedinUrl: string;
  linkedinSSI: string;
  resumeUrl?: string;
  rawNamedValues?: Record<string, string>;
}

function buildPipelineInput(
  analysisInput: AnalysisInput,
  resumeFileUrl?: string,
  rawNamedValues?: Record<string, string>,
): AnalysisPipelineInput {
  const { resumeText, linkedinUrl, linkedinSSI, ...rest } = analysisInput;
  return {
    questionnaire: JSON.stringify(rest, null, 2),
    resumeText: resumeText || "",
    linkedinUrl: linkedinUrl || "",
    linkedinSSI: linkedinSSI || "",
    resumeUrl: resumeFileUrl,
    ...(rawNamedValues ? { rawNamedValues } : {}),
  };
}

function pickFirstUrl(raw?: string): string | undefined {
  if (!raw) return undefined;
  return raw.split(",").map((u) => u.trim()).find(Boolean);
}

/**
 * Извлекает голый URL (https://…/in/…) из строки, где LinkedIn-ссылка может
 * быть с комментариями куратора в той же ячейке (как у @ollga_c).
 */
function cleanLinkedinUrl(raw: string): string {
  const m = raw.match(/https?:\/\/[^\s]+/);
  return m ? m[0].replace(/[)\],.;]+$/, "") : raw.trim();
}

/**
 * Inline-данные двух клиентов из старой формы, разложенные по позициям.
 * `extra` — дополнительные вопросы, которых нет в новой схеме; кладём их в
 * rawNamedValues с оригинальными старыми формулировками.
 */
interface OldFormSubmission {
  timestamp: string; // dd/mm/yyyy hh:mm:ss из старой формы
  telegramNick: string;
  itStatus: string;
  citizenship: string;
  currentLocation: string;
  targetCountries: string;
  workFormat: string;
  englishLevel: string;
  education: string;
  currentOccupation: string;
  currentJobAndSalary: string;
  yearsExperience: string;
  desiredSalary: string;
  desiredSalary3to5y: string;
  whyAccelerator: string;
  desiredResult: string;
  directionInterest: string;
  whyThisDirection: string;
  retrainingReadiness: string;
  weeklyHours: string;
  currentSituation: string;
  careerGoals: string;
  previousAttempts: string;
  communicationStyle: string;
  aspirationLevel: string;
  routineAttitude: string;
  hatedTasks: string;
  workPreference: string;
  additionalThoughts: string;
  resumeFileUrls: string[]; // одна или несколько Drive-ссылок
  linkedinRaw: string;       // у @ollga_c содержит коммент → cleanLinkedinUrl
  linkedinSSI?: string;
  /** доп.вопросы старой формы, которых нет в новой схеме */
  extra: Record<string, string>;
}

const SUBMISSIONS: OldFormSubmission[] = [
  {
    timestamp: "24/04/2026 20:24:22",
    telegramNick: "@ollga_c",
    itStatus: "Еще не в IT, но хочу в IT",
    citizenship: "Беларусь",
    currentLocation: "Вьетнам. 2.5 часа от Ханоя",
    targetCountries: "Европа или Азия",
    workFormat: "Удаленно из любой точки мира (кроме РФ)",
    englishLevel: "Могу проходить собеседования на английском",
    education: "Есть высшее, но не техническое",
    currentOccupation: "Работаю в найме",
    currentJobAndSalary: "1400$ , учителем английского во Вьетнаме",
    yearsExperience: "3-5 лет опыта",
    desiredSalary: "в начале 1.5 - 2.5k $",
    desiredSalary3to5y: "4-5k$",
    whyAccelerator:
      "Потому что Алиса точно знает о чем она говорит и имеет опыт в этой сфере. Я уже подписана какое-то время и слишком долго тянула с входом в ИТ, что уже начало казаться слишком поздно потому и взяла программу (отчасти спонтанно, но я не жалею, мне очень интересно)",
    desiredResult: "Помочь с позиционированием и входом + больше увидить эту кухню из нутри",
    directionInterest:
      "Project Manager (PMP вот уже одобрено. готовлюсь пока)(Product, BA - тоже как вариант)",
    whyThisDirection:
      "Потому что мне нравится работать в команде, общаться, заниматься структурированием разной информации и тд, плюс я в разгаре подготовки в ПМП (меня уже одобрили и хочу в июне сдать его или нет =))",
    retrainingReadiness: "Готов(а) полностью менять профессию",
    weeklyHours: "5-10 часов в неделю",
    currentSituation:
      "Мне в целом нравится моя работа учителем. Но это максимум чего я достигла и в доходах и в целом. Роста нет и нет удаленки  (учить на удаленке не хочу)",
    careerGoals: "хочу больше свободы потому хочу удаленку и рост свой личный, новые задачи и тд",
    previousAttempts:
      "ну вот я уже два года пассивно занимаюсь ПМП , очень пассивно. Меня отчасти все устраивает но я понимаю что в теплом болоте надоело уже сидеть.",
    communicationStyle: "Я гибкий человек, могу итак-итак",
    aspirationLevel: "сильный спец . но я прямо не против продукта, мне нравится создавать что-то",
    routineAttitude:
      "смотря какая рутина, есть норм рутина, есть та что угнетает , в основном окей , наша жизнь зачастую это сплошная рутина",
    hatedTasks: 'дурацкие. которые надо сдеать потому что "так надо" без понимания "зачем"',
    workPreference: "Улучшать и оптимизировать",
    additionalThoughts:
      'У меня вот на работе тичером родилась идея сделать тренажер для детей чтобы им кембридж экзамен проходить. есть проблема недостатка спикинга, но я вот думаю, а нужно ли, уже столько людей с пет проектами и еще же мой с друзьями проект развивается хорошо по помощи животным, там сообщество растет и я же там процессы настроила, но я там денег не получаю (@klub.kpd - instagram) .Я линк пока даже не заполнила чат гпт сказал мне надо писать что я координатор\n, но я слышала от Алисы что вот надо на мидла идти и я не понимаю как мне лучше все это организовать и правильно позиционироваться и есть ли смыл (после услышанного на вебинаре =) понимаю что я просто обязана начать уже столько энергии вкинуто в это все ну и окружение мое уже все кто хотел даже позже меня уже там, а я туплю. Собесы я тоже пока не проходила и какие места работы писать в линк? они никому не известны . резюме пока с чатом гпт делаю цифры пока не добавила но чтото высосать из пальца возможно. Пока бы понять в какую сторону дернуться',
    resumeFileUrls: [
      "https://drive.google.com/open?id=1N01OFrp9Ld_hZmuOO2E5VWN4rSUAclOJ",
      "https://drive.google.com/open?id=1JsvX8JlHWNAkdUUi__ganhvPNw0kSS3d",
    ],
    linkedinRaw:
      "https://www.linkedin.com/in/olga-cherniakovaa/ нужна помощь с тем как его заполнить и что писать может действительно в ПМ меня не возьмут пока? может стоит начать с чего-то попроще пока? но чтоб потом перейти в управление проектами или около этого",
    extra: {
      "Где ты сейчас ищешь работу/смотришь вакансии?": "соцсети гугл чат гпт (у меня даже есть ментор. она мне посоветовала как раз сдать пмп чтобы фильтры проходить но я ооочень сама все занятула сильно)",
      "В каком формате ты лучше воспринимаешь обучающие материалы?":
        "чаще видео и ИИ пока что , вообще нет строгих предпочтений . Подкасты только в качестве дополнений может. Я визуал",
      "Идеальный режим/график работы": "гибкая удаленка в идеале , не вставать рано",
      "Чем больше всего любишь заниматься (тип задач)?":
        "структурированием инфы. создание презентаций или общение",
      "Подозреваешь ли у себя СДВГ или другие особенности?":
        "Не уверена. но иногда похоже что-то на СДВГ (концентрация и гиперактивность) )",
      "Какие задачи тебе нравятся больше: чёткие/структурные или творческие?":
        "Четкие структурные ,но с творчеством тоже ок",
      "Сначала анализ или сразу действие?":
        "Зависит от задачи, иногда обстоятельства заставляют действовать сразу, но вообще предпочитаю сначала анализ",
      "Сильная сторона/в чём ты хороша?":
        "импровизирую (хотя я так не считаю). нахожу выходы из ситуаций. всегда есть знакомый знакомого у которого знакомый и тд (кто может помочь). докапываюсь до сути проблем (иногда)",
      "Когда ты в потоке/драйве?":
        "на уроках иногда когда они хорошо проходят или при возникномении спорных ситуаций где я могу остоять свою точку зрения . когда куча задач всяких еще и получается их выполнять . когда смена деятельности в процессе работы",
      "Самое важное в работе": "Свобода",
    },
  },
  {
    timestamp: "27/04/2026 21:00:56",
    telegramNick: "@plantrooon",
    itStatus: "Уже в IT, и хочу оставаться в IT",
    citizenship: "РФ",
    currentLocation: "РФ, Крым, Симферополь (Крым в документах нигде не фигурирует)",
    targetCountries: "Основные силы все-таки на США и Европу, но и РФ, конечно тоже, так как не уверена",
    workFormat: "Удаленно из РФ",
    englishLevel: "Говорю и понимаю не-IT темы",
    education: "Есть высшее, но не техническое",
    currentOccupation: "Работаю в найме",
    currentJobAndSalary: "70000 руб",
    yearsExperience: "До 3 лет опыта",
    desiredSalary: "130000$/год хотя бы на следующей позиции",
    desiredSalary3to5y: "230000$/year",
    whyAccelerator: "Я уже училась под твоим началом, знаю точно, что программа будет качественная)",
    desiredResult: "Разработать стратегию долгосрочную для своей карьеры",
    directionInterest:
      "Хочется, наверное,  больше уйти в технику что-то вроде программирования промышленных роботов и тд. Но не изучала в полной мере этот рынок",
    whyThisDirection:
      'Люблю видеть результат своей работы быстро.  И как бы "щупать" его. Меня это восхищает, если честно',
    retrainingReadiness: "Готов(а) сменить специализацию внутри своей профессии",
    weeklyHours: "10-20 часов в неделю",
    currentSituation:
      "Чувствую, что отупела из-за ИИ. Сейчас по полочкам снова nodeJS изучаю. Подтягиваю те скиллы, в которых уже работаю. Так как на работе нет времени изучить новый стек или фреймворк. Быстро сделал, выдал - выдохнул. Качество явно страдает из-за этого. \nТакже нет опытных разрабов, у которых можно вживую проконсультироваться, нет ревью кода, никто не скажет, что где-то хрень сделала, а где-то попала в точку. Как слепые котята. Работает - хорошо. Медленно? ну давай разберемся, что можно с этим сделать. Упускаю много чего, явно. \nИ зп не устраивает, конечно\nВ общем, 2 проблемы: я тупею и не расту в качестве будто на текущем месте работы и не устраивает ЗП.",
    careerGoals:
      "Рост собственной компетенции в текущем стеке, возможно, переквалификация в чуть другое направление. И рост дохода тоже.",
    previousAttempts:
      "Прохожусь по азам nodeJS, далее по плану TypeScript (так его много где требуют) и ReactNative (уже для себя, чтобы вообще все самой делать)\n\nЧестно, еще не писала рекрутерам, только изучала вакансии, наблюдала, что на рынке, так как по скиллам я чую, не дотягиваю нормально. Этим сейчас занимаюсь",
    communicationStyle: "70% интроверт, 30% люблю команду",
    aspirationLevel:
      "Сильный индивидуальный специалист. Мне проще, когда я отвечаю сама за результат. Мне не очень нравится управлять людьми и нести за них ответственность, хотя опыт такой с микрокомандами из 3-4 человек был и довольно позитивный",
    routineAttitude:
      "Иногда она мне очень нужна и я отдыхаю в ней, но если это 80% времени, то я могу сойти с ума и отупеть",
    hatedTasks:
      'Нереальные, ненужные или чересчур размытые на уровне "воздушных замков". Мне пытались поставить задачу сделать собственный аналог гитхаба, чтобы корпоративный код хранился только на наших серверах. Или когда попросили сделать мессенджер типа "Мишастик" только с нуля. В общем, велосипеды изобретать не люблю.',
    workPreference: "Создавать новое",
    additionalThoughts:
      'Недели 3 только думала на каком рынке работать, сложное было очень решение, если честно. Линк свой переделаю под зарубежный рынок. И мой главный страх, что я отупела из-за ИИ. Хотя из-за него же узнала много нового. Пока Армянское ИП не открывала, но пока хочу "пощупать" зарубежный рынок в этом направлении',
    resumeFileUrls: [
      "https://drive.google.com/open?id=1tcH49IX-kbVMmLUTDJxgVGdPEzBzRp6k",
      "https://drive.google.com/open?id=1p9GWah4JYAL8M7d2daR0y4snN3Kd-NkG",
      "https://drive.google.com/open?id=1I5Sw9wNkryVCQOVjzQPDNL2hQXKRsvts",
      "https://drive.google.com/open?id=1_77krqfQqNaETa6B62uMTzqJw4MN_ai6",
      "https://drive.google.com/open?id=1iytcEA0Vr25tUodEIsjj2kVCOSpgVRT_",
    ],
    linkedinRaw: "https://www.linkedin.com/in/marinaiatsuk/",
    extra: {
      "Подозреваешь ли у себя СДВГ или другие особенности?":
        "возможно СДВГ, но никто мне его не диагностировал, все мои выводы основаны только на рассказанном опыте других людей в соцсетях",
      "Какие задачи тебе нравятся больше: чёткие/структурные или творческие?":
        'Люблю, когда ставят четкую задачу. Но когда справляюсь со "сделай вот это как-то, но чтобы в итоге было так" то удовольствия от такой выполненной задачи больше. Но тоже, мне нужен баланс',
      "Сначала анализ или сразу действие?": "комбинируешь оба подхода",
      "Сильная сторона/в чём ты хороша?":
        'Нахожу решение "нерешаемых" задач и проблем. Об этом мне говорили во всех моих сферах. Если бы не говорили, я бы,честно, даже не обращала бы на это внимание',
      "Когда ты в потоке/драйве?":
        "Биология в средних классах )))) Если мне нужно что-то раскопать и найти ответ. Даже если меня спросили просто между делом.",
      "Самое важное в работе": "Самореализация",
    },
  },
];

/**
 * Из dd/mm/yyyy hh:mm:ss превращаем в ISO (UTC+3 ≈ Москва, как у Google Form
 * для русскоязычной анкеты — соответствует времени отправки клиентом).
 */
function toIso(timestamp: string): string {
  const m = timestamp.match(
    /^(\d{2})\/(\d{2})\/(\d{4})\s+(\d{2}):(\d{2}):(\d{2})$/,
  );
  if (!m) throw new Error(`Bad timestamp format: ${timestamp}`);
  const [, dd, mm, yyyy, hh, mi, ss] = m;
  // считаем как Europe/Moscow (UTC+3)
  return `${yyyy}-${mm}-${dd}T${hh}:${mi}:${ss}+03:00`;
}

/**
 * RawNamedValues для html-анкеты: новые headers (на которые маппится новая
 * форма) + старые "extra" — чтобы куратор увидел в чате ВСЕ ответы клиента,
 * включая те, которых уже нет в актуальной форме.
 */
function buildRawNamedValues(s: OldFormSubmission): Record<string, string> {
  return {
    Timestamp: s.timestamp,
    "Твой ник в телеграм": s.telegramNick,
    "Где ты сейчас?": s.itStatus,
    "Какое у тебя гражданство?": s.citizenship,
    "В какой стране и каком городе ты живешь сейчас?": s.currentLocation,
    "На какую страну или страны ты планируешь работать?": s.targetCountries,
    "Твой идеальный формат работы": s.workFormat,
    "А как у тебя с английским?": s.englishLevel,
    "Какое у тебя высшее образование?": s.education,
    "Чем ты занимаешься сейчас?": s.currentOccupation,
    "Кем ты работаешь сейчас и сколько зарабатываешь? (до налогов)":
      s.currentJobAndSalary,
    "Сколько у тебя опыта в текущей профессии?": s.yearsExperience,
    "А сколько хочешь зарабатывать и в какой валюте?": s.desiredSalary,
    "А сколько хочешь зарабатывать через 3-5 лет?": s.desiredSalary3to5y,
    "Почему твой выбор пал именно на работу с Алисой? Что для тебя самое важное, что зацепило?":
      s.whyAccelerator,
    "Какой результат ты хочешь получить от работы с Алисой?": s.desiredResult,
    "Есть ли у тебя уже пожелания или интерес какими направлениями хотелось бы заниматься?":
      s.directionInterest,
    "Расскажи подробно, почему именно это направление? Что в нем привлекает?":
      s.whyThisDirection,
    "Насколько ты готов(а) к переобучению?": s.retrainingReadiness,
    "Сколько времени можешь уделять поиску работы и переквалификации (при необходимости)? В часах в неделю":
      s.weeklyHours,
    "Опиши свою текущую карьерную ситуацию максимально подробно - что не нравится и какой главный затык":
      s.currentSituation,
    "Какие карьерные цели для тебя наиболее важны в ближайший год? (рост дохода, смена работы, повышение квалификации и т. д.)":
      s.careerGoals,
    "Были ли уже попытки что-то изменить в текущей ситуации, поменять работу, что-то доучить? Напиши максимально подробно":
      s.previousAttempts,
    "Как ты относишься к коммуникации и созвонам?": s.communicationStyle,
    "К какому уровню ты интуитивно стремишься в горизонте 3-5 лет: сильный индивидуальный специалист, тимлид/менеджер, эксперт‑консультант (без команды), свой продукт/бизнес? Почему?":
      s.aspirationLevel,
    "Ты больше любишь:": s.workPreference,
    "Как ты относишься к рутине? Она тебя успокаивает или угнетает?":
      s.routineAttitude,
    "А какие задачи ты терпеть не можешь?": s.hatedTasks,
    "Прикрепи свое резюме в любом формате (можно несколько версий)":
      s.resumeFileUrls.join(", "),
    "Прикрепи ссылку на свой Linkedin (если есть)": s.linkedinRaw,
    "Если есть Linkedin, напиши цифру своего SSI-рейтинга, он находится тут справа от большого кружка по ссылке: https://www.linkedin.com/sales/ssi":
      s.linkedinSSI ?? "",
    // дополнительные старые вопросы — куратор увидит их под секцией «Старая форма»
    ...Object.fromEntries(
      Object.entries(s.extra).map(([k, v]) => [`[старая форма] ${k}`, v]),
    ),
  };
}

function buildRawQuestionnaire(s: OldFormSubmission): RawQuestionnaire {
  const merged = {
    timestamp: s.timestamp,
    telegramNick: s.telegramNick,
    itStatus: s.itStatus,
    citizenship: s.citizenship,
    currentLocation: s.currentLocation,
    targetCountries: s.targetCountries,
    workFormat: s.workFormat,
    englishLevel: s.englishLevel,
    education: s.education,
    currentOccupation: s.currentOccupation,
    currentJobAndSalary: s.currentJobAndSalary,
    yearsExperience: s.yearsExperience,
    desiredSalary: s.desiredSalary,
    desiredSalary3to5y: s.desiredSalary3to5y,
    whyAccelerator: s.whyAccelerator,
    desiredResult: s.desiredResult,
    directionInterest: s.directionInterest,
    whyThisDirection: s.whyThisDirection,
    retrainingReadiness: s.retrainingReadiness,
    weeklyHours: s.weeklyHours,
    currentSituation: s.currentSituation,
    careerGoals: s.careerGoals,
    previousAttempts: s.previousAttempts,
    communicationStyle: s.communicationStyle,
    aspirationLevel: s.aspirationLevel,
    routineAttitude: s.routineAttitude,
    workPreference: s.workPreference,
    hatedTasks: s.hatedTasks,
    additionalThoughts: s.additionalThoughts,
    resumeFileUrl: s.resumeFileUrls.join(", "),
    linkedinUrl: cleanLinkedinUrl(s.linkedinRaw),
    linkedinSSI: s.linkedinSSI ?? "",
  };
  return rawQuestionnaireSchema.parse(merged);
}

async function buildState(s: OldFormSubmission): Promise<{
  state: PipelineState;
  notes: string[];
}> {
  const notes: string[] = [];
  const nick = normalizeNick(s.telegramNick);
  const createdAt = toIso(s.timestamp);
  const updatedAt = new Date().toISOString();
  const participantId = crypto.randomUUID();

  const rawQuestionnaire = buildRawQuestionnaire(s);
  const rawNamedValues = buildRawNamedValues(s);
  const analysisInput = toAnalysisInput(rawQuestionnaire);

  // 1) Резюме — берём первую ссылку, скачиваем, парсим.
  const resumeFileUrl = pickFirstUrl(rawQuestionnaire.resumeFileUrl);
  let resumeText = "";
  if (resumeFileUrl) {
    try {
      const { buffer, mimeType } = await downloadFromGoogleDrive(resumeFileUrl);
      resumeText = await extractResumeText(buffer, mimeType);
      analysisInput.resumeText = resumeText;
      notes.push(`resume parsed (${resumeText.length}c, ${mimeType})`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      notes.push(`resume failed: ${msg.slice(0, 200)}`);
    }
  } else {
    notes.push("no resumeFileUrl");
  }

  // 2) Phase 0: client summary
  let clientSummary: unknown;
  try {
    clientSummary = await runClientSummary({
      rawNamedValues,
      resumeText: analysisInput.resumeText,
      linkedinUrl: analysisInput.linkedinUrl,
      linkedinSSI: analysisInput.linkedinSSI,
    });
    const cs = clientSummary as {
      firstNameLatin?: string;
      lastNameLatin?: string;
      currentProfessionSlug?: string;
    };
    notes.push(
      `summary OK (${cs.firstNameLatin ?? "?"} ${cs.lastNameLatin ?? "?"}, ${cs.currentProfessionSlug ?? "non-IT"})`,
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    notes.push(`summary FAILED: ${msg.slice(0, 200)}`);
  }

  // 3) pipelineInput
  const pipelineInput = buildPipelineInput(
    analysisInput,
    rawQuestionnaire.resumeFileUrl,
    rawNamedValues,
  );

  const stageOutputs: Record<string, unknown> = {
    rawQuestionnaire,
    rawNamedValues,
    analysisInput,
    pipelineInput,
  };
  if (clientSummary) stageOutputs.clientSummary = clientSummary;
  if (resumeText) {
    (analysisInput as Record<string, unknown>).resumeText = resumeText;
  }

  const state: PipelineState = {
    participantId,
    telegramNick: nick,
    stage: clientSummary ? "awaiting_analysis" : "resume_parsed",
    createdAt,
    updatedAt,
    stageOutputs,
  };
  return { state, notes };
}

async function ensureNicksFreeOnProd(): Promise<string[]> {
  const res = await fetch(`${PROD_URL}/api/participants`);
  if (!res.ok) throw new Error(`GET /api/participants → ${res.status}`);
  const all = (await res.json()) as PipelineState[];
  const onProd = new Set(
    all.map((s) => normalizeNick(s.telegramNick)).filter(Boolean),
  );
  return SUBMISSIONS.map((s) => normalizeNick(s.telegramNick)).filter((n) =>
    onProd.has(n),
  );
}

async function main() {
  if (!process.env.ANTHROPIC_API_KEY) {
    throw new Error("ANTHROPIC_API_KEY not set — нужен для runClientSummary");
  }
  if (!DRY_RUN && !WEBHOOK_SECRET) {
    throw new Error(
      "WEBHOOK_SECRET not set — нужен для POST /api/admin/upsert-states (или DRY_RUN=1)",
    );
  }

  console.log(`PROD_URL: ${PROD_URL}`);
  console.log(`DRY_RUN:  ${DRY_RUN}`);
  console.log();

  const collisions = await ensureNicksFreeOnProd();
  if (collisions.length) {
    throw new Error(
      `На проде уже есть клиенты с никами: ${collisions.join(", ")}. ` +
        `Если это ОК (надо перезаписать) — закомментируй проверку и перезапусти.`,
    );
  }

  const updated: Record<string, PipelineState> = {};
  for (const sub of SUBMISSIONS) {
    const nick = normalizeNick(sub.telegramNick);
    console.log(`──── @${nick} ────`);
    const { state, notes } = await buildState(sub);
    for (const n of notes) console.log(`   • ${n}`);
    console.log(
      `   → state ready: stage=${state.stage} createdAt=${state.createdAt}`,
    );
    updated[state.participantId] = state;
    console.log();
  }

  if (DRY_RUN) {
    const outDir = "test-output/import-old";
    await mkdir(outDir, { recursive: true });
    for (const st of Object.values(updated)) {
      const file = `${outDir}/${normalizeNick(st.telegramNick)}.json`;
      await writeFile(file, JSON.stringify(st, null, 2), "utf-8");
      console.log(`DRY_RUN: written ${file}`);
    }
    console.log(
      `\nDRY_RUN=1 — на прод НЕ заливали. Проверь JSON, потом запусти без DRY_RUN.`,
    );
    return;
  }

  const upsertRes = await fetch(`${PROD_URL}/api/admin/upsert-states`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-webhook-secret": WEBHOOK_SECRET,
    },
    body: JSON.stringify({ states: updated }),
  });
  const body = await upsertRes.text();
  console.log(`upsert-states → ${upsertRes.status}: ${body}`);
  if (!upsertRes.ok) throw new Error(`upsert failed (${upsertRes.status})`);

  console.log("\n✅ Готово. Клиенты появятся в /clients на проде.");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
