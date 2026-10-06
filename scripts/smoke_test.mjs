import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { OperationsStore } from "../operations-store.mjs";

const rootDir = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const baseUrl = process.env.WORKBENCH_URL || "http://localhost:5177";

async function getJson(urlPath) {
  const response = await fetch(`${baseUrl}${urlPath}`);
  assert.equal(response.status, 200, `${urlPath} should return 200`);
  return response.json();
}

async function getText(urlPath) {
  const response = await fetch(`${baseUrl}${urlPath}`);
  assert.equal(response.status, 200, `${urlPath} should return 200`);
  return response.text();
}

const audit = await getJson("/api/audit");
assert.equal(audit.summary.homepageStatus, "ready_for_analysis");
assert.equal(audit.modules.find((item) => item.folder === "02-交易").fileCount, 5);
assert.equal(audit.modules.find((item) => item.folder === "03-流量").fileCount, 4);
assert.equal(audit.modules.find((item) => item.folder === "04-客户").fileCount, 3);

const homepage = await getJson("/api/homepage");
assert.equal(homepage.status, "ready");
assert.ok(homepage.cross_module.signals.some((item) => item.module === "流量"));
assert.ok(homepage.cross_module.signals.some((item) => item.module === "客户"));
assert.ok(homepage.cross_module.gaps.some((item) => item.module === "交易"));

const transactionLatest = await getJson("/api/module/transaction");
const transactionWeek = await getJson("/api/module/transaction?from=2026-07-25&to=2026-07-31");
assert.equal(transactionLatest.selection.mode, "daily");
assert.equal(transactionWeek.selection.day_count, 7);
assert.notEqual(transactionLatest.kpis[0].value, transactionWeek.kpis[0].value);
assert.equal(transactionWeek.trend.labels.length, 7);

const traffic = await getJson("/api/module/traffic?from=2026-06-10&to=2026-06-20");
assert.equal(traffic.selection.mode, "native_snapshot_mapped");
assert.equal(traffic.selection.date_from, "2026-06-01");
assert.ok(traffic.composition.rows.length > 0);
assert.ok(traffic.drilldown.rows.some((item) => item.label.includes(" / ")));
assert.ok(traffic.detail.columns.includes("原始行"));
assert.ok(traffic.findings.some((item) => item.title.includes("高流量低转化") && item.source.row));

const customer = await getJson("/api/module/customer?from=2026-06-10&to=2026-06-20");
assert.equal(customer.selection.mode, "native_snapshot_mapped");
assert.equal(customer.selection.date_from, "2026-06-01");
assert.ok(customer.findings.some((item) => item.title.includes("召回率")));

const diagnosis = await getJson("/api/diagnosis");
assert.equal(diagnosis.selection.date_from, "2026-08-01");
assert.ok(diagnosis.issues.every((item) => item.severity && item.confidence && item.evidence.length));
assert.ok(diagnosis.issues.some((item) => item.evidence.some((evidence) => evidence.deep_link)));
assert.ok(diagnosis.issues.some((item) => item.title.includes("逛逛")));
const diagnosisHistory = await getJson("/api/diagnosis/history");
assert.ok(diagnosisHistory.history.length > 0);

const actions = await getJson("/api/actions");
assert.ok(actions.actions.some((item) => item.title.includes("补充同期交易明细") && item.status === "待配置"));
assert.ok(actions.actions.every((item) => ["owner", "due_date", "note", "verification"].every((field) => field in item)));

const system = await getJson("/api/system");
assert.equal(system.status, "ready");
assert.ok(system.startup.exists);
assert.equal(system.data.normalized.filter((item) => item.exists).length, 4);
assert.ok(system.reports.some((item) => item.name.includes("01-首页数据审计")));

for (const page of ["/", "/transaction.html", "/traffic.html", "/customer.html", "/diagnosis.html", "/actions.html", "/audit.html", "/system.html"]) {
  const html = await getText(page);
  assert.match(html, /生意参谋数据工作台/);
}

const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "sycm-operations-test-"));
try {
  const store = new OperationsStore(tempRoot);
  const baseAction = { id: "0123456789abcdef", title: "持久化测试", module: "测试", target_module: "测试", priority: "高", status: "待处理", reason: "验证状态跨周期保留", period: "2026-08-01|2026-08-15", source: { workbook_file: "qa" }, sync_target: "执行中心" };
  await store.mergeGenerated([baseAction]);
  await store.update(baseAction.id, { status: "执行中", owner: "测试负责人", due_date: "2026-08-20", note: "已开始", verification: "待验证" });
  const regenerated = await store.mergeGenerated([{ ...baseAction, period: "2026-08-02|2026-08-16", status: "待处理" }]);
  assert.equal(regenerated.actions[0].status, "执行中");
  assert.equal(regenerated.actions[0].owner, "测试负责人");
  assert.equal(regenerated.actions[0].period, "2026-08-02|2026-08-16");
} finally {
  await fs.rm(tempRoot, { recursive: true, force: true });
}

for (const fileName of ["today_actions.json", "execution_tasks.json"]) {
  const exported = JSON.parse(await fs.readFile(path.join(rootDir, "action_exports", fileName), "utf8"));
  assert.ok(Array.isArray(exported.actions));
  assert.ok(exported.actions.every((item) => item.source && item.period));
}

console.log("PASS: V1.1 首页、专题分析、流量下钻、诊断中心、历史、持久化行动、系统状态与全部静态页面均通过冒烟测试");
