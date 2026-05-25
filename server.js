const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const zlib = require("zlib");

const PORT = Number(process.env.PORT || 3000);
const HOST = process.env.HOST || "127.0.0.1";
const DATA_DIR = path.join(__dirname, "data");
const DB_FILE = path.join(DATA_DIR, "store.json");
const PUBLIC_DIR = path.join(__dirname, "public");
const ENV_FILE = path.join(__dirname, ".env");

const MIME_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml"
};

const APPLICATION_STATUSES = [
  "投递中",
  "HR筛选通过",
  "一面",
  "二面",
  "终面",
  "已发Offer",
  "拒绝",
  "放弃"
];

function loadEnvFile() {
  if (!fs.existsSync(ENV_FILE)) return;
  const lines = fs.readFileSync(ENV_FILE, "utf8").split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const separator = trimmed.indexOf("=");
    if (separator === -1) continue;
    const key = trimmed.slice(0, separator).trim();
    let value = trimmed.slice(separator + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (key && process.env[key] === undefined) process.env[key] = value;
  }
}

loadEnvFile();

function ensureStore() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  if (!fs.existsSync(DB_FILE)) {
    fs.writeFileSync(
      DB_FILE,
      JSON.stringify(
        {
          userProfile: null,
          resumeVersions: [],
          jobCards: [],
          applications: [],
          growthInsights: []
        },
        null,
        2
      )
    );
  }
}

function readDb() {
  ensureStore();
  return JSON.parse(fs.readFileSync(DB_FILE, "utf8"));
}

function writeDb(db) {
  ensureStore();
  fs.writeFileSync(DB_FILE, JSON.stringify(db, null, 2));
}

function id(prefix) {
  return `${prefix}_${crypto.randomUUID()}`;
}

function now() {
  return new Date().toISOString();
}

function today() {
  return new Date().toISOString().slice(0, 10);
}

function sendJson(res, status, payload) {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(payload));
}

function notFound(res) {
  sendJson(res, 404, { error: "Not found" });
}

function parseBody(req) {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", chunk => {
      data += chunk;
      if (data.length > 2_000_000) {
        reject(new Error("Request body too large"));
        req.destroy();
      }
    });
    req.on("end", () => {
      if (!data) return resolve({});
      try {
        resolve(JSON.parse(data));
      } catch (error) {
        reject(error);
      }
    });
  });
}

function parseMultipart(req) {
  return new Promise((resolve, reject) => {
    const contentType = req.headers["content-type"] || "";
    const boundaryMatch = contentType.match(/boundary=(?:"([^"]+)"|([^;]+))/i);
    if (!boundaryMatch) return reject(new Error("Missing multipart boundary"));

    const boundary = Buffer.from(`--${boundaryMatch[1] || boundaryMatch[2]}`);
    const chunks = [];
    let total = 0;
    req.on("data", chunk => {
      total += chunk.length;
      if (total > 8_000_000) {
        reject(new Error("File is too large. Maximum size is 8MB."));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      const body = Buffer.concat(chunks);
      const parts = [];
      let cursor = body.indexOf(boundary) + boundary.length + 2;

      while (cursor > boundary.length) {
        const nextBoundary = body.indexOf(boundary, cursor);
        if (nextBoundary === -1) break;
        const part = body.slice(cursor, nextBoundary - 2);
        const headerEnd = part.indexOf(Buffer.from("\r\n\r\n"));
        if (headerEnd !== -1) {
          const headerText = part.slice(0, headerEnd).toString("utf8");
          const content = part.slice(headerEnd + 4);
          const name = headerText.match(/name="([^"]+)"/)?.[1] || null;
          const filename = headerText.match(/filename="([^"]*)"/)?.[1] || null;
          const type = headerText.match(/Content-Type:\s*([^\r\n]+)/i)?.[1] || "application/octet-stream";
          if (name) parts.push({ name, filename, type, content });
        }
        cursor = nextBoundary + boundary.length + 2;
      }
      resolve(parts);
    });
    req.on("error", reject);
  });
}

function cleanXmlText(xml) {
  return xml
    .replace(/<w:tab\/>/g, "\t")
    .replace(/<\/w:p>/g, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function listZipEntries(buffer) {
  const entries = [];
  let offset = 0;
  while (offset < buffer.length - 30) {
    const signature = buffer.readUInt32LE(offset);
    if (signature !== 0x04034b50) {
      offset += 1;
      continue;
    }

    const compression = buffer.readUInt16LE(offset + 8);
    const compressedSize = buffer.readUInt32LE(offset + 18);
    const uncompressedSize = buffer.readUInt32LE(offset + 22);
    const fileNameLength = buffer.readUInt16LE(offset + 26);
    const extraLength = buffer.readUInt16LE(offset + 28);
    const nameStart = offset + 30;
    const nameEnd = nameStart + fileNameLength;
    const dataStart = nameEnd + extraLength;
    const dataEnd = dataStart + compressedSize;
    const name = buffer.slice(nameStart, nameEnd).toString("utf8");
    const compressed = buffer.slice(dataStart, dataEnd);

    let content = null;
    if (compression === 0) content = compressed;
    if (compression === 8) content = zlib.inflateRawSync(compressed);
    entries.push({ name, content, compression, compressedSize, uncompressedSize });
    offset = dataEnd;
  }
  return entries;
}

function extractDocxText(buffer) {
  const entries = listZipEntries(buffer);
  const document = entries.find(entry => entry.name === "word/document.xml");
  if (!document?.content) throw new Error("Invalid DOCX file: word/document.xml not found");
  return cleanXmlText(document.content.toString("utf8"));
}

function decodePdfString(value) {
  return value
    .replace(/\\n/g, "\n")
    .replace(/\\r/g, "\n")
    .replace(/\\t/g, "\t")
    .replace(/\\\(/g, "(")
    .replace(/\\\)/g, ")")
    .replace(/\\\\/g, "\\")
    .replace(/\\([0-7]{1,3})/g, (_, octal) => String.fromCharCode(parseInt(octal, 8)));
}

function extractPdfText(buffer) {
  const chunks = [];
  const source = buffer.toString("latin1");
  const streamRegex = /<<(?:.|\n|\r)*?>>\s*stream\r?\n?([\s\S]*?)\r?\n?endstream/g;
  let match;

  while ((match = streamRegex.exec(source))) {
    const dictStart = source.lastIndexOf("<<", match.index);
    const dict = source.slice(dictStart, match.index);
    const raw = Buffer.from(match[1], "latin1");
    let stream = raw;
    if (/\/FlateDecode/.test(dict)) {
      try {
        stream = zlib.inflateSync(raw);
      } catch {
        try {
          stream = zlib.inflateRawSync(raw);
        } catch {
          stream = raw;
        }
      }
    }
    const text = stream.toString("latin1");
    const literalStrings = [...text.matchAll(/\((?:\\.|[^\\)])*\)\s*Tj/g)].map(item => decodePdfString(item[0].slice(1, item[0].lastIndexOf(")"))));
    const arrayStrings = [...text.matchAll(/\[((?:.|\n|\r)*?)\]\s*TJ/g)].flatMap(item =>
      [...item[1].matchAll(/\((?:\\.|[^\\)])*\)/g)].map(value => decodePdfString(value[0].slice(1, -1)))
    );
    chunks.push(...literalStrings, ...arrayStrings);
  }

  const text = chunks.join(" ").replace(/\s{2,}/g, " ").trim();
  if (!text) {
    throw new Error("No text could be extracted from this PDF. Scanned PDFs need OCR support.");
  }
  return text;
}

