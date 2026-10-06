const elements = {
  moduleNav: document.querySelector("#moduleNav"),
  moduleList: document.querySelector("#moduleList"),
  nextSteps: document.querySelector("#nextSteps"),
  focusList: document.querySelector("#focusList"),
  benchmarkList: document.querySelector("#benchmarkList"),
  funnelStages: document.querySelector("#funnelStages"),
  funnelCaliber: document.querySelector("#funnelCaliber"),
  impactAmount: document.querySelector("#impactAmount"),
  impactDetail: document.querySelector("#impactDetail"),
  kpiGrid: document.querySelector("#kpiGrid"),
  syncStatus: document.querySelector("#syncStatus"),
  sidebarSyncStatus: document.querySelector("#sidebarSyncStatus"),
  homeStatus: document.querySelector("#homeStatus"),
  latestDate: document.querySelector("#latestDate"),
  generatedAt: document.querySelector("#generatedAt"),
  sourceLine: document.querySelector("#sourceLine"),
  coverageSummary: document.querySelector("#coverageSummary"),
  sourceCount: document.querySelector("#sourceCount"),
  homeFileRows: document.querySelector("#homeFileRows"),
  refreshBtn: document.querySelector("#refreshBtn"),
  applyFilterBtn: document.querySelector("#applyFilterBtn"),
  fromDate: document.querySelector("#fromDate"),
  toDate: document.querySelector("#toDate"),
  filterCaliber: document.querySelector("#filterCaliber"),
  comparisonLabel: document.querySelector("#comparisonLabel"),
  trendLabel: document.querySelector("#trendLabel")
};

const presetButtons = [...document.querySelectorAll(".preset-button")];
const moduleIcons = {
  "01-首页": "house",
  "02-交易": "receipt-text",
  "03-流量": "route",
  "04-客户": "users",
  "05-商品": "package-search",
  "06-营销": "badge-percent",
  "07-服务": "headphones",
  "08-内容": "panels-top-left",
  "09-市场": "chart-no-axes-combined",
  "10-业务专区": "briefcase-business"
};
const severityLabels = {
  critical: "重点关注",
  warning: "需要留意",
  neutral: "保持观察",
  positive: "趋势改善"
};

let revenueChart = null;
let auditCache = null;
let availableFrom = null;
let availableTo = null;

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

function formatTime(value) {
  if (!value) return "无";
  return new Intl.DateTimeFormat("zh-CN", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit"
  }).format(new Date(value));
}

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

function changeClass(value) {
  if (value == null || Math.abs(value) < 0.0001) return "neutral";
  return value > 0 ? "positive" : "negative";
}

function dateShift(value, days) {
  const date = new Date(`${value}T00:00:00`);
  date.setDate(date.getDate() + days);
  return date.toLocaleDateString("en-CA");
}

function setActivePreset(name) {
  presetButtons.forEach((button) => button.classList.toggle("active", button.dataset.preset === name));
}

function setBusy(busy) {
  elements.refreshBtn.disabled = busy;
  elements.applyFilterBtn.disabled = busy;
  presetButtons.forEach((button) => {
    button.disabled = busy;
  });
  if (busy) elements.syncStatus.textContent = "计算中";
}

function renderNav(modules) {
  const routes = {
    "01-首页": "/",
    "02-交易": "/transaction.html",
    "03-流量": "/traffic.html",
    "04-客户": "/customer.html"
  };
  elements.moduleNav.innerHTML = modules
    .map((item) => routes[item.folder] ? `
      <a class="nav-item${item.folder === "01-首页" ? " active" : ""}" href="${routes[item.folder]}" title="${escapeHtml(item.description)}">
        <i data-lucide="${moduleIcons[item.folder] || "folder"}" aria-hidden="true"></i>
        <span>${escapeHtml(item.label)}</span><span class="nav-count">${item.fileCount}</span>
      </a>` : `
      <span class="nav-item nav-item-disabled" title="${escapeHtml(item.description)}">
        <i data-lucide="${moduleIcons[item.folder] || "folder"}" aria-hidden="true"></i>
        <span>${escapeHtml(item.label)}</span><span class="nav-count">${item.fileCount}</span>
      </span>`)
    .join("");
}

function renderModules(modules) {
  elements.moduleList.innerHTML = modules
    .map((item) => {
      const ready = item.fileCount > 0;
      const statusText = item.folder === "01-首页" && ready ? "已解析并诊断" : ready ? "真实文件已识别" : "等待真实数据";
      return `
        <div class="module-row">
          <div class="module-heading">
            <span class="module-icon"><i data-lucide="${moduleIcons[item.folder] || "folder"}" aria-hidden="true"></i></span>
            <div><div class="module-name">${escapeHtml(item.label)}</div><div class="module-folder">${escapeHtml(item.folder)}</div></div>
          </div>
          <div class="module-status${ready ? " ready" : ""}"><span>${statusText}</span><strong>${item.fileCount} 个</strong></div>
        </div>`;
    })
    .join("");
}

