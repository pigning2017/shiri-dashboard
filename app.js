"use strict";
const readonly = Boolean(window.__SHIRI_DATA__);
const $ = (s) => document.querySelector(s);
const esc = (x) =>
  String(x ?? "").replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ],
  );
const num = (x, n = 2) => (x == null ? "—" : Number(x).toFixed(n));
const pct = (x) =>
  x == null ? "—" : `${x >= 0 ? "+" : ""}${(x * 100).toFixed(2)}%`;
const color = (x) => (x == null || x === 0 ? "neutral" : x > 0 ? "up" : "down");
const labels = { pending: "待复核", watch: "待观察", rejected: "已排除" };
function remembered() {
  if (readonly) return null;
  try {
    return localStorage.getItem("shiri-dataset");
  } catch {
    return null;
  }
}
function remember(dataset) {
  if (readonly) return;
  try {
    localStorage.setItem("shiri-dataset", dataset);
  } catch {
    /* Storage is optional. */
  }
}
const state = {
  datasets: [],
  strategies: [],
  strategy: "ma",
  candidates: [],
  selected: null,
  detail: null,
  descending: true,
  request: 0,
  dateRequest: 0,
  detailRequest: 0,
  dirty: false,
  jobs: [],
  dataset: remembered(),
  date: null,
  runId: null,
};
let toastTimer;
const arrow = '<span aria-hidden="true">→</span>';
document.addEventListener("pointerdown", () => { document.documentElement.dataset.input = "pointer"; });
document.addEventListener("keydown", () => { document.documentElement.dataset.input = "keyboard"; }, true);

function resetSummary(message) {
  ["stat-universe", "stat-hits", "stat-pending", "stat-watch", "watch-count", "all-count"].forEach((id) => {
    $(`#${id}`).textContent = "—";
  });
  $("#stat-universe-sub").textContent = "";
  $("#stat-strategy").textContent = "";
  $("#data-summary").textContent = message;
  $("#data-notice").textContent = message;
  $("#quality-details").classList.remove("warning");
  $("#result-count").textContent = "0";
  $("#export").disabled = true;
}

function showCoverage(result) {
  const c = result.coverage, d = result.dataset;
  const age = (Date.now() - new Date(`${state.date}T23:59:59+08:00`).getTime()) / 86400000;
  const attention = (c.stale ?? 0) + (c.insufficient ?? 0) + (c.pending_factors ?? 0) + (c.gaps ?? 0) + (c.no_bars ?? 0);
  const warning = d.id !== "baostock" || age > 5 || d.status !== "ready" || attention > 0;
  $("#quality-details").classList.toggle("warning", warning);
  $("#data-summary").textContent = `${state.date} · ${d.id === "baostock" ? "前复权" : "封存数据"} · ${age > 5 ? "日期较旧" : d.status !== "ready" ? "覆盖不完整" : attention ? "有排除项" : "数据已就绪"}`;
  $("#data-notice").innerHTML = `<p>${esc(d.label)} · ${esc(d.adjustment)}</p>
    <dl class="quality-grid"><div><dt>股票池 / 预期</dt><dd>${num(c.universe ?? 0, 0)} / ${num(c.expected ?? 0, 0)}</dd></div>
    <div><dt>当日有效日线</dt><dd>${num(c.on_date ?? 0, 0)}</dd></div>
    <div><dt>日期未对齐</dt><dd>${num(c.stale ?? 0, 0)}</dd></div>
    <div><dt>历史不足</dt><dd>${num(c.insufficient ?? 0, 0)}</dd></div>
    <div><dt>待复权校准</dt><dd>${num(c.pending_factors ?? 0, 0)}</dd></div>
    <div><dt>日线缺口</dt><dd>${num(c.gaps ?? 0, 0)}</dd></div>
    <div><dt>尚无日线</dt><dd>${num(c.no_bars ?? 0, 0)}</dd></div>
    <div><dt>排除创业板</dt><dd>${num(c.excluded_board ?? 0, 0)}</dd></div></dl>
    <p class="quality-help">不符合数据条件的股票不参与筛选。${d.id !== "baostock" ? "旧数据未重新核验，请优先使用持续更新数据集。" : "行情来自 BaoStock，按筛选日归一。"}${age > 5 ? " 所选日期距今超过 5 天。" : ""}</p>`;
}

