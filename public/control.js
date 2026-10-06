const view = location.pathname.includes("actions") ? "actions"
  : location.pathname.includes("audit") ? "audit"
    : location.pathname.includes("system") ? "system" : "diagnosis";

const meta = {
  diagnosis: { title: "经营诊断中心", eyebrow: "经营数据 · 自动诊断", description: "把经营问题、证据、影响和行动放在同一个判断链路中。" },
  actions: { title: "行动追踪", eyebrow: "诊断结论 · 执行闭环", description: "状态、负责人、截止日期、备注和验证结果会保存在本地并持续输出联动 JSON。" },
  audit: { title: "数据审计", eyebrow: "原始文件 · 真实覆盖", description: "这里只显示实际识别到的文件，不用示例数据补齐缺失模块。" },
  system: { title: "系统状态", eyebrow: "本地服务 · 数据质量", description: "检查原始文件、标准化层、诊断历史、行动导出与启动能力。" }
};

const $ = (selector) => document.querySelector(selector);
const el = { title: $("#viewTitle"), eyebrow: $("#viewEyebrow"), status: $("#viewStatus"), period: $("#viewPeriod"), description: $("#viewDescription"), sync: $("#syncStatus"), refresh: $("#refreshBtn"), toolbar: $("#controlToolbar"), content: $("#controlContent"), sidebar: $("#sidebarStatus") };
const statuses = ["待处理", "执行中", "待验证", "已完成", "验证有效", "验证无效", "已搁置", "待配置"];

function escapeHtml(value) {
  return String(value ?? "").replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&#039;");
}

