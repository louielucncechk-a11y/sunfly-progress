const Core = window.TrackerCore;
const $ = (selector, parent = document) => parent.querySelector(selector);
const $$ = (selector, parent = document) => [...parent.querySelectorAll(selector)];

let state = null;
let selectedProjectId = null;
let selectedRoundIndex = 0;
let saveTimer = null;
let toastTimer = null;
let persistenceMode = "server";
const isStaticDeployment = location.hostname === "progress.sunfly.hk" || location.hostname.endsWith(".github.io");

const labels = {
  plan: { pending: "待确认", confirmed: "已确认", rejected: "需重做" },
  production: { not_started: "未开始", in_progress: "生产中", completed: "已完成", blocked: "受阻" },
  internalTest: { not_started: "未开始", in_progress: "测试中", completed: "已完成", blocked: "受阻", waived: "原表未记录 / 豁免" },
  transport: { not_started: "未发运", in_transit: "运输中", completed: "已送达", blocked: "受阻" },
  test: { not_started: "未开始", in_progress: "检测中", completed: "已完成", blocked: "受阻" },
  result: { pending: "待判定", pass: "通过", fail: "未通过", exception: "异常" },
};

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>'"]/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;" }[char]));
}

function formatDate(value, fallback = "待定") {
  if (!value) return fallback;
  const raw = value.slice(0, 10);
  const [year, month, day] = raw.split("-");
  if (!year || !month || !day) return value;
  return `${Number(month)}月${Number(day)}日`;
}

function formatDateTime(value) {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat("zh-CN", { dateStyle: "medium", timeStyle: "short" }).format(date);
}

function clone(value) {
  return typeof structuredClone === "function" ? structuredClone(value) : JSON.parse(JSON.stringify(value));
}

function validateData(data) {
  if (!data || typeof data !== "object" || !Array.isArray(data.projects)) throw new Error("备份文件结构无效：缺少 projects 数组");
  for (const project of data.projects) {
    if (!project.id || !project.name || !Array.isArray(project.rounds) || !project.rounds.length) throw new Error("备份文件中存在缺少项目名或轮次的记录");
    for (const round of project.rounds) {
      round.internalTest ||= { status: "not_started", plannedAt: "", startedAt: "", completedAt: "", result: "pending", note: "旧备份导入：请补充内部测试记录。" };
    }
  }
  return data;
}

async function loadData() {
  const local = localStorage.getItem("sunfly-progress-data-v1");
  if (isStaticDeployment) {
    persistenceMode = "browser";
    if (local) state = validateData(JSON.parse(local));
    else {
      const response = await fetch("data/tracker-data.json", { cache: "no-store" });
      if (!response.ok) throw new Error("无法读取初始数据");
      state = validateData(await response.json());
    }
    setSaveState("saved", "浏览器本地保存");
    localStorage.setItem("sunfly-progress-data-v1", JSON.stringify(state));
    return;
  }
  try {
    const response = await fetch("/api/data", { cache: "no-store" });
    if (!response.ok) throw new Error(`服务器返回 ${response.status}`);
    state = validateData(await response.json());
    setSaveState("saved", "数据已同步");
  } catch (error) {
    persistenceMode = "browser";
    if (local) {
      state = validateData(JSON.parse(local));
      setSaveState("error", "使用浏览器本地数据");
    } else {
      try {
        const response = await fetch("data/tracker-data.json", { cache: "no-store" });
        if (!response.ok) throw new Error("无法读取初始数据");
        state = validateData(await response.json());
        setSaveState("error", "离线模式");
      } catch {
        throw new Error("无法读取数据，请通过“启动网站.bat”打开本系统");
      }
    }
  }
  localStorage.setItem("sunfly-progress-data-v1", JSON.stringify(state));
}

function setSaveState(type, text) {
  const element = $("#saveState");
  element.className = `save-state ${type === "saved" ? "" : type}`;
  element.lastChild.textContent = text;
}

function queueSave(message = "进度已保存") {
  state.updatedAt = new Date().toISOString();
  localStorage.setItem("sunfly-progress-data-v1", JSON.stringify(state));
  setSaveState("saving", "正在保存…");
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => persist(message), 300);
}

async function persist(message) {
  if (persistenceMode === "browser") {
    setSaveState("saved", "浏览器本地保存");
    showToast(`${message}（已保存到当前浏览器）`);
    return;
  }
  try {
    const response = await fetch("/api/data", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(state),
    });
    if (!response.ok) throw new Error(`保存失败（${response.status}）`);
    setSaveState("saved", "数据已同步");
    showToast(message);
  } catch (error) {
    setSaveState("error", "仅保存在本机浏览器");
    showToast(`服务器写入失败，已保存在当前浏览器：${error.message}`, true);
  }
}

