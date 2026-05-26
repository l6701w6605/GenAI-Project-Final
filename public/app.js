const applicationStatuses = ["投递中", "HR筛选通过", "一面", "二面", "终面", "已发Offer", "拒绝", "放弃"];

let state = {
  userProfile: null,
  resumeVersions: [],
  jobCards: [],
  applications: [],
  growthInsights: []
};

let view = "dashboard";
let selectedResumeId = null;
let selectedJobId = null;
let selectedOptimizedResumeId = null;
let selectedApplicationId = null;
let draftResumeText = "";
let draftResumeFile = "";
let draftJdText = "";
let jdInputMode = "text";
let loadingStepTimer = null;

const $ = selector => document.querySelector(selector);
const root = () => $("#appRoot");

function statusRank(status) {
  return applicationStatuses.indexOf(status);
}

function hasReachedStatus(app, targetStatus) {
  const targetRank = statusRank(targetStatus);
  const currentRank = statusRank(app.current_status);
  const historyRanks = (app.status_history || []).map(item => statusRank(item.status));
  return [currentRank, ...historyRanks].some(rank => rank >= targetRank);
}

function rejectionStage(app) {
  if (app.rejection_stage) return app.rejection_stage;
  if (app.final_result !== "拒绝" && app.current_status !== "拒绝") return null;
  const history = [...(app.status_history || [])].reverse();
  const rejectedIndex = history.findIndex(item => item.status === "拒绝");
  if (rejectedIndex > 0) return history[rejectedIndex - 1].status;
  return app.current_status === "拒绝" ? "未记录阶段" : app.current_status;
}

function rate(numerator, denominator) {
  if (!denominator) return 0;
  return Math.round((numerator / denominator) * 100);
}

function toast(message) {
  const node = $("#toast");
  node.textContent = message;
  node.classList.add("show");
  window.setTimeout(() => node.classList.remove("show"), 2800);
}

function showLoadingOverlay({ title, subtitle, steps = [] }) {
  hideLoadingOverlay();
  const items = steps.map((step, index) => `<li class="${index === 0 ? "active" : ""}">${escapeHtml(step)}</li>`).join("");
  document.body.insertAdjacentHTML("beforeend", `
    <div class="loading-overlay" id="loadingOverlay" role="status" aria-live="polite">
      <section class="loading-card">
        <div class="loading-ring" aria-hidden="true"><span></span></div>
        <h2>${escapeHtml(title)}</h2>
        <p>${escapeHtml(subtitle)}</p>
        ${steps.length ? `<ol class="loading-steps">${items}</ol>` : ""}
      </section>
    </div>
  `);
  if (steps.length > 1) {
    let activeIndex = 0;
    loadingStepTimer = window.setInterval(() => {
      const nodes = document.querySelectorAll("#loadingOverlay .loading-steps li");
      if (!nodes.length) return;
      nodes[activeIndex]?.classList.remove("active");
      activeIndex = (activeIndex + 1) % nodes.length;
      nodes[activeIndex]?.classList.add("active");
    }, 1500);
  }
}

function hideLoadingOverlay() {
  if (loadingStepTimer) {
    window.clearInterval(loadingStepTimer);
    loadingStepTimer = null;
  }
  $("#loadingOverlay")?.remove();
}

async function withLoadingOverlay(config, fn) {
  showLoadingOverlay(config);
  try {
    return await fn();
  } finally {
    hideLoadingOverlay();
  }
}

function showOptimizationCompleteModal(optimizedResume) {
  $("#completionModal")?.remove();
  const optimized = optimizedResume?.optimized || {};
  const suggestions = normalizeRewriteSuggestions(optimized);
  const keywords = new Set([
    ...(optimized.keywords_added || []),
    ...suggestions.flatMap(item => item.keywords || [])
  ].filter(Boolean));
  document.body.insertAdjacentHTML("beforeend", `
    <div class="modal-backdrop" id="completionModal" role="dialog" aria-modal="true" aria-labelledby="completionTitle">
      <section class="completion-modal">
        <div class="completion-icon" aria-hidden="true">✅</div>
        <h2 id="completionTitle">优化完成</h2>
        <p>本次共优化了 <strong>${escapeHtml(suggestions.length)}</strong> 处描述</p>
        <p>解析了 <strong>${escapeHtml(keywords.size)}</strong> 个关键词</p>
        <button id="closeCompletionModal" type="button">关闭</button>
      </section>
    </div>
  `);
  $("#closeCompletionModal").addEventListener("click", () => $("#completionModal")?.remove());
}

async function api(path, options = {}) {
  const response = await fetch(path, {
    ...options,
    headers: {
      "Content-Type": "application/json",
      ...(options.headers || {})
    }
  });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || "请求失败");
  return data;
}

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function formatDate(value) {
  if (!value) return "-";
  return new Date(value).toLocaleDateString("zh-CN", { month: "2-digit", day: "2-digit" });
}

function scoreLevel(score) {
  if (score >= 85) return "高度匹配";
  if (score >= 70) return "较好匹配";
  if (score >= 55) return "部分匹配";
  return "差距较大";
}

function scaleTo15(value, legacyMax = 15) {
  const numeric = Number(value || 0);
  if (!Number.isFinite(numeric)) return 0;
  if (numeric <= 15) return Math.max(0, Math.min(15, Math.round(numeric * 10) / 10));
  return Math.max(0, Math.min(15, Math.round((numeric / legacyMax) * 15 * 10) / 10));
}

function dimensionValue(dimensions, aliases, legacyMax = 15, fallbackComment = "") {
  const raw = aliases.map(alias => dimensions?.[alias]).find(value => value !== undefined && value !== null);
  if (raw && typeof raw === "object" && !Array.isArray(raw)) {
    return {
      score: scaleTo15(raw.score, legacyMax),
      comment: raw.comment || fallbackComment
    };
  }
  return {
    score: scaleTo15(raw, legacyMax),
    comment: fallbackComment
  };
}

function dimensionColorClass(score) {
  if (score < 5) return "danger";
  if (score < 10) return "warning";
  return "success";
}

function resumeTitle(resume) {
  const profile = resume?.analysis?.user_profile || {};
  if (resume?.archive_name) return resume.archive_name;
  return profile.name ? `${profile.name} 的简历` : resume?.file_name || `简历版本 ${formatDate(resume?.created_at)}`;
}

function healthScore(resume) {
  return resume?.optimized?.optimization_score ?? resume?.analysis?.diagnosis?.health_score ?? resume?.analysis?.diagnosis?.score ?? "-";
}

function normalizeRewriteSuggestions(optimized) {
  const direct = optimized?.rewrite_suggestions || [];
  if (direct.length) {
    return direct.map((item, index) => ({
      index: index + 1,
      section: typeof item === "string" ? "优化建议" : item.section || item.target_field || "简历内容",
      before: typeof item === "string"
        ? `原版简历未充分体现：${item}`
        : item.before || item.original_responsibility || item.original || item.original_text || "原版对应内容需要补充或强化，但模型未返回原句。",
      after: typeof item === "string"
        ? item
        : item.after || item.optimized_responsibility || item.optimized || item.suggestion || item.optimized_text || "请按该项建议补充更贴合岗位的表达。",
      reason: typeof item === "string" ? "模型返回的是概括建议，已转为可读对照。" : item.reason || item.change_reason || item.description || "",
      keywords: typeof item === "string" ? [] : item.keywords_inserted || item.keywords || [],
      gapDriven: typeof item === "string" ? false : item.gap_driven ?? item.gapDriven ?? false
    }));
  }
  const experience = optimized?.optimized_experience || [];
  return experience.map((item, index) => ({
    index: index + 1,
    section: `经历 ${item.experience_index ?? index + 1}`,
    before: item.original_responsibility || "原文未返回",
    after: item.optimized_responsibility || "优化建议未返回",
    reason: item.change_reason || "",
    keywords: item.keywords_inserted || [],
    gapDriven: Boolean(item.gap_driven)
  }));
}

function baseResumes() {
  return state.resumeVersions.filter(resume => resume.source !== "targeted_optimization");
}

function optimizedChildren(parentResumeId) {
  return state.resumeVersions.filter(resume => resume.source === "targeted_optimization" && resume.parent_resume_version_id === parentResumeId);
}

function latestBaseResume() {
  return baseResumes()[0] || state.resumeVersions.find(resume => resume.analysis?.user_profile) || null;
}

function jobTitle(job) {
  return job?.jd_profile?.job_title || "未命名岗位";
}

function company(job) {
  return job?.jd_profile?.company || "公司未识别";
}

function skillsFromProfile(profile) {
  if (!profile?.skills) return [];
  if (Array.isArray(profile.skills)) return profile.skills;
  return [
    ...(profile.skills.technical || []),
    ...(profile.skills.soft || []),
    ...(profile.skills.language || []),
    ...(profile.skills.certificate || [])
  ].filter(Boolean);
}

function pills(items, className = "") {
  if (!items || items.length === 0) return `<span class="meta">暂无</span>`;
  return `<div class="pill-row">${items.map(item => `<span class="pill ${className}">${escapeHtml(item)}</span>`).join("")}</div>`;
}

function list(items) {
  if (!items || items.length === 0) return `<p class="meta">暂无</p>`;
  return `<ul>${items.map(item => `<li>${escapeHtml(typeof item === "string" ? item : JSON.stringify(item))}</li>`).join("")}</ul>`;
}

function setView(nextView, options = {}) {
  view = nextView;
  if (options.resumeId !== undefined) selectedResumeId = options.resumeId;
  if (options.jobId !== undefined) selectedJobId = options.jobId;
  if (options.optimizedResumeId !== undefined) selectedOptimizedResumeId = options.optimizedResumeId;
  if (options.applicationId !== undefined) selectedApplicationId = options.applicationId;
  document.querySelectorAll(".nav-tabs button").forEach(button => {
    button.classList.toggle("active", button.dataset.view === topLevelView(nextView));
  });
  render();
}

function topLevelView(current) {
  if (current.startsWith("resume")) return "resumes";
  if (current.startsWith("job") || current.startsWith("match")) return "jobs";
  if (current.startsWith("application")) return "applications";
  if (current.startsWith("growth")) return "applications";
  return current;
}

function renderShell(title, subtitle, actions = "") {
  return `
    <section class="topbar">
      <div>
        <h1>${escapeHtml(title)}</h1>
        <p>${escapeHtml(subtitle)}</p>
      </div>
      <div class="button-row">${actions}</div>
    </section>
  `;
}