function icons() { if (window.lucide) window.lucide.createIcons(); }
function formatTime(value) { return value ? new Intl.DateTimeFormat("zh-CN", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" }).format(new Date(value)) : "暂无"; }
function statusClass(status) { return ["已完成", "验证有效"].includes(status) ? "positive" : status === "验证无效" ? "critical" : ["执行中", "待验证"].includes(status) ? "warning" : "neutral"; }
function sourceText(source) {
  if (!source) return "覆盖审计记录";
  return [source.archive_file, source.workbook_file, source.sheet, source.row ? `第 ${source.row} 行` : null, source.column ? `第 ${source.column} 列` : null].filter(Boolean).join(" / ");
}

function diagnosisToolbar(selection = {}) {
  el.toolbar.innerHTML = `<div class="filter-strip control-filter">
    <div class="preset-control"><button class="preset-button" data-range="7">近 7 天</button><button class="preset-button" data-range="30">近 30 天</button><button class="preset-button active" data-range="mtd">本月至今</button></div>
    <div class="date-control"><label>开始<input id="diagnosisFrom" type="date" value="${escapeHtml(selection.date_from || "")}" min="${escapeHtml(selection.available_from || "")}" max="${escapeHtml(selection.available_to || "")}"></label><span class="date-separator">至</span><label>结束<input id="diagnosisTo" type="date" value="${escapeHtml(selection.date_to || "")}" min="${escapeHtml(selection.available_from || "")}" max="${escapeHtml(selection.available_to || "")}"></label><button class="apply-filter-button" id="runDiagnosis" type="button"><i data-lucide="scan-search"></i><span>运行诊断</span></button></div>
    <div class="filter-summary"><strong>${escapeHtml(selection.caliber || "按真实文件口径运行")}</strong><span>${escapeHtml(selection.comparison_label || "自动匹配可用周期")}</span></div>
  </div>`;
  $("#runDiagnosis").addEventListener("click", () => loadDiagnosis($("#diagnosisFrom").value, $("#diagnosisTo").value));
  el.toolbar.querySelectorAll("[data-range]").forEach((button) => button.addEventListener("click", () => {
    const to = $("#diagnosisTo").value || selection.available_to;
    const date = new Date(`${to}T00:00:00`);
    if (button.dataset.range === "mtd") date.setDate(1); else date.setDate(date.getDate() - Number(button.dataset.range) + 1);
    $("#diagnosisFrom").value = date.toLocaleDateString("en-CA");
    el.toolbar.querySelectorAll("[data-range]").forEach((item) => item.classList.toggle("active", item === button));
  }));
  icons();
}

function renderDiagnosis(data, history) {
  if (data.status === "waiting") {
    el.status.textContent = "等待导入";
    el.period.textContent = "尚无可分析周期";
    el.toolbar.innerHTML = "";
    el.content.innerHTML = `<div class="panel-empty">${escapeHtml(data.message)}</div>`;
    return;
  }
  diagnosisToolbar(data.selection);
  el.status.textContent = `${data.summary.issue_count} 个经营问题`;
  el.period.textContent = `${data.selection.date_from} 至 ${data.selection.date_to}`;
  el.sync.textContent = `诊断更新 ${formatTime(data.generated_at)}`;
  const summaries = [
    ["经营问题", data.summary.issue_count, "当前真实文件生成"],
    ["重点问题", data.summary.critical_count, "按严重度排序"],
    ["已确认", data.summary.confirmed_count, "具有直接证据"],
    ["待处理行动", data.summary.open_action_count, "已输出执行中心 JSON"]
  ];
  el.content.innerHTML = `<section class="control-summary-grid">${summaries.map(([label, value, note]) => `<div class="control-summary-item"><span>${label}</span><strong>${value}</strong><small>${note}</small></div>`).join("")}</section>
    <div class="control-section-heading"><div><p class="section-kicker">问题优先级</p><h2>当前经营判断</h2></div><span>${escapeHtml(data.caliber)}</span></div>
    <div class="diagnosis-list">${data.issues.map((issue) => `<article class="diagnosis-item ${escapeHtml(issue.severity)}">
      <div class="diagnosis-priority"><span class="item-marker ${escapeHtml(issue.severity)}"></span><span>${issue.severity === "critical" ? "重点" : "关注"}</span></div>
      <div class="diagnosis-body">
        <div class="diagnosis-title-row"><div><span class="module-label">${escapeHtml(issue.module)}</span><h3>${escapeHtml(issue.title)}</h3></div><span class="confidence-pill">${escapeHtml(issue.confidence)}</span></div>
        <p class="diagnosis-judgment">${escapeHtml(issue.judgment)}</p>
        <div class="impact-line"><strong>影响判断</strong><span>${escapeHtml(issue.impact)}</span></div>
        <div class="evidence-block"><strong>数据证据</strong>${issue.evidence.map((evidence) => `<div class="evidence-row"><div><b>${escapeHtml(evidence.module)} · ${escapeHtml(evidence.period)}</b><span>${escapeHtml(evidence.text)}</span><small>${escapeHtml(sourceText(evidence.source))}</small></div><a href="${escapeHtml(evidence.deep_link)}">下钻查看 <i data-lucide="arrow-up-right"></i></a></div>`).join("")}</div>
      </div>
      <div class="diagnosis-action">${issue.action ? `<span>关联行动</span><strong>${escapeHtml(issue.action.title)}</strong><span class="focus-state ${statusClass(issue.action.status)}">${escapeHtml(issue.action.status)}</span><a href="/actions.html#${escapeHtml(issue.action.id)}">进入处理</a>` : `<span>下一步</span><strong>补齐同期数据后复核</strong><a href="/audit.html">查看缺口</a>`}</div>
    </article>`).join("")}</div>
    <details class="history-panel"><summary><div><i data-lucide="history"></i><strong>诊断历史</strong></div><span>${history.length} 次变化记录</span></summary>${history.length ? history.map((entry) => `<div class="history-row"><strong>${formatTime(entry.recorded_at)}</strong><span>${escapeHtml(entry.selection.date_from)} 至 ${escapeHtml(entry.selection.date_to)}</span><span>${entry.summary.issue_count} 个问题 / ${entry.summary.critical_count} 个重点</span></div>`).join("") : `<div class="panel-empty">首次诊断已记录，发生变化后会新增历史</div>`}</details>`;
  icons();
}

async function loadDiagnosis(from, to) {
  setBusy(true);
  try {
    const query = from && to ? `?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}` : "";
    const [data, historyData] = await Promise.all([fetch(`/api/diagnosis${query}`, { cache: "no-store" }).then(checkJson), fetch("/api/diagnosis/history", { cache: "no-store" }).then(checkJson)]);
    renderDiagnosis(data, historyData.history);
    if (from && to) history.replaceState(null, "", `/diagnosis.html${query}`);
  } catch (error) { renderError(error); } finally { setBusy(false); }
}

function renderActions(data) {
  el.status.textContent = `${data.actions.length} 个行动项`;
  el.period.textContent = `导出更新 ${formatTime(data.generated_at)}`;
  el.toolbar.innerHTML = `<div class="action-toolbar"><span>高优先级且未完成的行动会同步到 <b>today_actions.json</b></span><a href="/api/actions">查看联动数据</a></div>`;
  el.content.innerHTML = `<div class="control-section-heading"><div><p class="section-kicker">执行闭环</p><h2>经营行动清单</h2></div><span>修改后自动本地保存</span></div><div class="action-list">${data.actions.map((action) => `<form class="action-row" id="${escapeHtml(action.id)}" data-action-id="${escapeHtml(action.id)}">
    <div class="action-main"><div class="action-title-row"><span class="priority-tag ${action.priority === "高" ? "high" : "medium"}">${escapeHtml(action.priority)}优先</span><span class="module-label">${escapeHtml(action.module)}</span></div><h3>${escapeHtml(action.title)}</h3><p>${escapeHtml(action.reason)}</p><small>证据周期 ${escapeHtml(action.period)} · ${escapeHtml(sourceText(action.source))}</small></div>
    <label>状态<select name="status">${statuses.map((status) => `<option${status === action.status ? " selected" : ""}>${status}</option>`).join("")}</select></label>
    <label>负责人<input name="owner" value="${escapeHtml(action.owner)}" placeholder="待分配"></label>
    <label>截止日期<input name="due_date" type="date" value="${escapeHtml(action.due_date)}"></label>
    <label class="action-wide">执行备注<textarea name="note" rows="2" placeholder="记录已经做了什么">${escapeHtml(action.note)}</textarea></label>
    <label class="action-wide">验证结果<textarea name="verification" rows="2" placeholder="记录复盘结果和数据变化">${escapeHtml(action.verification)}</textarea></label>
    <div class="action-save"><span>${action.updated_at ? `更新于 ${formatTime(action.updated_at)}` : "尚未人工更新"}</span><button class="apply-filter-button" type="submit"><i data-lucide="save"></i><span>保存</span></button></div>
  </form>`).join("")}</div>`;
  el.content.querySelectorAll(".action-row").forEach((form) => form.addEventListener("submit", saveAction));
  if (location.hash) setTimeout(() => document.querySelector(location.hash)?.scrollIntoView({ behavior: "smooth", block: "center" }), 100);
  icons();
}

async function saveAction(event) {
  event.preventDefault();
  const form = event.currentTarget;
  const button = form.querySelector("button[type=submit]");
  button.disabled = true;
  const payload = Object.fromEntries(new FormData(form).entries());
  try {
    await fetch(`/api/actions/${form.dataset.actionId}`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify(payload) }).then(checkJson);
    button.querySelector("span").textContent = "已保存";
    setTimeout(() => loadActions(), 500);
  } catch (error) { alert(error.message); button.disabled = false; }
}

async function loadActions() { setBusy(true); try { renderActions(await fetch("/api/actions", { cache: "no-store" }).then(checkJson)); } catch (error) { renderError(error); } finally { setBusy(false); } }

function renderAudit(data) {
  el.status.textContent = `${data.summary.modulesWithData}/${data.summary.moduleCount} 模块有数据`;
  el.period.textContent = `${data.summary.totalFiles} 个真实文件`;
  el.toolbar.innerHTML = "";
  el.content.innerHTML = `<section class="control-summary-grid"><div class="control-summary-item"><span>真实文件</span><strong>${data.summary.totalFiles}</strong><small>Excel / CSV / ZIP</small></div><div class="control-summary-item"><span>已有数据模块</span><strong>${data.summary.modulesWithData}</strong><small>共 ${data.summary.moduleCount} 个目录</small></div><div class="control-summary-item"><span>首页文件</span><strong>${data.summary.homepageFiles}</strong><small>已进入自动分析</small></div><div class="control-summary-item"><span>当前缺口</span><strong>${data.summary.moduleCount - data.summary.modulesWithData}</strong><small>等待真实下载</small></div></section>
  <div class="control-section-heading"><div><p class="section-kicker">目录覆盖</p><h2>真实文件识别</h2></div><span>${escapeHtml(data.rawDir)}</span></div><div class="audit-list">${data.modules.map((module) => `<div class="audit-row"><div class="audit-module"><span class="module-icon"><i data-lucide="${module.fileCount ? "folder-check" : "folder-clock"}"></i></span><div><strong>${escapeHtml(module.label)}</strong><small>${escapeHtml(module.folder)} · ${escapeHtml(module.description)}</small></div></div><div><strong>${module.fileCount}</strong><span>个文件</span></div><div><strong>${escapeHtml(module.totalBytesLabel)}</strong><span>总大小</span></div><div><strong>${module.fileCount ? "已识别" : "待下载"}</strong><span>${module.latestModifiedAt ? formatTime(module.latestModifiedAt) : "尚无文件"}</span></div></div>`).join("")}</div>`;
  icons();
}

async function loadAudit() { setBusy(true); try { renderAudit(await fetch("/api/audit", { cache: "no-store" }).then(checkJson)); } catch (error) { renderError(error); } finally { setBusy(false); } }

function renderSystem(data) {
  el.status.textContent = "本地服务正常";
  el.period.textContent = `运行 ${Math.floor(data.service.uptime_seconds / 60)} 分钟`;
  el.toolbar.innerHTML = "";
  const checks = [
    ["本地读取服务", true, `端口 ${data.service.port} · 启动 ${formatTime(data.service.started_at)}`],
    ["标准化数据层", data.data.normalized.every((item) => item.exists), `${data.data.normalized.filter((item) => item.exists).length}/${data.data.normalized.length} 个 JSON 就绪`],
    ["诊断历史", data.diagnosis.history_available, data.diagnosis.latest_recorded_at ? `最近记录 ${formatTime(data.diagnosis.latest_recorded_at)}` : "运行诊断后建立"],
    ["行动联动导出", data.actions.count > 0, `${data.actions.count} 个行动，${data.actions.open_count} 个未关闭`],
    ["便捷启动", data.startup.exists, data.startup.exists ? "启动脚本已就绪" : "启动脚本缺失"],
    ["店铺标识", data.shop_config.configured, data.shop_config.message]
  ];
  el.content.innerHTML = `<div class="control-section-heading"><div><p class="section-kicker">运行检查</p><h2>数据链路状态</h2></div><span>检查于 ${formatTime(data.generated_at)}</span></div><div class="system-checks">${checks.map(([label, ready, detail]) => `<div class="system-check"><span class="system-icon ${ready ? "ready" : "warning"}"><i data-lucide="${ready ? "check" : "triangle-alert"}"></i></span><div><strong>${escapeHtml(label)}</strong><p>${escapeHtml(detail)}</p></div><b>${ready ? "正常" : "待处理"}</b></div>`).join("")}</div>
  <div class="control-section-heading secondary-heading"><div><p class="section-kicker">数据资产</p><h2>标准化文件与审计报告</h2></div><span>仅展示本工作台文件</span></div><div class="asset-grid"><section><h3>标准化数据</h3>${data.data.normalized.map((item) => `<div class="asset-row"><span>${escapeHtml(item.name)}</span><b>${item.exists ? escapeHtml(item.size_label) : "缺失"}</b><small>${item.modified_at ? formatTime(item.modified_at) : "-"}</small></div>`).join("")}</section><section><h3>审计与验收</h3>${data.reports.map((item) => `<div class="asset-row"><span>${escapeHtml(item.name)}</span><b>${escapeHtml(item.size_label)}</b><small>${formatTime(item.modified_at)}</small></div>`).join("")}</section></div>`;
  icons();
}

async function loadSystem() { setBusy(true); try { renderSystem(await fetch("/api/system", { cache: "no-store" }).then(checkJson)); } catch (error) { renderError(error); } finally { setBusy(false); } }
async function checkJson(response) { const data = await response.json(); if (!response.ok) throw new Error(data.detail || data.message || `接口返回 ${response.status}`); return data; }
function renderError(error) { el.status.textContent = "读取失败"; el.sync.textContent = "需要检查"; el.content.innerHTML = `<div class="panel-empty">${escapeHtml(error.message)}</div>`; }
function setBusy(busy) { el.refresh.disabled = busy; el.sync.textContent = busy ? "正在读取" : "真实数据已更新"; }

const current = meta[view];
document.title = `${current.title} · 生意参谋数据工作台`;
el.title.textContent = current.title; el.eyebrow.textContent = current.eyebrow; el.description.textContent = current.description;
document.querySelector(`[data-view="${view}"]`)?.classList.add("active");
const loaders = { diagnosis: () => { const params = new URLSearchParams(location.search); return loadDiagnosis(params.get("from"), params.get("to")); }, actions: loadActions, audit: loadAudit, system: loadSystem };
el.refresh.addEventListener("click", loaders[view]);
icons(); loaders[view]();
