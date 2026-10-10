import { createServer } from "node:http";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { analyzeBusinessModule } from "./business-analysis.mjs";
import { buildDiagnosisCenter, DiagnosisHistory } from "./diagnosis-center.mjs";
import { OperationsStore, readRequestJson } from "./operations-store.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = __dirname;
const rawDir = path.join(rootDir, "raw");
const publicDir = path.join(rootDir, "public");
const homepageScript = path.join(rootDir, "scripts", "build_homepage_data.py");
const periodAnalysisScript = path.join(rootDir, "scripts", "analyze_homepage_period.py");
const businessBuildScript = path.join(rootDir, "scripts", "build_business_modules.py");
const homepageSummaryPath = path.join(rootDir, "reports", "homepage-summary.json");
const port = Number(process.env.PORT || 5177);
const execFileAsync = promisify(execFile);
let homepageBuildPromise = null;
let businessBuildPromise = null;
const operationsStore = new OperationsStore(rootDir);
const diagnosisHistory = new DiagnosisHistory(rootDir);
const startedAt = new Date();

const categories = [
  ["01-首页", "首页", "默认 / 数据概览 / 数据看板 / 店铺概况"],
  ["02-交易", "交易", "交易 / 支付 / 订单 / 成交"],
  ["03-流量", "流量", "流量来源 / 渠道 / 访客 / 点击"],
  ["04-客户", "客户", "客户 / 人群 / 新客老客 / 会员"],
  ["05-商品", "商品", "商品效果 / 单品 / SKU / 商品排行"],
  ["06-营销", "营销", "营销 / 活动 / 推广 / 投放 / 优惠"],
  ["07-服务", "服务", "服务 / 售后 / 评价 / 退款 / 客服"],
  ["08-内容", "内容", "内容 / 直播 / 短视频 / 逛逛"],
  ["09-市场", "市场", "市场 / 竞品 / 行业 / 搜索排行"],
  ["10-业务专区", "业务专区", "暂未归类或平台专区数据"]
];

const dataExts = new Set([".xlsx", ".xls", ".csv", ".tsv", ".zip"]);
const mime = new Map([
  [".html", "text/html; charset=utf-8"],
  [".css", "text/css; charset=utf-8"],
  [".js", "text/javascript; charset=utf-8"],
  [".json", "application/json; charset=utf-8"],
  [".png", "image/png"],
  [".jpg", "image/jpeg"],
  [".jpeg", "image/jpeg"],
  [".svg", "image/svg+xml"]
]);

function formatBytes(bytes) {
  if (!bytes) return "0 B";
  const units = ["B", "KB", "MB", "GB"];
  let size = bytes;
  let unit = 0;
  while (size >= 1024 && unit < units.length - 1) {
    size /= 1024;
    unit += 1;
  }
  return `${size.toFixed(unit === 0 ? 0 : 1)} ${units[unit]}`;
}

async function listDataFiles(categoryDir) {
  const entries = await fs.readdir(categoryDir, { withFileTypes: true }).catch(() => []);
  const files = [];

  for (const entry of entries) {
    if (!entry.isFile()) continue;
    const ext = path.extname(entry.name).toLowerCase();
    if (!dataExts.has(ext)) continue;

    const fullPath = path.join(categoryDir, entry.name);
    const stat = await fs.stat(fullPath);
    files.push({
      name: entry.name,
      ext: ext.slice(1),
      size: stat.size,
      sizeLabel: formatBytes(stat.size),
      modifiedAt: stat.mtime.toISOString()
    });
  }

  return files.sort((a, b) => b.modifiedAt.localeCompare(a.modifiedAt));
}

