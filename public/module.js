const pageModule = location.pathname.includes("traffic")
  ? "traffic"
  : location.pathname.includes("customer")
    ? "customer"
    : "transaction";

const moduleMeta = {
  transaction: { title: "交易分析", eyebrow: "交易数据 · 日级诊断", trend: "支付与转化趋势" },
  traffic: { title: "流量分析", eyebrow: "流量数据 · 来源与效率", trend: "支付与转化趋势" },
  customer: { title: "客户分析", eyebrow: "客户数据 · 新老客与复购", trend: "复购与回访趋势" }
};

const el = Object.fromEntries([
  "pageTitle", "eyebrow", "dataStatus", "coverageStatus", "sourceLine", "syncStatus", "sidebarStatus",
  "refreshBtn", "applyFilterBtn", "fromDate", "toDate", "filterSummary", "filterCaliber", "periodNote",
  "kpiGrid", "findingList", "actionList", "trendTitle", "trendCaliber", "trendChart",
  "compositionTitle", "compositionCaliber", "compositionList", "secondaryTitle", "secondaryCaliber",
  "secondaryChart", "secondaryList", "detailTitle", "detailHead", "detailBody", "detailNote",
  "sourceCount", "sourceList"
].map((id) => [id, document.querySelector(`#${id}`)]));

const presetButtons = [...document.querySelectorAll(".preset-button")];
let dataCache = null;
let trendChart = null;
let secondaryChart = null;

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function createIcons() {
  if (window.lucide) window.lucide.createIcons();
}

