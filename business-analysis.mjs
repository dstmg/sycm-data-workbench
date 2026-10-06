import { promises as fs } from "node:fs";
import path from "node:path";

const MODULE_FILES = {
  transaction: "transaction-data.json",
  traffic: "traffic-data.json",
  customer: "customer-data.json"
};

const cache = new Map();

const asNumber = (value) => {
  if (value == null || value === "") return null;
  const parsed = Number(String(value).replaceAll(",", "").replaceAll("%", ""));
  return Number.isFinite(parsed) ? parsed : null;
};

const average = (values) => {
  const valid = values.filter((value) => value != null && Number.isFinite(value));
  return valid.length ? valid.reduce((sum, value) => sum + value, 0) / valid.length : null;
};

const sum = (values) => values.reduce((total, value) => total + (asNumber(value) ?? 0), 0);
const round = (value, digits = 2) => value == null ? null : Number(value.toFixed(digits));
const money = (value) => value == null ? "无数据" : `¥${Number(value).toLocaleString("zh-CN", { maximumFractionDigits: 2 })}`;
const integer = (value) => value == null ? "无数据" : Math.round(value).toLocaleString("zh-CN");
const percent = (value) => value == null ? "无数据" : `${Number(value).toFixed(2)}%`;
const decimal = (value) => value == null ? "无数据" : Number(value).toLocaleString("zh-CN", { maximumFractionDigits: 2 });

function dateParts(range) {
  const [from, to] = String(range || "").split("|");
  return { from, to: to || from };
}

function isoDate(value) {
  return /^\d{4}-\d{2}-\d{2}$/.test(value || "") ? value : null;
}

function daysBetween(from, to) {
  return Math.round((new Date(`${to}T00:00:00`) - new Date(`${from}T00:00:00`)) / 86400000) + 1;
}

function shiftDate(value, days) {
  const date = new Date(`${value}T00:00:00`);
  date.setDate(date.getDate() + days);
  return date.toLocaleDateString("en-CA");
}

function clamp(value, min, max) {
  return value < min ? min : value > max ? max : value;
}

function field(dataset, record, column) {
  return record?.values?.[column - 1] ?? null;
}

function source(dataset, record, column, caliber) {
  const schema = dataset.schema.find((item) => item.column === column);
  return {
    archive_file: dataset.archive_file,
    workbook_file: record?.workbook_file || null,
    sheet: dataset.sheet,
    row: record?.row || null,
    column,
    field: schema?.display_name || schema?.header || `第 ${column} 列`,
    raw_value: record ? field(dataset, record, column) : null,
    caliber
  };
}

function sourceSummary(dataset, caliber) {
  return {
    archive_file: dataset.archive_file,
    sheet: dataset.sheet,
    record_count: dataset.records.length,
    workbook_count: dataset.workbook_count,
    caliber
  };
}

function change(current, previous) {
  if (current == null || previous == null || previous === 0) return null;
  return ((current - previous) / Math.abs(previous)) * 100;
}

function changeLabel(value) {
  if (value == null) return "无可比周期";
  const sign = value > 0 ? "+" : "";
  return `${sign}${value.toFixed(2)}%`;
}

function severityFor(value, inverse = false) {
  if (value == null || Math.abs(value) < 3) return "neutral";
  const isGood = inverse ? value < 0 : value > 0;
  return isGood ? "positive" : Math.abs(value) >= 15 ? "critical" : "warning";
}

function uniqueRanges(dataset) {
  return [...new Set(dataset.records.map((record) => record.date_range).filter(Boolean))]
    .map((range) => ({ range, ...dateParts(range) }))
    .filter((item) => isoDate(item.from) && isoDate(item.to))
    .sort((a, b) => a.to.localeCompare(b.to));
}

function chooseSnapshot(dataset, requestedFrom, requestedTo) {
  const ranges = uniqueRanges(dataset);
  const latest = ranges.at(-1);
  if (!latest) return null;
  if (!requestedFrom || !requestedTo) return { ...latest, mode: "latest", requestedFrom: latest.from, requestedTo: latest.to };

  const exact = ranges.find((item) => item.from === requestedFrom && item.to === requestedTo);
  if (exact) return { ...exact, mode: "exact", requestedFrom, requestedTo };

  const containing = ranges
    .filter((item) => item.from <= requestedFrom && item.to >= requestedTo)
    .sort((a, b) => daysBetween(a.from, a.to) - daysBetween(b.from, b.to))[0];
  if (containing) return { ...containing, mode: "contained", requestedFrom, requestedTo };

  const overlap = ranges
    .map((item) => ({ ...item, overlap: Math.max(0, Math.min(new Date(item.to), new Date(requestedTo)) - Math.max(new Date(item.from), new Date(requestedFrom))) }))
    .sort((a, b) => b.overlap - a.overlap || b.to.localeCompare(a.to))[0];
  if (overlap?.overlap > 0) return { ...overlap, mode: "overlap", requestedFrom, requestedTo };

  const prior = ranges.filter((item) => item.to <= requestedTo).at(-1) || latest;
  return { ...prior, mode: "nearest", requestedFrom, requestedTo };
}