export async function buildAudit() {
  await fs.mkdir(rawDir, { recursive: true });

  const modules = [];
  for (const [folder, label, description] of categories) {
    const dir = path.join(rawDir, folder);
    await fs.mkdir(dir, { recursive: true });
    const files = await listDataFiles(dir);
    const totalBytes = files.reduce((sum, file) => sum + file.size, 0);
    modules.push({
      folder,
      label,
      description,
      fileCount: files.length,
      totalBytes,
      totalBytesLabel: formatBytes(totalBytes),
      latestModifiedAt: files[0]?.modifiedAt || null,
      status: files.length ? "ready_for_audit" : "waiting",
      files
    });
  }

  const totalFiles = modules.reduce((sum, item) => sum + item.fileCount, 0);
  const modulesWithData = modules.filter((item) => item.fileCount > 0).length;
  const homepage = modules.find((item) => item.folder === "01-首页");

  return {
    generatedAt: new Date().toISOString(),
    rawDir,
    summary: {
      totalFiles,
      modulesWithData,
      moduleCount: modules.length,
      homepageFiles: homepage?.fileCount || 0,
      homepageStatus: homepage?.fileCount ? "ready_for_analysis" : "waiting_for_homepage_data"
    },
    modules,
    nextSteps: totalFiles
      ? ["首页诊断已生成", "补齐流量与商品模块", "配置店铺标识"]
      : ["把首页数据放入 raw/01-首页", "刷新页面确认文件已识别", "开始字段审计"]
  };
}

async function archiveFingerprint(paths) {
  const digest = createHash("sha256");
  for (const filename of [...paths].sort()) {
    const stat = await fs.stat(filename, { bigint: true });
    digest.update(path.basename(filename));
    digest.update(String(stat.size));
    digest.update(String(stat.mtimeNs));
  }
  return digest.digest("hex");
}

async function ensureHomepageSummary() {
  const entries = await fs.readdir(path.join(rawDir, "01-首页"), { withFileTypes: true }).catch(() => []);
  const archivePaths = entries
    .filter((entry) => entry.isFile() && path.extname(entry.name).toLowerCase() === ".zip")
    .map((entry) => path.join(rawDir, "01-首页", entry.name));

  if (!archivePaths.length) {
    return {
      status: "waiting",
      latest_date: null,
      coverage: { archive_count: 0, workbook_count: 0, daily_unique_dates: 0, monthly_unique_dates: 0 },
      kpis: [],
      focus: [],
      actions: [],
      drivers: [],
      trend: { labels: [], series: {} },
      sources: []
    };
  }

  const sourceStats = await Promise.all(archivePaths.map((archivePath) => fs.stat(archivePath)));
  const scriptStat = await fs.stat(homepageScript);
  const newestInput = Math.max(scriptStat.mtimeMs, ...sourceStats.map((stat) => stat.mtimeMs));
  const summaryStat = await fs.stat(homepageSummaryPath).catch(() => null);
  const cached = await fs.readFile(homepageSummaryPath, "utf8").then(JSON.parse).catch(() => null);
  const fingerprint = await archiveFingerprint(archivePaths);

  if (!summaryStat || summaryStat.mtimeMs < newestInput || cached?.source_fingerprint !== fingerprint) {
    if (!homepageBuildPromise) {
      homepageBuildPromise = execFileAsync("python", [homepageScript], {
        cwd: rootDir,
        windowsHide: true,
        maxBuffer: 4 * 1024 * 1024
      }).finally(() => {
        homepageBuildPromise = null;
      });
    }
    await homepageBuildPromise;
  }

  return JSON.parse(await fs.readFile(homepageSummaryPath, "utf8"));
}

async function analyzeHomepagePeriod(dateFrom, dateTo) {
  const datePattern = /^\d{4}-\d{2}-\d{2}$/;
  if ((dateFrom && !datePattern.test(dateFrom)) || (dateTo && !datePattern.test(dateTo))) {
    throw new Error("日期格式必须为 YYYY-MM-DD");
  }
  if ((dateFrom && !dateTo) || (!dateFrom && dateTo)) {
    throw new Error("开始日期和结束日期必须同时提供");
  }

  const summary = await ensureHomepageSummary();
  if (summary.status === "waiting") return summary;
  const args = [periodAnalysisScript];
  if (dateFrom && dateTo) args.push("--from", dateFrom, "--to", dateTo);
  const { stdout } = await execFileAsync("python", args, {
    cwd: rootDir,
    windowsHide: true,
    maxBuffer: 4 * 1024 * 1024
  });
  return augmentHomepageWithModules(JSON.parse(stdout));
}

