(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  root.TrackerCore = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  const DAY = 24 * 60 * 60 * 1000;

  function todayISO(now = new Date()) {
    const local = new Date(now.getTime() - now.getTimezoneOffset() * 60000);
    return local.toISOString().slice(0, 10);
  }

  function uid(prefix = "id") {
    return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  }

  function currentRound(project) {
    return project.rounds[project.rounds.length - 1];
  }

  function isDone(status) {
    return status === "completed" || status === "confirmed" || status === "pass" || status === "waived";
  }

  function progressOf(project) {
    const round = currentRound(project);
    const steps = [
      round.plan.status === "confirmed",
      isDone(round.production.status),
      isDone(round.internalTest.status),
      isDone(round.transport.status),
      isDone(round.test.status) || ["pass", "fail", "exception"].includes(round.result.status),
      ["pass", "fail", "exception"].includes(round.result.status),
      round.result.status === "pass" || Boolean(round.reasonSummary && round.correctiveAction),
    ];
    return Math.round((steps.filter(Boolean).length / steps.length) * 100);
  }

  function stageOf(project) {
    const round = currentRound(project);
    if (round.result.status === "pass") return { key: "passed", label: "已通过", tone: "success" };
    if (["fail", "exception"].includes(round.result.status)) {
      return round.reasonSummary && round.correctiveAction
        ? { key: "improving", label: "整改中", tone: "danger" }
        : { key: "analysis", label: "待原因总结", tone: "danger" };
    }
    if (round.internalTest.result === "fail") return { key: "internal_testing", label: "内部测试未通过", tone: "danger" };
    if (round.test.status === "completed") return { key: "result", label: "待判定", tone: "warning" };
    if (["in_progress", "completed"].includes(round.test.status)) return { key: "testing", label: "检测中", tone: "info" };
    if (["in_transit", "completed"].includes(round.transport.status)) return { key: "transport", label: round.transport.status === "completed" ? "待检测" : "运输中", tone: "info" };
    if (["in_progress", "blocked"].includes(round.internalTest.status)) return { key: "internal_testing", label: round.internalTest.status === "in_progress" ? "内部测试中" : "内部测试受阻", tone: round.internalTest.status === "blocked" ? "danger" : "info" };
    if (round.production.status === "completed" && !isDone(round.internalTest.status)) return { key: "internal_testing", label: "待内部测试", tone: "info" };
    if (["in_progress", "completed", "blocked"].includes(round.production.status)) {
      const label = round.production.status === "completed" ? "待运输" : round.production.status === "blocked" ? "生产受阻" : "生产中";
      return { key: "production", label, tone: round.production.status === "blocked" ? "danger" : "info" };
    }
    if (round.plan.status === "confirmed") return { key: "planned", label: "方案已确认", tone: "neutral" };
    return { key: "proposal", label: "待确认方案", tone: "neutral" };
  }

  function daysBetween(fromISO, toISO) {
    if (!fromISO || !toISO) return null;
    const from = new Date(`${fromISO}T00:00:00`);
    const to = new Date(`${toISO}T00:00:00`);
    return Math.round((to - from) / DAY);
  }

  function riskOf(project, settings = {}, today = todayISO()) {
    const warningDays = Number(settings.warningDays ?? 3);
    const round = currentRound(project);
    if (round.internalTest.result === "fail") {
      return { key: "abnormal", label: "异常", tone: "danger", reason: "内部测试未通过" };
    }
    if (["fail", "exception"].includes(round.result.status)) {
      return { key: "abnormal", label: "异常", tone: "danger", reason: round.result.status === "fail" ? "本轮检测未通过" : "本轮存在异常" };
    }
    if (round.result.status === "pass") return { key: "normal", label: "正常", tone: "success", reason: "检测已通过" };

    const checkpoints = [];
    if (round.production.status !== "completed" && round.production.endDate) checkpoints.push([round.production.endDate, "生产完成"]);
    if (!isDone(round.internalTest.status) && round.internalTest.plannedAt) checkpoints.push([round.internalTest.plannedAt.slice(0, 10), "内部测试"]);
    if (round.transport.status !== "completed" && round.transport.deliveredAt) checkpoints.push([round.transport.deliveredAt.slice(0, 10), "送达实验室"]);
    if (!["in_progress", "completed"].includes(round.test.status) && round.test.plannedAt) checkpoints.push([round.test.plannedAt.slice(0, 10), "开始检测"]);
    if (project.targetReportDate) checkpoints.push([project.targetReportDate, "提交报告"]);

    const upcoming = checkpoints
      .filter(([date]) => date)
      .map(([date, label]) => ({ date, label, days: daysBetween(today, date) }))
      .sort((a, b) => a.days - b.days)[0];
    if (!upcoming) return { key: "normal", label: "正常", tone: "success", reason: "暂无明确截止时间" };
    if (upcoming.days < 0) return { key: "overdue", label: "已逾期", tone: "danger", reason: `${upcoming.label}已逾期 ${Math.abs(upcoming.days)} 天` };
    if (upcoming.days <= warningDays) return { key: "warning", label: "临期", tone: "warning", reason: `${upcoming.label}还有 ${upcoming.days} 天` };
    return { key: "normal", label: "正常", tone: "success", reason: `${upcoming.label}还有 ${upcoming.days} 天` };
  }

  function makeNextRound(project, now = new Date()) {
    const last = currentRound(project);
    const next = {
      id: uid("round"),
      number: last.number + 1,
      createdAt: now.toISOString(),
      plan: { status: "pending", confirmedAt: "", note: "" },
      production: { status: "not_started", startDate: "", endDate: "" },
      internalTest: { status: "not_started", plannedAt: "", startedAt: "", completedAt: "", result: "pending", note: "" },
      transport: { status: "not_started", shippedAt: "", deliveredAt: "" },
      test: { status: "not_started", plannedAt: "", startedAt: "", completedAt: "" },
      result: { status: "pending", reportDate: "" },
      reasonSummary: "",
      correctiveAction: "",
      followUp: "",
      notes: last.result.status === "pass" ? "复验轮次" : `承接第 ${last.number} 轮改进措施：${last.correctiveAction || "待补充"}`,
    };
    project.rounds.push(next);
    project.updatedAt = now.toISOString();
    return next;
  }

  function escapeCSV(value) {
    const text = value == null ? "" : String(value);
    return /[",\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
  }

  const CSV_HEADERS = [
    "项目ID", "序号", "地板类型", "检测分类", "检测项目", "标准", "要求报告日期", "样品/数量", "跟进人",
    "轮次", "方案状态", "方案确认时间", "方案说明", "生产状态", "生产开始", "生产完成",
    "内部测试状态", "内部测试计划", "内部测试开始", "内部测试完成", "内部测试结果", "内部测试说明",
    "运输状态", "发运时间", "送达时间", "检测状态", "计划检测", "检测开始", "检测完成",
    "检测结果", "报告日期", "原因总结", "改进措施", "后续跟进", "备注"
  ];

  function exportCSV(data) {
    const rows = [CSV_HEADERS];
    for (const project of data.projects) {
      for (const round of project.rounds) {
        rows.push([
          project.id, project.sequence, project.material, project.category, project.name, project.standard,
          project.targetReportDate, project.sampleRequirement, project.owner, round.number,
          round.plan.status, round.plan.confirmedAt, round.plan.note,
          round.production.status, round.production.startDate, round.production.endDate,
          round.internalTest.status, round.internalTest.plannedAt, round.internalTest.startedAt, round.internalTest.completedAt, round.internalTest.result, round.internalTest.note,
          round.transport.status, round.transport.shippedAt, round.transport.deliveredAt,
          round.test.status, round.test.plannedAt, round.test.startedAt, round.test.completedAt,
          round.result.status, round.result.reportDate, round.reasonSummary, round.correctiveAction, round.followUp, round.notes,
        ]);
      }
    }
    return rows.map((row) => row.map(escapeCSV).join(",")).join("\r\n");
  }

  function parseCSV(text) {
    const rows = [];
    let row = [], field = "", quoted = false;
    for (let i = 0; i < text.length; i++) {
      const char = text[i];
      if (quoted) {
        if (char === '"' && text[i + 1] === '"') { field += '"'; i++; }
        else if (char === '"') quoted = false;
        else field += char;
      } else if (char === '"') quoted = true;
      else if (char === ",") { row.push(field); field = ""; }
      else if (char === "\n") { row.push(field.replace(/\r$/, "")); rows.push(row); row = []; field = ""; }
      else field += char;
    }
    if (field || row.length) { row.push(field.replace(/\r$/, "")); rows.push(row); }
    return rows;
  }

  function importCSV(text, baseData) {
    const rows = parseCSV(text.replace(/^\uFEFF/, ""));
    const headers = rows.shift();
    if (!headers || !CSV_HEADERS.every((header) => headers.includes(header))) throw new Error("CSV 列结构不匹配，请使用本网站导出的 CSV 文件");
    const at = Object.fromEntries(headers.map((header, index) => [header, index]));
    const data = structuredClone(baseData);
    data.projects = [];
    const projects = new Map();
    for (const cols of rows.filter((item) => item.some(Boolean))) {
      const value = (name) => cols[at[name]] || "";
      const id = value("项目ID") || uid("project");
      let project = projects.get(id);
      if (!project) {
        project = {
          id, sequence: value("序号"), material: value("地板类型"), category: value("检测分类"),
          name: value("检测项目"), standard: value("标准"), targetReportDate: value("要求报告日期"),
          sampleRequirement: value("样品/数量"), owner: value("跟进人"), sourceRow: "CSV 导入",
          archived: false, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), rounds: [],
        };
        projects.set(id, project);
        data.projects.push(project);
      }
      project.rounds.push({
        id: uid("round"), number: Number(value("轮次")) || project.rounds.length + 1, createdAt: new Date().toISOString(),
        plan: { status: value("方案状态") || "pending", confirmedAt: value("方案确认时间"), note: value("方案说明") },
        production: { status: value("生产状态") || "not_started", startDate: value("生产开始"), endDate: value("生产完成") },
        internalTest: { status: value("内部测试状态") || "not_started", plannedAt: value("内部测试计划"), startedAt: value("内部测试开始"), completedAt: value("内部测试完成"), result: value("内部测试结果") || "pending", note: value("内部测试说明") },
        transport: { status: value("运输状态") || "not_started", shippedAt: value("发运时间"), deliveredAt: value("送达时间") },
        test: { status: value("检测状态") || "not_started", plannedAt: value("计划检测"), startedAt: value("检测开始"), completedAt: value("检测完成") },
        result: { status: value("检测结果") || "pending", reportDate: value("报告日期") },
        reasonSummary: value("原因总结"), correctiveAction: value("改进措施"), followUp: value("后续跟进"), notes: value("备注"),
      });
    }
    data.updatedAt = new Date().toISOString();
    return data;
  }

  return { todayISO, uid, currentRound, progressOf, stageOf, riskOf, makeNextRound, exportCSV, parseCSV, importCSV, CSV_HEADERS };
});
