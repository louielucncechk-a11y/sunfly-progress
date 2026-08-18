const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const Core = require("../tracker-core.js");

const data = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "data", "tracker-data.json"), "utf8"));

assert.equal(data.projects.length, 10, "应导入 10 个实际检测项目");
assert.ok(data.projects.every((project) => project.rounds.every((round) => round.internalTest)), "每轮都应包含内部测试环节");

const retest = data.projects.find((project) => project.id === "sf-en13501-1");
assert.equal(retest.rounds.length, 2, "EN 13501-1 应保留首轮失败与第二轮重测");
assert.equal(retest.rounds[0].result.status, "fail");
assert.equal(retest.rounds[1].result.status, "pending");

const copy = structuredClone(retest);
const previousRound = JSON.stringify(copy.rounds[1]);
Core.makeNextRound(copy, new Date("2026-08-18T04:00:00Z"));
assert.equal(copy.rounds.length, 3, "应创建后续轮次");
assert.equal(JSON.stringify(copy.rounds[1]), previousRound, "开启下一轮不能覆盖上一轮");
assert.equal(copy.rounds[2].internalTest.status, "not_started");

const steelEn1081 = data.projects.find((project) => project.id === "steel-en1081");
assert.equal(Core.riskOf(steelEn1081, data.settings, "2026-08-18").key, "overdue", "已错过检测计划的项目应逾期");

const internalFailure = structuredClone(data.projects[0]);
internalFailure.rounds[0].production.status = "completed";
internalFailure.rounds[0].internalTest.status = "completed";
internalFailure.rounds[0].internalTest.result = "fail";
assert.equal(Core.riskOf(internalFailure, data.settings, "2026-08-18").key, "abnormal", "内部测试失败应触发异常");
assert.equal(Core.stageOf(internalFailure).key, "internal_testing");

const csv = Core.exportCSV(data);
assert.ok(csv.includes("内部测试状态"));
const reimported = Core.importCSV(csv, data);
assert.equal(reimported.projects.length, data.projects.length, "CSV 往返后项目数应一致");
assert.equal(reimported.projects.find((project) => project.id === "sf-en13501-1").rounds.length, 2, "CSV 往返应保留轮次");

console.log("核心逻辑测试通过：10 个项目、内部测试、循环历史、风险预警、CSV 往返均正常。");