function renderDashboard() {
  const matched = state.jobCards.filter(job => job.status === "matched" || job.status === "resume_optimized");
  const archives = baseResumes();
  const optimizedCount = state.resumeVersions.filter(resume => resume.source === "targeted_optimization").length;
  const avg = matched.length ? Math.round(matched.reduce((sum, job) => sum + (job.match_report?.total_score || 0), 0) / matched.length) : "-";
  root().innerHTML = `
    ${renderShell("求职决策工作台", "每份简历都是独立档案；选择具体简历和岗位后，匹配差距会驱动定向优化。", `<button id="newResume">上传简历</button><button id="newJob" class="secondary">添加岗位</button>`)}
    <div class="metric-grid">
      <article class="metric"><span>简历档案</span><strong>${archives.length}</strong></article>
      <article class="metric"><span>岗位卡片</span><strong>${state.jobCards.length}</strong></article>
      <article class="metric"><span>优化版本</span><strong>${optimizedCount}</strong></article>
      <article class="metric"><span>平均匹配分</span><strong>${avg}</strong></article>
    </div>
    <div class="two-column">
      <section class="panel">
        <div class="panel-heading"><h2>当前用户画像</h2></div>
        ${renderUserProfile()}
      </section>
      <section class="panel">
        <div class="panel-heading"><h2>最近岗位</h2></div>
        <div class="stack">${state.jobCards.slice(0, 4).map(renderJobCard).join("") || `<div class="empty-state">还没有分析过的岗位。</div>`}</div>
      </section>
    </div>
  `;
  $("#newResume").addEventListener("click", () => setView("resumeUpload"));
  $("#newJob").addEventListener("click", () => setView("jobInput"));
  bindJobCardActions();
}

function renderUserProfile() {
  const resume = selectedResumeId ? state.resumeVersions.find(item => item.resume_version_id === selectedResumeId) : latestBaseResume();
  const profile = resume?.analysis?.user_profile || state.userProfile;
  if (!profile) {
    return `<div class="empty-state">请先上传简历并生成用户画像。</div>`;
  }
  return `
    <div class="report-block">
      <h3>${escapeHtml(resumeTitle(resume))}</h3>
      <p>${escapeHtml(profile.summary || "已生成该简历档案的用户画像。")}</p>
      ${pills(skillsFromProfile(profile), "green")}
    </div>
  `;
}

function renderResumes() {
  const archives = baseResumes();
  root().innerHTML = `
    ${renderShell("我的简历", "每次上传都会形成一份独立简历档案；优化版本会挂在原始档案下面，不再默认归为同一个人。", `<button id="openOptimizeWorkspace" class="secondary">定向优化</button><button id="uploadResume">+ 新建简历档案</button>`)}
    <section class="panel">
      ${archives.length ? `<div class="card-grid">${archives.map(renderResumeCard).join("")}</div>` : renderResumeEmpty()}
    </section>
  `;
  $("#uploadResume").addEventListener("click", () => setView("resumeUpload"));
  $("#openOptimizeWorkspace").addEventListener("click", () => setView("targetedOptimization"));
  $("#emptyUploadResume")?.addEventListener("click", () => setView("resumeUpload"));
  document.querySelectorAll("[data-open-resume]").forEach(button => {
    button.addEventListener("click", () => setView("resumeDiagnosis", { resumeId: button.dataset.openResume }));
  });
  document.querySelectorAll("[data-optimize-resume]").forEach(button => {
    button.addEventListener("click", () => setView("targetedOptimization", { resumeId: button.dataset.optimizeResume }));
  });
  document.querySelectorAll("[data-open-comparison]").forEach(button => {
    button.addEventListener("click", () => setView("resumeComparison", { optimizedResumeId: button.dataset.openComparison }));
  });
}

function renderResumeEmpty() {
  return `
    <div class="empty-state center">
      <h2>还没有简历，先上传一份吧</h2>
      <p>上传后 AI 会解析教育、经历、技能和项目，并生成诊断问题清单。</p>
      <button id="emptyUploadResume" type="button">上传我的简历</button>
    </div>
  `;
}

function renderResumeCard(resume) {
  const diagnosis = resume.analysis?.diagnosis;
  const linkedCount = state.jobCards.filter(job => job.linked_resume_ids?.includes(resume.resume_version_id)).length;
  const children = optimizedChildren(resume.resume_version_id);
  return `
    <article class="job-card resume-archive">
      <header>
        <div>
          <strong>${escapeHtml(resumeTitle(resume))}</strong>
          <span class="meta">${escapeHtml(formatDate(resume.created_at))} · 独立简历档案 · ${escapeHtml(resume.file_name || "文本输入")}</span>
        </div>
        <span class="score small">${escapeHtml(healthScore(resume))}</span>
      </header>
      <p>${escapeHtml(diagnosis?.summary || resume.optimized?.positioning_summary || "已保存简历版本。")}</p>
      ${pills(skillsFromProfile(resume.analysis?.user_profile).slice(0, 6), "green")}
      ${children.length ? `
        <div class="nested-list">
          <strong>定向优化版本</strong>
          ${children.map(child => {
            const job = state.jobCards.find(item => item.job_card_id === child.job_card_id);
            return `<button class="nested-row nested-button" data-open-comparison="${child.resume_version_id}" type="button"><span>${escapeHtml(jobTitle(job))}</span><b>${escapeHtml(child.optimized?.optimization_score || "-")}分</b></button>`;
          }).join("")}
        </div>
      ` : `<p class="meta">暂无定向优化版本。</p>`}
      <div class="button-row">
        <button type="button" data-open-resume="${resume.resume_version_id}">查看诊断</button>
        <button type="button" class="secondary" data-optimize-resume="${resume.resume_version_id}">定向优化</button>
        <span class="pill">${linkedCount} 个关联岗位</span>
      </div>
    </article>
  `;
}

function renderResumeUpload() {
  root().innerHTML = `
    ${renderShell("上传简历", "支持 Word DOCX、可复制文本的 PDF、TXT/Markdown。扫描版 PDF 后续可接 OCR。", `<button class="ghost-button" id="backResumes">返回</button>`)}
    <div class="two-column wide-left">
      <section class="panel">
        <div class="upload-zone">
          <label for="resumeFile">选择简历文件</label>
          <input id="resumeFile" type="file" accept=".txt,.md,.markdown,.docx,.pdf,application/pdf,application/vnd.openxmlformats-officedocument.wordprocessingml.document" />
          <span id="fileStatus" class="meta">文件 ≤ 8MB。也可以直接粘贴文本。</span>
        </div>
        <textarea id="resumeText" rows="18" placeholder="上传文件后会自动填入抽取文本；你也可以直接粘贴简历内容。">${escapeHtml(draftResumeText)}</textarea>
        <div class="button-row">
          <button id="parseResume">确认信息，继续诊断</button>
        </div>
      </section>
      <section class="panel">
        <div class="panel-heading"><h2>流程</h2></div>
        <div class="step-list">
          <div class="step active"><strong>1 上传/粘贴简历</strong><span>提取非结构化文本</span></div>
          <div class="step"><strong>2 解析结果确认</strong><span>教育、经历、技能、项目</span></div>
          <div class="step"><strong>3 自动诊断</strong><span>健康分和高/中/低优先级问题</span></div>
          <div class="step"><strong>4 选择目标岗位</strong><span>复用 Job Card 或粘贴新 JD</span></div>
        </div>
      </section>
    </div>
  `;
  $("#backResumes").addEventListener("click", () => setView("resumes"));
  $("#resumeFile").addEventListener("change", uploadResumeFile);
  $("#parseResume").addEventListener("click", analyzeResume);
}

function renderResumeConfirm() {
  const resume = state.resumeVersions.find(item => item.resume_version_id === selectedResumeId) || state.resumeVersions[0];
  const profile = resume?.analysis?.user_profile;
  const diagnosis = resume?.analysis?.diagnosis;
  root().innerHTML = `
    ${renderShell("确认简历信息", "解析结果已生成。当前版本先展示确认态，字段编辑会在下一迭代接入。", `<button class="ghost-button" id="toDiagnosis">查看诊断</button>`)}
    <div class="two-column">
      <section class="panel">
        <div class="panel-heading"><h2>完整度</h2></div>
        <div class="progress"><span style="width:${Math.min(100, Number(diagnosis?.health_score || 70))}%"></span></div>
        <p class="meta">健康分 ${escapeHtml(diagnosis?.health_score || "-")}。补全经历和项目细节可提升匹配准确度。</p>
        <div class="report-block"><h3>教育背景</h3>${list(Array.isArray(profile?.education) ? profile.education : [profile?.education].filter(Boolean))}</div>
        <div class="report-block"><h3>工作/实习经历</h3>${list(profile?.experience)}</div>
      </section>
      <section class="panel">
        <div class="report-block"><h3>技能标签</h3>${pills(skillsFromProfile(profile), "green")}</div>
        <div class="report-block"><h3>项目经历</h3>${list(profile?.projects)}</div>
        <button id="confirmResume">确认信息，继续</button>
      </section>
    </div>
  `;
  $("#toDiagnosis").addEventListener("click", () => setView("resumeDiagnosis", { resumeId: resume.resume_version_id }));
  $("#confirmResume").addEventListener("click", () => setView("resumeDiagnosis", { resumeId: resume.resume_version_id }));
}

function renderResumeDiagnosis() {
  const resume = state.resumeVersions.find(item => item.resume_version_id === selectedResumeId) || state.resumeVersions[0];
  if (!resume) return setView("resumeUpload");
  const diagnosis = resume.analysis?.diagnosis || {};
  const issues = diagnosis.issues || [];
  root().innerHTML = `
    ${renderShell("简历诊断", "按高、中、低优先级展示影响求职成功率的问题，并引导进入岗位定向增强。", `<button class="ghost-button" id="backToResumes">返回列表</button><button id="chooseTarget">选择目标岗位</button>`)}
    <section class="panel">
      <div class="diagnosis-hero">
        <span class="score large">${escapeHtml(healthScore(resume))}</span>
        <div>
          <h2>简历健康分</h2>
          <p>${escapeHtml(diagnosis.summary || "建议根据目标岗位继续做定向优化。")}</p>
        </div>
      </div>
    </section>
    <div class="three-column">
      ${["high", "medium", "low"].map(priority => renderIssueColumn(priority, issues)).join("")}
    </div>
  `;
  $("#backToResumes").addEventListener("click", () => setView("resumes"));
  $("#chooseTarget").addEventListener("click", () => setView("resumeTarget", { resumeId: resume.resume_version_id }));
}

function renderIssueColumn(priority, issues) {
  const label = { high: "高优先级", medium: "中优先级", low: "低优先级" }[priority];
  const rows = issues.filter(item => item.priority === priority);
  return `
    <section class="panel">
      <div class="panel-heading"><h2>${label}（${rows.length}）</h2></div>
      <div class="stack">
        ${rows.map(item => `
          <article class="report-block">
            <span class="pill ${priority === "high" ? "amber" : ""}">${escapeHtml(item.category || priority)}</span>
            <h3>${escapeHtml(item.title)}</h3>
            <p>${escapeHtml(item.description)}</p>
            <p class="meta">建议：${escapeHtml(item.suggestion)}</p>
          </article>
        `).join("") || `<p class="meta">暂无</p>`}
      </div>
    </section>
  `;
}