function selectionForSnapshot(snapshot, label) {
  const mapped = snapshot.mode !== "exact" && snapshot.mode !== "latest";
  return {
    requested_from: snapshot.requestedFrom,
    requested_to: snapshot.requestedTo,
    date_from: snapshot.from,
    date_to: snapshot.to,
    day_count: daysBetween(snapshot.from, snapshot.to),
    mode: mapped ? "native_snapshot_mapped" : "native_snapshot",
    label: `${snapshot.from} 至 ${snapshot.to}`,
    note: mapped
      ? `所选日期没有独立日数据，已映射到${label}原生周期 ${snapshot.from} 至 ${snapshot.to}`
      : `${label}使用平台原生周期口径，不拆分或补齐日数据`
  };
}

async function loadModule(rootDir, moduleName) {
  const filePath = path.join(rootDir, "normalized", MODULE_FILES[moduleName]);
  const stat = await fs.stat(filePath);
  const existing = cache.get(moduleName);
  if (existing?.mtimeMs === stat.mtimeMs) return existing.data;
  const data = JSON.parse(await fs.readFile(filePath, "utf8"));
  cache.set(moduleName, { mtimeMs: stat.mtimeMs, data });
  return data;
}

function datasetMap(data) {
  return new Map(data.datasets.map((dataset) => [dataset.id, dataset]));
}

function baseResult(data, moduleName, title, selection, sources) {
  return {
    status: "ready",
    module: moduleName,
    title,
    generated_at: data.generated_at,
    coverage: data.quality,
    selection,
    kpis: [],
    findings: [],
    actions: [],
    trend: { labels: [], series: [], caliber: "" },
    composition: { title: "结构分析", rows: [], caliber: "" },
    secondary: { title: "补充分析", rows: [], caliber: "" },
    detail: { title: "数据明细", columns: [], rows: [] },
    sources
  };
}

function aggregateTransaction(records, overview) {
  return {
    payment: sum(records.map((record) => field(overview, record, 16))),
    visitors: average(records.map((record) => asNumber(field(overview, record, 8)))),
    orderBuyers: average(records.map((record) => asNumber(field(overview, record, 10)))),
    payBuyers: average(records.map((record) => asNumber(field(overview, record, 14)))),
    aov: average(records.map((record) => asNumber(field(overview, record, 18)))),
    orderConversion: average(records.map((record) => asNumber(field(overview, record, 20)))),
    payConversion: average(records.map((record) => asNumber(field(overview, record, 22)))),
    newBuyers: average(records.map((record) => asNumber(field(overview, record, 25)))),
    oldBuyers: average(records.map((record) => asNumber(field(overview, record, 26))))
  };
}

function aggregateRows(dataset, records, labelColumn, valueColumn, extras = []) {
  const groups = new Map();
  for (const record of records) {
    const label = String(field(dataset, record, labelColumn) || "未标记");
    const current = groups.get(label) || { label, value: 0, records: [], extras: Object.fromEntries(extras.map((item) => [item.key, []])) };
    current.value += asNumber(field(dataset, record, valueColumn)) ?? 0;
    current.records.push(record);
    for (const item of extras) current.extras[item.key].push(asNumber(field(dataset, record, item.column)));
    groups.set(label, current);
  }
  return [...groups.values()]
    .map((item) => ({
      label: item.label,
      value: round(item.value),
      ...Object.fromEntries(extras.map((extra) => [extra.key, round(extra.aggregate === "sum" ? sum(item.extras[extra.key]) : average(item.extras[extra.key]))]))
    }))
    .sort((a, b) => b.value - a.value);
}