function actionId(moduleName, title) {
  return createHash("sha256").update(`${moduleName}|${title}`).digest("hex").slice(0, 16);
}

async function writeActionExports(homepage, moduleResults) {
  const period = `${homepage.selection.date_from}|${homepage.selection.date_to}`;
  const sourceForAction = (result, action) => {
    const matchers = [
      ["高流量低转化", (title) => title.includes("高流量低转化") || title.includes("转化效率最低")],
      ["召回", (title) => title.includes("召回率")],
      ["价格", (title) => title.includes("价格带") || title.includes("客单价")],
      ["转化", (title) => title.includes("转化")],
      ["退款", (title) => title.includes("退款")]
    ];
    const matcher = matchers.find(([keyword]) => action.title.includes(keyword))?.[1];
    return (matcher ? result.findings.find((item) => matcher(item.title)) : null)?.source || result.findings[0]?.source || result.kpis[0]?.source || null;
  };
  const sourceForHomepageAction = (action) => {
    const matcher = action.title.includes("收入") || action.title.includes("支付")
      ? (title) => title.includes("净支付金额")
      : action.title.includes("转化")
        ? (title) => title.includes("转化")
        : null;
    return (matcher ? homepage.focus.find((item) => matcher(item.title)) : null)?.source || homepage.focus[0]?.source || homepage.kpis[0]?.source || null;
  };
  const collected = [
    ...homepage.actions.map((action) => ({ ...action, module: "首页", source: sourceForHomepageAction(action) })),
    ...moduleResults.flatMap((result) => result.actions.map((action) => ({
      ...action,
      module: result.title,
      source: sourceForAction(result, action),
      period: `${result.selection.date_from}|${result.selection.date_to}`
    }))),
    ...(homepage.cross_module?.gaps || []).map((gap) => ({
      title: `补充同期${gap.module}明细`,
      module: "数据质量",
      target_module: gap.module,
      priority: "高",
      status: "待配置",
      reason: gap.message,
      period,
      source: {
        archive_file: `raw/02-${gap.module}`,
        workbook_file: "文件覆盖审计",
        sheet: "目录审计",
        field: "最新数据日期",
        caliber: gap.message
      }
    }))
  ];
  const unique = [...new Map(collected.map((action) => [action.title, action])).values()];
  const executionTasks = unique.map((action) => ({
    id: actionId(action.module, action.title),
    title: action.title,
    module: action.module,
    target_module: action.target_module,
    priority: action.priority,
    status: action.status,
    reason: action.reason,
    period: action.period || period,
    source: action.source,
    sync_target: "执行中心",
    generated_at: new Date().toISOString()
  }));
  return operationsStore.mergeGenerated(executionTasks);
}