function renderResumeTarget() {
  root().innerHTML = `
    ${renderShell("选择目标岗位", "可复用已有 Job Card 的 JD Profile 和 Gap 数据，也可粘贴新 JD 创建岗位卡片。", `<button class="ghost-button" id="backDiagnosis">返回诊断</button>`)}
    <div class="two-column">
      <section class="panel">
        <div class="panel-heading"><h2>从我的岗位选择</h2></div>
        <div class="stack">
          ${state.jobCards.map(job => `
            <article class="job-card">
              <header>
                <div><strong>${escapeHtml(jobTitle(job))}</strong><span class="meta">${escapeHtml(company(job))} · ${escapeHtml(job.status)}</span></div>
                <span class="score small">${escapeHtml(job.match_report?.total_score || "-")}</span>
              </header>
              ${job.gap_data ? `<div class="notice">已加载匹配分析结果，可使用 Gap 驱动优化。</div>` : `<p class="meta">仅复用 JD Profile 做标准优化。</p>`}
              <button data-optimize-job="${job.job_card_id}">选择并生成定向优化</button>
            </article>
          `).join("") || `<div class="empty-state">还没有岗位卡片，请在右侧粘贴 JD。</div>`}
        </div>
      </section>
      <section class="panel">
        <div class="panel-heading"><h2>粘贴新的 JD</h2></div>
        <textarea id="targetJdText" rows="14" placeholder="粘贴岗位职责和任职要求。"></textarea>
        <button id="createTargetJob">解析 JD 并优化</button>
      </section>
    </div>
  `;
  $("#backDiagnosis").addEventListener("click", () => setView("resumeDiagnosis"));
  document.querySelectorAll("[data-optimize-job]").forEach(button => {
    button.addEventListener("click", () => optimizeResume(button.dataset.optimizeJob));
  });
  $("#createTargetJob").addEventListener("click", createTargetJobAndOptimize);
}

function renderTargetedOptimization() {
  const resumes = baseResumes();
  const jobs = state.jobCards;
  const activeResumeId = selectedResumeId || resumes[0]?.resume_version_id || "";
  const activeJobId = selectedJobId || jobs[0]?.job_card_id || "";
  const activeResume = resumes.find(item => item.resume_version_id === activeResumeId);
  const activeJob = jobs.find(item => item.job_card_id === activeJobId);

  root().innerHTML = `
    ${renderShell("定向优化工作台", "请选择一份待优化的简历档案和一个相关岗位。系统会用该简历自己的画像 + 岗位 JD/GAP 生成优化版本，并给出优化评分。", `<button class="ghost-button" id="backToResumesFromOpt">返回简历</button>`)}
    <div class="two-column">
      <section class="panel">
        <div class="panel-heading"><h2>选择优化对象</h2></div>
        <label>待优化简历档案
          <select id="optResumeSelect">
            ${resumes.map(resume => `<option value="${resume.resume_version_id}" ${resume.resume_version_id === activeResumeId ? "selected" : ""}>${escapeHtml(resumeTitle(resume))}｜${escapeHtml(healthScore(resume))}分</option>`).join("")}
          </select>
        </label>
        <label>相关岗位
          <select id="optJobSelect">
            ${jobs.map(job => `<option value="${job.job_card_id}" ${job.job_card_id === activeJobId ? "selected" : ""}>${escapeHtml(jobTitle(job))}｜${escapeHtml(company(job))}｜${escapeHtml(job.match_report?.total_score || job.status)}</option>`).join("")}
          </select>
        </label>
        <div class="button-row">
          <button id="runTargetedOptimize" ${!activeResume || !activeJob ? "disabled" : ""}>生成针对性优化版本</button>
        </div>
        ${!resumes.length ? `<div class="empty-state">还没有可优化的简历档案，请先上传并解析简历。</div>` : ""}
        ${!jobs.length ? `<div class="empty-state">还没有岗位卡片，请先在“我的岗位”添加 JD。</div>` : ""}
      </section>
      <section class="panel">
        <div class="panel-heading"><h2>优化依据</h2></div>
        ${activeResume ? `
          <div class="report-block">
            <h3>${escapeHtml(resumeTitle(activeResume))}</h3>
            <p>${escapeHtml(activeResume.analysis?.user_profile?.summary || "已生成简历画像。")}</p>
            ${pills(skillsFromProfile(activeResume.analysis?.user_profile).slice(0, 8), "green")}
          </div>
        ` : ""}
        ${activeJob ? `
          <div class="report-block">
            <h3>${escapeHtml(jobTitle(activeJob))}</h3>
            <p>${escapeHtml(activeJob.jd_profile?.job_summary || activeJob.raw_jd_text || "")}</p>
            ${activeJob.gap_data ? `<div class="notice">将使用该岗位的 Gap Data 驱动优化：${escapeHtml(activeJob.gap_data.gap_summary || "")}</div>` : `<p class="meta">该岗位尚无匹配 Gap，将使用 JD Profile 做标准优化。</p>`}
          </div>
        ` : ""}
      </section>
    </div>
  `;

  $("#backToResumesFromOpt").addEventListener("click", () => setView("resumes"));
  $("#optResumeSelect")?.addEventListener("change", event => {
    selectedResumeId = event.target.value;
    renderTargetedOptimization();
  });
  $("#optJobSelect")?.addEventListener("change", event => {
    selectedJobId = event.target.value;
    renderTargetedOptimization();
  });
  $("#runTargetedOptimize")?.addEventListener("click", () => optimizeResume($("#optJobSelect").value, $("#optResumeSelect").value));
}

function renderResumeComparison() {
  const optimizedResume = state.resumeVersions.find(item => item.resume_version_id === selectedOptimizedResumeId)
    || state.resumeVersions.find(item => item.source === "targeted_optimization");
  if (!optimizedResume) return setView("resumes");

  const sourceResume = state.resumeVersions.find(item => item.resume_version_id === optimizedResume.parent_resume_version_id);
  const job = state.jobCards.find(item => item.job_card_id === optimizedResume.job_card_id);
  const optimized = optimizedResume.optimized || {};
  const suggestions = normalizeRewriteSuggestions(optimized);
  const score = optimized.optimization_score || "-";

  root().innerHTML = `
    ${renderShell("简历优化对照", "红色展示原版简历中需要改动的地方，绿色展示新版简历的修改意见。", `<button class="ghost-button" id="backFromComparison">返回简历</button><button id="continueOptimizeFromComparison">再次优化</button>`)}
    <section class="panel">
      <div class="comparison-summary">
        <div>
          <span class="meta">原始档案</span>
          <h2>${escapeHtml(resumeTitle(sourceResume || optimizedResume))}</h2>
          <p>${escapeHtml(jobTitle(job))} · ${escapeHtml(company(job))}</p>
        </div>
        <span class="score large">${escapeHtml(score)}</span>
      </div>
      <div class="score-grid">
        ${renderScoreItem("岗位贴合", optimized.score_breakdown?.jd_alignment)}
        ${renderScoreItem("关键词覆盖", optimized.score_breakdown?.keyword_coverage)}
        ${renderScoreItem("证据质量", optimized.score_breakdown?.evidence_quality)}
        ${renderScoreItem("真实性风险", optimized.score_breakdown?.authenticity_risk)}
      </div>
      <div class="notice">${escapeHtml(optimized.positioning_summary || "已生成面向该岗位的简历优化建议。")}</div>
    </section>
    <section class="panel">
      <div class="panel-heading"><h2>结构化改动对照</h2></div>
      <div class="comparison-list">
        ${suggestions.length ? suggestions.map(renderComparisonItem).join("") : renderFallbackComparison(optimizedResume, sourceResume)}
      </div>
    </section>
    <section class="panel">
      <div class="panel-heading"><h2>关键词与风险提醒</h2></div>
      <div class="two-column">
        <div class="report-block"><h3>新增/强化关键词</h3>${pills(optimized.keywords_added || [], "green")}</div>
        <div class="report-block"><h3>风险提醒</h3>${list(optimized.risk_notes)}</div>
      </div>
    </section>
  `;

  $("#backFromComparison").addEventListener("click", () => setView("resumes"));
  $("#continueOptimizeFromComparison").addEventListener("click", () => setView("targetedOptimization", {
    resumeId: sourceResume?.resume_version_id || optimizedResume.parent_resume_version_id,
    jobId: job?.job_card_id || optimizedResume.job_card_id
  }));
}

function renderScoreItem(label, value) {
  return `<div class="score-item"><span>${escapeHtml(label)}</span><strong>${escapeHtml(value ?? "-")}</strong></div>`;
}

function renderComparisonItem(item) {
  return `
    <article class="comparison-item">
      <header>
        <div>
          <span class="pill">${escapeHtml(item.section)}</span>
          ${item.gapDriven ? `<span class="pill amber">Gap 驱动</span>` : ""}
        </div>
        <strong>#${item.index}</strong>
      </header>
      <div class="comparison-pair">
        <div class="before-block">
          <h3>原版需要改动</h3>
          <p>${escapeHtml(item.before)}</p>
        </div>
        <div class="after-block">
          <h3>新版修改意见</h3>
          <p>${escapeHtml(item.after)}</p>
        </div>
      </div>
      <footer>
        <p>${escapeHtml(item.reason || "建议按岗位要求强化表达。")}</p>
        ${item.keywords?.length ? pills(item.keywords, "green") : ""}
      </footer>
    </article>
  `;
}

function renderFallbackComparison(optimizedResume, sourceResume) {
  return `
    <article class="comparison-item">
      <header><span class="pill">全文对照</span><strong>#1</strong></header>
      <div class="comparison-pair">
        <div class="before-block">
          <h3>原版简历</h3>
          <p>${escapeHtml((sourceResume?.raw_text || optimizedResume.raw_text || "").slice(0, 1200))}</p>
        </div>
        <div class="after-block">
          <h3>新版优化稿</h3>
          <p>${escapeHtml((optimizedResume.optimized?.optimized_resume || "").slice(0, 1200))}</p>
        </div>
      </div>
    </article>
  `;
}

function renderJobs() {
  root().innerHTML = `
    ${renderShell("我的岗位", "以 Job Card 管理岗位画像、匹配报告、Gap 数据和关联优化简历。", `<button id="newJobButton">+ 新建岗位</button>`)}
    <section class="panel">
      <div class="filter-tabs">
        <span>全部 ${state.jobCards.length}</span>
        <span>待决策 ${state.jobCards.filter(job => job.user_decision === "pending").length}</span>
        <span>已投递 ${state.jobCards.filter(job => job.user_decision === "applied").length}</span>
        <span>已放弃 ${state.jobCards.filter(job => job.user_decision === "archived").length}</span>
      </div>
      ${state.jobCards.length ? `<div class="card-grid">${state.jobCards.map(renderJobCard).join("")}</div>` : `<div class="empty-state center"><h2>还没有分析过的岗位</h2><p>添加 JD 后，AI 会解析岗位画像并生成匹配报告。</p><button id="emptyNewJob">立即添加第一个岗位</button></div>`}
    </section>
  `;
  $("#newJobButton").addEventListener("click", () => setView("jobInput"));
  $("#emptyNewJob")?.addEventListener("click", () => setView("jobInput"));
  bindJobCardActions();
}