function analyzeTransaction(data, requestedFrom, requestedTo) {
  const datasets = datasetMap(data);
  const overview = datasets.get("ca89512a530cbaa6");
  const price = datasets.get("c8b79dae8e1c9c0f");
  const terminal = datasets.get("017baa69f522e7d6");
  const category = datasets.get("65adeeb8a96af922");
  const brand = datasets.get("238a8d766d802daf");
  const availableFrom = data.quality.date_start;
  const availableTo = data.quality.date_end;
  let dateTo = clamp(requestedTo || availableTo, availableFrom, availableTo);
  let dateFrom = clamp(requestedFrom || shiftDate(dateTo, -29), availableFrom, dateTo);
  if (dateFrom > dateTo) [dateFrom, dateTo] = [dateTo, dateFrom];
  const selected = overview.records.filter((record) => {
    const date = dateParts(record.date_range).from;
    return date >= dateFrom && date <= dateTo;
  }).sort((a, b) => dateParts(a.date_range).from.localeCompare(dateParts(b.date_range).from));
  const dayCount = Math.max(1, selected.length);
  const previousTo = shiftDate(dateFrom, -1);
  const previousFrom = shiftDate(previousTo, -(dayCount - 1));
  const previousRows = overview.records.filter((record) => {
    const date = dateParts(record.date_range).from;
    return date >= previousFrom && date <= previousTo;
  });
  const current = aggregateTransaction(selected, overview);
  const previous = previousRows.length === dayCount ? aggregateTransaction(previousRows, overview) : null;
  const paymentChange = change(current.payment, previous?.payment);
  const conversionChange = change(current.payConversion, previous?.payConversion);
  const latestRecord = selected.at(-1);
  const selection = {
    requested_from: requestedFrom || dateFrom,
    requested_to: requestedTo || dateTo,
    date_from: dateFrom,
    date_to: dateTo,
    day_count: dayCount,
    mode: "daily",
    label: dateFrom === dateTo ? dateTo : `${dateFrom} 至 ${dateTo}`,
    note: dayCount === 1 ? "单日使用原始导出值" : "支付金额求和；人数、比例与客单价为日均，不将跨日人数冒充去重人数"
  };
  const result = baseResult(data, "transaction", "交易分析", selection, [
    sourceSummary(overview, "交易日数据"),
    sourceSummary(price, "价格带日数据"),
    sourceSummary(terminal, "终端日数据"),
    sourceSummary(category, "叶子类目月度数据"),
    sourceSummary(brand, "品牌日数据")
  ]);

  result.kpis = [
    { label: "支付金额", value: round(current.payment), value_label: money(current.payment), comparison_change: round(paymentChange), comparison_label: changeLabel(paymentChange), source: source(overview, latestRecord, 16, selection.note) },
    { label: dayCount === 1 ? "访客数" : "日均访客数", value: round(current.visitors), value_label: integer(current.visitors), comparison_change: round(change(current.visitors, previous?.visitors)), comparison_label: changeLabel(change(current.visitors, previous?.visitors)), source: source(overview, latestRecord, 8, selection.note) },
    { label: dayCount === 1 ? "支付转化率" : "日均支付转化率", value: round(current.payConversion), value_label: percent(current.payConversion), comparison_change: round(conversionChange), comparison_label: changeLabel(conversionChange), source: source(overview, latestRecord, 22, selection.note) },
    { label: dayCount === 1 ? "客单价" : "日均客单价", value: round(current.aov), value_label: money(current.aov), comparison_change: round(change(current.aov, previous?.aov)), comparison_label: changeLabel(change(current.aov, previous?.aov)), source: source(overview, latestRecord, 18, selection.note) }
  ];

  const priceRows = price.records.filter((record) => {
    const date = dateParts(record.date_range).from;
    return date >= dateFrom && date <= dateTo;
  });
  const priceGroups = aggregateRows(price, priceRows, 9, 12, [{ key: "buyers", column: 11, aggregate: "sum" }, { key: "conversion", column: 13 }]);
  const priceTotal = sum(priceGroups.map((item) => item.value));
  result.composition = {
    title: "价格带支付贡献",
    metric: "支付金额",
    rows: priceGroups.map((item) => ({ ...item, value_label: money(item.value), share: priceTotal ? round(item.value / priceTotal * 100) : null, share_label: priceTotal ? percent(item.value / priceTotal * 100) : "无数据", conversion_label: percent(item.conversion) })),
    caliber: "所选日期内各价格带支付金额求和；占比按本表价格带金额合计计算",
    source: source(price, priceRows.at(-1), 12, "价格带支付金额按日求和")
  };

  const terminalRows = terminal.records.filter((record) => {
    const date = dateParts(record.date_range).from;
    return date >= dateFrom && date <= dateTo;
  });
  result.secondary = {
    title: "终端构成",
    rows: aggregateRows(terminal, terminalRows, 7, 8, [{ key: "buyers", column: 11, aggregate: "sum" }, { key: "conversion", column: 12 }]).map((item) => ({ ...item, value_label: money(item.value), conversion_label: percent(item.conversion) })),
    caliber: "支付金额与买家人次按日求和，支付转化率为日均",
    source: source(terminal, terminalRows.at(-1), 8, "终端支付金额按日求和")
  };

  const categorySnapshot = chooseSnapshot(category, dateFrom, dateTo);
  const categoryRows = categorySnapshot ? category.records.filter((record) => record.date_range === categorySnapshot.range) : [];
  const categoryTop = categoryRows
    .map((record) => ({ label: field(category, record, 11), value: asNumber(field(category, record, 12)), value_label: money(asNumber(field(category, record, 12))), share_label: String(field(category, record, 14) ?? "无数据"), conversion_label: String(field(category, record, 18) ?? "无数据") }))
    .sort((a, b) => (b.value ?? 0) - (a.value ?? 0)).slice(0, 8);
  const topPrice = result.composition.rows[0];
  const topCategory = categoryTop[0];
  const conversionImpact = previous && previous.payConversion > current.payConversion
    ? current.visitors * dayCount * ((previous.payConversion - current.payConversion) / 100) * current.aov
    : 0;
  result.findings = [
    {
      severity: severityFor(paymentChange),
      title: `支付金额${paymentChange == null ? "等待可比周期" : paymentChange >= 0 ? "增长" : "回落"}`,
      verdict: previous ? `所选周期支付金额 ${money(current.payment)}，较前一等长周期 ${changeLabel(paymentChange)}` : `所选周期支付金额 ${money(current.payment)}，前序完整周期不足`,
      evidence: [`${dayCount} 天金额求和`, `日均支付买家数 ${integer(current.payBuyers)}`, `日均客单价 ${money(current.aov)}`],
      impact: conversionImpact > 0 ? `若转化恢复到前期日均水平，静态影响估算约 ${money(conversionImpact)}` : "当前不生成正向影响估算",
      source: source(overview, latestRecord, 16, selection.note)
    },
    {
      severity: severityFor(conversionChange),
      title: `支付转化率${conversionChange == null ? "缺少完整对照" : conversionChange >= 0 ? "改善" : "承压"}`,
      verdict: `当前日均 ${percent(current.payConversion)}${previous ? `，前期日均 ${percent(previous.payConversion)}` : ""}`,
      evidence: [`日均访客 ${integer(current.visitors)}`, `日均下单买家 ${integer(current.orderBuyers)}`, `日均支付买家 ${integer(current.payBuyers)}`],
      impact: "该判断只说明同步变化，不直接认定因果",
      source: source(overview, latestRecord, 22, "跨日为日均支付转化率")
    },
    {
      severity: topPrice?.share >= 65 ? "warning" : "neutral",
      title: topPrice ? `${topPrice.label}贡献最高` : "等待价格带数据",
      verdict: topPrice ? `${topPrice.label}占所选周期价格带支付金额 ${topPrice.share_label}` : "所选周期没有价格带记录",
      evidence: [topCategory ? `月度叶子类目首位：${topCategory.label}，${topCategory.value_label}` : "类目数据仅提供月度快照", `类目快照：${categorySnapshot ? `${categorySnapshot.from} 至 ${categorySnapshot.to}` : "无"}`],
      impact: "高集中度意味着主力价格带波动会放大整体结果",
      source: result.composition.source
    }
  ];
  result.actions = [
    { priority: paymentChange != null && paymentChange < -10 ? "高" : "中", title: "核查支付金额变化来源", reason: "先拆访客、转化与客单价，避免只看总额下结论", target_module: "交易", status: "待处理" },
    { priority: conversionChange != null && conversionChange < -5 ? "高" : "中", title: "定位下单到支付流失", reason: `下单转化 ${percent(current.orderConversion)}，支付转化 ${percent(current.payConversion)}`, target_module: "交易", status: "待处理" },
    { priority: topPrice?.share >= 65 ? "中" : "低", title: "复核主力价格带承接", reason: topPrice ? `${topPrice.label}为当前最高支付贡献价格带` : "等待价格带记录", target_module: "交易", status: "待处理" }
  ];
  result.trend = {
    labels: selected.map((record) => dateParts(record.date_range).from),
    series: [{ label: "支付金额", data: selected.map((record) => asNumber(field(overview, record, 16))) }],
    caliber: "每日支付金额原始值",
    source: source(overview, latestRecord, 16, "每日原始值")
  };
  result.detail = {
    title: "交易日明细",
    columns: ["日期", "访客数", "下单买家", "支付买家", "支付金额", "支付转化率", "来源工作簿"],
    rows: selected.slice(-15).reverse().map((record) => [dateParts(record.date_range).from, integer(asNumber(field(overview, record, 8))), integer(asNumber(field(overview, record, 10))), integer(asNumber(field(overview, record, 14))), money(asNumber(field(overview, record, 16))), String(field(overview, record, 22) ?? "无数据"), record.workbook_file]),
    note: categoryTop.length ? `类目月度快照首位：${topCategory.label} ${topCategory.value_label}` : "所选周期没有可关联的类目月度快照"
  };
  return result;
}