function extractResumeFileText(file) {
  const filename = file.filename || "";
  const ext = path.extname(filename).toLowerCase();
  if ([".txt", ".md", ".markdown"].includes(ext)) {
    return file.content.toString("utf8");
  }
  if ([".docx"].includes(ext)) {
    return extractDocxText(file.content);
  }
  if ([".pdf"].includes(ext)) {
    return extractPdfText(file.content);
  }
  throw new Error("Unsupported file type. Please upload TXT, MD, DOCX, or text-based PDF.");
}

function extractTextFile(file, label = "file") {
  const filename = file.filename || "";
  const ext = path.extname(filename).toLowerCase();
  if ([".txt", ".md", ".markdown"].includes(ext)) return file.content.toString("utf8");
  if (ext === ".docx") return extractDocxText(file.content);
  if (ext === ".pdf") return extractPdfText(file.content);
  throw new Error(`Unsupported ${label} type. Please upload TXT, MD, DOCX, or text-based PDF.`);
}

function extractJson(text) {
  if (!text) return null;
  const fenced = text.match(/```json\s*([\s\S]*?)```/i) || text.match(/```\s*([\s\S]*?)```/);
  const raw = fenced ? fenced[1] : text;
  const first = raw.indexOf("{");
  const last = raw.lastIndexOf("}");
  if (first === -1 || last === -1 || last <= first) return null;
  return JSON.parse(raw.slice(first, last + 1));
}

async function callLlm(systemPrompt, userPrompt, fallback) {
  const apiKey = process.env.LLM_API_KEY || process.env.OPENAI_API_KEY;
  const baseUrl = (process.env.LLM_BASE_URL || "https://api.openai.com/v1").replace(/\/$/, "");
  const model = process.env.LLM_MODEL || process.env.OPENAI_MODEL || "gpt-4.1-mini";

  if (!apiKey) {
    return { ...fallback(), aiProvider: "local-fallback" };
  }

  const response = await fetch(`${baseUrl}/chat/completions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`
    },
    body: JSON.stringify({
      model,
      temperature: 0.2,
      response_format: { type: "json_object" },
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userPrompt }
      ]
    })
  });

  if (!response.ok) {
    const message = await response.text();
    throw new Error(`LLM request failed: ${response.status} ${message.slice(0, 300)}`);
  }

  const data = await response.json();
  const content = data.choices?.[0]?.message?.content || "";
  return { ...extractJson(content), aiProvider: model };
}

function compactText(value, max = 8000) {
  return String(value || "").replace(/\s+/g, " ").trim().slice(0, max);
}

function keywordHits(text, words) {
  const lower = text.toLowerCase();
  return words.filter(word => lower.includes(word.toLowerCase()));
}

function flattenSkills(skills) {
  if (!skills) return [];
  if (Array.isArray(skills)) return skills;
  return [
    ...(skills.technical || []),
    ...(skills.soft || []),
    ...(skills.language || []),
    ...(skills.certificate || []),
    ...(skills.must_have || []),
    ...(skills.nice_to_have || [])
  ].filter(Boolean);
}

function normalizeUserProfile(analysis, resumeText) {
  const profile = analysis.user_profile || {};
  const parsedSkills = flattenSkills(analysis.skills || profile.skills);
  return {
    ...profile,
    name: profile.name || null,
    target_role: profile.target_role || profile.title || "待确认目标岗位",
    years_experience: profile.years_experience ?? null,
    education: profile.education || analysis.education || null,
    experience: profile.experience || analysis.experience || [],
    skills: parsedSkills,
    projects: profile.projects || analysis.projects || [],
    career_keywords: profile.career_keywords || parsedSkills.slice(0, 10),
    summary: profile.summary || "已完成结构化解析，请确认关键信息后继续诊断。",
    raw_excerpt: compactText(resumeText, 300)
  };
}

function normalizeDiagnosis(analysis, profile) {
  const diagnosis = analysis.diagnosis || {};
  const issues = diagnosis.issues || [
    ...(diagnosis.weaknesses || []).map((item, index) => ({
      priority: index < 2 ? "high" : "medium",
      category: "量化表达",
      title: String(item).slice(0, 15),
      description: item,
      suggestion: "补充具体动作、业务规模、工具方法和可验证结果。",
      example: {
        before: "负责项目相关工作",
        after: "负责核心模块推进，通过数据分析定位问题并支撑业务指标提升"
      },
      target_field: "experience"
    })),
    ...(diagnosis.quick_fixes || []).map(item => ({
      priority: "low",
      category: "格式规范",
      title: String(item).slice(0, 15),
      description: item,
      suggestion: item,
      example: null,
      target_field: "resume"
    }))
  ];
  return {
    health_score: diagnosis.health_score ?? diagnosis.score ?? Math.min(90, 58 + flattenSkills(profile.skills).length * 4),
    summary: diagnosis.summary || "整体可用，建议加强岗位关键词和量化成果。",
    issues,
    strengths: diagnosis.strengths || flattenSkills(profile.skills).slice(0, 5)
  };
}