function renderKpis(kpis, selection) {
  elements.kpiGrid.innerHTML = kpis
    .map((item) => {
      const supporting = item.supporting?.length
        ? `<div class="kpi-supporting">${item.supporting.map((entry) => `<span>${escapeHtml(entry.label)} ${escapeHtml(entry.value_label)}</span>`).join("")}</div>`
        : "";
      const periodWord = selection.day_count === 1 ? "较前日" : "较上一周期";
      const metricPrefix = selection.day_count > 1 && item.format !== "currency" ? "日均" : "";
      return `
        <article class="kpi-card">
          <span>${metricPrefix}${escapeHtml(item.label)} · ${escapeHtml(selection.date_from === selection.date_to ? selection.date_to : `${selection.date_from} 至 ${selection.date_to}`)}</span>
          <strong>${escapeHtml(item.value_label)}</strong>
          <div class="kpi-meta">
            <span>${periodWord} <b class="change ${changeClass(item.comparison_change)}">${escapeHtml(item.comparison_change_label)}</b></span>
            <span>同行平均 <b>${escapeHtml(item.peer_average_label)}</b></span>
          </div>
          ${supporting}
        </article>`;
    })
    .join("");
}

function renderFocus(items) {
  elements.focusList.innerHTML = items.length
    ? items
        .map((item) => {
          const source = item.source;
          return `
            <article class="focus-item">
              <span class="item-marker ${item.severity}" aria-hidden="true"></span>
              <div>
                <strong>${escapeHtml(item.title)}</strong>
                <p>${escapeHtml(item.verdict)}</p>
                <ul class="evidence-list">${item.evidence.map((line) => `<li>${escapeHtml(line)}</li>`).join("")}</ul>
                <details class="source-details">
                  <summary>查看数据来源</summary>
                  <p>${escapeHtml(source.archive_file)} / ${escapeHtml(source.workbook_file)} / ${escapeHtml(source.sheet)} / 第 ${source.column} 列<br>${escapeHtml(source.caliber)}</p>
                </details>
                <a class="focus-deep-link" href="${escapeHtml(item.deep_link || "/diagnosis.html")}">查看完整证据 <i data-lucide="arrow-up-right"></i></a>
              </div>
              <span class="focus-state ${item.severity}">${severityLabels[item.severity] || "观察"}<small>${escapeHtml(item.confidence || "高概率")}</small></span>
            </article>`;
        })
        .join("")
    : '<div class="panel-empty">所选周期没有生成经营焦点</div>';
}

function renderActions(items) {
  elements.nextSteps.innerHTML = items
    .map((item) => `
      <li class="attention-item">
        <div>
          <strong>${escapeHtml(item.title)}</strong>
          <p>${escapeHtml(item.reason)}</p>
          <span class="action-target"><i data-lucide="arrow-right" aria-hidden="true"></i>${escapeHtml(item.target_module)} · ${escapeHtml(item.status)}</span>
          <a class="focus-deep-link" href="/actions.html">进入行动追踪</a>
        </div>
        <span class="attention-state ${item.priority === "高" ? "high" : "medium"}">${escapeHtml(item.priority)}优先</span>
      </li>`)
    .join("");
}

function renderBenchmark(items) {
  elements.benchmarkList.innerHTML = items
    .map((item) => {
      const maximum = Math.max(item.self || 0, item.peer_average || 0, item.peer_excellent || 0, 0.0001);
      const selfWidth = Math.max(2, Math.min(100, ((item.self || 0) / maximum) * 100));
      const averageLeft = Math.min(100, ((item.peer_average || 0) / maximum) * 100);
      const excellentLeft = Math.min(100, ((item.peer_excellent || 0) / maximum) * 100);
      return `
        <div class="benchmark-row">
          <div class="benchmark-heading"><strong>${escapeHtml(item.label)}</strong><span>本店</span><span>平均</span><span>优秀</span></div>
          <div class="benchmark-track">
            <div class="benchmark-self-bar" style="width:${selfWidth}%"></div>
            <span class="benchmark-marker" style="left:${averageLeft}%" title="同行平均"></span>
            <span class="benchmark-marker excellent" style="left:${excellentLeft}%" title="同行优秀"></span>
          </div>
          <div class="benchmark-values"><span></span><span class="self-value">${escapeHtml(item.self_label)}</span><span class="average-value">${escapeHtml(item.peer_average_label)}</span><span class="excellent-value">${escapeHtml(item.peer_excellent_label)}</span></div>
        </div>`;
    })
    .join("");
}