function snapshotRecord(dataset, range) {
  return dataset.records.find((record) => record.date_range === range);
}

function previousSnapshot(dataset, range) {
  const ranges = uniqueRanges(dataset);
  const index = ranges.findIndex((item) => item.range === range);
  return index > 0 ? snapshotRecord(dataset, ranges[index - 1].range) : null;
}

function analyzeTraffic(data, requestedFrom, requestedTo) {
  const datasets = datasetMap(data);
  const overview = datasets.get("78cc19d068bdce3b");
  const sourceChannels = datasets.get("ec640f4fba2dd9bd");
  const productOverview = datasets.get("a83c59c0261cf18e");
  const shopOverview = datasets.get("4601607d9cdf23b7");
  const conversionOverview = datasets.get("c1fdd7ece796557a");
  const conversionTrend = datasets.get("47e00eb5837eb742");
  const trafficTrend = datasets.get("723b3580125f8922");
  const hourDaily = datasets.get("182eba0f5f4ac6fb");
  const hourSnapshot = datasets.get("89f2390d17e3fdfb");
  const snapshot = chooseSnapshot(conversionOverview, requestedFrom, requestedTo);
  const selection = selectionForSnapshot(snapshot, "流量");
  const result = baseResult(data, "traffic", "流量分析", selection, [
    sourceSummary(overview, "流量类型平台原生周期"),
    sourceSummary(sourceChannels, "全店来源渠道平台原生周期"),
    sourceSummary(conversionOverview, "流量转化平台原生周期"),
    sourceSummary(hourDaily, "2026-07-17 至 2026-08-15 日级时段数据")
  ]);
  const overviewRows = overview.records.filter((record) => record.date_range === snapshot.range);
  const fullTraffic = overviewRows.find((record) => field(overview, record, 7) === "全店流量");
  const product = snapshotRecord(productOverview, snapshot.range);
  const shop = snapshotRecord(shopOverview, snapshot.range);
  const conversion = snapshotRecord(conversionOverview, snapshot.range);
  const previousConversion = previousSnapshot(conversionOverview, snapshot.range);
  const trafficValue = asNumber(field(overview, fullTraffic, 8));
  const trafficChange = asNumber(field(overview, fullTraffic, 9));
  const paymentValue = asNumber(field(conversionOverview, conversion, 11));
  const paymentPrevious = asNumber(field(conversionOverview, previousConversion, 11));
  const conversionValue = asNumber(field(conversionOverview, conversion, 12));
  const conversionPrevious = asNumber(field(conversionOverview, previousConversion, 12));
  result.kpis = [
    { label: "全店流量", value: trafficValue, value_label: integer(trafficValue), comparison_change: trafficChange, comparison_label: changeLabel(trafficChange), benchmark: { average: asNumber(field(overview, fullTraffic, 10)), excellent: asNumber(field(overview, fullTraffic, 11)) }, source: source(overview, fullTraffic, 8, selection.note) },
    { label: "访问商品访客数", value: asNumber(field(productOverview, product, 10)), value_label: integer(asNumber(field(productOverview, product, 10))), comparison_change: null, comparison_label: "平台未提供本字段环比", source: source(productOverview, product, 10, selection.note) },
    { label: "支付金额", value: paymentValue, value_label: money(paymentValue), comparison_change: round(change(paymentValue, paymentPrevious)), comparison_label: previousConversion ? `较相邻已导出周期 ${changeLabel(change(paymentValue, paymentPrevious))}` : "无相邻快照", source: source(conversionOverview, conversion, 11, selection.note) },
    { label: "支付转化率", value: conversionValue, value_label: percent(conversionValue), comparison_change: round(change(conversionValue, conversionPrevious)), comparison_label: previousConversion ? `较相邻已导出周期 ${changeLabel(change(conversionValue, conversionPrevious))}` : "无相邻快照", source: source(conversionOverview, conversion, 12, selection.note) }
  ];

  const channelRecords = sourceChannels.records.filter((record) => record.date_range === snapshot.range && field(sourceChannels, record, 7) === "整体" && field(sourceChannels, record, 8) && !field(sourceChannels, record, 9) && !field(sourceChannels, record, 10));
  const channelRows = channelRecords.map((record) => ({
    label: field(sourceChannels, record, 8),
    value: asNumber(field(sourceChannels, record, 12)),
    buyers: asNumber(field(sourceChannels, record, 14)),
    amount: asNumber(field(sourceChannels, record, 15)),
    conversion: asNumber(field(sourceChannels, record, 16)),
    value_label: integer(asNumber(field(sourceChannels, record, 12))),
    amount_label: money(asNumber(field(sourceChannels, record, 15))),
    conversion_label: percent(asNumber(field(sourceChannels, record, 16))),
    record
  })).sort((a, b) => (b.value ?? 0) - (a.value ?? 0));
  const channelTotal = sum(channelRows.map((item) => item.value));
  const hierarchyRecords = sourceChannels.records.filter((record) => record.date_range === snapshot.range && field(sourceChannels, record, 7) === "整体" && field(sourceChannels, record, 8));
  const recordPath = (record) => [field(sourceChannels, record, 8), field(sourceChannels, record, 9), field(sourceChannels, record, 10)].filter(Boolean);
  const leafRecords = hierarchyRecords.filter((record) => {
    const currentPath = recordPath(record);
    if (currentPath.length < 2) return false;
    return !hierarchyRecords.some((candidate) => {
      const candidatePath = recordPath(candidate);
      return candidatePath.length > currentPath.length && currentPath.every((part, index) => candidatePath[index] === part);
    });
  });
  const leafRows = leafRecords.map((record) => {
    const parts = recordPath(record);
    const visitors = asNumber(field(sourceChannels, record, 12));
    const leafConversion = asNumber(field(sourceChannels, record, 16));
    return {
      label: parts.join(" / "),
      level_1: parts[0],
      level_2: parts[1] || null,
      level_3: parts[2] || null,
      row: record.row,
      value: visitors,
      buyers: asNumber(field(sourceChannels, record, 14)),
      amount: asNumber(field(sourceChannels, record, 15)),
      conversion: leafConversion,
      value_label: integer(visitors),
      amount_label: money(asNumber(field(sourceChannels, record, 15))),
      conversion_label: percent(leafConversion),
      opportunity: visitors && leafConversion != null && conversionValue > leafConversion
        ? visitors * ((conversionValue - leafConversion) / 100) * (asNumber(field(conversionOverview, conversion, 16)) || 0)
        : 0,
      record
    };
  }).sort((a, b) => (b.value ?? 0) - (a.value ?? 0));
  result.composition = {
    title: "一级流量来源结构",
    metric: "访客数",
    rows: channelRows.map((item) => ({ ...item, share: channelTotal ? round(item.value / channelTotal * 100) : null, share_label: channelTotal ? percent(item.value / channelTotal * 100) : "无数据" })),
    caliber: "仅取全店流量、整体客户类型、二级与三级来源为空的一级来源汇总行，避免层级重复相加",
    source: source(sourceChannels, channelRecords[0], 12, "一级来源汇总行访客数")
  };

  const withinHourlyCoverage = selection.date_from >= "2026-07-17" && selection.date_to <= "2026-08-15";
  const hourlyRecords = withinHourlyCoverage
    ? hourDaily.records.filter((record) => {
      const date = dateParts(record.date_range).from;
      return date >= (requestedFrom || selection.date_from) && date <= (requestedTo || selection.date_to);
    })
    : snapshot.range === "2026-07-17|2026-08-15" ? hourSnapshot.records : [];
  result.secondary = {
    title: "时段质量",
    rows: aggregateRows(withinHourlyCoverage ? hourDaily : hourSnapshot, hourlyRecords, 8, 9, [{ key: "buyers", column: 10, aggregate: "sum" }, { key: "conversion", column: 11 }]).map((item) => ({ ...item, value_label: integer(item.value), conversion_label: percent(item.conversion) })),
    caliber: hourlyRecords.length ? (withinHourlyCoverage ? "所选日期内每小时访客与下单买家求和，转化率为日均" : "近30天平台原生时段快照") : "当前周期没有对应时段明细；不借用其他周期数据",
    source: hourlyRecords.length ? source(withinHourlyCoverage ? hourDaily : hourSnapshot, hourlyRecords.at(-1), 9, "时段访客数") : null
  };

  let trendRows = conversionTrend.records.filter((record) => record.date_range === snapshot.range && field(conversionTrend, record, 9) === "我的");
  trendRows = trendRows.sort((a, b) => String(field(conversionTrend, a, 8)).localeCompare(String(field(conversionTrend, b, 8))));
  result.trend = {
    labels: trendRows.map((record) => field(conversionTrend, record, 8)),
    series: [
      { label: "支付金额", data: trendRows.map((record) => asNumber(field(conversionTrend, record, 11))) },
      { label: "支付转化率", data: trendRows.map((record) => asNumber(field(conversionTrend, record, 12))), axis: "percent" }
    ],
    caliber: snapshot.range === "2026-07-17|2026-08-15" ? "近30天日趋势" : "所选月度快照附带的12个月趋势",
    source: source(conversionTrend, trendRows.at(-1), 11, "平台原生趋势")
  };

  const peerRows = conversionTrend.records.filter((record) => record.date_range === snapshot.range && field(conversionTrend, record, 9) === "同行同层平均");
  const peerConversion = average(peerRows.map((record) => asNumber(field(conversionTrend, record, 12))));
  const topChannel = channelRows[0];
  const lowQuality = leafRows
    .filter((item) => item.value >= Math.max(500, channelTotal * 0.002) && item.conversion != null && item.conversion < conversionValue)
    .sort((a, b) => b.opportunity - a.opportunity)[0];
  const aov = asNumber(field(conversionOverview, conversion, 16));
  const opportunity = lowQuality && conversionValue > lowQuality.conversion
    ? lowQuality.value * ((conversionValue - lowQuality.conversion) / 100) * (aov || 0)
    : 0;
  result.findings = [
    {
      severity: severityFor(trafficChange),
      title: `全店流量${trafficChange == null ? "缺少环比" : trafficChange >= 0 ? "增长" : "回落"}`,
      verdict: `${integer(trafficValue)}，平台原生较上一周期 ${changeLabel(trafficChange)}`,
      evidence: [`访问商品访客 ${integer(asNumber(field(productOverview, product, 10)))}`, `访问店铺访客 ${integer(asNumber(field(shopOverview, shop, 10)))}`, `同行同层平均 ${integer(asNumber(field(overview, fullTraffic, 10)))}`],
      impact: "流量量级变化需与支付转化同步判断",
      source: source(overview, fullTraffic, 8, selection.note)
    },
    {
      severity: peerConversion != null && conversionValue < peerConversion ? "critical" : "neutral",
      title: peerConversion != null && conversionValue < peerConversion ? "转化效率低于同行均值" : "转化效率暂未落后同行均值",
      verdict: `本店 ${percent(conversionValue)}，同行日/月趋势均值 ${percent(peerConversion)}`,
      evidence: [`支付买家 ${integer(asNumber(field(conversionOverview, conversion, 10)))}`, `UV价值 ${money(asNumber(field(conversionOverview, conversion, 15)))}`, `客单价 ${money(aov)}`],
      impact: "同行值仅作平台基准，不等于可直接实现目标",
      source: source(conversionOverview, conversion, 12, selection.note)
    },
    {
      severity: lowQuality && lowQuality.value > channelTotal * 0.1 ? "critical" : lowQuality ? "warning" : "neutral",
      title: lowQuality ? `${lowQuality.label}存在高流量低转化` : "等待渠道结构记录",
      verdict: lowQuality ? `${integer(lowQuality.value)} 访客，支付转化率 ${percent(lowQuality.conversion)}` : "当前周期无一级渠道汇总行",
      evidence: [topChannel ? `其一级来源 ${lowQuality?.level_1 || topChannel.label}；全店最大一级来源为 ${topChannel.label}` : "无最大来源", `筛选口径：整体客户、最深可用二级/三级来源，原始第 ${lowQuality?.row || "-"} 行`],
      impact: opportunity > 0 ? `按整体转化率静态测算的差额约 ${money(opportunity)}，只用于排查优先级` : "当前不生成渠道机会金额",
      source: lowQuality ? source(sourceChannels, lowQuality.record, 16, "整体客户类型下最深可用来源层级的支付转化率；以原始行位置区分同名路径") : result.composition.source
    }
  ];
  result.actions = [
    { priority: peerConversion != null && conversionValue < peerConversion ? "高" : "中", title: "优先排查高流量低转化来源", reason: lowQuality ? `${lowQuality.label}量级 ${integer(lowQuality.value)}、转化 ${percent(lowQuality.conversion)}` : "等待一级来源汇总", target_module: "流量", status: "待处理" },
    { priority: trafficChange != null && trafficChange < -10 ? "高" : "中", title: "核查全店流量变动", reason: `平台原生环比 ${changeLabel(trafficChange)}`, target_module: "流量", status: "待处理" },
    { priority: hourlyRecords.length ? "中" : "低", title: "安排高效时段承接", reason: hourlyRecords.length ? "根据真实时段访客与下单转化配置客服、直播和促销" : "需补充当前周期时段数据", target_module: "流量", status: "待处理" }
  ];
  result.detail = {
    title: "可执行来源下钻",
    columns: ["来源路径", "原始行", "访客数", "支付买家", "支付金额", "支付转化率", "来源工作簿"],
    rows: leafRows.slice(0, 20).map((item) => [item.label, item.row, item.value_label, integer(item.buyers), item.amount_label, item.conversion_label, item.record.workbook_file]),
    note: `${selection.note}；仅列二级/三级最深可用来源行，不与父级汇总重复相加`
  };
  result.drilldown = {
    title: "二级/三级来源机会",
    rows: leafRows.slice(0, 20).map((item) => ({ label: item.label, row: item.row, visitors: item.value, conversion: item.conversion, amount: item.amount, opportunity: round(item.opportunity) })),
    caliber: "按原始行位置保留同名来源；机会金额只用于排查优先级"
  };
  return result;
}