function bindJobCardActions() {
  document.querySelectorAll("[data-open-job]").forEach(button => {
    button.addEventListener("click", () => setView("jobDetail", { jobId: button.dataset.openJob }));
  });
  document.querySelectorAll("[data-start-match]").forEach(button => {
    button.addEventListener("click", () => matchExistingJob(button.dataset.startMatch));
  });
  document.querySelectorAll("[data-start-optimize]").forEach(button => {
    button.addEventListener("click", () => setView("targetedOptimization", { jobId: button.dataset.startOptimize }));
  });
}

function renderJobCard(job) {
  const score = job.match_report?.total_score;
  const action = job.status === "jd_parsed"
    ? `<button data-start-match="${job.job_card_id}">开始匹配</button>`
    : job.status === "matched"
      ? `<button data-start-optimize="${job.job_card_id}">生成简历</button>`
      : `<button data-open-job="${job.job_card_id}">查看详情</button>`;
  return `
    <article class="job-card">
      <header>
        <div>
          <strong>${escapeHtml(jobTitle(job))}</strong>
          <span class="meta">${escapeHtml(company(job))} · ${escapeHtml(job.jd_profile?.location || "地点未识别")}</span>
        </div>
        <span class="score small">${escapeHtml(score || "-")}</span>
      </header>
      <p>${escapeHtml(job.jd_profile?.job_summary || job.match_report?.summary || "已创建岗位卡片。")}</p>
      <div class="button-row">
        <span class="pill ${job.status === "resume_optimized" ? "green" : ""}">${escapeHtml(job.status)}</span>
        ${action}
      </div>
    </article>
  `;
}

function renderJobInput() {
  root().innerHTML = `
    ${renderShell("添加岗位", "MVP 已完整支持文本 JD；链接抓取和截图 OCR 作为产品入口先保留降级提示。", `<button class="ghost-button" id="backJobs">返回</button>`)}
    <section class="panel">
      <div class="segmented">
        <button class="${jdInputMode === "text" ? "active" : ""}" data-mode="text">粘贴文本</button>
        <button class="${jdInputMode === "url" ? "active" : ""}" data-mode="url">岗位链接</button>
        <button class="${jdInputMode === "screenshot" ? "active" : ""}" data-mode="screenshot">上传截图</button>
      </div>
      <div id="jdInputArea"></div>
    </section>
  `;
  $("#backJobs").addEventListener("click", () => setView("jobs"));
  document.querySelectorAll("[data-mode]").forEach(button => {
    button.addEventListener("click", () => {
      jdInputMode = button.dataset.mode;
      renderJobInputArea();
    });
  });
  renderJobInputArea();
}

function renderJobInputArea() {
  const area = $("#jdInputArea");
  if (jdInputMode !== "text") {
    area.innerHTML = `
      <div class="empty-state">
        ${jdInputMode === "url" ? "链接抓取容易受招聘网站反爬影响，MVP 先降级为文本粘贴。" : "截图 OCR 入口已预留，MVP 先使用文本粘贴保证准确度。"}
        <div class="button-row"><button id="switchTextMode">改用文本粘贴</button></div>
      </div>
    `;
    $("#switchTextMode").addEventListener("click", () => {
      jdInputMode = "text";
      renderJobInput();
    });
    return;
  }
  area.innerHTML = `
    <div class="upload-zone">
      <label for="jdFile">上传 JD 文件</label>
      <input id="jdFile" type="file" accept=".txt,.md,.markdown,.docx,.pdf,application/pdf,application/vnd.openxmlformats-officedocument.wordprocessingml.document" />
      <span id="jdFileStatus" class="meta">支持 TXT、Markdown、Word DOCX、可复制文本的 PDF。</span>
    </div>
    <textarea id="jdText" rows="16" placeholder="将招聘页面的职位描述粘贴到这里，建议包含岗位职责、任职要求、加分项。">${escapeHtml(draftJdText)}</textarea>
    <p class="meta" id="jdCount">建议 > 200 字以确保解析质量。</p>
    <button id="parseJob">解析岗位信息</button>
  `;
  $("#jdFile").addEventListener("change", uploadJdFile);
  $("#jdText").addEventListener("input", event => {
    draftJdText = event.target.value;
    $("#jdCount").textContent = `${draftJdText.length} 字${draftJdText.length < 100 ? "，内容过短可能影响准确度" : "，可解析"}`;
  });
  $("#parseJob").addEventListener("click", createJobCard);
}

function renderJobConfirm() {
  const job = state.jobCards.find(item => item.job_card_id === selectedJobId) || state.jobCards[0];
  if (!job) return setView("jobInput");
  const p = job.jd_profile || {};
  root().innerHTML = `
    ${renderShell("确认岗位信息", "JD Profile 已写入 Job Card。确认后可开始匹配分析，也可稍后在简历模块复用。", `<button class="ghost-button" id="backInput">返回</button><button id="startMatch">开始匹配分析</button>`)}
    <div class="two-column">
      <section class="panel">
        <div class="field-list">
          ${fieldRow("公司", p.company)}
          ${fieldRow("岗位", p.job_title)}
          ${fieldRow("地点", p.location)}
          ${fieldRow("薪资", p.salary_range)}
          ${fieldRow("经验", p.experience_required?.description || p.experience_required?.min_years)}
          ${fieldRow("学历", p.education_required)}
        </div>
      </section>
      <section class="panel">
        <div class="report-block"><h3>必要技能</h3>${pills(p.skills?.must_have, "green")}</div>
        <div class="report-block"><h3>加分技能</h3>${pills(p.skills?.nice_to_have)}</div>
        <div class="report-block"><h3>核心考察点</h3><p>${escapeHtml(p.key_challenge || "待模型识别")}</p></div>
      </section>
    </div>
  `;
  $("#backInput").addEventListener("click", () => setView("jobInput"));
  $("#startMatch").addEventListener("click", () => matchExistingJob(job.job_card_id));
}

function fieldRow(label, value) {
  return `<div class="field-row"><span>${escapeHtml(label)}</span><strong>${escapeHtml(value || "未识别")}</strong></div>`;
}

function renderJobReport() {
  const job = state.jobCards.find(item => item.job_card_id === selectedJobId) || state.jobCards[0];
  if (!job?.match_report) return setView("jobConfirm", { jobId: job?.job_card_id });
  const report = job.match_report;
  const dimension = report.dimension_scores || {};
  const skill = dimensionValue(dimension, ["skill_match", "skills", "skill"], 40, "根据必要技能与简历技能证据评估。");
  const experience = dimensionValue(dimension, ["experience_match", "experience"], 20, "根据岗位年限要求与经历相关度评估。");
  const education = dimensionValue(dimension, ["education_match", "education"], 15, "根据学历要求与教育背景评估。");
  const personality = dimensionValue(dimension, ["personality_match", "personality"], 15, "未完成性格测试时按 JD 行为特征粗略评估。");
  const background = dimensionValue(dimension, ["background_match", "background"], 10, "根据项目、行业与业务背景相关度评估。");
  root().innerHTML = `
    ${renderShell("匹配报告", "报告分为总览、维度得分和差距分析。Gap 数据会被简历优化模块消费。", `<button class="ghost-button" id="backJobDetail">返回详情</button><button id="optimizeFromReport">立即生成针对性简历</button>`)}
    <section class="panel">
      <div class="match-hero">
        <span class="score large">${escapeHtml(report.total_score)}</span>
        <div>
          <h2>${escapeHtml(report.match_level || scoreLevel(report.total_score))}</h2>
          <p>${escapeHtml(report.decision_suggestion || report.summary || "请查看详细差距后决策。")}</p>
          <p class="meta">${escapeHtml(jobTitle(job))} · ${escapeHtml(company(job))}</p>
        </div>
      </div>
    </section>
    <div class="two-column">
      <section class="panel">
        <div class="panel-heading"><h2>维度得分</h2></div>
        ${renderDimension("技能匹配度", skill.score, skill.comment)}
        ${renderDimension("经验年限匹配", experience.score, experience.comment)}
        ${renderDimension("学历匹配", education.score, education.comment)}
        ${renderDimension("性格标签吻合度", personality.score, personality.comment)}
        ${renderDimension("项目背景相关度", background.score, background.comment)}
      </section>
      <section class="panel">
        <div class="report-block"><h3>你的优势</h3>${pills(report.strengths || job.gap_data?.strengths_to_highlight, "green")}</div>
        <div class="report-block"><h3>待补强项</h3>${(job.gap_data?.priority_gaps || []).map(gap => `
          <div class="gap-item">
            <strong>${escapeHtml(gap.item)} · ${escapeHtml(gap.severity)}</strong>
            <p>${escapeHtml(gap.description)}</p>
            <p class="meta">${escapeHtml(gap.resume_fix)}</p>
            <button data-gap-optimize="${job.job_card_id}">立即在简历中改进</button>
          </div>
        `).join("") || `<p class="meta">暂无明显差距</p>`}</div>
      </section>
    </div>
  `;
  $("#backJobDetail").addEventListener("click", () => setView("jobDetail", { jobId: job.job_card_id }));
  $("#optimizeFromReport").addEventListener("click", () => setView("targetedOptimization", { jobId: job.job_card_id }));
  document.querySelectorAll("[data-gap-optimize]").forEach(button => {
    button.addEventListener("click", () => setView("targetedOptimization", { jobId: button.dataset.gapOptimize }));
  });
}

function renderDimension(label, score, comment) {
  const safe = scaleTo15(score);
  const colorClass = dimensionColorClass(safe);
  return `
    <div class="dimension-row ${colorClass}">
      <div><strong>${escapeHtml(label)}</strong><span>${safe}/15</span></div>
      <div class="progress"><span style="width:${Math.min(100, (safe / 15) * 100)}%"></span></div>
      <p class="meta">${escapeHtml(comment || "")}</p>
    </div>
  `;
}