function renderFunnel(funnel) {
  const [visitors, carts, buyers] = funnel.stages;
  const [visitToCart, cartToBuyer, overall] = funnel.rates;
  elements.funnelCaliber.textContent = funnel.caliber;
  elements.funnelStages.innerHTML = `
    <div class="funnel-stage"><span>${escapeHtml(visitors.label)}</span><strong>${escapeHtml(visitors.value_label)}</strong></div>
    <div class="funnel-step"><strong>${escapeHtml(visitToCart.value_label)}</strong><div class="funnel-line"></div><span>${escapeHtml(visitToCart.label)}</span></div>
    <div class="funnel-stage"><span>${escapeHtml(carts.label)}</span><strong>${escapeHtml(carts.value_label)}</strong></div>
    <div class="funnel-step"><strong>${escapeHtml(cartToBuyer.value_label)}</strong><div class="funnel-line"></div><span>${escapeHtml(cartToBuyer.label)}</span></div>
    <div class="funnel-stage"><span>${escapeHtml(buyers.label)}</span><strong>${escapeHtml(buyers.value_label)}</strong><span>整体 ${escapeHtml(overall.value_label)}</span></div>`;
  elements.impactAmount.textContent = funnel.impact.amount_label;
  elements.impactDetail.textContent = `约 ${funnel.impact.buyer_count_label} 个买家人次 · ${funnel.impact.description}`;
}

function renderSources(sources) {
  elements.sourceCount.textContent = `${sources.length} 个 ZIP 原始包`;
  elements.homeFileRows.innerHTML = sources
    .map((source) => {
      const detail = source.daily_workbooks ? `${source.daily_workbooks} 个日数据工作簿` : `${source.monthly_workbooks} 个数据看板工作簿`;
      return `<tr><td class="file-name">${escapeHtml(source.name)}</td><td>ZIP</td><td>${formatBytes(source.size)}</td><td>${formatTime(source.modified_at)}</td><td class="parse-ready">${detail}</td></tr>`;
    })
    .join("");
}