function findResumeVersion(db, resumeVersionId) {
  if (resumeVersionId) {
    const resume = db.resumeVersions.find(item => item.resume_version_id === resumeVersionId);
    if (resume) return resume;
  }
  return db.resumeVersions.find(item => item.analysis?.user_profile) || db.resumeVersions[0] || null;
}

function profileForResume(resume) {
  return resume?.analysis?.user_profile || resume?.profile_snapshot || null;
}

function syncApplicationForDecision(db, jobCard, decision) {
  if (!["applied", "archived"].includes(decision)) return null;
  const nextStatus = decision === "applied" ? "投递中" : "放弃";
  const finalResult = decision === "applied" ? "进行中" : "放弃";
  const resumeVersionId = jobCard.last_optimized_resume_id
    || jobCard.match_resume_version_id
    || jobCard.linked_resume_ids?.[0]
    || db.resumeVersions[0]?.resume_version_id
    || null;
  let application = db.applications.find(item => item.job_card_id === jobCard.job_card_id);
  if (!application) {
    application = {
      application_id: id("app"),
      created_at: now(),
      job_card_id: jobCard.job_card_id,
      resume_version_id: resumeVersionId,
      match_score_at_apply: jobCard.match_report?.total_score || null,
      gap_data_at_apply: jobCard.gap_data || null,
      apply_date: today(),
      apply_channel: "求职决策",
      referral_info: null,
      current_status: nextStatus,
      status_history: [{ status: nextStatus, date: today(), note: "由求职决策同步" }],
      interview_rounds: [],
      final_result: finalResult,
      rejection_stage: null,
      offer_details: { salary: null, accepted: null },
      retrospective: null
    };
    db.applications.unshift(application);
    return application;
  }
  if (application.current_status !== nextStatus) {
    application.status_history = application.status_history || [];
    application.status_history.unshift({ status: nextStatus, date: today(), note: "由求职决策同步" });
  }
  application.current_status = nextStatus;
  application.final_result = finalResult;
  application.resume_version_id = application.resume_version_id || resumeVersionId;
  application.match_score_at_apply = application.match_score_at_apply || jobCard.match_report?.total_score || null;
  application.gap_data_at_apply = application.gap_data_at_apply || jobCard.gap_data || null;
  return application;
}

function fallbackResumeAnalysis(resumeText) {
  const text = compactText(resumeText, 4000);
  const skills = keywordHits(text, [
    "JavaScript",
    "TypeScript",
    "React",
    "Vue",
    "Node",
    "Python",
    "SQL",
    "Java",
    "Spring",
    "Docker",
    "Kubernetes",
    "数据分析",
    "产品",
    "运营",
    "增长"
  ]);
  return {
    user_profile: {
      name: null,
      target_role: skills.includes("产品") ? "产品经理" : "软件工程师",
      years_experience: null,
      education: null,
      experience: [],
      skills,
      projects: [],
      project_highlights: text ? [text.slice(0, 120)] : [],
      career_keywords: skills.slice(0, 8),
      summary: "已根据简历文本抽取初步画像。配置 LLM_API_KEY 后可获得更精细的结构化分析。"
    },
    diagnosis: {
      health_score: Math.min(88, 55 + skills.length * 4),
      summary: "可投递基础岗位，建议补充量化结果。",
      strengths: skills.length ? [`技能关键词覆盖：${skills.slice(0, 5).join("、")}`] : ["简历已有基础信息，可继续补充量化成果"],
      issues: [
        {
          priority: "high",
          category: "量化表达",
          title: "缺少量化结果",
          description: "项目和经历描述需要更多规模、指标和业务影响。",
          suggestion: "为每段经历补充业务规模、工具方法、结果指标。",
          example: {
            before: "负责用户增长平台开发",
            after: "负责用户增长平台核心模块开发，将页面加载时间降低30%，支撑活动转化分析"
          },
          target_field: "experience"
        },
        {
          priority: "medium",
          category: "关键词匹配",
          title: "关键词可加强",
          description: "简历关键词需要和目标岗位语言进一步对齐。",
          suggestion: "在真实经历中自然加入 JD 高频关键词。",
          example: null,
          target_field: "skills"
        }
      ]
    }
  };
}

function fallbackJdParse(jdText) {
  const jd = compactText(jdText, 5000);
  const jdKeywords = keywordHits(jd, [
    "JavaScript",
    "TypeScript",
    "React",
    "Vue",
    "Node",
    "Python",
    "SQL",
    "Java",
    "Spring",
    "Docker",
    "Kubernetes",
    "沟通",
    "数据分析",
    "增长",
    "项目管理"
  ]);
  return {
    jd_profile: {
      company: jd.match(/(?:公司|企业|团队)[:：]?([^，。\s]+)/)?.[1] || null,
      job_title: jd.match(/(高级前端工程师|前端工程师|后端工程师|全栈工程师|产品经理|运营|数据分析师|分析师|设计师|开发)/)?.[0] || "目标岗位",
      location: jd.match(/(北京|上海|深圳|广州|杭州|成都|香港|远程)/)?.[0] || null,
      salary_range: jd.match(/\d+\s*[-~]\s*\d+\s*[kK千万]?/)?.[0] || null,
      experience_required: { min_years: Number(jd.match(/(\d+)\s*年以上/)?.[1] || 0), max_years: null, description: jd.match(/\d+\s*年以上[^，。]*/)?.[0] || "未明确" },
      education_required: jd.match(/本科|硕士|博士|大专/)?.[0] || "无要求",
      skills: { must_have: jdKeywords.slice(0, 8), nice_to_have: [] },
      personality_tendency: keywordHits(jd, ["沟通", "协作", "抗压", "主动", "数据驱动"]).slice(0, 5),
      job_type: jd.includes("实习") ? "实习" : "全职",
      industry: jd.includes("金融") ? "金融" : jd.includes("消费") ? "消费品" : "互联网",
      parsing_confidence: jdKeywords.length ? 0.82 : 0.56,
      job_summary: jd.slice(0, 160),
      key_challenge: jdKeywords.length ? `围绕 ${jdKeywords.slice(0, 3).join("、")} 证明岗位能力` : "JD 信息较少，建议补充职责和任职要求"
    }
  };
}