async function augmentHomepageWithModules(homepage) {
  await ensureBusinessData();
  const { date_from: dateFrom, date_to: dateTo } = homepage.selection;
  const [transactionLatest, traffic, customer] = await Promise.all([
    analyzeBusinessModule(rootDir, "transaction"),
    analyzeBusinessModule(rootDir, "traffic", dateFrom, dateTo),
    analyzeBusinessModule(rootDir, "customer", dateFrom, dateTo)
  ]);
  const moduleResults = [traffic, customer];
  const signals = [];
  const trafficFinding = traffic.findings.find((item) => item.title.includes("转化效率")) || traffic.findings[0];
  const customerFinding = customer.findings.find((item) => item.title.includes("召回率")) || customer.findings[0];
  if (trafficFinding) signals.push({ module: "流量", period: traffic.selection.label, finding: trafficFinding });
  if (customerFinding) signals.push({ module: "客户", period: customer.selection.label, finding: customerFinding });

  if (dateTo <= transactionLatest.coverage.date_end) {
    const transaction = await analyzeBusinessModule(rootDir, "transaction", dateFrom, dateTo);
    moduleResults.unshift(transaction);
    const transactionFinding = transaction.findings.find((item) => item.title.includes("转化率")) || transaction.findings[0];
    if (transactionFinding) signals.unshift({ module: "交易", period: transaction.selection.label, finding: transactionFinding });
  }

  const existingTitles = new Set(homepage.focus.map((item) => item.title));
  for (const signal of signals) {
    const title = `${signal.module}明细验证：${signal.finding.title}`;
    if (existingTitles.has(title)) continue;
    homepage.focus.push({
      title,
      verdict: `${signal.finding.verdict}（支持周期：${signal.period}）`,
      evidence: [...signal.finding.evidence.slice(0, 2), signal.finding.impact],
      severity: signal.finding.severity,
      confidence: "已确认",
      deep_link: `/${signal.module === "交易" ? "transaction" : signal.module === "流量" ? "traffic" : "customer"}.html?from=${dateFrom}&to=${dateTo}`,
      source: signal.finding.source
    });
  }
  homepage.focus = homepage.focus.slice(0, 5).map((item) => ({ confidence: item.confidence || "高概率", deep_link: item.deep_link || `/diagnosis.html?from=${dateFrom}&to=${dateTo}`, ...item }));

  const existingActions = new Set(homepage.actions.map((item) => item.title));
  for (const result of moduleResults) {
    const action = result.actions.find((item) => item.priority === "高") || result.actions[0];
    if (action && !existingActions.has(action.title)) homepage.actions.push(action);
  }
  homepage.actions = homepage.actions.slice(0, 5);
  homepage.cross_module = {
    signals: signals.map((signal) => ({ module: signal.module, period: signal.period, title: signal.finding.title, severity: signal.finding.severity })),
    gaps: dateTo > transactionLatest.coverage.date_end
      ? [{ module: "交易", message: `交易明细仅到 ${transactionLatest.coverage.date_end}，不用于 ${dateFrom} 至 ${dateTo} 的原因判断` }]
      : []
  };
  await writeActionExports(homepage, moduleResults).catch((error) => console.error("行动导出写入失败", error));
  return homepage;
}

async function ensureBusinessData() {
  const definitions = [
    ["02-交易", "transaction-data.json"],
    ["03-流量", "traffic-data.json"],
    ["04-客户", "customer-data.json"]
  ];
  const scriptStat = await fs.stat(businessBuildScript);
  let newestInput = scriptStat.mtimeMs;
  let needsBuild = false;

  for (const [folder, outputName] of definitions) {
    const entries = await fs.readdir(path.join(rawDir, folder), { withFileTypes: true }).catch(() => []);
    const archivePaths = [];
    for (const entry of entries) {
      if (!entry.isFile() || path.extname(entry.name).toLowerCase() !== ".zip") continue;
      archivePaths.push(path.join(rawDir, folder, entry.name));
      const stat = await fs.stat(path.join(rawDir, folder, entry.name));
      newestInput = Math.max(newestInput, stat.mtimeMs);
    }
    const outputStat = await fs.stat(path.join(rootDir, "normalized", outputName)).catch(() => null);
    const cached = await fs.readFile(path.join(rootDir, "normalized", outputName), "utf8").then(JSON.parse).catch(() => null);
    if (!outputStat || outputStat.mtimeMs < newestInput || cached?.source_fingerprint !== await archiveFingerprint(archivePaths)) needsBuild = true;
  }

  if (needsBuild) {
    if (!businessBuildPromise) {
      businessBuildPromise = execFileAsync("python", [businessBuildScript], {
        cwd: rootDir,
        windowsHide: true,
        maxBuffer: 8 * 1024 * 1024
      }).finally(() => {
        businessBuildPromise = null;
      });
    }
    await businessBuildPromise;
  }
}

async function analyzeModule(moduleName, dateFrom, dateTo) {
  await ensureBusinessData();
  const data = JSON.parse(await fs.readFile(path.join(rootDir, "normalized", `${moduleName}-data.json`), "utf8"));
  if (!data.datasets.length) return { status: "waiting", message: "尚无兼容的模块 ZIP 数据，请导入后刷新。" };
  return analyzeBusinessModule(rootDir, moduleName, dateFrom, dateTo);
}