function cssToken(name) {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

function renderChart(trend) {
  if (!window.Chart || !trend?.labels?.length) return;
  if (revenueChart) revenueChart.destroy();
  const anomalySet = new Set(trend.anomaly_indexes || []);
  elements.trendLabel.textContent = trend.label;
  revenueChart = new window.Chart(document.querySelector("#revenueChart"), {
    type: "line",
    data: {
      labels: trend.labels.map((date) => date.slice(5)),
      datasets: [{
        label: "净支付金额",
        data: trend.series.net_payment_amount,
        borderColor: cssToken("--accent"),
        backgroundColor: cssToken("--chart-fill"),
        pointBackgroundColor: trend.labels.map((_, index) => anomalySet.has(index) ? cssToken("--danger") : cssToken("--surface")),
        pointBorderColor: trend.labels.map((_, index) => anomalySet.has(index) ? cssToken("--danger") : cssToken("--accent")),
        pointRadius: trend.labels.map((_, index) => anomalySet.has(index) ? 5 : 2),
        pointHoverRadius: 5,
        borderWidth: 2,
        fill: true,
        tension: 0.22,
        spanGaps: false
      }]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      interaction: { intersect: false, mode: "index" },
      plugins: {
        legend: { display: false },
        tooltip: { callbacks: { label: (context) => ` 净支付金额 ¥${Number(context.raw).toLocaleString("zh-CN", { maximumFractionDigits: 2 })}` } }
      },
      scales: {
        x: { grid: { display: false }, ticks: { color: cssToken("--text-muted"), maxTicksLimit: 8, maxRotation: 0 } },
        y: {
          beginAtZero: true,
          grid: { color: cssToken("--chart-grid") },
          border: { display: false },
          ticks: { color: cssToken("--text-muted"), callback: (value) => `¥${Number(value).toLocaleString("zh-CN", { notation: "compact" })}` }
        }
      }
    }
  });
}

function configureDateInputs(selection) {
  availableFrom = selection.available_from;
  availableTo = selection.available_to;
  for (const input of [elements.fromDate, elements.toDate]) {
    input.min = availableFrom;
    input.max = availableTo;
  }
  elements.fromDate.value = selection.date_from;
  elements.toDate.value = selection.date_to;
  elements.filterCaliber.textContent = selection.caliber;
  elements.comparisonLabel.textContent = selection.comparison_label;
}

function renderReady(homepage) {
  const quality = homepage.coverage;
  const selection = homepage.selection;
  elements.homeStatus.textContent = "首页数据已解析";
  elements.latestDate.textContent = selection.date_from === selection.date_to ? `统计 ${selection.date_to}` : `统计 ${selection.date_from} 至 ${selection.date_to}`;
  elements.syncStatus.textContent = "真实数据已更新";
  elements.sidebarSyncStatus.textContent = "本地文件实时同步";
  elements.generatedAt.textContent = `判断更新于 ${formatTime(homepage.generated_at)}`;
  elements.sourceLine.textContent = `可选日期 ${selection.available_from} 至 ${selection.available_to} · 当前 ${selection.caliber}`;
  elements.coverageSummary.textContent = `首页 ${quality.daily_unique_dates} 个日周期 / ${quality.monthly_unique_dates} 个月周期`;
  configureDateInputs(selection);
  if (homepage.cross_module?.gaps?.length) {
    elements.filterCaliber.textContent = `${selection.caliber} · ${homepage.cross_module.gaps[0].message}`;
  }
  renderKpis(homepage.kpis, selection);
  renderFocus(homepage.focus);
  renderActions(homepage.actions);
  renderBenchmark(homepage.benchmark);
  renderFunnel(homepage.funnel);
  renderSources(homepage.sources);
  renderChart(homepage.trend);
  createIcons();
}

function renderFailure(message) {
  elements.syncStatus.textContent = "读取失败";
  elements.homeStatus.textContent = "日期计算异常";
  elements.focusList.innerHTML = `<div class="panel-empty">${escapeHtml(message)}</div>`;
}

async function loadPeriod(dateFrom = null, dateTo = null, refreshAudit = false) {
  setBusy(true);
  try {
    if (!auditCache || refreshAudit) {
      const auditResponse = await fetch(`/api/audit?t=${Date.now()}`, { cache: "no-store" });
      if (!auditResponse.ok) throw new Error(`目录审计接口返回 ${auditResponse.status}`);
      auditCache = await auditResponse.json();
      renderNav(auditCache.modules);
      renderModules(auditCache.modules);
    }
    const query = dateFrom && dateTo ? `?from=${encodeURIComponent(dateFrom)}&to=${encodeURIComponent(dateTo)}&t=${Date.now()}` : `?t=${Date.now()}`;
    const response = await fetch(`/api/homepage${query}`, { cache: "no-store" });
    const homepage = await response.json();
    if (!response.ok) throw new Error(homepage.detail || `首页接口返回 ${response.status}`);
    if (homepage.status === "waiting") {
      elements.syncStatus.textContent = "等待导入";
      elements.homeStatus.textContent = "尚无首页数据";
      elements.focusList.innerHTML = '<div class="panel-empty">请将本人有权使用的生意参谋首页导出 ZIP 放入项目的 raw/01-首页 文件夹，然后点击刷新。未导入前不会生成经营结论。</div>';
      return;
    }
    if (homepage.status !== "ready") throw new Error("等待首页真实 ZIP 数据");
    renderReady(homepage);
    if (dateFrom && dateTo) history.replaceState(null, "", `/?from=${encodeURIComponent(dateFrom)}&to=${encodeURIComponent(dateTo)}`);
  } catch (error) {
    console.error(error);
    renderFailure(error.message);
  } finally {
    setBusy(false);
  }
}

function applyPreset(name) {
  if (!availableTo) return;
  let from = availableTo;
  const to = availableTo;
  if (name === "7d") from = dateShift(to, -6);
  if (name === "30d") from = dateShift(to, -29);
  if (name === "mtd") from = `${to.slice(0, 8)}01`;
  if (from < availableFrom) from = availableFrom;
  elements.fromDate.value = from;
  elements.toDate.value = to;
  setActivePreset(name);
  loadPeriod(from, to);
}

presetButtons.forEach((button) => {
  button.addEventListener("click", () => {
    const name = button.dataset.preset;
    if (name === "custom") {
      setActivePreset("custom");
      elements.fromDate.focus();
      return;
    }
    applyPreset(name);
  });
});

for (const input of [elements.fromDate, elements.toDate]) {
  input.addEventListener("change", () => setActivePreset("custom"));
}

elements.applyFilterBtn.addEventListener("click", () => {
  const from = elements.fromDate.value;
  const to = elements.toDate.value;
  if (!from || !to) return renderFailure("请选择完整的开始和结束日期");
  if (from > to) return renderFailure("开始日期不能晚于结束日期");
  setActivePreset("custom");
  loadPeriod(from, to);
});

elements.refreshBtn.addEventListener("click", () => loadPeriod(elements.fromDate.value || null, elements.toDate.value || null, true));
createIcons();
const initialParams = new URLSearchParams(location.search);
loadPeriod(initialParams.get("from"), initialParams.get("to"));