function analyzeCustomer(data, requestedFrom, requestedTo) {
  const datasets = datasetMap(data);
  const overview = datasets.get("f8824efd111dc114");
  const trend = datasets.get("3b126a906124c574");
  const core = datasets.get("4a29a446b2055355");
  const journey = datasets.get("65f70ba41e6cbab8");
  const portrait = datasets.get("12dfa8ca5aa7ff02");
  const paymentJourney = datasets.get("8d95c21587ac499d");
  const snapshot = chooseSnapshot(core, requestedFrom, requestedTo);
  const selection = selectionForSnapshot(snapshot, "客户");
  const result = baseResult(data, "customer", "客户分析", selection, [
    sourceSummary(overview, "客户概况平台原生周期"),
    sourceSummary(core, "已购客户核心指标平台原生周期"),
    sourceSummary(journey, "客户旅程月度快照"),
    sourceSummary(portrait, "客户画像月度快照")
  ]);
  const current = snapshotRecord(overview, snapshot.range);
  const coreRecord = snapshotRecord(core, snapshot.range);
  const storeCustomers = asNumber(field(overview, current, 9));
  const customerChange = asNumber(field(overview, current, 10));
  const newConversion = asNumber(field(overview, current, 17));
  const repeatBuyers = asNumber(field(core, coreRecord, 23));
  const repeatBuyersChange = asNumber(field(core, coreRecord, 25));
  const repeatAmount = asNumber(field(core, coreRecord, 33));
  const repeatAmountChange = asNumber(field(core, coreRecord, 35));
  result.kpis = [
    { label: "店铺客户数", value: storeCustomers, value_label: integer(storeCustomers), comparison_change: customerChange, comparison_label: changeLabel(customerChange), benchmark: { excellent: asNumber(field(overview, current, 11)) }, source: source(overview, current, 9, selection.note) },
    { label: "新访支付转化率", value: newConversion, value_label: percent(newConversion), comparison_change: null, comparison_label: "源文件未提供本字段环比", source: source(overview, current, 17, selection.note) },
    { label: "老客复购人数", value: repeatBuyers, value_label: integer(repeatBuyers), comparison_change: repeatBuyersChange, comparison_label: changeLabel(repeatBuyersChange), benchmark: { excellent: asNumber(field(core, coreRecord, 24)) }, source: source(core, coreRecord, 23, selection.note) },
    { label: "复购金额", value: repeatAmount, value_label: money(repeatAmount), comparison_change: repeatAmountChange, comparison_label: changeLabel(repeatAmountChange), benchmark: { excellent: asNumber(field(core, coreRecord, 34)) }, source: source(core, coreRecord, 33, selection.note) }
  ];

  const journeySnapshot = chooseSnapshot(journey, snapshot.from, snapshot.to);
  const journeyRows = journey.records.filter((record) => record.date_range === journeySnapshot?.range).map((record) => ({
    label: field(journey, record, 7),
    value: asNumber(field(journey, record, 8)),
    value_label: integer(asNumber(field(journey, record, 8))),
    conversion: asNumber(field(journey, record, 9)),
    conversion_label: percent(asNumber(field(journey, record, 9)),),
    share_label: String(field(journey, record, 10) ?? "无数据"),
    record
  })).sort((a, b) => (b.value ?? 0) - (a.value ?? 0));
  const journeyTotal = sum(journeyRows.map((item) => item.value));
  result.composition = {
    title: "客户旅程结构",
    metric: "客户数",
    rows: journeyRows.map((item) => ({ ...item, share: journeyTotal ? round(item.value / journeyTotal * 100) : null })),
    caliber: journeySnapshot ? `客户旅程仅有月度数据；当前展示 ${journeySnapshot.from} 至 ${journeySnapshot.to} 的最近可用快照` : "无客户旅程月度快照",
    source: journeyRows.length ? source(journey, journeyRows[0].record, 8, "平台原生月度客户数") : null
  };

  const portraitSnapshot = chooseSnapshot(portrait, snapshot.from, snapshot.to);
  const portraitRows = portrait.records.filter((record) => record.date_range === portraitSnapshot?.range && field(portrait, record, 7) === "预测地域分布（省）")
    .map((record) => ({ label: field(portrait, record, 8), value: asNumber(field(portrait, record, 9)), value_label: integer(asNumber(field(portrait, record, 9))), share_label: String(field(portrait, record, 10) ?? "无数据") }))
    .sort((a, b) => (b.value ?? 0) - (a.value ?? 0)).slice(0, 10);
  result.secondary = {
    title: "新访客户地域 Top 10",
    rows: portraitRows,
    caliber: portraitSnapshot ? `客户画像月度快照 ${portraitSnapshot.from} 至 ${portraitSnapshot.to}，指标为客户新访人数` : "无客户画像月度快照",
    source: portraitRows.length ? source(portrait, portrait.records.find((record) => record.date_range === portraitSnapshot.range && field(portrait, record, 7) === "预测地域分布（省）"), 9, "客户新访人数") : null
  };

  const coreRows = [...core.records].sort((a, b) => dateParts(a.date_range).to.localeCompare(dateParts(b.date_range).to));
  result.trend = {
    labels: coreRows.map((record) => field(core, record, 6) || dateParts(record.date_range).to.slice(0, 7)),
    series: [
      { label: "老客复购人数", data: coreRows.map((record) => asNumber(field(core, record, 23))) },
      { label: "已购客户回访人数", data: coreRows.map((record) => asNumber(field(core, record, 8))) }
    ],
    selected_index: coreRows.findIndex((record) => record.date_range === snapshot.range),
    caliber: "月度与近30天均为独立平台原生快照；相邻点不强行视为等长连续时间序列",
    source: source(core, coreRecord, 23, "平台原生周期值")
  };

  const excellentRepeatBuyers = asNumber(field(core, coreRecord, 24));
  const excellentRepeatAmount = asNumber(field(core, coreRecord, 34));
  const recallRate = asNumber(field(core, coreRecord, 13));
  const excellentRecall = asNumber(field(core, coreRecord, 14));
  const returnConversion = asNumber(field(core, coreRecord, 18));
  const excellentReturnConversion = asNumber(field(core, coreRecord, 19));
  const amountGap = Math.max(0, (excellentRepeatAmount ?? 0) - (repeatAmount ?? 0));
  result.findings = [
    {
      severity: severityFor(customerChange),
      title: `店铺客户数${customerChange == null ? "缺少环比" : customerChange >= 0 ? "增长" : "回落"}`,
      verdict: `${integer(storeCustomers)}，平台原生较上一周期 ${changeLabel(customerChange)}`,
      evidence: [`客户新访 ${integer(asNumber(field(overview, current, 12)))}`, `未购回访 ${integer(asNumber(field(overview, current, 23)))}`, `已购回访 ${integer(asNumber(field(overview, current, 35)))}`],
      impact: "客户类型人数来自同一平台周期，不跨日相加",
      source: source(overview, current, 9, selection.note)
    },
    {
      severity: repeatBuyers < excellentRepeatBuyers ? "warning" : "positive",
      title: repeatBuyers < excellentRepeatBuyers ? "老客复购人数低于同行优秀" : "老客复购人数达到同行优秀参考",
      verdict: `本店 ${integer(repeatBuyers)}，同行同层优秀 ${integer(excellentRepeatBuyers)}`,
      evidence: [`复购比例 ${String(field(core, coreRecord, 28) ?? "无数据")}`, `已购回访支付转化 ${percent(returnConversion)}`, `同行优秀回访支付转化 ${percent(excellentReturnConversion)}`],
      impact: amountGap > 0 ? `与同行优秀复购金额参考值相差 ${money(amountGap)}；仅作基准差额，不承诺可实现` : "当前没有正向基准差额",
      source: source(core, coreRecord, 23, selection.note)
    },
    {
      severity: recallRate < excellentRecall ? "critical" : "neutral",
      title: recallRate < excellentRecall ? "已购客户召回率偏低" : "已购客户召回率未低于优秀参考",
      verdict: `本店 ${percent(recallRate)}，同行同层优秀 ${percent(excellentRecall)}`,
      evidence: [`已购客户回访 ${integer(asNumber(field(core, coreRecord, 8)))}`, `老客复购 ${integer(repeatBuyers)}`, `复购金额占全店支付 ${String(field(core, coreRecord, 38) ?? "无数据")}`],
      impact: "先改善召回覆盖，再判断复购转化承接",
      source: source(core, coreRecord, 13, selection.note)
    }
  ];
  result.actions = [
    { priority: recallRate < excellentRecall ? "高" : "中", title: "建立已购客户召回任务", reason: `本店召回率 ${percent(recallRate)}，优秀参考 ${percent(excellentRecall)}`, target_module: "客户", status: "待处理" },
    { priority: repeatBuyers < excellentRepeatBuyers ? "高" : "中", title: "拆解老客复购不足", reason: "按已购回访人数、回访支付转化和复购客单价逐层核查", target_module: "客户", status: "待处理" },
    { priority: newConversion < 2 ? "中" : "低", title: "复核新访客户承接", reason: `新访支付转化率 ${percent(newConversion)}`, target_module: "客户", status: "待处理" }
  ];
  const paymentSnapshot = chooseSnapshot(paymentJourney, snapshot.from, snapshot.to);
  const paymentRows = paymentJourney.records.filter((record) => record.date_range === paymentSnapshot?.range);
  result.detail = {
    title: "客户旅程明细",
    columns: ["客户类型", "客户数", "支付转化率", "支付金额占比", "来源工作簿"],
    rows: journeyRows.map((item) => [item.label, item.value_label, item.conversion_label, item.share_label, item.record.workbook_file]),
    note: paymentRows.length ? `最近支付动作快照含 ${paymentRows.length} 个真实指标行，可在后续动作下钻页继续展开` : "当前没有可关联的支付动作月度快照"
  };
  return result;
}

export async function analyzeBusinessModule(rootDir, moduleName, requestedFrom, requestedTo) {
  if (!MODULE_FILES[moduleName]) throw new Error("不支持的数据模块");
  if ((requestedFrom && !isoDate(requestedFrom)) || (requestedTo && !isoDate(requestedTo))) throw new Error("日期格式必须为 YYYY-MM-DD");
  if ((requestedFrom && !requestedTo) || (!requestedFrom && requestedTo)) throw new Error("开始日期和结束日期必须同时提供");
  const data = await loadModule(rootDir, moduleName);
  if (moduleName === "transaction") return analyzeTransaction(data, requestedFrom, requestedTo);
  if (moduleName === "traffic") return analyzeTraffic(data, requestedFrom, requestedTo);
  return analyzeCustomer(data, requestedFrom, requestedTo);
}