async function buildDiagnosis(dateFrom, dateTo) {
  const initialSummary = await ensureHomepageSummary();
  if (initialSummary.status === "waiting") {
    return { status: "waiting", message: "请先把首页导出 ZIP 放入 raw/01-首页，再刷新。", selection: {}, issues: [], actions: [] };
  }
  if (!dateFrom && !dateTo) {
    const summary = await ensureHomepageSummary();
    dateTo = summary.latest_date;
    dateFrom = `${dateTo.slice(0, 8)}01`;
  }
  const homepage = await analyzeHomepagePeriod(dateFrom, dateTo);
  const [transaction, traffic, customer] = await Promise.all([
    analyzeModule("transaction"),
    analyzeModule("traffic", homepage.selection.date_from, homepage.selection.date_to),
    analyzeModule("customer", homepage.selection.date_from, homepage.selection.date_to)
  ]);
  const actionExport = await operationsStore.list();
  const diagnosis = buildDiagnosisCenter({ homepage, transaction, traffic, customer, actions: actionExport.actions });
  await diagnosisHistory.appendIfChanged(diagnosis);
  return diagnosis;
}

async function fileStatus(filePath) {
  const stat = await fs.stat(filePath).catch(() => null);
  return stat ? { exists: true, size: stat.size, size_label: formatBytes(stat.size), modified_at: stat.mtime.toISOString() } : { exists: false };
}

async function buildSystemStatus() {
  const audit = await buildAudit();
  const normalizedNames = ["homepage-data.json", "transaction-data.json", "traffic-data.json", "customer-data.json"];
  const normalized = await Promise.all(normalizedNames.map(async (name) => ({ name, ...(await fileStatus(path.join(rootDir, "normalized", name))) })));
  const reportFolders = ["reports", "audit"];
  const reportGroups = await Promise.all(reportFolders.map(async (folder) => {
    const entries = await fs.readdir(path.join(rootDir, folder), { withFileTypes: true }).catch(() => []);
    return Promise.all(entries.filter((entry) => entry.isFile() && /审计|验收/.test(entry.name)).map(async (entry) => ({ name: `${folder}/${entry.name}`, ...(await fileStatus(path.join(rootDir, folder, entry.name))) })));
  }));
  const reports = reportGroups.flat();
  const actionExport = await operationsStore.list();
  const history = await diagnosisHistory.list(1);
  const configPath = path.join(rootDir, "config", "shop.json");
  const config = await fs.readFile(configPath, "utf8").then(JSON.parse).catch(() => null);
  return {
    status: "ready",
    generated_at: new Date().toISOString(),
    service: { port, started_at: startedAt.toISOString(), uptime_seconds: Math.floor((Date.now() - startedAt.getTime()) / 1000) },
    data: { ...audit.summary, raw_dir: audit.rawDir, normalized },
    actions: {
      count: actionExport.actions.length,
      open_count: actionExport.actions.filter((item) => !["已完成", "验证有效", "已搁置"].includes(item.status)).length,
      export_updated_at: actionExport.generated_at
    },
    diagnosis: { latest_recorded_at: history[0]?.recorded_at || null, history_available: history.length > 0 },
    reports: reports.sort((a, b) => (b.modified_at || "").localeCompare(a.modified_at || "")),
    shop_config: config || { configured: false, message: "尚未建立店铺标识配置" },
    startup: await fileStatus(path.join(rootDir, "启动生意参谋数据工作台.cmd"))
  };
}

async function sendJson(res, data, status = 200) {
  const body = JSON.stringify(data, null, 2);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store"
  });
  res.end(body);
}