function fallbackJobMatch(resumeProfile, jdProfileOrText) {
  const jdProfile = typeof jdProfileOrText === "string" ? fallbackJdParse(jdProfileOrText).jd_profile : jdProfileOrText;
  const jd = JSON.stringify(jdProfile);
  const profileSkills = flattenSkills(resumeProfile?.skills);
  const jdKeywords = [...(jdProfile?.skills?.must_have || []), ...(jdProfile?.skills?.nice_to_have || [])];
  const commonSkills = keywordHits(jd, profileSkills);
  const missing = jdKeywords.filter(word => !commonSkills.includes(word));
  const skillScore = Math.min(40, Math.max(10, commonSkills.length * 8 + (jdKeywords.length ? 8 : 0)));
  const experienceScore = 16;
  const educationScore = 13;
  const personalityScore = null;
  const backgroundScore = Math.min(10, commonSkills.length * 2 + 4);
  const score = Math.max(30, Math.min(94, skillScore + experienceScore + educationScore + backgroundScore));
  const matchLevel = score >= 85 ? "高度匹配" : score >= 70 ? "较好匹配" : score >= 55 ? "部分匹配" : "差距较大";

  return {
    jd_profile: jdProfile,
    match_report: {
      total_score: score,
      match_level: matchLevel,
      dimension_scores: {
        skill_match: {
          score: skillScore,
          matched_skills: commonSkills,
          missing_skills: missing,
          comment: commonSkills.length ? "核心技能有命中，但仍需补充证据。" : "必要技能命中较少。"
        },
        experience_match: {
          score: experienceScore,
          user_years: resumeProfile?.years_experience || 0,
          required_years_min: jdProfile?.experience_required?.min_years || 0,
          comment: "需结合具体项目深度判断。"
        },
        education_match: { score: educationScore, comment: "学历要求未形成主要阻碍。" },
        personality_match: { score: personalityScore, matched_tags: [], mismatched_tags: [], comment: "未完成性格测试，已按可评估维度调整。" },
        background_match: { score: backgroundScore, comment: "项目背景相关度中等。" }
      },
      strengths: commonSkills.slice(0, 5),
      decision_suggestion: score >= 70 ? "建议投递，并先做定向简历优化。" : "建议补强关键证据后再投递。",
      key_selling_points: commonSkills.slice(0, 3).map(item => `突出 ${item} 相关项目成果`),
      dimensions: [
        { name: "技能匹配度", score: skillScore, evidence: commonSkills.join("、") || "暂无明显技能命中" },
        { name: "经验年限匹配", score: experienceScore, evidence: "需结合项目经历进一步判断" },
        { name: "学历匹配", score: educationScore, evidence: "学历要求未形成主要阻碍" },
        { name: "项目背景相关度", score: backgroundScore, evidence: "按技能与业务关键词估算" }
      ],
      summary: `${matchLevel}，${score >= 70 ? "建议投递" : "建议谨慎"}。`,
      interview_focus: missing.slice(0, 4).map(item => `准备 ${item} 相关项目案例`)
    },
    gap_data: {
      gap_summary: missing.length ? `简历缺少 ${missing.slice(0, 3).join("、")} 的明确证据` : "主要差距不明显，重点强化表达",
      priority_gaps: missing.slice(0, 5).map((item, index) => ({
        item,
        severity: index < 2 ? "high" : "medium",
        description: `简历未明显体现 ${item}`,
        resume_fix: `在项目经历中补充/强调 ${item} 的真实应用场景。`
      })),
      keywords_to_insert: missing,
      strengths_to_highlight: commonSkills
    }
  };
}

function scaleTo15(value, legacyMax = 15) {
  const numeric = Number(value || 0);
  if (!Number.isFinite(numeric)) return 0;
  if (numeric <= 15) return Math.max(0, Math.min(15, Math.round(numeric * 10) / 10));
  return Math.max(0, Math.min(15, Math.round((numeric / legacyMax) * 15 * 10) / 10));
}

function normalizeDimension(raw, aliases, legacyMax, fallbackComment) {
  const source = aliases.map(alias => raw?.[alias]).find(value => value !== undefined && value !== null);
  if (source && typeof source === "object" && !Array.isArray(source)) {
    return {
      ...source,
      score: scaleTo15(source.score, legacyMax),
      comment: source.comment || fallbackComment
    };
  }
  return {
    score: scaleTo15(source, legacyMax),
    comment: fallbackComment
  };
}

function normalizeMatchReport(report) {
  if (!report || typeof report !== "object") return report;
  const raw = report.dimension_scores || {};
  report.dimension_scores = {
    skill_match: normalizeDimension(raw, ["skill_match", "skills", "skill", "技能匹配度"], 40, "根据必要技能与简历技能证据评估。"),
    experience_match: normalizeDimension(raw, ["experience_match", "experience", "经验年限匹配"], 20, "根据岗位年限要求与经历相关度评估。"),
    education_match: normalizeDimension(raw, ["education_match", "education", "学历匹配"], 15, "根据学历要求与教育背景评估。"),
    personality_match: normalizeDimension(raw, ["personality_match", "personality", "性格标签吻合度"], 15, "未完成性格测试时按 JD 行为特征粗略评估。"),
    background_match: normalizeDimension(raw, ["background_match", "background", "项目背景相关度"], 10, "根据项目、行业与业务背景相关度评估。")
  };
  return report;
}