function renderJobDetail() {
  const job = state.jobCards.find(item => item.job_card_id === selectedJobId) || state.jobCards[0];
  if (!job) return setView("jobs");
  const linked = state.resumeVersions.filter(resume => job.linked_resume_ids?.includes(resume.resume_version_id));
  root().innerHTML = `
    ${renderShell(`${jobTitle(job)} · ${company(job)}`, "Job Card 聚合岗位画像、匹配报告、关联优化简历和求职决策。", `<button class="ghost-button" id="backJobsList">我的岗位</button>`)}
    <section class="panel">
      <div class="status-strip"><span>${escapeHtml(job.status)}</span><strong>${escapeHtml(job.user_decision)}</strong></div>
    </section>
    <div class="two-column">
      <section class="panel">
        <div class="report-block"><h3>岗位信息摘要</h3><p>${escapeHtml(job.jd_profile?.job_summary || job.raw_jd_text)}</p>${pills(job.jd_profile?.skills?.must_have, "green")}</div>
        <div class="report-block"><h3>匹配分析</h3>${job.match_report ? `<p><strong>${job.match_report.total_score}分 ${escapeHtml(job.match_report.match_level || scoreLevel(job.match_report.total_score))}</strong></p><button id="openReport">查看报告</button>` : `<p class="meta">尚未匹配。</p><button id="detailStartMatch">开始匹配</button>`}</div>
      </section>
      <section class="panel">
        <div class="report-block"><h3>关联简历</h3>${linked.map(resume => {
          const parent = state.resumeVersions.find(item => item.resume_version_id === resume.parent_resume_version_id);
          return `<button class="nested-row nested-button" data-detail-comparison="${resume.resume_version_id}" type="button"><span>${escapeHtml(resumeTitle(parent || resume))} 的优化版 · ${formatDate(resume.created_at)}</span><b>${escapeHtml(resume.optimized?.optimization_score || "-")}分</b></button>`;
        }).join("") || `<p class="meta">暂无关联优化简历</p>`}<button id="detailOptimize">再次优化简历</button></div>
        <div class="report-block"><h3>求职决策</h3><div class="button-row"><button data-decision="applied">标记为已投递</button><button class="ghost-button" data-decision="archived">放弃此岗位</button></div></div>
      </section>
    </div>
  `;
  $("#backJobsList").addEventListener("click", () => setView("jobs"));
  $("#openReport")?.addEventListener("click", () => setView("jobReport", { jobId: job.job_card_id }));
  $("#detailStartMatch")?.addEventListener("click", () => matchExistingJob(job.job_card_id));
  $("#detailOptimize").addEventListener("click", () => setView("targetedOptimization", { jobId: job.job_card_id }));
  document.querySelectorAll("[data-detail-comparison]").forEach(button => {
    button.addEventListener("click", () => setView("resumeComparison", { optimizedResumeId: button.dataset.detailComparison }));
  });
  document.querySelectorAll("[data-decision]").forEach(button => {
    button.addEventListener("click", () => updateJobDecision(job.job_card_id, button.dataset.decision));
  });
}

function renderApplications() {
  const unlocked = state.applications.length >= 3;
  root().innerHTML = `
    ${renderShell("投递追踪", "投递状态由「我的岗位」中的求职决策同步生成。", `<button id="openGrowthInsights" ${unlocked ? "" : "disabled"}>成长分析</button>`)}
    <section class="panel">
      ${unlocked
        ? `<div class="notice">已积累 ${state.applications.length} 条投递记录，可以查看跨投递成长分析。</div>`
        : `<div class="empty-state">还差 ${3 - state.applications.length} 条投递记录解锁成长分析。先从「我的岗位」标记投递或放弃来积累数据。</div>`}
    </section>
    <div class="kanban">${applicationStatuses.map(status => {
      const apps = state.applications.filter(app => app.current_status === status);
      return `<section class="kanban-column"><h3>${status}<span>${apps.length}</span></h3>${apps.map(renderApplicationCard).join("") || `<p class="meta">暂无记录</p>`}</section>`;
    }).join("")}</div>
  `;
  $("#openGrowthInsights").addEventListener("click", () => {
    if (!unlocked) return toast("至少需要 3 条投递记录才能查看成长分析");
    setView("growthInsights");
  });
  document.querySelectorAll("[data-open-application]").forEach(card => {
    card.addEventListener("click", () => setView("applicationDetail", { applicationId: card.dataset.openApplication }));
  });
}

function renderApplicationCard(app) {
  const job = state.jobCards.find(item => item.job_card_id === app.job_card_id);
  return `<article class="application-card" data-open-application="${app.application_id}" tabindex="0"><strong>${escapeHtml(jobTitle(job))}</strong><p class="meta">${escapeHtml(company(job))} · ${escapeHtml(app.apply_channel)} · ${escapeHtml(app.apply_date)} · ${escapeHtml(app.match_score_at_apply || "-")}分</p></article>`;
}

function computeGrowthStats() {
  const apps = state.applications || [];
  const scored = apps.filter(app => Number.isFinite(Number(app.match_score_at_apply)));
  const total = apps.length;
  const hrPassed = apps.filter(app => hasReachedStatus(app, "HR筛选通过")).length;
  const interviewReached = apps.filter(app => hasReachedStatus(app, "一面")).length;
  const interviewPassed = apps.filter(app => hasReachedStatus(app, "二面") || app.current_status === "已发Offer" || app.final_result === "Offer").length;
  const offers = apps.filter(app => app.current_status === "已发Offer" || app.final_result === "Offer").length;
  const averageMatch = scored.length
    ? Math.round(scored.reduce((sum, app) => sum + Number(app.match_score_at_apply), 0) / scored.length)
    : "-";
  const rejectedStages = apps.map(rejectionStage).filter(Boolean);
  const stageCounts = rejectedStages.reduce((acc, stage) => {
    acc[stage] = (acc[stage] || 0) + 1;
    return acc;
  }, {});
  const mostRejectedStage = Object.entries(stageCounts).sort((a, b) => b[1] - a[1])[0] || null;
  const gapCounts = {};
  apps.forEach(app => {
    (app.gap_data_at_apply?.priority_gaps || []).forEach(gap => {
      const key = gap.item || "未命名 Gap";
      gapCounts[key] = gapCounts[key] || { item: key, count: 0, high: 0, failed: 0 };
      gapCounts[key].count += 1;
      if (gap.severity === "high") gapCounts[key].high += 1;
      if (["拒绝", "放弃"].includes(app.final_result) || ["拒绝", "放弃"].includes(app.current_status)) gapCounts[key].failed += 1;
    });
  });
  const recurringGaps = Object.values(gapCounts)
    .filter(item => item.count >= 2)
    .sort((a, b) => b.count - a.count)
    .slice(0, 5);
  const growthHighMatchThreshold = 50;
  const matchBuckets = [
    { label: "高匹配 50+", apps: apps.filter(app => Number(app.match_score_at_apply || 0) >= growthHighMatchThreshold) },
    { label: "低匹配 <50", apps: apps.filter(app => Number(app.match_score_at_apply || 0) < growthHighMatchThreshold) }
  ].map(bucket => ({
    ...bucket,
    hrRate: rate(bucket.apps.filter(app => hasReachedStatus(app, "HR筛选通过")).length, bucket.apps.length),
    interviewRate: rate(bucket.apps.filter(app => hasReachedStatus(app, "一面")).length, bucket.apps.length),
    offerRate: rate(bucket.apps.filter(app => app.current_status === "已发Offer" || app.final_result === "Offer").length, bucket.apps.length)
  }));
  return {
    total,
    hrRate: rate(hrPassed, total),
    interviewRate: rate(interviewPassed, interviewReached),
    interviewReached,
    offers,
    averageMatch,
    mostRejectedStage,
    stageCounts,
    recurringGaps,
    matchBuckets
  };
}

function renderGrowthInsights() {
  if (state.applications.length < 3) return setView("applications");
  const stats = computeGrowthStats();
  const aiInsight = state.growthInsights?.[0];
  root().innerHTML = `
    ${renderShell("成长分析", "基于投递记录识别求职漏斗、匹配分表现和反复出现的 Gap。", `<button class="ghost-button" id="backApplicationsFromGrowth">投递追踪</button>`)}
    <div class="metric-grid">
      <article class="metric"><span>总投递数</span><strong>${escapeHtml(stats.total)}</strong></article>
      <article class="metric"><span>HR 通过率</span><strong>${escapeHtml(stats.hrRate)}%</strong></article>
      <article class="metric"><span>面试通过率</span><strong>${escapeHtml(stats.interviewRate)}%</strong></article>
      <article class="metric"><span>Offer 数</span><strong>${escapeHtml(stats.offers)}</strong></article>
    </div>
    <div class="two-column">
      <section class="panel">
        <div class="panel-heading"><h2>漏斗概览</h2></div>
        ${renderFunnelRow("HR 通过率", stats.hrRate, `${stats.hrRate}%`, "blue")}
        ${renderFunnelRow("面试通过率", stats.interviewRate, `${stats.interviewRate}%`, "blue")}
        ${renderFunnelRow("平均匹配分", Number(stats.averageMatch) || 0, `${stats.averageMatch}分`, "blue")}
        <div class="notice">最常被拒阶段：${escapeHtml(stats.mostRejectedStage ? `${stats.mostRejectedStage[0]}（${stats.mostRejectedStage[1]}次）` : "暂无拒绝记录")}</div>
      </section>
      <section class="panel">
        <div class="panel-heading"><h2>匹配分表现对比</h2></div>
        ${stats.matchBuckets.map(bucket => {
          const bucketColor = bucket.label.includes("高匹配") ? "green" : "amber";
          return `
          <div class="bucket-card ${bucketColor}">
            <strong>${escapeHtml(bucket.label)}</strong>
            <p class="meta">${escapeHtml(bucket.apps.length)} 条记录</p>
            ${bucket.apps.length ? `
              ${renderFunnelRow("HR 通过", bucket.hrRate, `${bucket.hrRate}%`, bucketColor)}
              ${renderFunnelRow("进入面试", bucket.interviewRate, `${bucket.interviewRate}%`, bucketColor)}
              ${renderFunnelRow("Offer", bucket.offerRate, `${bucket.offerRate}%`, bucketColor)}
            ` : `<div class="empty-state">暂无该匹配分区间的投递样本。</div>`}
          </div>
        `;
        }).join("")}
      </section>
    </div>
    <div class="two-column">
      <section class="panel">
        <div class="panel-heading"><h2>被拒阶段分布</h2></div>
        ${Object.keys(stats.stageCounts).length ? Object.entries(stats.stageCounts).map(([stage, count]) => `
          <div class="stage-row"><span>${escapeHtml(stage)}</span><strong>${escapeHtml(count)} 次</strong></div>
        `).join("") : `<p class="meta">暂无拒绝阶段数据。</p>`}
      </section>
      <section class="panel">
        <div class="panel-heading"><h2>反复出现的 Gap</h2></div>
        ${stats.recurringGaps.length ? stats.recurringGaps.map(gap => `
          <div class="gap-item">
            <strong>${escapeHtml(gap.item)}</strong>
            <p class="meta">出现 ${escapeHtml(gap.count)} 次 · 高优先级 ${escapeHtml(gap.high)} 次 · 失败/放弃关联 ${escapeHtml(gap.failed)} 次</p>
          </div>
        `).join("") : `<p class="meta">暂无反复出现的 Gap。积累更多匹配报告后会更准确。</p>`}
      </section>
    </div>
    <section class="panel">
      <div class="panel-heading">
        <h2>AI 成长解读</h2>
        <button id="generateGrowthInsight" type="button">${aiInsight ? "刷新 AI 解读" : "生成 AI 解读"}</button>
      </div>
      ${aiInsight ? renderGrowthInsightBlock(aiInsight) : `<div class="empty-state">点击生成后，AI 会结合投递状态、匹配分、Gap 和复盘记录，给出阶段性成长解读。此操作会调用一次大模型。</div>`}
    </section>
  `;
  $("#backApplicationsFromGrowth").addEventListener("click", () => setView("applications"));
  $("#generateGrowthInsight").addEventListener("click", event => generateGrowthInsight(event.currentTarget));
}