async function sendStatic(req, res) {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const modulePages = new Set(["/transaction.html", "/traffic.html", "/customer.html"]);
  const controlPages = new Set(["/diagnosis.html", "/actions.html", "/audit.html", "/system.html"]);
  const requested = url.pathname === "/"
    ? "/index.html"
    : modulePages.has(url.pathname)
      ? "/module.html"
      : controlPages.has(url.pathname)
        ? "/control.html"
      : decodeURIComponent(url.pathname);
  const target = path.normalize(path.join(publicDir, requested));

  if (target !== publicDir && !target.startsWith(publicDir + path.sep)) {
    res.writeHead(403);
    res.end("Forbidden");
    return;
  }

  try {
    const body = await fs.readFile(target);
    const contentType = mime.get(path.extname(target).toLowerCase()) || "application/octet-stream";
    res.writeHead(200, { "content-type": contentType });
    res.end(body);
  } catch {
    res.writeHead(404);
    res.end("Not found");
  }
}

if (process.argv.includes("--audit")) {
  console.log(JSON.stringify(await buildAudit(), null, 2));
} else {
  const server = createServer(async (req, res) => {
    const requestUrl = new URL(req.url, `http://${req.headers.host}`);
    if (requestUrl.pathname === "/api/audit") {
      await sendJson(res, await buildAudit());
      return;
    }
    if (requestUrl.pathname === "/api/homepage") {
      try {
        await sendJson(
          res,
          await analyzeHomepagePeriod(
            requestUrl.searchParams.get("from"),
            requestUrl.searchParams.get("to")
          )
        );
      } catch (error) {
        console.error("首页数据构建失败", error);
        await sendJson(
          res,
          { status: "error", message: "首页数据解析失败", detail: error.message },
          500
        );
      }
      return;
    }
    if (requestUrl.pathname === "/api/diagnosis") {
      try {
        await sendJson(res, await buildDiagnosis(requestUrl.searchParams.get("from"), requestUrl.searchParams.get("to")));
      } catch (error) {
        console.error("经营诊断生成失败", error);
        await sendJson(res, { status: "error", message: "经营诊断生成失败", detail: error.message }, 500);
      }
      return;
    }
    if (requestUrl.pathname === "/api/diagnosis/history") {
      await sendJson(res, { status: "ready", history: await diagnosisHistory.list(Number(requestUrl.searchParams.get("limit") || 30)) });
      return;
    }
    if (requestUrl.pathname === "/api/actions" && req.method === "GET") {
      await sendJson(res, await operationsStore.list());
      return;
    }
    const actionMatch = requestUrl.pathname.match(/^\/api\/actions\/([a-f0-9]{16})$/);
    if (actionMatch && ["PATCH", "POST"].includes(req.method)) {
      try {
        await sendJson(res, { status: "ready", action: await operationsStore.update(actionMatch[1], await readRequestJson(req)) });
      } catch (error) {
        await sendJson(res, { status: "error", message: error.message }, error.message.includes("不存在") ? 404 : 400);
      }
      return;
    }
    if (requestUrl.pathname === "/api/system") {
      await sendJson(res, await buildSystemStatus());
      return;
    }
    const moduleMatch = requestUrl.pathname.match(/^\/api\/module\/(transaction|traffic|customer)$/);
    if (moduleMatch) {
      try {
        await sendJson(
          res,
          await analyzeModule(
            moduleMatch[1],
            requestUrl.searchParams.get("from"),
            requestUrl.searchParams.get("to")
          )
        );
      } catch (error) {
        console.error(`${moduleMatch[1]} 数据分析失败`, error);
        await sendJson(
          res,
          { status: "error", message: "专题数据解析失败", detail: error.message },
          500
        );
      }
      return;
    }
    await sendStatic(req, res);
  }).listen(port, "127.0.0.1", () => {
    console.log(`生意参谋数据工作台已启动: http://127.0.0.1:${server.address().port}`);
  });
  server.on("error", (error) => {
    if (error.code === "EADDRINUSE") {
      console.error(`端口 ${port} 已被占用。请关闭旧工作台，或在 PowerShell 中设置 $env:PORT = '5178' 后重试。`);
    } else {
      console.error("本地服务启动失败:", error.message);
    }
    process.exitCode = 1;
  });
}