function fallbackOptimizedResume(resumeText, jobCard) {
  const gaps = jobCard?.gap_data?.priority_gaps || [];
  const scoreBase = jobCard?.match_report?.total_score || 70;
  const optimizationScore = Math.min(95, scoreBase + Math.max(4, gaps.length ? 10 - gaps.length : 8));
  return {
    optimized_resume: compactText(resumeText, 5000),
    positioning_summary: `围绕 ${jobCard?.jd_profile?.job_title || "目标岗位"} 强化岗位关键词和量化成果。`,
    optimization_score: optimizationScore,
    score_breakdown: {
      jd_alignment: Math.min(100, optimizationScore + 2),
      keyword_coverage: Math.min(100, 72 + (jobCard?.gap_data?.keywords_to_insert || []).length * 4),
      evidence_quality: Math.max(60, optimizationScore - 8),
      authenticity_risk: 92
    },
    rewrite_suggestions: gaps.length
      ? gaps.map(gap => ({
          section: "项目经历",
          before: "原描述偏职责罗列",
          after: `${gap.resume_fix}，并补充业务规模、技术动作和结果指标。`,
          reason: gap.description
        }))
      : [
          {
            section: "项目经历",
            before: "负责项目开发和维护",
            after: "负责核心模块设计与交付，通过性能优化将关键页面响应时间降低 30%",
            reason: "用动作、指标和影响增强可信度"
          }
        ],
    keywords_added: jobCard?.gap_data?.keywords_to_insert || [],
    risk_notes: ["请只保留真实经历，不要编造未做过的技能或指标。"]
  };
}

function normalizeOptimizationResult(optimized, resumeText, jobCard) {
  const fallback = fallbackOptimizedResume(resumeText, jobCard);
  const result = optimized && typeof optimized === "object" ? optimized : {};
  if (result.optimization_score === undefined) result.optimization_score = fallback.optimization_score;
  if (!result.score_breakdown) result.score_breakdown = fallback.score_breakdown;
  if (!Array.isArray(result.keywords_added)) result.keywords_added = fallback.keywords_added;
  if (!Array.isArray(result.risk_notes)) result.risk_notes = Array.isArray(result.risk_notes) ? result.risk_notes : [String(result.risk_notes || fallback.risk_notes[0])];

  const rawSuggestions = Array.isArray(result.rewrite_suggestions) ? result.rewrite_suggestions : [];
  result.rewrite_suggestions = rawSuggestions.length
    ? rawSuggestions.map((item, index) => {
        if (typeof item === "string") {
          return {
            section: "优化建议",
            before: `原版简历未充分体现：${item}`,
            after: item,
            reason: "模型返回的是概括建议，已转为结构化对照。",
            keywords_inserted: [],
            gap_driven: false
          };
        }
        return {
          section: item.section || item.target_field || `改动 ${index + 1}`,
          before: item.before || item.original_responsibility || item.original || item.original_text || "原版对应内容需要补充或强化，但模型未返回原句。",
          after: item.after || item.optimized_responsibility || item.optimized || item.suggestion || item.optimized_text || "请按该项建议补充更贴合岗位的表达。",
          reason: item.reason || item.change_reason || item.description || "建议按岗位要求强化表达。",
          keywords_inserted: item.keywords_inserted || item.keywords || [],
          gap_driven: item.gap_driven ?? item.gapDriven ?? false
        };
      })
    : fallback.rewrite_suggestions;
  return result;
}

function fallbackRetrospective(application) {
  const score = application.match_score_at_apply || 0;
  const finalResult = application.final_result || application.current_status;
  const interviewCount = application.interview_rounds?.length || 0;
  return {
    result_interpretation: score >= 75 && finalResult === "拒绝"
      ? "匹配分较高但未成功，问题更可能出现在面试表达、竞争强度或招聘侧变化。"
      : "需要结合匹配差距和投递阶段判断主要瓶颈。",
    prediction_accuracy: finalResult === "Offer" ? "准确" : score >= 80 ? "偏高" : "准确",
    gap_validation: (application.gap_data_at_apply?.priority_gaps || []).map(gap => ({
      gap_item: gap.item,
      actually_tested: interviewCount > 0,
      performance: "待验证",
      note: "可在面试记录中补充是否被问到该点。"
    })),
    process_analysis: interviewCount ? `已记录 ${interviewCount} 轮面试，可继续补充卡住的问题。` : "缺少面试记录，本次只能做基础复盘。",
    key_learnings: ["投递时保留匹配分快照，后续可验证选岗判断", "每轮面试后记录卡点会显著提升复盘质量"],
    action_items: [
      { title: "补充面试卡点", type: "记录完善", priority: "high", done: false },
      { title: "按高优先级 Gap 更新简历", type: "简历优化", priority: "high", done: false },
      { title: "准备 2 个岗位关键词相关案例", type: "面试准备", priority: "medium", done: false }
    ],
    data_improvement_tip: interviewCount ? null : "补充一轮面试记录"
  };
}

function fallbackGrowthInsights(applications) {
  const rejected = applications.filter(item => item.final_result === "拒绝").length;
  const offers = applications.filter(item => item.final_result === "Offer").length;
  return {
    generated_at: now(),
    overview: `已分析 ${applications.length} 条投递记录，其中 Offer ${offers} 条、拒绝 ${rejected} 条。`,
    patterns: [
      "持续记录投递结果后，可以验证匹配分是否高估或低估",
      "高频 Gap 应优先转化为简历关键词和面试案例"
    ],
    bottlenecks: ["面试过程信息不足会限制复盘深度"],
    recommended_strategy: "优先投递匹配分 70 分以上岗位，并对高频差距做定向补强。",
    next_actions: ["完成最近 3 次投递复盘", "更新简历中的高频岗位关键词", "为每个核心技能准备 STAR 案例"]
  };
}