function renderGrowthInsightBlock(insight) {
  const strategy = readableGrowthStrategy(insight.recommended_strategy);
  const actions = normalizeGrowthActions(insight.next_actions);
  const patterns = normalizeGrowthPatterns(insight.patterns);
  const bottlenecks = normalizeGrowthBottlenecks(insight.bottlenecks);
  return `
    <div class="growth-ai-grid">
      <div class="notice">${escapeHtml(readableText(insight.overview) || "已生成成长洞察。")}</div>
      <div class="report-block"><h3>正向规律</h3>${renderGrowthPatternsTable(patterns)}</div>
      <div class="report-block"><h3>主要瓶颈</h3>${renderGrowthBottlenecksTable(bottlenecks)}</div>
      ${strategy ? `<div class="report-block"><h3>推荐策略</h3>${renderStrategyTable(strategy)}</div>` : ""}
      <div class="report-block"><h3>下一步行动</h3>${renderGrowthActionsTable(actions)}</div>
      <p class="meta">生成时间：${escapeHtml(formatDate(insight.generated_at))}</p>
    </div>
  `;
}

function readableText(value) {
  if (value === null || value === undefined) return "";
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    const text = String(value).trim();
    return text === "[object Object]" || text === "{}" ? "" : text;
  }
  if (Array.isArray(value)) return value.map(readableText).filter(Boolean).join("；");
  if (typeof value === "object") {
    const preferred = ["summary", "insight", "description", "recommendation", "strategy", "action", "impact", "evidence", "text"];
    const picked = preferred.map(key => readableText(value[key])).filter(Boolean);
    if (picked.length) return picked.join("；");
    return Object.entries(value)
      .filter(([, item]) => item !== null && item !== undefined && typeof item !== "object")
      .map(([key, item]) => `${key}: ${readableText(item)}`)
      .filter(Boolean)
      .join("；");
  }
  return "";
}

function readableGrowthStrategy(value) {
  if (!value) return "";
  if (typeof value === "string") {
    const trimmed = value.trim();
    return trimmed && trimmed !== "[object Object]" && trimmed !== "{}" ? trimmed : "";
  }
  if (typeof value === "object") {
    const candidates = [
      value.summary,
      value.recommendation,
      value.strategy,
      value.advice,
      value.text,
      value.description
    ].filter(item => typeof item === "string" && item.trim());
    if (candidates.length) return candidates.join(" ");
  }
  return "";
}

function normalizeGrowthPatterns(items) {
  if (!Array.isArray(items)) return [];
  return items.map((item, index) => {
    if (typeof item === "string") {
      return { topic: `规律 ${index + 1}`, insight: item, evidence: "-", suggestion: "-" };
    }
    return {
      topic: readableText(item.topic || item.category || item.pattern || item.name) || `规律 ${index + 1}`,
      insight: readableText(item.insight || item.description || item.summary || item.pattern) || "-",
      evidence: readableText(item.evidence || item.reason || item.data || item.metrics) || "-",
      suggestion: readableText(item.recommendation || item.action || item.next_step || item.suggestion) || "-"
    };
  });
}

function normalizeGrowthBottlenecks(items) {
  if (!Array.isArray(items)) return [];
  return items.map((item, index) => {
    if (typeof item === "string") {
      return { item: item, severity: "-", impact: "-", evidence: "-" };
    }
    return {
      item: readableText(item.item || item.bottleneck || item.category || item.name) || `瓶颈 ${index + 1}`,
      severity: readableText(item.severity || item.priority || item.level) || "-",
      impact: readableText(item.impact || item.description || item.insight || item.reason) || "-",
      evidence: readableText(item.evidence || item.evidence_source || item.metrics || item.data) || "-"
    };
  });
}

function normalizeGrowthActions(actions) {
  if (!Array.isArray(actions)) return [];
  return actions.map(item => {
    if (typeof item === "string") {
      return { category: "行动", action: item, priority: "-", dueDate: "-", metric: "-" };
    }
    return {
      category: readableText(item.category || item.type) || "行动",
      action: readableText(item.action || item.title || item.task || item.description) || "未命名行动",
      priority: readableText(item.priority) || "-",
      dueDate: readableText(item.due_date || item.dueDate || item.deadline) || "-",
      metric: readableText(item.metrics || item.metric || item.success_metric) || "-"
    };
  });
}

function hasTableValue(value) {
  const text = readableText(value);
  return Boolean(text && text !== "-");
}

function renderDynamicTable(items, columns, emptyText) {
  if (!items.length) return `<p class="meta">${escapeHtml(emptyText)}</p>`;
  const visibleColumns = columns.filter(column => items.some(item => hasTableValue(item[column.key])));
  if (!visibleColumns.length) return `<p class="meta">${escapeHtml(emptyText)}</p>`;
  return `
    <div class="table-wrap">
      <table class="action-table">
        <thead>
          <tr>${visibleColumns.map(column => `<th>${escapeHtml(column.label)}</th>`).join("")}</tr>
        </thead>
        <tbody>
          ${items.map(item => `
            <tr>
              ${visibleColumns.map(column => `<td>${escapeHtml(readableText(item[column.key]) || "-")}</td>`).join("")}
            </tr>
          `).join("")}
        </tbody>
      </table>
    </div>
  `;
}

function renderStrategyTable(strategy) {
  return `
    <div class="table-wrap">
      <table class="action-table">
        <thead><tr><th>策略</th></tr></thead>
        <tbody><tr><td>${escapeHtml(strategy)}</td></tr></tbody>
      </table>
    </div>
  `;
}

function renderGrowthPatternsTable(patterns) {
  return renderDynamicTable(patterns, [
    { key: "topic", label: "维度" },
    { key: "insight", label: "洞察" },
    { key: "evidence", label: "依据" },
    { key: "suggestion", label: "建议" }
  ], "暂无正向规律。");
}

function renderGrowthBottlenecksTable(bottlenecks) {
  return renderDynamicTable(bottlenecks, [
    { key: "item", label: "瓶颈" },
    { key: "severity", label: "严重度" },
    { key: "impact", label: "影响" },
    { key: "evidence", label: "依据" }
  ], "暂无主要瓶颈。");
}

function renderGrowthActionsTable(actions) {
  if (!actions.length) return `<p class="meta">暂无下一步行动。</p>`;
  return `
    <div class="table-wrap">
      <table class="action-table">
        <thead>
          <tr>
            <th>类别</th>
            <th>行动</th>
            <th>优先级</th>
            <th>截止时间</th>
            <th>衡量指标</th>
          </tr>
        </thead>
        <tbody>
          ${actions.map(item => `
            <tr>
              <td>${escapeHtml(item.category)}</td>
              <td>${escapeHtml(item.action)}</td>
              <td>${escapeHtml(item.priority)}</td>
              <td>${escapeHtml(item.dueDate)}</td>
              <td>${escapeHtml(item.metric)}</td>
            </tr>
          `).join("")}
        </tbody>
      </table>
    </div>
  `;
}

function renderFunnelRow(label, value, displayValue, colorClass = "blue") {
  const safe = Math.max(0, Math.min(100, Number(value || 0)));
  return `
    <div class="funnel-row ${colorClass}">
      <div><strong>${escapeHtml(label)}</strong><span>${escapeHtml(displayValue)}</span></div>
      <div class="progress"><span style="width:${safe}%"></span></div>
    </div>
  `;
}

function renderApplicationDetail() {
  const app = state.applications.find(item => item.application_id === selectedApplicationId) || state.applications[0];
  if (!app) return setView("applications");
  const job = state.jobCards.find(item => item.job_card_id === app.job_card_id);
  const resume = state.resumeVersions.find(item => item.resume_version_id === app.resume_version_id);
  const statusHistory = app.status_history?.length
    ? [...app.status_history].reverse()
    : [{ status: app.current_status, date: app.apply_date, note: "当前状态" }];
  const gaps = app.gap_data_at_apply?.priority_gaps || job?.gap_data?.priority_gaps || [];
  const retrospective = app.retrospective;
  root().innerHTML = `
    ${renderShell(`${jobTitle(job)} · ${company(job)}`, "投递详情聚合投递状态、使用简历、匹配报告、Gap 数据和面试记录。", `<button class="ghost-button" id="backApplications">投递追踪</button>`)}
    <section class="panel">
      <div class="status-strip"><span>${escapeHtml(app.current_status)}</span><strong>${escapeHtml(app.final_result || "进行中")}</strong></div>
    </section>
    <div class="two-column wide-left">
      <section class="panel">
        <div class="report-block">
          <h3>投递基本信息</h3>
          <div class="field-list">
            <div class="field-row"><span>岗位名称</span><strong>${escapeHtml(jobTitle(job))}</strong></div>
            <div class="field-row"><span>公司</span><strong>${escapeHtml(company(job))}</strong></div>
            <div class="field-row"><span>匹配分</span><strong>${escapeHtml(app.match_score_at_apply || job?.match_report?.total_score || "-")}分</strong></div>
            <div class="field-row"><span>投递日期</span><strong>${escapeHtml(app.apply_date || "-")}</strong></div>
            <div class="field-row"><span>当前状态</span><strong>${escapeHtml(app.current_status || "-")}</strong></div>
            <div class="field-row"><span>使用简历</span><strong>${escapeHtml(resumeTitle(resume))}</strong></div>
            <div class="field-row"><span>投递渠道</span><strong>${escapeHtml(app.apply_channel || "-")}</strong></div>
          </div>
          <div class="button-row">
            <button id="openStatusDrawer" type="button">更新进度</button>
          </div>
        </div>
        <div class="report-block">
          <h3>状态历史时间线</h3>
          <div class="timeline">${statusHistory.map(item => `
            <div class="timeline-item">
              <span>${escapeHtml(item.date || formatDate(item.created_at) || "-")}</span>
              <strong>${escapeHtml(item.status)}</strong>
              ${item.note ? `<p>${escapeHtml(item.note)}</p>` : ""}
            </div>
          `).join("")}</div>
        </div>
        <div class="report-block">
          <h3>面试记录</h3>
          ${(app.interview_rounds || []).map(round => `
            <div class="gap-item">
              <strong>${escapeHtml(round.round_type)} · ${escapeHtml(round.outcome || "待结果")}</strong>
              <p class="meta">自评 ${escapeHtml(round.performance_rating || "-")}/5 · ${escapeHtml(formatDate(round.completed_at))}</p>
              ${round.stuck_on ? `<p>${escapeHtml(round.stuck_on)}</p>` : ""}
              ${pills(round.question_types || [])}
            </div>
          `).join("") || `<p class="meta">暂无面试记录。只有你主动记录后，这里才会出现一面、二面等信息。</p>`}
          <button id="recordInterview" type="button">记录面试</button>
        </div>
      </section>
      <section class="panel">
        <div class="report-block">
          <h3>关联 Job Card</h3>
          <p>${escapeHtml(job?.jd_profile?.job_summary || job?.raw_jd_text || "暂无岗位摘要。")}</p>
          <div class="button-row">
            <button id="openApplicationJob" type="button">查看岗位详情</button>
            ${job?.match_report ? `<button class="ghost-button" id="openApplicationReport" type="button">查看匹配报告</button>` : ""}
          </div>
        </div>
        <div class="report-block">
          <h3>关联 Gap 数据</h3>
          ${gaps.map(gap => `
            <div class="gap-item">
              <strong>${escapeHtml(gap.item)} · ${escapeHtml(gap.severity)}</strong>
              <p>${escapeHtml(gap.description)}</p>
              <p class="meta">${escapeHtml(gap.resume_fix)}</p>
            </div>
          `).join("") || `<p class="meta">暂无 Gap 数据。完成岗位匹配后会自动关联。</p>`}
        </div>
        <div class="report-block">
          <h3>复盘报告</h3>
          ${retrospective ? renderRetrospectiveBlock(retrospective) : `<p class="meta">尚未生成复盘。数据不足时也可以生成基础复盘，系统会明确标注推断范围。</p>`}
          <button id="generateRetrospective" type="button">生成复盘</button>
        </div>
      </section>
    </div>
  `;
  $("#backApplications").addEventListener("click", () => setView("applications"));
  $("#openStatusDrawer").addEventListener("click", () => showStatusDrawer(app));
  $("#openApplicationJob").addEventListener("click", () => setView("jobDetail", { jobId: job?.job_card_id }));
  $("#openApplicationReport")?.addEventListener("click", () => setView("jobReport", { jobId: job?.job_card_id }));
  $("#recordInterview").addEventListener("click", () => showInterviewDrawer(app));
  $("#generateRetrospective").addEventListener("click", event => generateRetrospective(app.application_id, event.currentTarget));
}