function showToast(message, isError = false) {
  const toast = $("#toast");
  toast.textContent = message;
  toast.className = `toast show${isError ? " error" : ""}`;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { toast.className = "toast"; }, 3400);
}

function projectMetrics() {
  const active = state.projects.filter((project) => !project.archived);
  const risks = active.map((project) => Core.riskOf(project, state.settings));
  const stages = active.map(Core.stageOf);
  return [
    { label: "跟踪项目", value: active.length, note: `${active.reduce((sum, project) => sum + project.rounds.length, 0)} 个检测轮次`, color: "#1c3454" },
    { label: "检测进行中", value: stages.filter((item) => item.key === "testing").length, note: "实验室正在执行", color: "#2b6cb0" },
    { label: "已逾期", value: risks.filter((item) => item.key === "overdue").length, note: "需优先处理", color: "#cf3c4f" },
    { label: "临期预警", value: risks.filter((item) => item.key === "warning").length, note: `未来 ${state.settings.warningDays} 天`, color: "#d98a13" },
    { label: "未通过 / 异常", value: risks.filter((item) => item.key === "abnormal").length, note: "需分析并整改", color: "#cf3c4f" },
    { label: "检测已通过", value: stages.filter((item) => item.key === "passed").length, note: "已闭环项目", color: "#198754" },
  ];
}

function renderMetrics() {
  $("#metrics").innerHTML = projectMetrics().map((metric) => `
    <article class="metric-card" style="--metric-color:${metric.color}">
      <p class="metric-label">${escapeHtml(metric.label)}</p>
      <p class="metric-value">${metric.value}</p>
      <p class="metric-note">${escapeHtml(metric.note)}</p>
    </article>`).join("");
}

function renderMaterialOptions() {
  const select = $("#materialFilter");
  const current = select.value;
  const values = [...new Set(state.projects.map((project) => project.material))].sort();
  select.innerHTML = `<option value="all">全部类型</option>${values.map((value) => `<option value="${escapeHtml(value)}">${escapeHtml(value)}</option>`).join("")}`;
  select.value = values.includes(current) ? current : "all";
}

function filteredProjects() {
  const term = $("#searchInput").value.trim().toLowerCase();
  const material = $("#materialFilter").value;
  const stage = $("#stageFilter").value;
  const risk = $("#riskFilter").value;
  return state.projects.filter((project) => {
    if (project.archived) return false;
    const searchable = [project.name, project.standard, project.category, project.material, project.owner, project.sampleRequirement].join(" ").toLowerCase();
    if (term && !searchable.includes(term)) return false;
    if (material !== "all" && project.material !== material) return false;
    if (stage !== "all" && Core.stageOf(project).key !== stage) return false;
    if (risk !== "all" && Core.riskOf(project, state.settings).key !== risk) return false;
    return true;
  }).sort((a, b) => {
    const order = { overdue: 0, abnormal: 1, warning: 2, normal: 3 };
    return order[Core.riskOf(a, state.settings).key] - order[Core.riskOf(b, state.settings).key] || Number(a.sequence) - Number(b.sequence);
  });
}

function nextKeyDate(project) {
  const round = Core.currentRound(project);
  if (round.result.status === "pass") return [round.result.reportDate, "报告完成"];
  if (round.test.status === "in_progress") return [round.test.completedAt, "计划完成"];
  if (round.transport.status === "completed") return [round.test.plannedAt, "计划检测"];
  if (round.production.status === "completed" && !["completed", "waived"].includes(round.internalTest.status)) return [round.internalTest.plannedAt, "内部测试"];
  if (round.production.status === "completed") return [round.transport.deliveredAt, "计划送达"];
  if (round.plan.status === "confirmed") return [round.production.startDate, "计划生产"];
  return [project.targetReportDate, "报告目标"];
}