const prompts = {
  resumeAnalysis: {
    system: `你是一名专业的简历解析引擎和高级 HR。请把简历解析成结构化 JSON，并给出诊断。规则：忠实提取，不虚构；无法确定返回 null；输出严格 JSON，不要 Markdown。必须包含 user_profile 和 diagnosis。diagnosis 使用 health_score、summary、issues。`,
    user: resumeText => `请解析并诊断以下简历文本。\n\n输出 JSON 字段：user_profile{name,target_role,years_experience,education,experience,skills,projects,career_keywords,summary}；diagnosis{health_score,summary,issues,strengths}。\nissues 每条包含 priority,category,title,description,suggestion,example,target_field。\n\n简历：\n${resumeText}`
  },
  jdParse: {
    system: `你是一名专业的岗位解析引擎。请从招聘 JD 中提取严格 JSON。必须包含 jd_profile。不要输出 Markdown。`,
    user: jdText => `请解析以下 JD，并返回 jd_profile：company,job_title,location,salary_range,experience_required{min_years,max_years,description},education_required,skills{must_have,nice_to_have},personality_tendency,job_type,industry,parsing_confidence,job_summary,key_challenge。\n\nJD：\n${jdText}`
  },
  jobMatch: {
    system: `你是一名资深职业顾问，同时具备招聘官和候选人双视角。请基于用户画像与岗位画像输出严格 JSON，不要 Markdown。必须包含 match_report 和 gap_data。match_report.total_score 为 0-100。dimension_scores 必须包含 skill_match、experience_match、education_match、personality_match、background_match 五项，每项都是对象，格式为 {\"score\": 0~15, \"comment\": \"50字以内说明\"}；所有维度分都使用 15 分制，禁止返回 40/20/10 分制。gap_data 必须能直接驱动简历优化。`,
    user: ({ userProfile, jdProfile }) => `用户画像：\n${JSON.stringify(userProfile, null, 2)}\n\n岗位画像：\n${JSON.stringify(jdProfile, null, 2)}\n\n请严格按以下 JSON 结构输出：\n{\n  \"match_report\": {\n    \"total_score\": 0,\n    \"match_level\": \"高度匹配|较好匹配|部分匹配|差距较大\",\n    \"dimension_scores\": {\n      \"skill_match\": {\"score\": 0, \"comment\": \"说明\"},\n      \"experience_match\": {\"score\": 0, \"comment\": \"说明\"},\n      \"education_match\": {\"score\": 0, \"comment\": \"说明\"},\n      \"personality_match\": {\"score\": 0, \"comment\": \"说明\"},\n      \"background_match\": {\"score\": 0, \"comment\": \"说明\"}\n    },\n    \"strengths\": [\"string\"],\n    \"decision_suggestion\": \"string\"\n  },\n  \"gap_data\": {\n    \"gap_summary\": \"string\",\n    \"priority_gaps\": [{\"item\":\"string\",\"severity\":\"high|medium|low\",\"description\":\"string\",\"resume_fix\":\"string\"}],\n    \"keywords_to_insert\": [\"string\"],\n    \"strengths_to_highlight\": [\"string\"]\n  }\n}`
  },
  optimizeResume: {
    system: `你是资深求职教练。请基于原简历、岗位画像和 Gap 数据输出严格 JSON，不要输出 Markdown。必须包含 optimized_resume、positioning_summary、optimization_score、score_breakdown、rewrite_suggestions、keywords_added、risk_notes。optimization_score 为 0-100，衡量优化后简历对该岗位的投递质量。score_breakdown 包含 jd_alignment、keyword_coverage、evidence_quality、authenticity_risk。rewrite_suggestions 必须是对象数组，禁止返回字符串数组；每个对象必须包含 section、before、after、reason、keywords_inserted、gap_driven。before 必须引用或概括原简历中具体需要改的内容，after 必须给出新版修改表达。所有建议必须真实可信，不能编造经历。`,
    user: ({ resumeText, jobCard }) => `原简历：\n${resumeText}\n\n岗位卡片：\n${JSON.stringify(jobCard, null, 2)}\n\n请严格按以下 JSON 结构输出：\n{\n  \"optimized_resume\": \"string 或结构化对象\",\n  \"positioning_summary\": \"string\",\n  \"optimization_score\": 0,\n  \"score_breakdown\": {\"jd_alignment\": 0, \"keyword_coverage\": 0, \"evidence_quality\": 0, \"authenticity_risk\": 0},\n  \"rewrite_suggestions\": [\n    {\"section\": \"经历/项目/技能等区块\", \"before\": \"原简历中需要修改的具体内容\", \"after\": \"新版简历建议表达\", \"reason\": \"为什么这样改\", \"keywords_inserted\": [\"关键词\"], \"gap_driven\": true}\n  ],\n  \"keywords_added\": [\"string\"],\n  \"risk_notes\": [\"string\"]\n}`
  },
  retrospective: {
    system: `你是资深求职教练，擅长结合投递、匹配和面试记录做复盘。输出严格 JSON，不要输出 Markdown。必须包含 result_interpretation、prediction_accuracy、gap_validation、process_analysis、key_learnings、action_items、data_improvement_tip。行动项要具体可执行。`,
    user: application => `请基于以下投递记录生成复盘报告：\n${JSON.stringify(application, null, 2)}`
  },
  growth: {
    system: `你是职业发展分析师。请基于多条投递记录识别跨投递模式，输出严格 JSON，不要输出 Markdown。必须包含 generated_at、overview、patterns、bottlenecks、recommended_strategy、next_actions。`,
    user: applications => `请分析这些投递记录：\n${JSON.stringify(applications, null, 2)}`
  }
};