function renderRetrospectiveBlock(retrospective) {
  const result = typeof retrospective.result_interpretation === "object"
    ? retrospective.result_interpretation
    : {
        summary: retrospective.result_interpretation,
        prediction_accuracy: retrospective.prediction_accuracy,
        accuracy_explanation: retrospective.process_analysis,
        likely_bottleneck: "数据不足"
      };
  const performance = retrospective.performance_analysis || {
    available: Boolean(retrospective.process_analysis),
    trend: "暂无记录",
    key_insight: retrospective.process_analysis || "基于推断，仅供参考：暂无面试记录。",
    stuck_point: null
  };
  const gaps = retrospective.gap_validation || [];
  const actions = retrospective.action_items || [];
  const learnings = retrospective.key_learnings || [];
  return `
    <div class="retrospective-stack">
      <section class="retrospective-section">
        <h4>1. 结果解读</h4>
        <div class="notice">${escapeHtml(result.summary || retrospective.summary_for_notification || "已生成复盘报告。")}</div>
        <div class="field-list compact">
          <div class="field-row"><span>匹配预测</span><strong>${escapeHtml(result.prediction_accuracy || retrospective.prediction_accuracy || "-")}</strong></div>
          <div class="field-row"><span>主要瓶颈</span><strong>${escapeHtml(result.likely_bottleneck || "-")}</strong></div>
        </div>
        <p class="meta">${escapeHtml(result.accuracy_explanation || "")}</p>
      </section>
      <section class="retrospective-section">
        <h4>2. 面试表现分析</h4>
        <p>${escapeHtml(performance.key_insight || "暂无面试表现记录。")}</p>
        <p class="meta">趋势：${escapeHtml(performance.trend || "-")}</p>
        ${performance.stuck_point ? `<p class="meta">卡点：${escapeHtml(performance.stuck_point)}</p>` : ""}
      </section>
      <section class="retrospective-section">
        <h4>3. Gap 验证</h4>
        ${gaps.length ? gaps.map(gap => `
          <div class="gap-item">
            <strong>${escapeHtml(gap.gap_item || gap.item || "Gap 项")} · ${escapeHtml(gap.validation_result || "未验证")}</strong>
            <p>${escapeHtml(gap.insight || gap.note || "暂无验证说明。")}</p>
            <p class="meta">优先级：${escapeHtml(gap.original_severity || "-")} · 实际考察：${escapeHtml(gap.actually_tested === true ? "是" : gap.actually_tested === false ? "否" : "不确定")} · 表现：${escapeHtml(gap.user_performance || gap.performance || "待验证")}</p>
          </div>
        `).join("") : `<p class="meta">暂无可验证 Gap。完成岗位匹配或补充面试记录后会更准确。</p>`}
      </section>
      <section class="retrospective-section">
        <h4>4. 行动清单</h4>
        ${actions.length ? actions.map(item => `
          <div class="action-item">
            <span class="pill ${item.priority === "high" ? "amber" : ""}">${escapeHtml(item.category || item.type || "行动项")}</span>
            <strong>${escapeHtml(item.action || item.title || item)}</strong>
            <p class="meta">${escapeHtml(item.estimated_effort || "")}${item.target_module ? ` · ${escapeHtml(item.target_module)}` : ""}</p>
          </div>
        `).join("") : list(learnings)}
      </section>
      ${retrospective.data_improvement_tip ? `<p class="meta">下次建议补充：${escapeHtml(retrospective.data_improvement_tip)}</p>` : ""}
    </div>
  `;
}

function showStatusDrawer(app) {
  $("#statusDrawer")?.remove();
  document.body.insertAdjacentHTML("beforeend", `
    <div class="drawer-backdrop" id="statusDrawer" role="dialog" aria-modal="true" aria-labelledby="statusDrawerTitle">
      <section class="bottom-drawer">
        <div class="drawer-handle" aria-hidden="true"></div>
        <div class="panel-heading">
          <div>
            <h2 id="statusDrawerTitle">更新投递进度</h2>
            <p>当前状态：${escapeHtml(app.current_status || "投递中")}</p>
          </div>
          <button class="ghost-button" id="closeStatusDrawer" type="button">关闭</button>
        </div>
        <div class="status-option-grid">
          ${applicationStatuses.map(status => `
            <label class="status-option ${status === app.current_status ? "active" : ""}">
              <input type="radio" name="nextStatus" value="${escapeHtml(status)}" ${status === app.current_status ? "checked" : ""} />
              <span>${escapeHtml(status)}</span>
            </label>
          `).join("")}
        </div>
        <p class="meta">如果选择更早的状态，系统会把后续误选的状态记录清除，只保留回退后的正确时间线。</p>
        <label class="drawer-field">
          <span>备注（可选）</span>
          <textarea id="statusNote" rows="3" placeholder="例如：HR 已约面，时间待确认；或邮件通知未通过。"></textarea>
        </label>
        <div class="button-row drawer-actions">
          <button id="submitStatusUpdate" type="button">确认更新</button>
          <button class="ghost-button" id="cancelStatusUpdate" type="button">取消</button>
        </div>
      </section>
    </div>
  `);
  document.querySelectorAll("#statusDrawer .status-option input").forEach(input => {
    input.addEventListener("change", () => {
      document.querySelectorAll("#statusDrawer .status-option").forEach(label => label.classList.remove("active"));
      input.closest(".status-option")?.classList.add("active");
    });
  });
  $("#closeStatusDrawer").addEventListener("click", hideStatusDrawer);
  $("#cancelStatusUpdate").addEventListener("click", hideStatusDrawer);
  $("#statusDrawer").addEventListener("click", event => {
    if (event.target.id === "statusDrawer") hideStatusDrawer();
  });
  $("#submitStatusUpdate").addEventListener("click", event => updateApplicationStatus(app.application_id, event.currentTarget));
}

function hideStatusDrawer() {
  $("#statusDrawer")?.remove();
}

function showInterviewDrawer(app) {
  $("#interviewDrawer")?.remove();
  const defaultRound = ["HR筛选通过", "一面", "二面", "终面"].includes(app.current_status)
    ? app.current_status.replace("HR筛选通过", "HR面")
    : "一面";
  const roundOptions = ["HR面", "一面", "二面", "终面", "其他"];
  const outcomeOptions = ["通过", "未通过", "待结果"];
  const questionOptions = ["技术题", "行为题", "案例分析", "产品设计", "背景了解"];
  document.body.insertAdjacentHTML("beforeend", `
    <div class="drawer-backdrop" id="interviewDrawer" role="dialog" aria-modal="true" aria-labelledby="interviewDrawerTitle">
      <section class="bottom-drawer">
        <div class="drawer-handle" aria-hidden="true"></div>
        <div class="panel-heading">
          <div>
            <h2 id="interviewDrawerTitle">记录面试</h2>
            <p>用 30 秒补充关键感受，后续复盘会更准确。</p>
          </div>
          <button class="ghost-button" id="closeInterviewDrawer" type="button">关闭</button>
        </div>
        <label class="drawer-field">
          <span>面试轮次</span>
          <select id="interviewRoundType">
            ${roundOptions.map(option => `<option value="${escapeHtml(option)}" ${option === defaultRound ? "selected" : ""}>${escapeHtml(option)}</option>`).join("")}
          </select>
        </label>
        <div class="drawer-section">
          <h3>这轮结果如何？</h3>
          <div class="choice-grid three">
            ${outcomeOptions.map(option => `
              <label class="choice-card ${option === "待结果" ? "active" : ""}">
                <input type="radio" name="interviewOutcome" value="${escapeHtml(option)}" ${option === "待结果" ? "checked" : ""} />
                <span>${escapeHtml(option)}</span>
              </label>
            `).join("")}
          </div>
        </div>
        <div class="drawer-section">
          <h3>考察了哪些问题？</h3>
          <div class="choice-grid">
            ${questionOptions.map(option => `
              <label class="choice-card">
                <input type="checkbox" name="questionTypes" value="${escapeHtml(option)}" />
                <span>${escapeHtml(option)}</span>
              </label>
            `).join("")}
          </div>
        </div>
        <label class="drawer-field">
          <span>哪里卡住了？（可跳过）</span>
          <textarea id="interviewStuckOn" rows="3" placeholder="比如：案例分析思路不够清晰，或者 SQL 题没有写完整。"></textarea>
        </label>
        <div class="drawer-section">
          <h3>整体感觉怎么样？</h3>
          <div class="rating-row" id="interviewRating">
            ${[1, 2, 3, 4, 5].map(value => `<button class="${value === 3 ? "active" : ""}" data-rating="${value}" type="button">${value}</button>`).join("")}
          </div>
        </div>
        <div class="button-row drawer-actions">
          <button id="saveInterviewRecord" type="button">保存记录</button>
          <button class="ghost-button" id="cancelInterviewRecord" type="button">取消</button>
        </div>
      </section>
    </div>
  `);
  bindChoiceCards("#interviewDrawer");
  $("#interviewRating").addEventListener("click", event => {
    const button = event.target.closest("[data-rating]");
    if (!button) return;
    document.querySelectorAll("#interviewRating button").forEach(item => item.classList.remove("active"));
    button.classList.add("active");
  });
  $("#closeInterviewDrawer").addEventListener("click", hideInterviewDrawer);
  $("#cancelInterviewRecord").addEventListener("click", hideInterviewDrawer);
  $("#interviewDrawer").addEventListener("click", event => {
    if (event.target.id === "interviewDrawer") hideInterviewDrawer();
  });
  $("#saveInterviewRecord").addEventListener("click", event => saveInterviewRecord(app.application_id, event.currentTarget));
}

