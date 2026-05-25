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
  document.querySelectorAll(".nav-tabs button").forEach(button => {
    button.classList.toggle("active", button.dataset.view === topLevelView(nextView));
  });
  render();
}

function topLevelView(current) {
  if (current.startsWith("resume")) return "resumes";
  if (current.startsWith("job") || current.startsWith("match")) return "jobs";
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
  root().innerHTML = `
    ${renderShell("投递追踪", "投递模块保留为结果层：绑定 Job Card，记录进展并为复盘提供信号。", `<button id="createApplication">创建投递</button>`)}
    <section class="panel">
      <div class="form-inline">
        <select id="applicationJobSelect">${state.jobCards.map(job => `<option value="${job.job_card_id}">${escapeHtml(jobTitle(job))}｜${escapeHtml(company(job))}</option>`).join("")}</select>
        <select id="applicationChannel"><option>官网</option><option>Boss直聘</option><option>拉勾</option><option>猎聘</option><option>内推</option><option>其他</option></select>
      </div>
    </section>
    <div class="kanban">${applicationStatuses.map(status => {
      const apps = state.applications.filter(app => app.current_status === status);
      return `<section class="kanban-column"><h3>${status}<span>${apps.length}</span></h3>${apps.map(renderApplicationCard).join("") || `<p class="meta">暂无记录</p>`}</section>`;
    }).join("")}</div>
  `;
  $("#createApplication").addEventListener("click", createApplication);
}

function renderApplicationCard(app) {
  const job = state.jobCards.find(item => item.job_card_id === app.job_card_id);
  return `<article class="application-card"><strong>${escapeHtml(jobTitle(job))}</strong><p class="meta">${escapeHtml(app.apply_channel)} · ${escapeHtml(app.apply_date)} · ${escapeHtml(app.match_score_at_apply || "-")}分</p></article>`;
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

async function createApplication() {
  const jobCardId = $("#applicationJobSelect").value;
  if (!jobCardId) return toast("请先创建岗位卡片");
  await api("/api/applications", {
    method: "POST",
    body: JSON.stringify({ jobCardId, applyChannel: $("#applicationChannel").value })
  });
  await refresh();
  setView("applications");
  toast("投递记录已创建");
}

document.querySelectorAll(".nav-tabs button").forEach(button => {
  button.addEventListener("click", () => setView(button.dataset.view));
});

refresh().catch(error => toast(error.message));