async function handleApi(req, res, url) {
  try {
    const db = readDb();
    const body = req.method === "GET" || (req.headers["content-type"] || "").startsWith("multipart/form-data")
      ? {}
      : await parseBody(req);

    if (req.method === "GET" && url.pathname === "/api/state") {
      return sendJson(res, 200, db);
    }

    if (req.method === "POST" && url.pathname === "/api/extract-resume-file") {
      const parts = await parseMultipart(req);
      const file = parts.find(part => part.name === "resumeFile" && part.filename);
      if (!file) return sendJson(res, 400, { error: "resumeFile is required" });
      const text = compactText(extractTextFile(file, "resume"), 20000);
      if (!text) return sendJson(res, 422, { error: "No text was extracted from the uploaded file." });
      return sendJson(res, 200, {
        filename: file.filename,
        mimeType: file.type,
        text,
        characters: text.length
      });
    }

    if (req.method === "POST" && url.pathname === "/api/extract-jd-file") {
      const parts = await parseMultipart(req);
      const file = parts.find(part => part.name === "jdFile" && part.filename);
      if (!file) return sendJson(res, 400, { error: "jdFile is required" });
      const text = compactText(extractTextFile(file, "JD"), 20000);
      if (!text) return sendJson(res, 422, { error: "No text was extracted from the uploaded JD file." });
      return sendJson(res, 200, {
        filename: file.filename,
        mimeType: file.type,
        text,
        characters: text.length
      });
    }

    if (req.method === "POST" && url.pathname === "/api/analyze-resume") {
      const resumeText = compactText(body.resumeText, 12000);
      if (!resumeText) return sendJson(res, 400, { error: "resumeText is required" });

      const rawAnalysis = await callLlm(
        prompts.resumeAnalysis.system,
        prompts.resumeAnalysis.user(resumeText),
        () => fallbackResumeAnalysis(resumeText)
      );
      const userProfile = normalizeUserProfile(rawAnalysis, resumeText);
      const diagnosis = normalizeDiagnosis(rawAnalysis, userProfile);
      const analysis = {
        ...rawAnalysis,
        user_profile: userProfile,
        diagnosis
      };
      const resumeVersion = {
        resume_version_id: id("resume"),
        created_at: now(),
        source: "user_input",
        file_name: body.fileName || null,
        archive_name: body.archiveName || body.fileName || userProfile.name || `简历档案 ${new Date().toLocaleDateString("zh-CN")}`,
        status: "diagnosed",
        raw_text: resumeText,
        analysis,
        optimized: null
      };
      db.userProfile = analysis.user_profile;
      db.resumeVersions.unshift(resumeVersion);
      writeDb(db);
      return sendJson(res, 200, { userProfile: db.userProfile, resumeVersion });
    }

    if (req.method === "POST" && url.pathname === "/api/job-cards") {
      const jdText = compactText(body.jdText, 12000);
      if (!jdText) return sendJson(res, 400, { error: "jdText is required" });

      const parsed = await callLlm(
        prompts.jdParse.system,
        prompts.jdParse.user(jdText),
        () => fallbackJdParse(jdText)
      );
      const jobCard = {
        job_card_id: id("job"),
        created_at: now(),
        updated_at: now(),
        created_from: body.createdFrom || "match_module",
        raw_jd_text: jdText,
        jd_input_method: body.inputMethod || "text_paste",
        jd_profile: parsed.jd_profile || parsed,
        match_report: null,
        gap_data: null,
        linked_resume_ids: [],
        status: "jd_parsed",
        user_decision: "pending",
        aiProvider: parsed.aiProvider
      };
      db.jobCards.unshift(jobCard);
      writeDb(db);
      return sendJson(res, 200, { jobCard });
    }

    if (req.method === "POST" && url.pathname === "/api/match-job") {
      const jdText = compactText(body.jdText, 12000);
      if (!jdText) return sendJson(res, 400, { error: "jdText is required" });
      const resume = findResumeVersion(db, body.resumeVersionId);
      const resumeProfile = profileForResume(resume) || db.userProfile;
      if (!resumeProfile) return sendJson(res, 409, { error: "请先分析一份简历，生成该简历档案的用户画像后再做岗位匹配。" });

      const parsed = await callLlm(
        prompts.jdParse.system,
        prompts.jdParse.user(jdText),
        () => fallbackJdParse(jdText)
      );
      const match = await callLlm(
        prompts.jobMatch.system,
        prompts.jobMatch.user({ userProfile: resumeProfile, jdProfile: parsed.jd_profile }),
        () => fallbackJobMatch(resumeProfile, parsed.jd_profile)
      );
      match.match_report = normalizeMatchReport(match.match_report);
      const jobCard = {
        job_card_id: id("job"),
        created_at: now(),
        updated_at: now(),
        created_from: "match_module",
        raw_jd_text: jdText,
        jd_input_method: "text_paste",
        jd_profile: parsed.jd_profile || match.jd_profile,
        match_report: match.match_report,
        gap_data: match.gap_data,
        linked_resume_ids: [],
        match_resume_version_id: resume?.resume_version_id || null,
        status: "matched",
        user_decision: "pending",
        aiProvider: match.aiProvider
      };
      db.jobCards.unshift(jobCard);
      writeDb(db);
      return sendJson(res, 200, { jobCard });
    }

    const jobCardMatch = url.pathname.match(/^\/api\/job-cards\/([^/]+)(?:\/([^/]+))?$/);
    if (jobCardMatch) {
      const jobCard = db.jobCards.find(item => item.job_card_id === jobCardMatch[1]);
      if (!jobCard) return notFound(res);
      const action = jobCardMatch[2];

      if (req.method === "PATCH" && !action) {
        if (body.jdProfile) jobCard.jd_profile = { ...jobCard.jd_profile, ...body.jdProfile };
        let syncedApplication = null;
        if (body.userDecision) {
          jobCard.user_decision = body.userDecision;
          syncedApplication = syncApplicationForDecision(db, jobCard, body.userDecision);
        }
        if (body.status) jobCard.status = body.status;
        jobCard.updated_at = now();
        writeDb(db);
        return sendJson(res, 200, { jobCard, application: syncedApplication });
      }

      if (req.method === "POST" && action === "match") {
        const resume = findResumeVersion(db, body.resumeVersionId);
        const resumeProfile = profileForResume(resume) || db.userProfile;
        if (!resumeProfile) return sendJson(res, 409, { error: "请先分析一份简历，生成该简历档案的用户画像后再做岗位匹配。" });
        const match = await callLlm(
          prompts.jobMatch.system,
          prompts.jobMatch.user({ userProfile: resumeProfile, jdProfile: jobCard.jd_profile }),
          () => fallbackJobMatch(resumeProfile, jobCard.jd_profile)
        );
        jobCard.match_report = normalizeMatchReport(match.match_report);
        jobCard.gap_data = match.gap_data;
        jobCard.match_resume_version_id = resume?.resume_version_id || null;
        jobCard.status = "matched";
        jobCard.updated_at = now();
        jobCard.aiProvider = match.aiProvider;
        writeDb(db);
        return sendJson(res, 200, { jobCard });
      }
    }

    if (req.method === "POST" && url.pathname === "/api/optimize-resume") {
      const sourceResume = findResumeVersion(db, body.resumeVersionId);
      const resumeText = compactText(body.resumeText || sourceResume?.raw_text, 12000);
      const jobCard = db.jobCards.find(item => item.job_card_id === body.jobCardId) || db.jobCards[0];
      if (!resumeText) return sendJson(res, 400, { error: "resumeText is required" });
      if (!jobCard) return sendJson(res, 400, { error: "jobCardId is required" });

      const optimized = await callLlm(
        prompts.optimizeResume.system,
        prompts.optimizeResume.user({ resumeText, jobCard }),
        () => fallbackOptimizedResume(resumeText, jobCard)
      );
      const normalizedOptimized = normalizeOptimizationResult(optimized, resumeText, jobCard);
      const resumeVersion = {
        resume_version_id: id("resume"),
        created_at: now(),
        source: "targeted_optimization",
        status: "optimized",
        raw_text: resumeText,
        parent_resume_version_id: sourceResume?.resume_version_id || null,
        profile_snapshot: profileForResume(sourceResume),
        analysis: sourceResume?.analysis || null,
        optimized: normalizedOptimized,
        job_card_id: jobCard.job_card_id
      };
      db.resumeVersions.unshift(resumeVersion);
      jobCard.linked_resume_ids.unshift(resumeVersion.resume_version_id);
      jobCard.last_optimized_resume_id = resumeVersion.resume_version_id;
      jobCard.status = "resume_optimized";
      writeDb(db);
      return sendJson(res, 200, { resumeVersion, jobCard });
    }

    if (req.method === "POST" && url.pathname === "/api/applications") {
      const jobCard = db.jobCards.find(item => item.job_card_id === body.jobCardId);
      if (!jobCard) return sendJson(res, 400, { error: "jobCardId is required" });
      const application = {
        application_id: id("app"),
        created_at: now(),
        job_card_id: jobCard.job_card_id,
        resume_version_id: body.resumeVersionId || db.resumeVersions[0]?.resume_version_id || null,
        match_score_at_apply: jobCard.match_report?.total_score || null,
        gap_data_at_apply: jobCard.gap_data || null,
        apply_date: body.applyDate || today(),
        apply_channel: body.applyChannel || "官网",
        referral_info: body.referralInfo || null,
        current_status: body.currentStatus || "投递中",
        status_history: [{ status: body.currentStatus || "投递中", date: today(), note: "创建投递记录" }],
        interview_rounds: [],
        final_result: "进行中",
        rejection_stage: null,
        offer_details: { salary: null, accepted: null },
        retrospective: null
      };
      jobCard.user_decision = "applied";
      db.applications.unshift(application);
      writeDb(db);
      return sendJson(res, 200, { application });
    }

    const applicationMatch = url.pathname.match(/^\/api\/applications\/([^/]+)(?:\/([^/]+))?$/);
    if (applicationMatch) {
      const application = db.applications.find(item => item.application_id === applicationMatch[1]);
      if (!application) return notFound(res);
      const action = applicationMatch[2];

      if (req.method === "PATCH" && !action) {
        if (body.currentStatus && APPLICATION_STATUSES.includes(body.currentStatus)) {
          application.current_status = body.currentStatus;
          application.status_history.unshift({ status: body.currentStatus, date: today(), note: body.note || null });
          if (body.currentStatus === "拒绝") application.final_result = "拒绝";
          if (body.currentStatus === "已发Offer") application.final_result = "Offer";
          if (body.currentStatus === "放弃") application.final_result = "放弃";
        }
        if (body.finalResult) application.final_result = body.finalResult;
        if (body.rejectionStage !== undefined) application.rejection_stage = body.rejectionStage || null;
        writeDb(db);
        return sendJson(res, 200, { application });
      }

      if (req.method === "POST" && action === "interviews") {
        const round = {
          round_id: id("round"),
          round_type: body.roundType || "技术面",
          scheduled_at: body.scheduledAt || null,
          completed_at: body.completedAt || now(),
          question_types: body.questionTypes || [],
          stuck_on: body.stuckOn || null,
          performance_rating: Number(body.performanceRating || 3),
          outcome: body.outcome || "待结果",
          notes: body.notes || null,
          key_questions: body.keyQuestions || [],
          interviewer_style: body.interviewerStyle || null
        };
        application.interview_rounds.unshift(round);
        application.retrospective = application.retrospective ? { ...application.retrospective, stale: true } : null;
        writeDb(db);
        return sendJson(res, 200, { round, application });
      }

      if (req.method === "POST" && action === "retrospective") {
        const report = await callLlm(
          prompts.retrospective.system,
          prompts.retrospective.user(application),
          () => fallbackRetrospective(application)
        );
        application.retrospective = {
          ...report,
          generated_at: now(),
          user_confirmed: false,
          stale: false
        };
        writeDb(db);
        return sendJson(res, 200, { retrospective: application.retrospective, application });
      }
    }

    if (req.method === "POST" && url.pathname === "/api/growth-insights") {
      const completed = db.applications.filter(item => item.final_result && item.final_result !== "进行中");
      if (completed.length < 3) {
        return sendJson(res, 409, { error: "至少需要 3 条有结果的投递记录才能生成成长洞察。" });
      }
      const insight = await callLlm(
        prompts.growth.system,
        prompts.growth.user(completed),
        () => fallbackGrowthInsights(completed)
      );
      db.growthInsights.unshift({ ...insight, generated_at: insight.generated_at || now() });
      db.growthInsights = db.growthInsights.slice(0, 3);
      writeDb(db);
      return sendJson(res, 200, { insight: db.growthInsights[0] });
    }

    return notFound(res);
  } catch (error) {
    console.error(error);
    sendJson(res, 500, { error: error.message || "Internal server error" });
  }
}

function serveStatic(req, res, url) {
  const requestedPath = url.pathname === "/" ? "/index.html" : decodeURIComponent(url.pathname);
  const filePath = path.normalize(path.join(PUBLIC_DIR, requestedPath));
  if (!filePath.startsWith(PUBLIC_DIR)) return notFound(res);

  fs.readFile(filePath, (error, content) => {
    if (error) return notFound(res);
    const ext = path.extname(filePath);
    res.writeHead(200, { "Content-Type": MIME_TYPES[ext] || "application/octet-stream" });
    res.end(content);
  });
}

ensureStore();

http
  .createServer((req, res) => {
    const url = new URL(req.url, `http://${req.headers.host}`);
    if (url.pathname.startsWith("/api/")) return handleApi(req, res, url);
    return serveStatic(req, res, url);
  })
  .listen(PORT, HOST, () => {
    console.log(`AI job search assistant running at http://${HOST}:${PORT}`);
  });