function toast(message, error = false) {
  $("#toast").textContent = message;
  $("#toast").classList.toggle("error", error);
  $("#toast").hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(
    () => ($("#toast").hidden = true),
    error ? 6500 : 2800,
  );
}
function staticApi(url, options = {}) {
  const data = window.__SHIRI_DATA__;
  const u = new URL(url, "https://snapshot.invalid");
  const method = (options.method || "GET").toUpperCase();
  const screenRead = u.pathname === "/api/screen" && ["GET", "POST"].includes(method);
  if (u.origin !== "https://snapshot.invalid" || (method !== "GET" && !screenRead))
    throw new Error("公开快照为只读，不支持写入");
  for (const [key, expected] of [["dataset", data.dataset.id], ["date", data.date], ["exclude_chinext", "true"]]) {
    if (u.searchParams.has(key) && u.searchParams.get(key) !== expected)
      throw new Error("公开快照仅包含固定交易日与筛选条件");
  }
  // Neutral UI placeholders are created here only, never read from a private review.
  const neutral = () => ({state: "pending", note: ""});
  if (u.pathname === "/api/datasets") return structuredClone([data.dataset]);
  if (u.pathname === "/api/dates") return [data.date];
  if (u.pathname === "/api/strategies") return structuredClone(data.strategies);
  if (screenRead) {
    const strategy = u.searchParams.get("strategy") || "ma";
    if (!Object.hasOwn(data.results, strategy)) throw new Error("快照中没有该策略");
    const result = structuredClone(data.results[strategy]);
    result.candidates.forEach(c => { c.review = neutral(); });
    return result;
  }
  if (u.pathname.startsWith("/api/stocks/")) {
    const symbol = decodeURIComponent(u.pathname.slice("/api/stocks/".length));
    if (!Object.hasOwn(data.stocks, symbol)) throw new Error("快照中没有该候选");
    return {...structuredClone(data.stocks[symbol]), review: neutral()};
  }
  throw new Error("公开快照不支持此操作");
}
async function api(url, options = {}) {
  if (readonly) return staticApi(url, options);
  const r = await fetch(url, {
    headers: { "Content-Type": "application/json" },
    ...options,
  });
  if (!r.ok) {
    const b = await r.json().catch(() => ({}));
    throw new Error(
      typeof b.detail === "string" ? b.detail : `请求失败 (${r.status})`,
    );
  }
  return r.json();
}
function params(extra = {}) {
  return new URLSearchParams({
    dataset: state.dataset,
    date: state.date,
    ...extra,
  });
}
function discardNote() {
  if (!state.dirty) return true;
  if (!window.confirm("这条复核笔记还没有保存，是否放弃修改？")) return false;
  state.dirty = false;
  return true;
}
function drawStrategies() {
  const focused = document.activeElement?.dataset.strategy;
  $("#strategy-list").innerHTML = state.strategies
    .map(
      (s, i) =>
        `<button class="strategy ${s.id === state.strategy ? "selected" : ""}" data-strategy="${esc(s.id)}" aria-pressed="${s.id === state.strategy}" title="${esc(s.description)}"><span class="num">0${i + 1}</span>${esc(s.name)}</button>`,
    )
    .join("");
  if (focused) $("#strategy-list").querySelector(`[data-strategy="${focused}"]`)?.focus({ preventScroll: true });
  $("#strategy-list")
    .querySelectorAll("button")
    .forEach(
      (b) =>
        (b.onclick = () => {
          if (!discardNote()) return;
          state.strategy = b.dataset.strategy;
          drawStrategies();
          runScreen();
        }),
    );
}
async function loadDatasets(preferred = null) {
  state.datasets = (await api("/api/datasets")).filter(
    (d) =>
      d.has_data && ["ready", "partial"].includes(d.status),
  );
  $("#dataset").innerHTML = state.datasets.length
    ? state.datasets
        .map(
          (d) =>
            `<option value="${esc(d.id)}">${esc(d.label)}${d.status === "partial" ? " · 待补齐" : ""}</option>`,
        )
        .join("")
    : '<option value="">尚无本地数据</option>';
  const selected = preferred || state.dataset;
  if (state.datasets.some((d) => d.id === selected))
    $("#dataset").value = selected;
  state.dataset = $("#dataset").value;
  await loadDates();
}
async function loadDates() {
  const request = ++state.dateRequest,
    dataset = state.dataset;
  const screenRequest = ++state.request;
  ++state.detailRequest;
  if (!state.dataset) {
    $("#date").innerHTML = '<option value="">—</option>';
    state.date = null;
    showNoData();
    return;
  }
  remember(dataset);
  state.date = null;
  state.candidates = [];
  state.runId = null;
  resetSummary("正在读取交易日…");
  emptyDetail();
  $("#candidates").innerHTML = '<div class="empty">正在读取交易日…</div>';
  $("#candidates").setAttribute("aria-busy", "true");
  $("#date").disabled = true;
  $("#run-screen").disabled = true;
  try {
    const dates = await api(`/api/dates?${new URLSearchParams({ dataset })}`);
    if (request !== state.dateRequest) return;
    $("#date").innerHTML = dates.map((d) => `<option>${esc(d)}</option>`).join("");
    state.date = dates[0] || null;
    if (!state.date) {
      showNoData();
      return;
    }
    $("#date").disabled = readonly;
    await runScreen();
  } catch (error) {
    if (request !== state.dateRequest) return;
    $("#date").innerHTML = '<option value="">读取失败</option>';
    resetSummary("交易日读取失败 · 请刷新重试");
    $("#candidates").innerHTML = `<div class="empty"><strong>交易日读取失败</strong>${esc(error.message)}</div>`;
    toast(error.message, true);
  } finally {
    if (request === state.dateRequest && screenRequest === state.request)
      $("#candidates").setAttribute("aria-busy", "false");
  }
}
function showNoData() {
  state.candidates = [];
  state.runId = null;
  resetSummary("尚无本地日线 · 请先同步");
  $("#candidates").setAttribute("aria-busy", "false");
  emptyDetail();
  $("#run-screen").disabled = true;
  $("#data-notice").textContent =
    "还没有本地日线。点击“更新免费日线”开始按交易日获取全市场行情。";
  $("#candidates").innerHTML =
    '<div class="empty"><strong>尚无本地日线</strong>通过右上角“更新日线”获取真实行情。</div>';
}
async function runScreen() {
  if (!state.dataset || !state.date) return;
  const request = ++state.request;
  ++state.detailRequest;
  state.detail = null;
  state.selected = null;
  state.candidates = [];
  state.runId = null;
  resetSummary(`${state.date} · 正在筛选`);
  $("#candidates").setAttribute("aria-busy", "true");
  $("#detail").setAttribute("aria-busy", "true");
  $("#run-screen").disabled = true;
  $("#run-screen").textContent = "正在筛选…";
  $("#candidates").innerHTML = '<div class="empty">正在应用策略…</div>';
  $("#detail").innerHTML =
    '<div class="detail-placeholder"><h2>正在整理候选日线</h2></div>';
  try {
    const result = await api(
      `/api/screen?${params({ strategy: state.strategy, exclude_chinext: $("#exclude-chinext").checked })}`, { method: "POST" },
    );
    if (request !== state.request) return;
    state.candidates = result.candidates;
    state.runId = result.run_id;
    const c = result.coverage;
    $("#stat-universe").textContent = (c.on_date ?? 0).toLocaleString();
    $("#stat-universe-sub").textContent =
      `覆盖 ${c.universe ?? 0} 只 / 预期 ${c.expected ?? 0} 只`;
    $("#stat-strategy").textContent =
      state.strategies.find((s) => s.id === state.strategy)?.name || "";
    showCoverage(result);
    updateStats();
    drawList();
    const visible = visibleCandidates();
    if (visible.length) await selectStock(visible[0].symbol);
    else emptyDetail();
  } catch (error) {
    if (request !== state.request) return;
    resetSummary(`${state.date} · 筛选失败`);
    toast(error.message, true);
    $("#candidates").innerHTML =
      `<div class="empty"><strong>这次筛选未完成</strong>${esc(error.message)}</div>`;
    emptyDetail();
  } finally {
    if (request === state.request) {
      $("#run-screen").disabled = false;
      $("#run-screen").innerHTML = `运行初筛 ${arrow}`;
      $("#candidates").setAttribute("aria-busy", "false");
    }
  }
}
function updateStats() {
  const items = state.candidates;
  if (readonly) {
    $("#stat-hits").textContent = items.length;
    $("#all-count").textContent = items.length;
    return;
  }
  const watch = items.filter((c) => c.review.state === "watch").length;
  $("#stat-hits").textContent = items.length;
  $("#stat-pending").textContent = items.filter(
    (c) => c.review.state === "pending",
  ).length;
  $("#stat-watch").textContent = watch;
  $("#watch-count").textContent = watch;
  $("#all-count").textContent = items.length;
}
function visibleCandidates() {
  const search = $("#search").value.trim().toLowerCase(),
    review = $("#review-filter").value;
  return state.candidates
    .filter(
      (c) =>
        `${c.name} ${c.symbol}`.toLowerCase().includes(search) &&
        (readonly || review === "all" || c.review.state === review),
    )
    .sort(
      (a, b) =>
        (state.descending ? -1 : 1) * (a.ten_day_return - b.ten_day_return),
    );
}
function drawList() {
  const focused = document.activeElement?.dataset.symbol;
  const items = visibleCandidates();
  $("#export").disabled = !items.length;
  ["all", "watch"].forEach((view) => {
    const active = $("#review-filter").value === view;
    $(`#${view}-nav`).classList.toggle("active", active);
    $(`#${view}-nav`).setAttribute("aria-pressed", String(active));
  });
  $("#result-count").textContent = items.length;
  $("#candidates").innerHTML = items.length
    ? items
        .map(
          (c) =>
            `<button class="stock-row ${state.selected === c.symbol ? "selected" : ""}" data-symbol="${esc(c.symbol)}" aria-pressed="${state.selected === c.symbol}"><div><div class="stock-name">${esc(c.name)}</div><div class="stock-code">${esc(c.symbol.toUpperCase())}</div></div><div><span class="stock-return ${color(c.ten_day_return)}">${pct(c.ten_day_return)}</span>${readonly ? "" : `<span class="review-label ${c.review.state}">${labels[c.review.state]}</span>`}</div></button>`,
        )
        .join("")
    : `<div class="empty"><strong>${state.candidates.length ? "没有匹配的候选" : "这个交易日没有命中"}</strong>${state.candidates.length ? "试试其他名称、代码或复核状态。" : "可以切换策略，或选择其他交易日。"}</div>`;
  if (focused) $("#candidates").querySelector(`[data-symbol="${focused}"]`)?.focus({ preventScroll: true });
  $("#candidates")
    .querySelectorAll("button")
    .forEach(
      (b) =>
        (b.onclick = () => {
          if (discardNote()) selectStock(b.dataset.symbol);
        }),
    );
  $("#list-footer").textContent =
    `显示 ${items.length} / ${state.candidates.length} 只 · 涨幅按第 1 日至第 10 日收盘计算`;
}
function emptyDetail() {
  state.detail = null;
  state.selected = null;
  $("#detail").setAttribute("aria-busy", "false");
  $("#detail").innerHTML =
    '<div class="detail-placeholder"><h2>暂无个股详情</h2><p>选择其他策略、日期，或从候选列表选择股票。</p></div>';
}
async function selectStock(symbol) {
  const request = ++state.detailRequest;
  state.selected = symbol;
  state.detail = null;
  $("#detail").setAttribute("aria-busy", "true");
  drawList();
  $("#detail").innerHTML =
    '<div class="detail-placeholder"><h2>正在读取最近十天…</h2></div>';
  try {
    const detail = await api(
      `/api/stocks/${encodeURIComponent(symbol)}?${params({ run_id: state.runId })}`,
    );
    if (request !== state.detailRequest) return;
    state.detail = detail;
    state.dirty = false;
    drawDetail();
    $("#detail").setAttribute("aria-busy", "false");
  } catch (error) {
    if (request === state.detailRequest) {
      emptyDetail();
      toast(error.message, true);
    }
  }
}
function candleChart(bars) {
  const w = 740,
    h = 260,
    pad = { l: 22, r: 58, t: 17, b: 28 };
  const prices = bars
    .flatMap((b) => [b.low, b.high, b.ma5, b.ma10])
    .filter((v) => v != null);
  let lo = Math.min(...prices),
    hi = Math.max(...prices),
    range = hi - lo || hi * 0.05 || 1;
  lo -= range * 0.13;
  hi += range * 0.13;
  range = hi - lo;
  const y = (v) => pad.t + ((hi - v) / range) * (h - pad.t - pad.b),
    step = (w - pad.l - pad.r) / 10,
    x = (i) => pad.l + step * (i + 0.5);
  let svg = `<svg class="chart" viewBox="0 0 ${w} ${h}" role="img" aria-label="最近 10 个交易日日 K 线与 MA5、MA10；红色上涨，绿色下跌"><rect width="${w}" height="${h}" fill="var(--surface)"/>`;
  for (let i = 0; i < 5; i++) {
    const v = hi - (range * i) / 4,
      yy = y(v);
    svg += `<line x1="${pad.l}" x2="${w - pad.r}" y1="${yy}" y2="${yy}" stroke="var(--chart-grid)" stroke-dasharray="3 4"/><text x="${w - pad.r + 10}" y="${yy + 4}">${num(v)}</text>`;
  }
  bars.forEach((b, i) => {
    const xx = x(i),
      cc = b.close >= b.open ? "var(--chart-up)" : "var(--chart-down)";
    svg += `<line x1="${xx}" x2="${xx}" y1="${y(b.high)}" y2="${y(b.low)}" stroke="${cc}" stroke-width="1.5"/><rect x="${xx - 12}" y="${Math.min(y(b.open), y(b.close))}" width="24" height="${Math.max(Math.abs(y(b.open) - y(b.close)), 1.5)}" rx="1" fill="${cc}"/><text x="${xx}" y="${h - 7}" text-anchor="middle">${esc(b.date.slice(5))}</text>`;
  });
  [
    ["ma5", "var(--ma5)"],
    ["ma10", "var(--ma10)"],
  ].forEach(([key, cc]) => {
    let points = [];
    const flush = () => {
      if (points.length)
        svg += `<polyline points="${points.join(" ")}" fill="none" stroke="${cc}" stroke-width="1.8" stroke-linejoin="round"/>`;
      points = [];
    };
    bars.forEach((b, i) => {
      if (b[key] == null) flush();
      else points.push(`${x(i)},${y(b[key])}`);
    });
    flush();
  });
  bars.forEach(
    (b, i) =>
      (svg += `<rect class="cross-area" x="${pad.l + step * i}" y="0" width="${step}" height="${h}" fill="transparent"><title>${esc(b.date)}\n开 ${num(b.open)} / 高 ${num(b.high)}\n低 ${num(b.low)} / 收 ${num(b.close)}\n涨跌 ${pct(b.rate)}\nMA5 ${num(b.ma5)} / MA10 ${num(b.ma10)}</title></rect>`),
  );
  return svg + "</svg>";
}
function drawDetail() {
  const d = state.detail,
    b = d.bars.at(-1),
    hit = state.candidates.find((c) => c.symbol === d.symbol);
  const reason = hit
    ? state.strategies.find((s) => s.id === state.strategy).description
    : "";
  $("#detail").innerHTML =
    `<div class="detail-heading"><div><h2>${esc(d.name)}<small>${esc(d.symbol.toUpperCase())}</small></h2><div class="detail-sub">${esc(d.date)} · ${esc(d.dataset.adjustment)} · 最近 ${d.bars.length} 个交易日</div></div><div class="portal-links"><a href="${esc(d.links.eastmoney)}" target="_blank" rel="noopener noreferrer">东方财富 ↗</a><a href="${esc(d.links.sina)}" target="_blank" rel="noopener noreferrer">新浪财经 ↗</a></div></div>
    <div class="price-row"><strong>${num(b.close)}</strong><span class="${color(b.rate)}">${pct(b.rate)}</span><small>所选日收盘 / 当日涨跌</small></div>
    <div class="chart-header"><span>日 K 线 <small> / 10D</small></span><div class="chart-legend"><span>MA5 ${num(b.ma5)}</span><span>MA10 ${num(b.ma10)}</span></div></div>
    <div class="chart-wrap">${candleChart(d.bars)}</div>
    <div class="detail-evidence">策略依据 · ${esc(reason)}${readonly ? "" : ` · <a href="/api/runs/${esc(state.runId)}" target="_blank" rel="noopener">本次筛选记录 ↗</a>`}<br>外站默认展示最新行情，历史复核请按上方日期定位，并选择相同复权口径。</div>
    <details><summary class="table-toggle">展开 10 日日线明细</summary><div class="table-wrap"><table class="ohlc-table"><thead><tr><th>日期</th><th>开盘</th><th>最高</th><th>最低</th><th>收盘</th><th>涨跌幅</th></tr></thead><tbody>${d.bars.map((r) => `<tr><td>${esc(r.date)}</td><td>${num(r.open)}</td><td>${num(r.high)}</td><td>${num(r.low)}</td><td>${num(r.close)}</td><td class="${color(r.rate)}">${pct(r.rate)}</td></tr>`).join("")}</tbody></table></div></details>
    <div class="review-area"><div class="review-toolbar"><span>复核记录</span><div class="review-buttons">${Object.entries(
      labels,
    )
      .map(
        ([k, v]) =>
          `<button data-review="${k}" class="${d.review.state === k ? "active" : ""}" aria-pressed="${d.review.state === k}">${v}</button>`,
      )
      .join(
        "",
      )}</div></div><div class="note-row"><textarea id="review-note" maxlength="2000" aria-label="复核笔记" placeholder="记下形态、关注价位或排除原因…">${esc(d.review.note)}</textarea><button id="save-note" class="button secondary">保存笔记</button></div><div class="note-state" id="note-state">${d.review.note ? "笔记已保存于当前数据集与日期" : "复核记录按数据集、股票和日期保存"}</div></div>`;
  if (readonly) {
    $("#detail .review-area").remove();
    return;
  }
  $("#review-note").oninput = () => {
    state.dirty = true;
    $("#note-state").textContent = "笔记尚未保存";
  };
  $("#save-note").onclick = () => saveReview(d.review.state);
  document
    .querySelectorAll("[data-review]")
    .forEach((el) => (el.onclick = () => saveReview(el.dataset.review)));
}
async function saveReview(reviewState) {
  if (readonly) throw new Error("公开快照为只读");
  const d = state.detail,
    note = $("#review-note").value;
  if (!d) return;
  const identity = `${d.dataset.id}/${d.date}/${d.symbol}`;
  document
    .querySelectorAll("[data-review],#save-note,#review-note")
    .forEach((b) => (b.disabled = true));
  try {
    await api("/api/reviews", {
      method: "POST",
      body: JSON.stringify({
        dataset: d.dataset.id,
        date: d.date,
        symbol: d.symbol,
        state: reviewState,
        note,
      }),
    });
    if (
      !state.detail ||
      identity !==
        `${state.detail.dataset.id}/${state.detail.date}/${state.detail.symbol}`
    )
      return;
    d.review = { state: reviewState, note };
    state.dirty = false;
    const hit = state.candidates.find((c) => c.symbol === d.symbol);
    if (hit) hit.review = d.review;
    const restoreSaveFocus = document.activeElement === document.body ||
      document.activeElement?.matches("#save-note, #review-note, [data-review]");
    updateStats();
    drawList();
    drawDetail();
    toast("复核已保存");
    if (restoreSaveFocus) $("#save-note").focus({ preventScroll: true });
  } catch (e) {
    toast(e.message, true);
  } finally {
    document
      .querySelectorAll("[data-review],#save-note,#review-note")
      .forEach((b) => (b.disabled = false));
  }
}
async function pollJobs() {
  if (readonly) return;
  try {
    const previous = state.jobs;
    state.jobs = await api("/api/jobs");
    const active = state.jobs.find((j) =>
      ["queued", "running"].includes(j.status),
    );
    $("#job-banner").hidden = !active;
    if (active)
      $("#job-banner").textContent =
        `↻ ${active.message || "正在准备同步…"} · 成功 ${active.succeeded} / 失败 ${active.failed} · 可关闭浏览器继续后台同步`;
    $("#start-sync").disabled = !!active;
    $("#start-sync").textContent = active
      ? "日线同步中…"
      : "开始同步 →";
    $("#job-history").innerHTML = state.jobs.length
      ? state.jobs
          .map(
            (j) =>
              `<div class="job-record">${esc(j.message || "准备同步")}<br><small>${esc(new Date(j.created_at).toLocaleString("zh-CN"))} · ${esc({ completed: "完成", failed: "失败", partial: "部分完成", running: "运行中", queued: "排队中" }[j.status] || j.status)}</small>${j.errors.length ? `<details><summary>查看 ${j.failed} 条失败（最多展示 100 条）</summary>${j.errors.map((e) => `${esc(e.symbol)} · ${esc(e.message)}`).join("<br>")}</details>` : ""}</div>`,
          )
          .join("")
      : "暂无同步记录";
    const ended = state.jobs.find(
      (j) =>
        !["queued", "running"].includes(j.status) &&
        previous.some(
          (p) => p.id === j.id && ["queued", "running"].includes(p.status),
        ),
    );
    if (
      active?.dataset &&
      active.succeeded &&
      !state.datasets.some((d) => d.id === active.dataset) &&
      !state.dirty
    )
      await loadDatasets(state.dataset);
    if (ended) {
      toast(ended.message, ended.status === "failed");
      $("#sync-feedback").textContent = ended.message;
      if (ended.succeeded && !state.dirty) await loadDatasets(ended.dataset);
    }
  } catch (e) {
    $("#sync-feedback").textContent =
      "无法读取同步状态，请确认本地服务正在运行。";
  }
}
function exportCSV() {
  const rows = visibleCandidates();
  if (!rows.length) {
    toast("当前没有可导出的候选");
    return;
  }
  const cell = (x) =>
    `"${String(x ?? "")
      .replace(/^[=+\-@\t\r]/, "'$&")
      .replaceAll('"', '""')}"`;
  const data = [
    [
      "代码",
      "名称",
      "筛选日期",
      "策略",
      "数据集",
      "筛选记录",
      "收盘价",
      "10日涨幅",
      "复核状态",
      "笔记",
      "东方财富",
    ],
    ...rows.map((c) => [
      c.symbol,
      c.name,
      state.date,
      state.strategy,
      state.dataset,
      state.runId,
      c.last_price,
      pct(c.ten_day_return),
      labels[c.review.state],
      c.review.note,
      c.links.eastmoney,
    ]),
  ];
  const blob = new Blob(
    ["\ufeff" + data.map((r) => (readonly ? r.filter((_, i) => ![5, 8, 9].includes(i)) : r).map(cell).join(",")).join("\r\n")],
    { type: "text/csv;charset=utf-8" },
  );
  const url = URL.createObjectURL(blob),
    a = document.createElement("a");
  a.href = url;
  a.download = `拾日-${state.date}-${state.strategy}.csv`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
$("#dataset").onchange = async () => {
  if (!discardNote()) {
    $("#dataset").value = state.dataset;
    return;
  }
  state.dataset = $("#dataset").value;
  await loadDates();
};
$("#date").onchange = () => {
  if (!discardNote()) {
    $("#date").value = state.date;
    return;
  }
  state.date = $("#date").value;
  runScreen();
};
$("#run-screen").onclick = () => {
  if (discardNote()) runScreen();
};
$("#exclude-chinext").onchange = () => {
  if (discardNote()) runScreen();
  else $("#exclude-chinext").checked = !$("#exclude-chinext").checked;
};
$("#search").oninput = drawList;
$("#review-filter").onchange = () => {
  drawList();
};
$("#sort").onclick = () => {
  state.descending = !state.descending;
  $("#sort").textContent = `10 日涨幅 ${state.descending ? "↓" : "↑"}`;
  drawList();
};
$("#export").onclick = exportCSV;
$("#all-nav").onclick = () => {
  $("#review-filter").value = "all";
  drawList();
};
$("#watch-nav").onclick = () => {
  $("#review-filter").value = "watch";
  drawList();
};
$("#sync-open").onclick = $("#data-settings").onclick = () => {
  $("#sync-dialog").showModal();
  pollJobs();
};
$("#close-dialog").onclick = () => $("#sync-dialog").close();
document.addEventListener("pointerdown", (event) => {
  if (!$("#quality-details").contains(event.target)) $("#quality-details").open = false;
});
document.addEventListener("keydown", (event) => {
  if (event.key === "Escape" && $("#quality-details").open && !$("#sync-dialog").open) {
    $("#quality-details").open = false;
    $("#quality-details summary").focus();
  }
});
$("#sync-scope").onchange = () => {
  $("#custom-symbols-label").hidden = $("#sync-scope").value !== "custom";
};
$("#start-sync").onclick = async () => {
  $("#start-sync").disabled = true;
  try {
    const body = { workers: Number($("#sync-workers").value), days: 40 };
    if ($("#sync-scope").value === "custom")
      body.symbols = $("#custom-symbols")
        .value.split(/[,，\s]+/)
        .map((x) => x.trim().toLowerCase())
        .filter(Boolean);
    await api("/api/sync", { method: "POST", body: JSON.stringify(body) });
    $("#sync-feedback").textContent =
      "同步已开始，可以关闭此窗口继续检查股票。";
    await pollJobs();
  } catch (e) {
    $("#sync-feedback").textContent = e.message;
    $("#start-sync").disabled = false;
  }
};
window.addEventListener("beforeunload", (e) => {
  if (state.dirty) {
    e.preventDefault();
    e.returnValue = "";
  }
});
function setupReadonly() {
  if (!readonly) return;
  document.documentElement.dataset.mode = "readonly";
  ["#dataset", "#date", "#exclude-chinext"].forEach(selector => { $(selector).disabled = true; });
  $("#exclude-chinext").checked = true;
  document.querySelectorAll("#sync-open, #data-settings, #watch-nav, #review-filter, #run-screen, #sync-dialog, .sidebar-footer a")
    .forEach(el => { el.hidden = true; el.style.setProperty("display", "none", "important"); });
  ["#stat-pending", "#stat-watch"].forEach(selector => {
    const el = $(selector).closest(".compact-stat");
    el.hidden = true;
    el.style.setProperty("display", "none", "important");
  });
  $(".local-status").textContent = "公开只读 · BaoStock";
  $(".topbar-title span").textContent = `交易日 ${window.__SHIRI_DATA__.date} · 生成于 ${window.__SHIRI_DATA__.generated_at.replace("T", " ")} · 只读快照`;
}
(async () => {
  try {
    setupReadonly();
    state.strategies = await api("/api/strategies");
    drawStrategies();
    await loadDatasets();
    await pollJobs();
  } catch (e) {
    toast(e.message, true);
    resetSummary("读取失败 · 请刷新重试");
    $("#run-screen").disabled = true;
    $("#candidates").setAttribute("aria-busy", "false");
    $("#candidates").innerHTML = '<div class="empty"><strong>读取失败</strong>确认本地服务运行后刷新页面。</div>';
    emptyDetail();
    $("#data-notice").textContent = "读取本地数据失败，请确认服务状态后刷新。";
  }
  if (!readonly) setInterval(pollJobs, 2500);
})();