function renderRows() {
  const projects = filteredProjects();
  $("#resultCount").textContent = `显示 ${projects.length} / ${state.projects.filter((project) => !project.archived).length} 个项目`;
  $("#emptyState").hidden = projects.length > 0;
  $("#projectTable").hidden = projects.length === 0;
  $("#projectRows").innerHTML = projects.map((project) => {
    const stage = Core.stageOf(project);
    const risk = Core.riskOf(project, state.settings);
    const progress = Core.progressOf(project);
    const round = Core.currentRound(project);
    const [keyDate, keyLabel] = nextKeyDate(project);
    return `<tr>
      <td class="project-cell">
        <div class="project-kicker"><span class="material-dot"></span>${escapeHtml(project.material)} · ${escapeHtml(project.category)}</div>
        <p class="project-name">${escapeHtml(project.name)}</p>
        <p class="project-standard">${escapeHtml(project.standard)} · ${escapeHtml(project.owner || "未指定跟进人")}</p>
      </td>
      <td><span class="badge badge-${stage.tone}">${escapeHtml(stage.label)}</span></td>
      <td class="progress-cell"><div class="progress-line"><div class="progress-track"><div class="progress-fill" style="width:${progress}%"></div></div><span class="progress-number">${progress}%</span></div></td>
      <td><span class="date-primary">${escapeHtml(keyLabel)}：${formatDate(keyDate)}</span><span class="date-secondary">报告目标：${formatDate(project.targetReportDate)}</span></td>
      <td><span class="badge badge-${risk.tone}" title="${escapeHtml(risk.reason)}">${escapeHtml(risk.label)}</span><span class="date-secondary">${escapeHtml(risk.reason)}</span></td>
      <td><span class="round-chip">R${round.number}</span>${project.rounds.length > 1 ? `<span class="date-secondary">共 ${project.rounds.length} 轮</span>` : ""}</td>
      <td><button class="row-action" type="button" data-project-id="${escapeHtml(project.id)}">查看 / 更新 →</button></td>
    </tr>`;
  }).join("");
  $$("[data-project-id]", $("#projectRows")).forEach((button) => button.addEventListener("click", () => openDrawer(button.dataset.projectId)));
}

function renderAll() {
  renderMetrics();
  renderMaterialOptions();
  renderRows();
}

function getSelectedProject() {
  return state.projects.find((project) => project.id === selectedProjectId);
}

function setFieldValue(form, name, value) {
  const field = form.elements.namedItem(name);
  if (field) field.value = value ?? "";
}

function renderDrawer() {
  const project = getSelectedProject();
  if (!project) return;
  const round = project.rounds[selectedRoundIndex];
  const current = selectedRoundIndex === project.rounds.length - 1;
  const stage = Core.stageOf({ ...project, rounds: project.rounds.slice(0, selectedRoundIndex + 1) });
  const risk = Core.riskOf({ ...project, rounds: project.rounds.slice(0, selectedRoundIndex + 1) }, state.settings);

  $("#drawerMaterial").textContent = `${project.material} · ${project.category}`;
  $("#drawerTitle").textContent = project.name;
  $("#drawerStandard").textContent = `${project.standard} · ${project.sourceRow || "手工新增"}`;
  $("#detailSummary").innerHTML = `
    <div class="summary-item"><span>跟进人</span><strong>${escapeHtml(project.owner || "未指定")}</strong></div>
    <div class="summary-item"><span>报告目标</span><strong>${formatDate(project.targetReportDate)}</strong></div>
    <div class="summary-item"><span>本轮阶段</span><strong><span class="badge badge-${stage.tone}">${escapeHtml(stage.label)}</span></strong></div>
    <div class="summary-item"><span>本轮风险</span><strong><span class="badge badge-${risk.tone}">${escapeHtml(risk.label)}</span></strong></div>
    <div class="summary-item"><span>本轮进度</span><strong>${Core.progressOf({ ...project, rounds: project.rounds.slice(0, selectedRoundIndex + 1) })}%</strong></div>
    <div class="summary-item"><span>轮次创建</span><strong>${formatDate(round.createdAt)}</strong></div>`;

  $("#roundSelect").innerHTML = project.rounds.map((item, index) => `<option value="${index}">第 ${item.number} 轮${index === project.rounds.length - 1 ? "（当前）" : "（历史）"} · ${labels.result[item.result.status] || item.result.status}</option>`).join("");
  $("#roundSelect").value = String(selectedRoundIndex);
  $("#historyNote").textContent = current ? "当前轮次可编辑；开启下一轮后，本轮将自动转为只读历史。" : "正在查看历史轮次。为保证追溯完整，该轮次为只读，不会被后续更新覆盖。";

  const form = $("#roundForm");
  const entries = {
    "plan.status": round.plan.status, "plan.confirmedAt": round.plan.confirmedAt, "plan.note": round.plan.note,
    "production.status": round.production.status, "production.startDate": round.production.startDate, "production.endDate": round.production.endDate,
    "internalTest.status": round.internalTest.status, "internalTest.result": round.internalTest.result, "internalTest.plannedAt": round.internalTest.plannedAt,
    "internalTest.startedAt": round.internalTest.startedAt, "internalTest.completedAt": round.internalTest.completedAt, "internalTest.note": round.internalTest.note,
    "project.sampleRequirement": project.sampleRequirement,
    "transport.status": round.transport.status, "transport.shippedAt": round.transport.shippedAt, "transport.deliveredAt": round.transport.deliveredAt,
    "test.status": round.test.status, "test.plannedAt": round.test.plannedAt, "test.startedAt": round.test.startedAt, "test.completedAt": round.test.completedAt,
    "result.status": round.result.status, "result.reportDate": round.result.reportDate,
    reasonSummary: round.reasonSummary, correctiveAction: round.correctiveAction, followUp: round.followUp, notes: round.notes,
  };
  Object.entries(entries).forEach(([name, value]) => setFieldValue(form, name, value));
  $$('input, select, textarea, button[type="submit"]', form).forEach((field) => { field.disabled = !current; });
  $("#roundUpdated").textContent = current ? `项目更新：${formatDateTime(project.updatedAt)}` : `历史轮次创建：${formatDateTime(round.createdAt)}`;
  $("#nextRoundBtn").disabled = !current;
}