function bindChoiceCards(scopeSelector) {
  document.querySelectorAll(`${scopeSelector} .choice-card input`).forEach(input => {
    input.addEventListener("change", () => {
      if (input.type === "radio") {
        document.querySelectorAll(`${scopeSelector} input[name='${input.name}']`).forEach(item => {
          item.closest(".choice-card")?.classList.toggle("active", item.checked);
        });
      } else {
        input.closest(".choice-card")?.classList.toggle("active", input.checked);
      }
    });
  });
}

function hideInterviewDrawer() {
  $("#interviewDrawer")?.remove();
}

function render() {
  const provider = state.jobCards[0]?.aiProvider || state.resumeVersions[0]?.analysis?.aiProvider || "未配置时使用本地降级分析";
  $("#modelStatus").textContent = `模型：${provider}`;
  if (view === "dashboard") return renderDashboard();
  if (view === "resumes") return renderResumes();
  if (view === "resumeUpload") return renderResumeUpload();
  if (view === "resumeConfirm") return renderResumeConfirm();
  if (view === "resumeDiagnosis") return renderResumeDiagnosis();
  if (view === "resumeTarget") return renderResumeTarget();
  if (view === "targetedOptimization") return renderTargetedOptimization();
  if (view === "resumeComparison") return renderResumeComparison();
  if (view === "jobs") return renderJobs();
  if (view === "jobInput") return renderJobInput();
  if (view === "jobConfirm") return renderJobConfirm();
  if (view === "jobReport") return renderJobReport();
  if (view === "jobDetail") return renderJobDetail();
  if (view === "applications") return renderApplications();
  if (view === "applicationDetail") return renderApplicationDetail();
  if (view === "growthInsights") return renderGrowthInsights();
}

async function refresh() {
  state = await api("/api/state");
  render();
}

async function withBusy(button, label, fn) {
  const original = button.textContent;
  button.disabled = true;
  button.textContent = label;
  try {
    await fn();
  } catch (error) {
    toast(error.message);
  } finally {
    button.disabled = false;
    button.textContent = original;
  }
}

async function uploadResumeFile() {
  const file = $("#resumeFile").files?.[0];
  if (!file) return;
  $("#fileStatus").textContent = `正在解析：${file.name}`;
  try {
    const form = new FormData();
    form.append("resumeFile", file);
    const response = await fetch("/api/extract-resume-file", { method: "POST", body: form });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || "文件解析失败");
    draftResumeText = data.text;
    draftResumeFile = data.filename;
    $("#resumeText").value = data.text;
    $("#fileStatus").textContent = `已解析 ${data.filename}，共 ${data.characters} 字。`;
    toast("简历文本已提取");
  } catch (error) {
    $("#fileStatus").textContent = "解析失败，请改用 DOCX、可复制文本 PDF 或直接粘贴。";
    toast(error.message);
  }
}

async function uploadJdFile() {
  const file = $("#jdFile").files?.[0];
  if (!file) return;
  $("#jdFileStatus").textContent = `正在解析：${file.name}`;
  try {
    const form = new FormData();
    form.append("jdFile", file);
    const response = await fetch("/api/extract-jd-file", { method: "POST", body: form });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || "JD 文件解析失败");
    draftJdText = data.text;
    $("#jdText").value = data.text;
    $("#jdCount").textContent = `${data.characters} 字，可解析`;
    $("#jdFileStatus").textContent = `已解析 ${data.filename}，共 ${data.characters} 字。`;
    toast("JD 文本已提取");
  } catch (error) {
    $("#jdFileStatus").textContent = "解析失败，请改用 DOCX、可复制文本 PDF 或直接粘贴。";
    toast(error.message);
  }
}

async function analyzeResume() {
  const button = $("#parseResume");
  await withBusy(button, "解析中", async () => {
    await withLoadingOverlay({
      title: "正在解析简历",
      subtitle: "AI 正在读取简历内容，并生成结构化画像与诊断结果。",
      steps: ["提取教育和经历信息", "整理技能与项目标签", "生成简历健康诊断", "保存为独立简历档案"]
    }, async () => {
      draftResumeText = $("#resumeText").value;
      const { resumeVersion } = await api("/api/analyze-resume", {
        method: "POST",
        body: JSON.stringify({ resumeText: draftResumeText, fileName: draftResumeFile })
      });
      selectedResumeId = resumeVersion.resume_version_id;
      await refresh();
      setView("resumeConfirm", { resumeId: selectedResumeId });
      toast("简历解析和诊断已完成");
    });
  });
}

async function createJobCard() {
  const button = $("#parseJob");
  await withBusy(button, "解析中", async () => {
    draftJdText = $("#jdText").value;
    const { jobCard } = await api("/api/job-cards", {
      method: "POST",
      body: JSON.stringify({ jdText: draftJdText, inputMethod: "text_paste", createdFrom: "match_module" })
    });
    selectedJobId = jobCard.job_card_id;
    draftJdText = "";
    await refresh();
    setView("jobConfirm", { jobId: selectedJobId });
    toast("岗位画像已生成");
  });
}

async function createTargetJobAndOptimize() {
  const button = $("#createTargetJob");
  await withBusy(button, "解析并优化中", async () => {
    await withLoadingOverlay({
      title: "正在解析岗位并优化简历",
      subtitle: "AI 会先生成岗位画像，再根据岗位要求重写简历表达。",
      steps: ["解析岗位 JD", "提取岗位关键词", "对照简历差距", "生成定向优化版本"]
    }, async () => {
      const jdText = $("#targetJdText").value;
      const { jobCard } = await api("/api/job-cards", {
        method: "POST",
        body: JSON.stringify({ jdText, inputMethod: "text_paste", createdFrom: "resume_module" })
      });
      await refresh();
      await optimizeResume(jobCard.job_card_id, selectedResumeId, { showOverlay: false });
    });
  });
}

async function matchExistingJob(jobId) {
  const resume = state.resumeVersions.find(item => item.resume_version_id === selectedResumeId) || latestBaseResume();
  await api(`/api/job-cards/${jobId}/match`, {
    method: "POST",
    body: JSON.stringify({ resumeVersionId: resume?.resume_version_id || null })
  });
  selectedJobId = jobId;
  selectedResumeId = resume?.resume_version_id || selectedResumeId;
  await refresh();
  setView("jobReport", { jobId });
  toast("匹配报告已生成");
}

async function optimizeResume(jobId, resumeId = selectedResumeId, options = {}) {
  const resume = state.resumeVersions.find(item => item.resume_version_id === resumeId) || latestBaseResume();
  if (!resume) {
    toast("请先上传并解析简历");
    return setView("resumeUpload");
  }
  const run = async () => {
    const { resumeVersion } = await api("/api/optimize-resume", {
      method: "POST",
      body: JSON.stringify({ resumeVersionId: resume.resume_version_id, jobCardId: jobId })
    });
    selectedJobId = jobId;
    selectedResumeId = resume.resume_version_id;
    await refresh();
    setView("jobDetail", { jobId });
    showOptimizationCompleteModal(resumeVersion);
  };
  if (options.showOverlay === false) return run();
  return withLoadingOverlay({
    title: "正在优化简历",
    subtitle: "AI 正在结合目标岗位、匹配差距和原始简历生成优化版本。",
    steps: ["读取目标岗位画像", "识别简历可强化内容", "生成红绿对照建议", "计算优化后评分"]
  }, run);
}

async function updateJobDecision(jobId, decision) {
  await api(`/api/job-cards/${jobId}`, {
    method: "PATCH",
    body: JSON.stringify({ userDecision: decision })
  });
  await refresh();
  setView("jobDetail", { jobId });
  toast(decision === "applied" ? "已同步到投递追踪：投递中" : "已同步到投递追踪：放弃");
}

async function updateApplicationStatus(applicationId, button) {
  const selected = document.querySelector("#statusDrawer input[name='nextStatus']:checked")?.value;
  if (!selected) return toast("请选择新的投递状态");
  const note = $("#statusNote")?.value || "";
  await withBusy(button, "更新中", async () => {
    await api(`/api/applications/${applicationId}`, {
      method: "PATCH",
      body: JSON.stringify({ currentStatus: selected, note })
    });
    hideStatusDrawer();
    await refresh();
    setView("applicationDetail", { applicationId });
    toast("投递进度已更新");
  });
}

async function saveInterviewRecord(applicationId, button) {
  const roundType = $("#interviewRoundType")?.value || "一面";
  const outcome = document.querySelector("#interviewDrawer input[name='interviewOutcome']:checked")?.value || "待结果";
  const questionTypes = Array.from(document.querySelectorAll("#interviewDrawer input[name='questionTypes']:checked")).map(input => input.value);
  const performanceRating = Number(document.querySelector("#interviewRating button.active")?.dataset.rating || 3);
  const stuckOn = $("#interviewStuckOn")?.value || "";
  await withBusy(button, "保存中", async () => {
    await api(`/api/applications/${applicationId}/interviews`, {
      method: "POST",
      body: JSON.stringify({
        roundType,
        outcome,
        questionTypes,
        stuckOn,
        performanceRating
      })
    });
    hideInterviewDrawer();
    await refresh();
    setView("applicationDetail", { applicationId });
    toast("面试记录已保存");
  });
}

async function generateRetrospective(applicationId, button) {
  await withBusy(button, "生成中", async () => {
    await withLoadingOverlay({
      title: "正在生成复盘报告",
      subtitle: "AI 正在结合投递记录、匹配分、Gap 数据和面试记录进行分析。",
      steps: ["解读投递结果", "分析面试表现", "验证预测 Gap", "生成行动清单"]
    }, async () => {
      await api(`/api/applications/${applicationId}/retrospective`, { method: "POST" });
      await refresh();
      setView("applicationDetail", { applicationId });
      toast("复盘报告已生成");
    });
  });
}

async function generateGrowthInsight(button) {
  await withBusy(button, "生成中", async () => {
    await withLoadingOverlay({
      title: "正在生成成长解读",
      subtitle: "AI 正在汇总多次投递记录，识别共性问题和下一步策略。",
      steps: ["计算投递漏斗", "对比匹配分表现", "识别反复 Gap", "整理下一步行动"]
    }, async () => {
      await api("/api/growth-insights", { method: "POST" });
      await refresh();
      setView("growthInsights");
      toast("AI 成长解读已生成");
    });
  });
}

document.querySelectorAll(".nav-tabs button").forEach(button => {
  button.addEventListener("click", () => setView(button.dataset.view));
});

refresh().catch(error => toast(error.message));
