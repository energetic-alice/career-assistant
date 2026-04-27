import type { IdealResume } from "../schemas/ideal-resume.js";

/**
 * Turn a validated `IdealResume` JSON into the Apps Script payload
 * for `action=fill_template` and call the Apps Script web app.
 *
 * The Apps Script side (see `scripts/google-apps-script.js` →
 * `handleFillTemplate`) copies `IDEAL_RESUME_TEMPLATE_DOC_ID` and
 * fills `{{simple}}` placeholders + replaces `{{*_block}}` paragraphs
 * with the rendered styled paragraphs.
 *
 * Returns the URL + Drive ID of the freshly-created Doc.
 */

export interface FillTemplateResult {
  url: string;
  id: string;
}

interface StyledParagraph {
  text: string;
  style:
    | "plain"
    | "skill_line"
    | "company_header"
    | "job_title"
    | "project_line"
    | "bullet"
    | "technologies"
    | "spacer";
}

export async function fillIdealResumeTemplate(
  resume: IdealResume,
  title: string,
): Promise<FillTemplateResult> {
  const templateId = process.env.IDEAL_RESUME_TEMPLATE_DOC_ID;
  if (!templateId) {
    throw new Error(
      "IDEAL_RESUME_TEMPLATE_DOC_ID is not set. Run `createIdealResumeTemplate` once in Apps Script and put the resulting doc ID into env.",
    );
  }
  const webAppUrl = process.env.APPS_SCRIPT_DOC_URL;
  if (!webAppUrl) {
    throw new Error("APPS_SCRIPT_DOC_URL is not set");
  }
  const secret = process.env.WEBHOOK_SECRET;
  if (!secret) {
    throw new Error("WEBHOOK_SECRET is not set");
  }

  const payload = {
    action: "fill_template",
    secret,
    templateId,
    folderId: process.env.GOOGLE_DRIVE_FOLDER_ID || "",
    title,
    simple: {
      full_name: resume.fullName,
      title: resume.title,
      contact_line: resume.contactLine,
      summary: resume.summary,
    },
    blocks: {
      skills_block: renderSkills(resume),
      experience_block: renderExperience(resume),
      certifications_block: renderCertifications(resume),
      education_block: renderEducation(resume),
      languages_block: renderLanguages(resume),
    },
  };

  const resp = await fetch(webAppUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
    redirect: "follow",
  });

  if (!resp.ok) {
    throw new Error(
      `Apps Script error ${resp.status}: ${await resp.text()}`,
    );
  }

  const data = (await resp.json()) as {
    url?: string;
    id?: string;
    error?: string;
  };
  if (data.error) {
    throw new Error(`Apps Script: ${data.error}`);
  }
  if (!data.url || !data.id) {
    throw new Error("Apps Script did not return url+id");
  }
  return { url: data.url, id: data.id };
}

function renderSkills(resume: IdealResume): StyledParagraph[] {
  const out: StyledParagraph[] = [];
  for (const cat of resume.skills) {
    out.push({
      text: `${cat.category}: ${cat.items.join(", ")}`,
      style: "skill_line",
    });
  }
  return out;
}

function renderExperience(resume: IdealResume): StyledParagraph[] {
  const out: StyledParagraph[] = [];
  resume.experience.forEach((job, idx) => {
    if (idx > 0) out.push({ text: "", style: "spacer" });

    const companyLine = job.location
      ? `${job.company}\t${job.location}`
      : job.company;
    out.push({ text: companyLine, style: "company_header" });

    out.push({
      text: `${job.jobTitle}\t${job.period}`,
      style: "job_title",
    });

    if (job.projects && job.projects.length > 0) {
      for (const p of job.projects) {
        out.push({ text: p.label, style: "project_line" });
      }
    }

    for (const b of job.bullets) {
      out.push({ text: b.replace(/^\*\s*/, "").trim(), style: "bullet" });
    }

    if (job.technologies?.trim()) {
      out.push({
        text: `Technologies: ${job.technologies.trim()}`,
        style: "technologies",
      });
    }
  });
  return out;
}

function renderCertifications(resume: IdealResume): StyledParagraph[] {
  if (!resume.certifications || resume.certifications.length === 0) {
    return [{ text: "—", style: "plain" }];
  }
  return resume.certifications.map((c) => ({
    text: c.date ? `${c.name}\t${c.date}` : c.name,
    style: "plain",
  }));
}

function renderEducation(resume: IdealResume): StyledParagraph[] {
  return resume.education.map((e) => ({ text: e.text, style: "plain" }));
}

function renderLanguages(resume: IdealResume): StyledParagraph[] {
  return [
    {
      text: resume.languages.map((l) => l.text).join("    "),
      style: "plain",
    },
  ];
}