function openDrawer(projectId) {
  selectedProjectId = projectId;
  const project = getSelectedProject();
  selectedRoundIndex = project.rounds.length - 1;
  renderDrawer();
  $("#drawerBackdrop").hidden = false;
  $("#detailDrawer").classList.add("open");
  $("#detailDrawer").setAttribute("aria-hidden", "false");
  document.body.style.overflow = "hidden";
}

function closeDrawer() {
  $("#detailDrawer").classList.remove("open");
  $("#detailDrawer").setAttribute("aria-hidden", "true");
  document.body.style.overflow = "";
  setTimeout(() => { $("#drawerBackdrop").hidden = true; }, 240);
}

function setNested(target, path, value) {
  const parts = path.split(".");
  let current = target;
  for (let index = 0; index < parts.length - 1; index++) current = current[parts[index]];
  current[parts.at(-1)] = value;
}

function saveRound(event) {
  event.preventDefault();
  const project = getSelectedProject();
  if (!project || selectedRoundIndex !== project.rounds.length - 1) return;
  const round = project.rounds[selectedRoundIndex];
  const formData = new FormData(event.currentTarget);
  for (const [name, value] of formData.entries()) {
    if (name.startsWith("project.")) project[name.split(".")[1]] = value;
    else if (name.includes(".")) setNested(round, name, value);
    else round[name] = value;
  }
  if (round.result.status === "pass" && round.test.status !== "completed") round.test.status = "completed";
  if (round.internalTest.result === "pass" && round.internalTest.status !== "completed") round.internalTest.status = "completed";
  project.updatedAt = new Date().toISOString();
  queueSave(round.result.status === "fail" && !round.reasonSummary ? "已保存；请尽快补充未通过原因" : "本轮进度已保存");
  renderAll();
  renderDrawer();
}

function startNextRound() {
  const project = getSelectedProject();
  if (!project) return;
  const current = Core.currentRound(project);
  const prompt = current.result.status === "pending"
    ? `第 ${current.number} 轮尚未判定结果。仍要锁定本轮并开启第 ${current.number + 1} 轮吗？`
    : `将完整保留第 ${current.number} 轮，并开启第 ${current.number + 1} 轮。是否继续？`;
  if (!window.confirm(prompt)) return;
  Core.makeNextRound(project);
  selectedRoundIndex = project.rounds.length - 1;
  queueSave(`已开启第 ${Core.currentRound(project).number} 轮，上一轮已锁定为历史`);
  renderAll();
  renderDrawer();
}

function addProject(event) {
  event.preventDefault();
  const form = event.currentTarget;
  if (!form.reportValidity()) return;
  const values = Object.fromEntries(new FormData(form));
  const now = new Date();
  const project = {
    id: Core.uid("project"), sequence: String(state.projects.length + 1), material: values.material.trim(), category: values.category.trim(),
    name: values.name.trim(), standard: values.standard.trim(), targetReportDate: values.targetReportDate,
    sampleRequirement: values.sampleRequirement.trim(), owner: values.owner.trim(), sourceRow: "手工新增", archived: false,
    createdAt: now.toISOString(), updatedAt: now.toISOString(), rounds: [{
      id: Core.uid("round"), number: 1, createdAt: now.toISOString(),
      plan: { status: "pending", confirmedAt: "", note: "" },
      production: { status: "not_started", startDate: "", endDate: "" },
      internalTest: { status: "not_started", plannedAt: "", startedAt: "", completedAt: "", result: "pending", note: "" },
      transport: { status: "not_started", shippedAt: "", deliveredAt: "" },
      test: { status: "not_started", plannedAt: "", startedAt: "", completedAt: "" },
      result: { status: "pending", reportDate: "" }, reasonSummary: "", correctiveAction: "", followUp: "", notes: "",
    }],
  };
  state.projects.push(project);
  form.reset();
  $("#projectDialog").close();
  queueSave("新检测项目已创建");
  renderAll();
  openDrawer(project.id);
}

