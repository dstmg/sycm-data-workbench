import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";

function stableId(moduleName, title) {
  return createHash("sha256").update(`${moduleName}|${title}`).digest("hex").slice(0, 16);
}

function metric(result, label) {
  return result?.kpis?.find((item) => item.label === label) || null;
}

function finding(result, matcher) {
  return result?.findings?.find((item) => matcher(item.title)) || null;
}

function evidenceFrom(moduleName, period, item, deepLink) {
  if (!item) return [];
  return [{
    module: moduleName,
    period,
    text: item.verdict,
    source: item.source || null,
    deep_link: deepLink
  }];
}

function actionFor(actions, moduleName, titlePart) {
  return actions.find((item) => item.module === moduleName && item.title.includes(titlePart))
    || actions.find((item) => item.module === moduleName)
    || null;
}

export function buildDiagnosisCenter({ homepage, transaction, traffic, customer, actions }) {
  const issues = [];
  const trafficPeriod = traffic.selection.label;
  const customerPeriod = customer.selection.label;
  const transactionPeriod = transaction.selection.label;
  const homePeriod = homepage.selection.date_from === homepage.selection.date_to
    ? homepage.selection.date_to
    : `${homepage.selection.date_from} 至 ${homepage.selection.date_to}`;

  const trafficConversion = finding(traffic, (title) => title.includes("转化效率"));
  const homeConversionMetric = homepage.kpis?.find((item) => item.label === "支付转化率");
  const homeConversion = homeConversionMetric ? {
    verdict: `首页本店 ${homeConversionMetric.value_label}，同行平均 ${homeConversionMetric.peer_average_label}`,
    source: homeConversionMetric.source
  } : null;
  if (trafficConversion || homeConversion) {
    const action = actionFor(actions, "流量分析", "高流量低转化") || actionFor(actions, "流量", "高流量低转化");
    const trafficKpi = metric(traffic, "支付转化率");
    const amountKpi = metric(traffic, "支付金额");
    const peerAverage = trafficKpi?.benchmark?.average;
    const current = trafficKpi?.value;
    const estimated = current && peerAverage && peerAverage > current
      ? (amountKpi?.value || 0) * (peerAverage / current - 1)
      : null;
    issues.push({
      id: stableId("流量", "转化效率低于同行"),
      module: "流量",
      severity: "critical",
      confidence: trafficConversion && homeConversion ? "已确认" : "高概率",
      title: "流量增长没有同步转成成交效率",
      judgment: trafficConversion?.verdict || homeConversion?.verdict,
      impact: estimated
        ? `按当前支付金额与同行平均转化率静态测算，存在约 ¥${estimated.toLocaleString("zh-CN", { maximumFractionDigits: 2 })} 的效率差额；仅用于确定排查优先级。`
        : trafficConversion?.impact || "当前文件不足以可靠估算金额影响。",
      evidence: [
        ...evidenceFrom("流量", trafficPeriod, trafficConversion, `/traffic.html?from=${traffic.selection.date_from}&to=${traffic.selection.date_to}#detail`),
        ...(homeConversion ? [{ module: "首页", period: homePeriod, text: homeConversion.verdict, source: homeConversion.source || null, deep_link: `/?from=${homepage.selection.date_from}&to=${homepage.selection.date_to}` }] : [])
      ],
      action
    });
  }

  const leafFinding = traffic.findings?.find((item) => item.title.includes("高流量低转化") || item.title.includes("转化效率最低"));
  if (leafFinding) {
    const action = actionFor(actions, "流量分析", "高流量低转化") || actionFor(actions, "流量", "高流量低转化");
    issues.push({
      id: stableId("流量", "来源下钻机会"),
      module: "流量",
      severity: leafFinding.severity || "warning",
      confidence: "已确认",
      title: leafFinding.title,
      judgment: leafFinding.verdict,
      impact: leafFinding.impact,
      evidence: evidenceFrom("流量", trafficPeriod, leafFinding, `/traffic.html?from=${traffic.selection.date_from}&to=${traffic.selection.date_to}#detail`),
      action
    });
  }

  const recallFinding = finding(customer, (title) => title.includes("召回率"));
  if (recallFinding) {
    const action = actionFor(actions, "客户分析", "召回") || actionFor(actions, "客户", "召回");
    issues.push({
      id: stableId("客户", "老客召回不足"),
      module: "客户",
      severity: recallFinding.severity || "warning",
      confidence: "已确认",
      title: "老客召回能力明显落后于同行优秀值",
      judgment: recallFinding.verdict,
      impact: recallFinding.impact || "将影响复购规模与获客成本摊薄能力。",
      evidence: evidenceFrom("客户", customerPeriod, recallFinding, `/customer.html?from=${customer.selection.date_from}&to=${customer.selection.date_to}`),
      action
    });
  }

  const priceFinding = finding(transaction, (title) => title.includes("价格带") || title.includes("低价"));
  if (priceFinding) {
    const action = actionFor(actions, "交易分析", "价格") || actionFor(actions, "交易", "价格");
    issues.push({
      id: stableId("交易", "价格带集中"),
      module: "交易",
      severity: priceFinding.severity || "warning",
      confidence: transaction.coverage.date_end < homepage.selection.date_to ? "历史证据" : "已确认",
      title: priceFinding.title,
      judgment: priceFinding.verdict,
      impact: priceFinding.impact || "价格结构可能压低客单价，需结合商品明细进一步验证。",
      evidence: evidenceFrom("交易", transactionPeriod, priceFinding, `/transaction.html?from=${transaction.selection.date_from}&to=${transaction.selection.date_to}`),
      action
    });
  }

  if (transaction.coverage.date_end < homepage.selection.date_to) {
    issues.push({
      id: stableId("数据质量", "交易明细滞后"),
      module: "数据质量",
      severity: "warning",
      confidence: "数据缺口",
      title: "交易明细更新晚于首页、流量和客户",
      judgment: `交易明细仅覆盖至 ${transaction.coverage.date_end}，当前首页已到 ${homepage.selection.date_to}。`,
      impact: "最新经营判断无法用同期交易价格带、订单与退款明细交叉验证。",
      evidence: [{ module: "交易", period: transactionPeriod, text: `真实文件覆盖 ${transaction.coverage.date_start} 至 ${transaction.coverage.date_end}`, source: null, deep_link: "/audit.html" }],
      action: actionFor(actions, "交易分析", "下载") || null
    });
  }

  const order = { critical: 0, warning: 1, neutral: 2, positive: 3 };
  issues.sort((a, b) => (order[a.severity] ?? 9) - (order[b.severity] ?? 9));
  return {
    status: "ready",
    generated_at: new Date().toISOString(),
    selection: homepage.selection,
    summary: {
      issue_count: issues.length,
      critical_count: issues.filter((item) => item.severity === "critical").length,
      confirmed_count: issues.filter((item) => item.confidence === "已确认").length,
      open_action_count: actions.filter((item) => !["已完成", "验证有效", "已搁置"].includes(item.status)).length
    },
    issues,
    caliber: "诊断由当前真实导出文件自动生成；跨模块证据周期不一致时会明确标记，不强行合并口径。"
  };
}