function cssToken(name) {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

function shiftDate(value, days) {
  const date = new Date(`${value}T00:00:00`);
  date.setDate(date.getDate() + days);
  return date.toLocaleDateString("en-CA");
}

function setBusy(busy) {
  el.refreshBtn.disabled = busy;
  el.applyFilterBtn.disabled = busy || !dataCache;
  for (const input of [el.fromDate, el.toDate]) input.disabled = busy || !dataCache;
  presetButtons.forEach((button) => { button.disabled = busy || !dataCache; });
  if (busy) {
    el.syncStatus.textContent = "正在计算";
    el.dataStatus.textContent = "读取真实数据";
  }
}

function setPreset(name) {
  presetButtons.forEach((button) => button.classList.toggle("active", button.dataset.preset === name));
}

function sourceDetails(source) {
  if (!source) return "";
  const row = source.row ? ` / 第 ${source.row} 行` : "";
  return `<details class="source-details"><summary>查看数据来源</summary><p>${escapeHtml(source.archive_file)}<br>${escapeHtml(source.workbook_file || "多个工作簿")} / ${escapeHtml(source.sheet)}${row} / 第 ${escapeHtml(source.column)} 列<br>字段：${escapeHtml(source.field)}；口径：${escapeHtml(source.caliber)}</p></details>`;
}

function changeClass(value) {
  if (value == null || Math.abs(value) < 0.0001) return "neutral";
  return value > 0 ? "positive" : "negative";
}

function renderKpis(items) {
  el.kpiGrid.innerHTML = items.map((item) => `
    <article class="kpi-card module-kpi-card">
      <span>${escapeHtml(item.label)}</span>
      <strong>${escapeHtml(item.value_label)}</strong>
      <div class="kpi-meta"><span>${escapeHtml(item.comparison_label || "无对比")}</span></div>
      ${item.benchmark?.average != null ? `<div class="kpi-supporting"><span>同行平均 ${Number(item.benchmark.average).toLocaleString("zh-CN")}</span><span>同行优秀 ${Number(item.benchmark.excellent).toLocaleString("zh-CN")}</span></div>` : ""}
      ${sourceDetails(item.source)}
    </article>`).join("");
}

function renderFindings(items) {
  const labels = { critical: "重点处理", warning: "需要留意", positive: "趋势改善", neutral: "继续观察" };
  el.findingList.innerHTML = items.length ? items.map((item) => `
    <article class="focus-item module-focus-item">
      <span class="item-marker ${escapeHtml(item.severity)}"></span>
      <div>
        <strong>${escapeHtml(item.title)}</strong>
        <p>${escapeHtml(item.verdict)}</p>
        <ul class="evidence-list">${(item.evidence || []).map((line) => `<li>${escapeHtml(line)}</li>`).join("")}</ul>
        <p class="impact-line"><b>影响：</b>${escapeHtml(item.impact)}</p>
        ${sourceDetails(item.source)}
      </div>
      <span class="focus-state ${escapeHtml(item.severity)}">${labels[item.severity] || "观察"}</span>
    </article>`).join("") : '<div class="panel-empty">所选周期没有可生成的经营判断</div>';
}

function renderActions(items) {
  el.actionList.innerHTML = items.length ? items.map((item) => `
    <li class="attention-item">
      <div>
        <strong>${escapeHtml(item.title)}</strong>
        <p>${escapeHtml(item.reason)}</p>
        <span class="action-target"><i data-lucide="arrow-right"></i>${escapeHtml(item.target_module)} · ${escapeHtml(item.status)}</span>
      </div>
      <span class="attention-state ${item.priority === "高" ? "high" : "medium"}">${escapeHtml(item.priority)}优先</span>
    </li>`).join("") : '<li class="panel-empty">当前没有待处理项</li>';
}

function renderStructure(target, rows, valueKey = "value", maxRows = 10) {
  if (!rows?.length) {
    target.innerHTML = '<div class="panel-empty">当前筛选周期没有对应明细，不借用其他周期数据</div>';
    return;
  }
  const shown = rows.slice(0, maxRows);
  const maximum = Math.max(...shown.map((row) => Number(row[valueKey]) || 0), 1);
  target.innerHTML = shown.map((row, index) => `
    <div class="structure-row">
      <span class="structure-rank">${String(index + 1).padStart(2, "0")}</span>
      <div class="structure-main">
        <div class="structure-heading"><strong>${escapeHtml(row.label)}</strong><span>${escapeHtml(row.value_label ?? row[valueKey])}</span></div>
        <div class="structure-track"><span style="width:${Math.max(1, Math.min(100, (Number(row[valueKey]) || 0) / maximum * 100))}%"></span></div>
        <div class="structure-meta">
          ${row.share_label ? `<span>占比 ${escapeHtml(row.share_label)}</span>` : ""}
          ${row.amount_label ? `<span>支付 ${escapeHtml(row.amount_label)}</span>` : ""}
          ${row.conversion_label ? `<span>转化 ${escapeHtml(row.conversion_label)}</span>` : ""}
        </div>
      </div>
    </div>`).join("");
}

function destroyCharts() {
  if (trendChart) trendChart.destroy();
  if (secondaryChart) secondaryChart.destroy();
  trendChart = null;
  secondaryChart = null;
}

function renderTrend(trend) {
  if (!window.Chart || !trend?.labels?.length || !trend.series?.length) {
    el.trendChart.hidden = true;
    return;
  }
  el.trendChart.hidden = false;
  const accent = cssToken("--accent");
  const info = cssToken("--info");
  const selected = trend.selected_index;
  trendChart = new window.Chart(el.trendChart, {
    type: "line",
    data: {
      labels: trend.labels,
      datasets: trend.series.map((series, index) => ({
        label: series.label,
        data: series.data,
        yAxisID: series.axis === "percent" ? "yPercent" : "y",
        borderColor: index === 0 ? accent : info,
        backgroundColor: index === 0 ? cssToken("--chart-fill") : "transparent",
        pointBackgroundColor: series.data.map((_, pointIndex) => pointIndex === selected ? cssToken("--danger") : index === 0 ? accent : info),
        pointRadius: series.data.map((_, pointIndex) => pointIndex === selected ? 5 : 2),
        borderWidth: 2,
        tension: 0.28,
        fill: index === 0
      }))
    },
    options: {
      animation: !window.matchMedia("(prefers-reduced-motion: reduce)").matches,
      maintainAspectRatio: false,
      interaction: { mode: "index", intersect: false },
      plugins: { legend: { position: "bottom", labels: { usePointStyle: true, boxWidth: 8 } } },
      scales: {
        x: { grid: { display: false }, ticks: { maxTicksLimit: 10 } },
        y: { beginAtZero: false, grid: { color: cssToken("--chart-grid") } },
        yPercent: { display: trend.series.some((series) => series.axis === "percent"), position: "right", grid: { drawOnChartArea: false }, ticks: { callback: (value) => `${value}%` } }
      }
    }
  });
}

function renderSecondaryChart(rows) {
  if (!window.Chart || !rows?.length) {
    el.secondaryChart.hidden = true;
    return;
  }
  const shown = rows.slice(0, 10);
  el.secondaryChart.hidden = false;
  secondaryChart = new window.Chart(el.secondaryChart, {
    type: "bar",
    data: {
      labels: shown.map((row) => row.label),
      datasets: [{ label: "当前值", data: shown.map((row) => row.value), backgroundColor: cssToken("--accent-soft"), borderColor: cssToken("--accent"), borderWidth: 1 }]
    },
    options: {
      animation: !window.matchMedia("(prefers-reduced-motion: reduce)").matches,
      indexAxis: "y",
      maintainAspectRatio: false,
      plugins: { legend: { display: false } },
      scales: { x: { beginAtZero: true, grid: { color: cssToken("--chart-grid") } }, y: { grid: { display: false } } }
    }
  });
}

function renderDetail(detail) {
  el.detailTitle.textContent = detail.title;
  el.detailHead.innerHTML = `<tr>${detail.columns.map((column) => `<th>${escapeHtml(column)}</th>`).join("")}</tr>`;
  el.detailBody.innerHTML = detail.rows.length
    ? detail.rows.map((row) => `<tr>${row.map((value, index) => `<td${index === row.length - 1 ? ' class="source-workbook-cell"' : ""}>${escapeHtml(value)}</td>`).join("")}</tr>`).join("")
    : `<tr class="empty-row"><td colspan="${detail.columns.length}">当前筛选周期没有对应明细</td></tr>`;
  el.detailNote.textContent = detail.note || "";
}

function renderSources(items) {
  el.sourceCount.textContent = `${items.length} 类真实来源`;
  el.sourceList.innerHTML = items.map((item) => `
    <article class="source-audit-row">
      <div><strong>${escapeHtml(item.sheet)}</strong><span>${escapeHtml(item.archive_file)}</span></div>
      <div><b>${escapeHtml(item.workbook_count)}</b><span>工作簿</span></div>
      <div><b>${escapeHtml(item.record_count)}</b><span>标准记录</span></div>
      <p>${escapeHtml(item.caliber)}</p>
    </article>`).join("");
}

function render(data) {
  dataCache = data;
  const meta = moduleMeta[pageModule];
  document.title = `${meta.title} · 生意参谋数据工作台`;
  el.pageTitle.textContent = meta.title;
  el.eyebrow.textContent = meta.eyebrow;
  document.querySelector(`[data-module="${pageModule}"]`)?.classList.add("active");
  el.dataStatus.textContent = "真实数据已读取";
  el.coverageStatus.textContent = `${data.coverage.date_start} 至 ${data.coverage.date_end}`;
  el.sourceLine.textContent = `${data.coverage.archive_count} 个 ZIP · ${data.coverage.workbook_count} 个工作簿 · ${data.coverage.record_count} 条标准记录`;
  el.sidebarStatus.textContent = `已同步 ${data.coverage.archive_count} 个原始包`;
  el.syncStatus.textContent = "已完成本地计算";
  el.filterSummary.textContent = `当前分析：${data.selection.label}`;
  el.filterCaliber.textContent = data.selection.mode === "daily" ? "日级真实数据" : "平台原生周期快照";
  el.periodNote.hidden = false;
  el.periodNote.textContent = data.selection.note;
  el.fromDate.min = data.coverage.date_start;
  el.fromDate.max = data.coverage.date_end;
  el.toDate.min = data.coverage.date_start;
  el.toDate.max = data.coverage.date_end;
  el.fromDate.value = data.selection.requested_from || data.selection.date_from;
  el.toDate.value = data.selection.requested_to || data.selection.date_to;
  el.trendTitle.textContent = meta.trend;
  el.trendCaliber.textContent = data.trend.caliber;
  el.compositionTitle.textContent = data.composition.title;
  el.compositionCaliber.textContent = data.composition.caliber;
  el.secondaryTitle.textContent = data.secondary.title;
  el.secondaryCaliber.textContent = data.secondary.caliber;
  destroyCharts();
  renderKpis(data.kpis);
  renderFindings(data.findings);
  renderActions(data.actions);
  renderTrend(data.trend);
  renderStructure(el.compositionList, data.composition.rows);
  renderSecondaryChart(data.secondary.rows);
  renderStructure(el.secondaryList, data.secondary.rows, "value", 6);
  renderDetail(data.detail);
  renderSources(data.sources);
  createIcons();
}

async function loadData(from, to) {
  document.title = `${moduleMeta[pageModule].title} · 生意参谋数据工作台`;
  el.pageTitle.textContent = moduleMeta[pageModule].title;
  document.querySelector(`[data-module="${pageModule}"]`)?.classList.add("active");
  setBusy(true);
  try {
    const params = from && to ? `?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}` : "";
    const response = await fetch(`/api/module/${pageModule}${params}`, { cache: "no-store" });
    const data = await response.json();
    if (!response.ok || data.status === "error") throw new Error(data.detail || data.message || "数据读取失败");
    if (data.status === "waiting") {
      dataCache = null;
      destroyCharts();
      el.pageTitle.textContent = moduleMeta[pageModule].title;
      el.dataStatus.textContent = "等待导入";
      el.syncStatus.textContent = "等待导入";
      el.sidebarStatus.textContent = "尚无专题分析数据";
      el.coverageStatus.textContent = "尚无可分析日期";
      el.filterSummary.textContent = "尚无可分析周期";
      el.filterCaliber.textContent = "导入后选择日期";
      el.fromDate.value = el.toDate.value = "";
      el.kpiGrid.innerHTML = '<div class="panel-empty">尚无兼容报表 · 缺失数据不代表 0</div>';
      el.findingList.innerHTML = '<div class="panel-empty">导入后生成分析。<a href="/#importGuide">查看导入指南</a></div>';
      el.actionList.innerHTML = '<div class="panel-empty">暂无可生成的行动</div>';
      el.compositionList.innerHTML = el.secondaryList.innerHTML = '<div class="panel-empty">等待真实数据</div>';
      el.periodNote.hidden = false;
      el.periodNote.textContent = data.message;
      return;
    }
    render(data);
    if (from && to) history.replaceState(null, "", `${location.pathname}?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}${location.hash}`);
    if (location.hash) setTimeout(() => document.querySelector(location.hash)?.scrollIntoView({ block: "start" }), 80);
  } catch (error) {
    el.dataStatus.textContent = "读取失败";
    el.syncStatus.textContent = "需要检查";
    el.periodNote.hidden = false;
    el.periodNote.textContent = `本次读取失败：${error.message}。已有内容未更新，请检查本地服务、ZIP 格式与数据审计后刷新。`;
    console.error(error);
  } finally {
    setBusy(false);
  }
}

function applyPreset(name) {
  if (!dataCache) return;
  const latest = dataCache.coverage.date_end;
  let from = latest;
  if (name === "7d") from = shiftDate(latest, -6);
  if (name === "30d") from = shiftDate(latest, -29);
  if (name === "month") from = `${latest.slice(0, 8)}01`;
  setPreset(name);
  el.fromDate.value = from < dataCache.coverage.date_start ? dataCache.coverage.date_start : from;
  el.toDate.value = latest;
  loadData(el.fromDate.value, el.toDate.value);
}

presetButtons.forEach((button) => button.addEventListener("click", () => applyPreset(button.dataset.preset)));
el.applyFilterBtn.addEventListener("click", () => {
  if (!el.fromDate.value || !el.toDate.value) return;
  setPreset("custom");
  loadData(el.fromDate.value, el.toDate.value);
});
el.refreshBtn.addEventListener("click", () => loadData(el.fromDate.value || null, el.toDate.value || null));

createIcons();
const initialParams = new URLSearchParams(location.search);
loadData(initialParams.get("from"), initialParams.get("to"));