function saveSettings(event) {
  event.preventDefault();
  const value = Number(new FormData(event.currentTarget).get("warningDays"));
  if (!Number.isFinite(value) || value < 0 || value > 30) return;
  state.settings.warningDays = value;
  $("#settingsDialog").close();
  queueSave("预警设置已更新");
  renderAll();
}

function downloadFile(content, filename, type) {
  const blob = new Blob([content], { type });
  const link = document.createElement("a");
  link.href = URL.createObjectURL(blob);
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(link.href), 1000);
}

async function importBackup(file) {
  const text = await file.text();
  let imported;
  if (file.name.toLowerCase().endsWith(".csv")) imported = Core.importCSV(text, clone(state));
  else imported = validateData(JSON.parse(text));
  if (!window.confirm(`将导入 ${imported.projects.length} 个项目，并替换当前数据。建议先导出完整备份。是否继续？`)) return;
  state = imported;
  selectedProjectId = null;
  closeDrawer();
  queueSave("备份数据已导入");
  renderAll();
}

function bindEvents() {
  ["searchInput", "materialFilter", "stageFilter", "riskFilter"].forEach((id) => {
    $("#" + id).addEventListener(id === "searchInput" ? "input" : "change", renderRows);
  });
  $("#clearFiltersBtn").addEventListener("click", () => {
    $("#searchInput").value = "";
    $("#materialFilter").value = "all";
    $("#stageFilter").value = "all";
    $("#riskFilter").value = "all";
    renderRows();
  });
  $("#closeDrawerBtn").addEventListener("click", closeDrawer);
  $("#drawerBackdrop").addEventListener("click", closeDrawer);
  $("#roundSelect").addEventListener("change", (event) => { selectedRoundIndex = Number(event.target.value); renderDrawer(); });
  $("#roundForm").addEventListener("submit", saveRound);
  $("#nextRoundBtn").addEventListener("click", startNextRound);
  $("#addProjectBtn").addEventListener("click", () => $("#projectDialog").showModal());
  $("#projectForm").addEventListener("submit", addProject);
  $("#settingsBtn").addEventListener("click", () => { $("#settingsForm").elements.warningDays.value = state.settings.warningDays; $("#settingsDialog").showModal(); });
  $("#settingsForm").addEventListener("submit", saveSettings);
  $("#importBtn").addEventListener("click", () => $("#importFile").click());
  $("#importFile").addEventListener("change", async (event) => {
    const [file] = event.target.files;
    if (!file) return;
    try { await importBackup(file); } catch (error) { showToast(`导入失败：${error.message}`, true); }
    event.target.value = "";
  });
  $("#exportJsonBtn").addEventListener("click", () => {
    downloadFile(JSON.stringify(state, null, 2), `检测报告进度完整备份_${Core.todayISO()}.json`, "application/json;charset=utf-8");
    showToast("完整备份已导出");
  });
  $("#exportCsvBtn").addEventListener("click", () => {
    downloadFile("\uFEFF" + Core.exportCSV(state), `检测报告进度明细_${Core.todayISO()}.csv`, "text/csv;charset=utf-8");
    showToast("CSV 已导出，可直接用 Excel 打开");
  });
  document.addEventListener("keydown", (event) => { if (event.key === "Escape" && $("#detailDrawer").classList.contains("open")) closeDrawer(); });
}

async function init() {
  $("#todayLabel").textContent = new Intl.DateTimeFormat("zh-CN", { dateStyle: "full" }).format(new Date());
  bindEvents();
  try {
    await loadData();
    renderAll();
  } catch (error) {
    document.body.innerHTML = `<main class="page-shell"><section class="workspace-card" style="padding:40px"><h1>网站数据未能加载</h1><p>${escapeHtml(error.message)}</p><p>请关闭当前页面，双击项目目录中的“启动网站.bat”重新打开。</p></section></main>`;
  }
}

init();