export class DiagnosisHistory {
  constructor(rootDir) {
    this.filePath = path.join(rootDir, "reports", "diagnosis-history.jsonl");
  }

  async list(limit = 30) {
    const content = await fs.readFile(this.filePath, "utf8").catch(() => "");
    return content.split(/\r?\n/).filter(Boolean).slice(-limit).reverse().map((line) => JSON.parse(line));
  }

  async appendIfChanged(diagnosis) {
    await fs.mkdir(path.dirname(this.filePath), { recursive: true });
    const signature = createHash("sha256").update(JSON.stringify(diagnosis.issues.map((item) => ({
      id: item.id,
      severity: item.severity,
      confidence: item.confidence,
      judgment: item.judgment,
      action_status: item.action?.status || null
    })))).digest("hex").slice(0, 20);
    const latest = (await this.list(1))[0];
    if (latest?.signature === signature) return latest;
    const entry = {
      recorded_at: new Date().toISOString(),
      signature,
      selection: diagnosis.selection,
      summary: diagnosis.summary,
      issues: diagnosis.issues.map((item) => ({ id: item.id, module: item.module, severity: item.severity, confidence: item.confidence, title: item.title, judgment: item.judgment }))
    };
    await fs.appendFile(this.filePath, `${JSON.stringify(entry)}\n`, "utf8");
    return entry;
  }
}
