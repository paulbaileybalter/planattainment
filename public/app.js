/* =========================================================================
   Balter Brewing — Production Plan Attainment dashboard
   Parses the "Live Brewery Board" workbook (Plan for WC ###### / Attainment
   of WC ######) entirely client-side and renders daily + weekly attainment.
   ========================================================================= */

const DAY_START_COLS = [1, 4, 7, 10, 13, 16, 19]; // 0-indexed cols B,E,H,K,N,Q,T
const DAY_NAMES = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
const DAY_FULL = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"];

const CATEGORIES = [
  { key: "dme", label: "DME Brew", group: "Brewing", unit: "brews", color: "var(--teal)" },
  { key: "krones", label: "Krones Brew", group: "Brewing", unit: "brews", color: "var(--sky)" },
  { key: "cartons", label: "Cartons", group: "Packaging", unit: "cases", color: "var(--orange)" },
  { key: "kegs", label: "Kegs", group: "Packaging", unit: "kegs", color: "var(--purple)" },
];

const BREW_RE = /^([A-Za-z]{2,})X(\d{1,2})$/;
const SKU_PREFIX_RE = /^([A-Za-z]+)/;

let workbookWeeks = []; // [{ id, label, dateLabel, mondayDate, plan, actual, hasActual }]
let currentWeekIndex = -1;
let currentTab = "week"; // "week" | 0..6 (day index)

// ---------------------------------------------------------------------------
// Sheet helpers
// ---------------------------------------------------------------------------

function cellStr(v) {
  return typeof v === "string" ? v.trim() : "";
}

function findLabelRow(aoa, matcher, fromRow) {
  for (let r = fromRow; r < aoa.length; r++) {
    const v = cellStr(aoa[r] && aoa[r][0]);
    if (v && matcher(v)) return r;
  }
  return -1;
}

function findNextLabelRow(aoa, fromRow) {
  for (let r = fromRow + 1; r < aoa.length; r++) {
    const v = cellStr(aoa[r] && aoa[r][0]);
    if (v) return r;
  }
  return aoa.length;
}

function emptyDayTotals() {
  // per category -> per day index (0-6) -> { total, skus: {sku: qty} }
  const out = {};
  for (const c of CATEGORIES) {
    out[c.key] = [];
    for (let d = 0; d < 7; d++) out[c.key].push({ total: 0, skus: {} });
  }
  return out;
}

function addQty(bucket, day, sku, qty) {
  if (!qty) return;
  bucket[day].total += qty;
  bucket[day].skus[sku] = (bucket[day].skus[sku] || 0) + qty;
}

function extractBrews(aoa, range, bucket) {
  const [start, end] = range;
  if (start < 0) return;
  for (let r = start; r < Math.min(end, aoa.length); r++) {
    const row = aoa[r];
    if (!row) continue;
    for (let d = 0; d < 7; d++) {
      const base = DAY_START_COLS[d];
      for (let off = 0; off < 3; off++) {
        const raw = cellStr(row[base + off]);
        if (!raw) continue;
        const m = raw.match(BREW_RE);
        if (m) addQty(bucket, d, m[1].toUpperCase(), parseInt(m[2], 10));
      }
    }
  }
}

function extractPackaging(aoa, range, bucket) {
  const [start, end] = range;
  if (start < 0) return;
  for (let r = start; r < Math.min(end, aoa.length); r++) {
    const row = aoa[r];
    if (!row) continue;
    for (let d = 0; d < 7; d++) {
      const base = DAY_START_COLS[d];
      const qty = row[base + 2];
      if (typeof qty === "number" && qty > 0) {
        const nameRaw = cellStr(row[base]);
        const skuMatch = nameRaw.match(SKU_PREFIX_RE);
        const sku = skuMatch ? skuMatch[1].toUpperCase() : "OTHER";
        addQty(bucket, d, sku, qty);
      }
    }
  }
}

function parseSheet(ws) {
  const aoa = XLSX.utils.sheet_to_json(ws, { header: 1, raw: true, defval: null });

  const dateRow = findLabelRow(aoa, (v) => v.toLowerCase() === "date", 0);
  const dates = [];
  if (dateRow >= 0) {
    for (const col of DAY_START_COLS) {
      const v = aoa[dateRow][col];
      dates.push(v instanceof Date ? v : null);
    }
  }

  const dmeRow = findLabelRow(aoa, (v) => /^dme brew$/i.test(v), 0);
  const kronesRow = findLabelRow(aoa, (v) => /^krones brew$/i.test(v), dmeRow >= 0 ? dmeRow + 1 : 0);
  const cartonsRow = findLabelRow(aoa, (v) => /^cartons$/i.test(v), kronesRow >= 0 ? kronesRow + 1 : 0);
  const kegsRow = findLabelRow(aoa, (v) => /^kegs$/i.test(v), cartonsRow >= 0 ? cartonsRow + 1 : 0);
  const afterKegsRow = kegsRow >= 0 ? findNextLabelRow(aoa, kegsRow) : -1;

  const bucket = emptyDayTotals();
  extractBrews(aoa, [dmeRow, kronesRow >= 0 ? kronesRow : dmeRow + 1], bucket.dme);
  extractBrews(aoa, [kronesRow, cartonsRow >= 0 ? cartonsRow : kronesRow + 1], bucket.krones);
  extractPackaging(aoa, [cartonsRow, kegsRow >= 0 ? kegsRow : cartonsRow + 1], bucket.cartons);
  extractPackaging(aoa, [kegsRow, afterKegsRow >= 0 ? afterKegsRow : kegsRow + 1], bucket.kegs);

  return { dates, ...bucket };
}

function fmtDate(d) {
  if (!d) return "";
  return d.toLocaleDateString("en-AU", { day: "numeric", month: "short" });
}

function parseWorkbook(workbook) {
  const sheetNames = workbook.SheetNames;
  const weeks = new Map(); // wc token -> { planSheet, actualSheet }

  for (const name of sheetNames) {
    const planMatch = name.match(/plan for wc\s*(\S+)/i);
    const actualMatch = name.match(/attainment of wc\s*(\S+)/i);
    if (planMatch) {
      const key = planMatch[1];
      if (!weeks.has(key)) weeks.set(key, {});
      weeks.get(key).planSheet = name;
    } else if (actualMatch) {
      const key = actualMatch[1];
      if (!weeks.has(key)) weeks.set(key, {});
      weeks.get(key).actualSheet = name;
    }
  }

  const result = [];
  for (const [wc, sheets] of weeks.entries()) {
    if (!sheets.planSheet) continue; // need at least a plan
    const plan = parseSheet(workbook.Sheets[sheets.planSheet]);
    const actual = sheets.actualSheet ? parseSheet(workbook.Sheets[sheets.actualSheet]) : null;
    const monday = plan.dates[0] || null;
    const sunday = plan.dates[6] || null;
    result.push({
      id: wc,
      label: `WC ${wc}`,
      dateLabel: monday && sunday ? `${fmtDate(monday)} – ${fmtDate(sunday)}` : "",
      mondayDate: monday,
      plan,
      actual,
      hasActual: !!sheets.actualSheet,
    });
  }

  result.sort((a, b) => {
    const ta = a.mondayDate ? a.mondayDate.getTime() : 0;
    const tb = b.mondayDate ? b.mondayDate.getTime() : 0;
    return tb - ta;
  });

  return result;
}

// ---------------------------------------------------------------------------
// Aggregation for the currently selected tab
// ---------------------------------------------------------------------------

function sumRange(dayArray, dayIndices) {
  const out = { total: 0, skus: {} };
  for (const d of dayIndices) {
    const b = dayArray[d];
    if (!b) continue;
    out.total += b.total;
    for (const sku in b.skus) out.skus[sku] = (out.skus[sku] || 0) + b.skus[sku];
  }
  return out;
}

function activeDayIndices() {
  return currentTab === "week" ? [0, 1, 2, 3, 4, 5, 6] : [currentTab];
}

function pct(actual, planned) {
  if (!planned && !actual) return null;
  if (!planned) return null;
  return (actual / planned) * 100;
}

// Three-way comparison against target, independent of rounding:
//   below target -> red, target exactly met -> green (XPA), exceeded -> purple (IPA)
function attainmentState(planned, actual, hasActual) {
  if (!hasActual) return "pending";
  if (planned === 0 && actual === 0) return "met";
  if (actual < planned) return "below";
  if (actual > planned) return "exceeded";
  return "met";
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

function el(tag, attrs = {}, children = []) {
  const e = document.createElement(tag);
  for (const k in attrs) {
    if (k === "class") e.className = attrs[k];
    else if (k === "text") e.textContent = attrs[k];
    else if (k === "html") e.innerHTML = attrs[k];
    else e.setAttribute(k, attrs[k]);
  }
  for (const c of [].concat(children)) if (c) e.appendChild(c);
  return e;
}

function renderWeekSelector() {
  const sel = document.getElementById("weekSelect");
  sel.innerHTML = "";
  workbookWeeks.forEach((w, i) => {
    const opt = el("option", { value: i, text: `${w.label}${w.dateLabel ? " · " + w.dateLabel : ""}${w.hasActual ? "" : "  (plan only)"}` });
    sel.appendChild(opt);
  });
  sel.value = currentWeekIndex;
}

function renderDayTabs() {
  const wrap = document.getElementById("dayTabs");
  wrap.innerHTML = "";
  const week = workbookWeeks[currentWeekIndex];
  const weekBtn = el("button", { class: "tab" + (currentTab === "week" ? " active" : ""), text: "Week" });
  weekBtn.addEventListener("click", () => { currentTab = "week"; renderDashboard(); });
  wrap.appendChild(weekBtn);
  DAY_NAMES.forEach((name, i) => {
    const dateStr = week && week.plan.dates[i] ? fmtDate(week.plan.dates[i]) : "";
    const btn = el("button", { class: "tab" + (currentTab === i ? " active" : "") });
    btn.innerHTML = `${name}${dateStr ? `<span class="tab-date">${dateStr}</span>` : ""}`;
    btn.addEventListener("click", () => { currentTab = i; renderDashboard(); });
    wrap.appendChild(btn);
  });
}

function ring(p, state) {
  const display = p === null ? "—" : `${Math.round(p)}%`;
  return el("div", { class: `ring ring-${state}` }, [
    el("span", { class: "ring-val", text: display }),
  ]);
}

function renderKpiCards() {
  const wrap = document.getElementById("kpiCards");
  wrap.innerHTML = "";
  const week = workbookWeeks[currentWeekIndex];
  const days = activeDayIndices();

  for (const cat of CATEGORIES) {
    const planSum = sumRange(week.plan[cat.key], days);
    const actualSum = week.actual ? sumRange(week.actual[cat.key], days) : { total: 0, skus: {} };
    const p = week.hasActual ? pct(actualSum.total, planSum.total) : null;
    const state = attainmentState(planSum.total, actualSum.total, week.hasActual);

    const card = el("div", { class: "kpi-card" }, [
      el("div", { class: "kpi-bar", style: `background:${cat.color}` }),
      el("div", { class: "kpi-inner" }, [
        el("div", { class: "kpi-top" }, [
          el("div", {}, [
            el("div", { class: "kpi-group", text: cat.group }),
            el("div", { class: "kpi-label", text: cat.label }),
          ]),
          ring(p, state),
        ]),
        el("div", { class: "kpi-nums" }, [
          el("div", { class: "kpi-num" }, [
            el("span", { class: "kpi-num-val", text: fmtNum(planSum.total) }),
            el("span", { class: "kpi-num-lbl", text: `planned ${cat.unit}` }),
          ]),
          el("div", { class: "kpi-num" }, [
            el("span", { class: `kpi-num-val kpi-num-${state}`, text: week.hasActual ? fmtNum(actualSum.total) : "—" }),
            el("span", { class: "kpi-num-lbl", text: `actual ${cat.unit}` }),
          ]),
        ]),
      ]),
    ]);
    card.style.setProperty("--kpi-card-accent", cat.color);
    wrap.appendChild(card);
  }
}

function fmtNum(n) {
  return Math.round(n).toLocaleString("en-AU");
}

function renderDailyChart() {
  const wrap = document.getElementById("dailyCharts");
  wrap.innerHTML = "";
  const week = workbookWeeks[currentWeekIndex];

  for (const cat of CATEGORIES) {
    const section = el("div", { class: "chart-card" });
    section.appendChild(el("div", { class: "chart-head" }, [
      el("span", { class: "chart-dot", style: `background:${cat.color}` }),
      el("h3", { text: `${cat.label} — daily attainment` }),
    ]));
    const bars = el("div", { class: "chart-bars" });
    for (let d = 0; d < 7; d++) {
      const planned = week.plan[cat.key][d].total;
      const actual = week.actual ? week.actual[cat.key][d].total : 0;
      const p = week.hasActual ? pct(actual, planned) : null;
      const state = attainmentState(planned, actual, week.hasActual);
      const maxVal = Math.max(planned, actual, 1);
      const plannedH = (planned / maxVal) * 100;
      const actualH = (actual / maxVal) * 100;

      const col = el("div", { class: "chart-col" + (currentTab === d ? " chart-col-active" : "") });
      col.addEventListener("click", () => { currentTab = d; renderDashboard(); });
      const track = el("div", { class: "chart-track" }, [
        el("div", { class: "chart-plan", style: `height:${plannedH}%` }),
        week.hasActual ? el("div", { class: `chart-actual chart-actual-${state}`, style: `height:${actualH}%` }) : null,
      ]);
      col.appendChild(track);
      col.appendChild(el("div", { class: "chart-pct", text: p === null ? "—" : `${Math.round(p)}%` }));
      col.appendChild(el("div", { class: "chart-day", text: DAY_NAMES[d] }));
      bars.appendChild(col);
    }
    section.appendChild(bars);
    section.appendChild(el("div", { class: "chart-legend" }, [
      el("span", {}, [el("i", { class: "leg-swatch leg-plan" }), document.createTextNode("Planned")]),
      el("span", {}, [el("i", { class: "leg-swatch leg-actual" }), document.createTextNode("Actual")]),
    ]));
    wrap.appendChild(section);
  }
}

function renderSkuTables() {
  const wrap = document.getElementById("skuTables");
  wrap.innerHTML = "";
  const week = workbookWeeks[currentWeekIndex];
  const days = activeDayIndices();
  const label = currentTab === "week" ? "Week total" : DAY_FULL[currentTab];

  for (const cat of CATEGORIES) {
    const planSum = sumRange(week.plan[cat.key], days);
    const actualSum = week.actual ? sumRange(week.actual[cat.key], days) : { total: 0, skus: {} };
    const skuSet = new Set([...Object.keys(planSum.skus), ...Object.keys(actualSum.skus)]);

    const card = el("div", { class: "sku-card" });
    card.appendChild(el("div", { class: "sku-head" }, [
      el("span", { class: "chart-dot", style: `background:${cat.color}` }),
      el("h3", { text: `${cat.label}` }),
      el("span", { class: "sku-scope", text: label }),
    ]));

    if (skuSet.size === 0) {
      card.appendChild(el("div", { class: "sku-empty", text: "No entries for this selection." }));
      wrap.appendChild(card);
      continue;
    }

    const table = el("table", { class: "sku-table" });
    const thead = el("thead", {}, [
      el("tr", {}, [
        el("th", { text: "SKU" }),
        el("th", { class: "num", text: "Planned" }),
        el("th", { class: "num", text: "Actual" }),
        el("th", { class: "num", text: "Attainment" }),
      ]),
    ]);
    table.appendChild(thead);
    const tbody = el("tbody");

    const rows = [...skuSet].map((sku) => {
      const planned = planSum.skus[sku] || 0;
      const actual = actualSum.skus[sku] || 0;
      const p = week.hasActual ? pct(actual, planned) : null;
      const state = attainmentState(planned, actual, week.hasActual);
      return { sku, planned, actual, p, state };
    }).sort((a, b) => b.planned - a.planned);

    for (const row of rows) {
      tbody.appendChild(el("tr", {}, [
        el("td", { class: "sku-name", text: row.sku }),
        el("td", { class: "num", text: fmtNum(row.planned) }),
        el("td", { class: `num num-${row.state}`, text: week.hasActual ? fmtNum(row.actual) : "—" }),
        el("td", { class: "num" }, [el("span", { class: `pct-pill pct-${row.state}`, text: row.p === null ? "—" : `${Math.round(row.p)}%` })]),
      ]));
    }
    table.appendChild(tbody);
    card.appendChild(table);
    wrap.appendChild(card);
  }
}

// ---------------------------------------------------------------------------
// Export the four top tiles (for pasting into the 9AM handover email)
// ---------------------------------------------------------------------------

function scopeLabel() {
  const week = workbookWeeks[currentWeekIndex];
  const dayPart = currentTab === "week" ? "Week total" : DAY_FULL[currentTab];
  return `${week.label}${week.dateLabel ? " · " + week.dateLabel : ""} — ${dayPart}`;
}

function buildTilesData() {
  const week = workbookWeeks[currentWeekIndex];
  const days = activeDayIndices();
  return CATEGORIES.map((cat) => {
    const planSum = sumRange(week.plan[cat.key], days);
    const actualSum = week.actual ? sumRange(week.actual[cat.key], days) : { total: 0, skus: {} };
    const p = week.hasActual ? pct(actualSum.total, planSum.total) : null;
    const state = attainmentState(planSum.total, actualSum.total, week.hasActual);
    return { ...cat, planned: planSum.total, actual: actualSum.total, p, state, hasActual: week.hasActual };
  });
}

function ringStyleFor(state) {
  switch (state) {
    case "met": return { border: "#47D7AC", bg: "rgba(71,215,172,.14)", val: "#1f7a5c" };
    case "below": return { border: "#D64545", bg: "rgba(214,69,69,.12)", val: "#D64545" };
    case "exceeded": return { border: "#7566A0", bg: "rgba(117,102,160,.14)", val: "#7566A0" };
    default: return { border: "#E7E5DE", bg: "#FAFAF7", val: "#a9a596" };
  }
}

function numColorFor(state) {
  switch (state) {
    case "met": return "#1f7a5c";
    case "below": return "#D64545";
    case "exceeded": return "#7566A0";
    default: return "#0B0B0C";
  }
}

const EMAIL_FONT = "'Lexend',Arial,Helvetica,sans-serif";
const EMAIL_MONO = "'IBM Plex Mono',Consolas,'Courier New',monospace";

function buildTilesHtml(tiles) {
  const cards = tiles.map((t) => {
    const ring = ringStyleFor(t.state);
    const numColor = numColorFor(t.state);
    const pctText = t.p === null ? "—" : `${Math.round(t.p)}%`;
    const actualText = t.hasActual ? fmtNum(t.actual) : "—";
    return `
    <div style="flex:1 1 200px;min-width:190px;max-width:260px;background:#ffffff;border:1px solid #E7E5DE;border-radius:14px;box-shadow:0 1px 2px rgba(11,11,12,.04),0 6px 16px rgba(11,11,12,.05);overflow:hidden;font-family:${EMAIL_FONT};">
      <div style="height:4px;line-height:4px;font-size:0;background:${t.color};">&nbsp;</div>
      <div style="padding:14px 16px 16px;">
        <div style="display:flex;align-items:flex-start;justify-content:space-between;gap:8px;">
          <div>
            <div style="font-family:${EMAIL_MONO};font-size:9.5px;text-transform:uppercase;letter-spacing:.08em;color:#9c9887;">${t.group}</div>
            <div style="font-family:${EMAIL_FONT};font-size:15px;font-weight:700;margin-top:2px;color:#0B0B0C;">${t.label}</div>
          </div>
          <div style="width:46px;height:46px;border-radius:50%;border:3px solid ${ring.border};background:${ring.bg};display:flex;align-items:center;justify-content:center;flex:0 0 auto;text-align:center;">
            <span style="font-family:${EMAIL_MONO};font-size:11px;font-weight:700;color:${ring.val};">${pctText}</span>
          </div>
        </div>
        <div style="display:flex;gap:16px;margin-top:14px;">
          <div style="display:flex;flex-direction:column;">
            <span style="font-family:${EMAIL_FONT};font-size:19px;font-weight:700;color:#0B0B0C;">${fmtNum(t.planned)}</span>
            <span style="font-family:${EMAIL_MONO};font-size:9.5px;color:#9c9887;text-transform:uppercase;letter-spacing:.05em;">planned ${t.unit}</span>
          </div>
          <div style="display:flex;flex-direction:column;">
            <span style="font-family:${EMAIL_FONT};font-size:19px;font-weight:700;color:${numColor};">${actualText}</span>
            <span style="font-family:${EMAIL_MONO};font-size:9.5px;color:#9c9887;text-transform:uppercase;letter-spacing:.05em;">actual ${t.unit}</span>
          </div>
        </div>
      </div>
    </div>`;
  }).join("");

  return `<div style="font-family:${EMAIL_FONT};">
    <div style="font-family:${EMAIL_FONT};font-size:15px;font-weight:700;color:#0B0B0C;margin-bottom:2px;">Weekly Production Plan Attainment Snapshot</div>
    <div style="font-family:${EMAIL_FONT};font-size:11.5px;color:#6b6858;margin-bottom:12px;">${scopeLabel()}</div>
    <div style="display:flex;gap:14px;flex-wrap:wrap;">${cards}
    </div>
  </div>`;
}

function buildTilesText(tiles) {
  const header = `Weekly Production Plan Attainment Snapshot (${scopeLabel()})`;
  const lines = tiles.map((t) => {
    const actualText = t.hasActual ? fmtNum(t.actual) : "—";
    const pctText = t.p === null ? "—" : `${Math.round(t.p)}%`;
    return `${t.label}: Planned ${fmtNum(t.planned)} ${t.unit} | Actual ${actualText} ${t.unit} | ${pctText}`;
  });
  return [header, ...lines].join("\n");
}

async function copyTilesForEmail() {
  const statusEl = document.getElementById("copyStatus");
  const tiles = buildTilesData();
  const html = buildTilesHtml(tiles);
  const text = buildTilesText(tiles);

  try {
    if (window.ClipboardItem) {
      const item = new ClipboardItem({
        "text/html": new Blob([html], { type: "text/html" }),
        "text/plain": new Blob([text], { type: "text/plain" }),
      });
      await navigator.clipboard.write([item]);
    } else {
      await navigator.clipboard.writeText(text);
    }
    statusEl.textContent = "Copied — paste into the handover email.";
  } catch (err) {
    console.error(err);
    try {
      await navigator.clipboard.writeText(text);
      statusEl.textContent = "Copied as plain text — paste into the handover email.";
    } catch (err2) {
      statusEl.textContent = "Couldn't copy automatically — select the tiles and copy manually.";
    }
  }
  setTimeout(() => { statusEl.textContent = ""; }, 4000);
}

function renderStatusBanner() {
  const banner = document.getElementById("statusBanner");
  const week = workbookWeeks[currentWeekIndex];
  if (!week.hasActual) {
    banner.style.display = "flex";
    banner.textContent = `Awaiting actuals for ${week.label} — showing plan only. Upload the sheet again once "Attainment of ${week.label.replace('WC ', 'WC ')}" has been filled in.`;
  } else {
    banner.style.display = "none";
  }
}

function renderDashboard() {
  if (currentWeekIndex < 0) return;
  renderDayTabs();
  renderStatusBanner();
  renderKpiCards();
  renderDailyChart();
  renderSkuTables();
  document.getElementById("dashboard").style.display = "block";
  document.getElementById("emptyState").style.display = "none";
}

// ---------------------------------------------------------------------------
// Upload handling
// ---------------------------------------------------------------------------

function handleFile(file) {
  const statusEl = document.getElementById("uploadStatus");
  statusEl.textContent = "Reading workbook…";
  const reader = new FileReader();
  reader.onload = (e) => {
    try {
      const data = new Uint8Array(e.target.result);
      const workbook = XLSX.read(data, { type: "array", cellDates: true });
      const weeks = parseWorkbook(workbook);
      if (weeks.length === 0) {
        statusEl.textContent = "No \"Plan for WC ######\" tabs found in that file.";
        return;
      }
      workbookWeeks = weeks;
      currentWeekIndex = 0;
      currentTab = "week";
      renderWeekSelector();
      renderDashboard();
      statusEl.textContent = `Loaded ${weeks.length} week${weeks.length === 1 ? "" : "s"} from ${file.name}.`;
      document.getElementById("uploadCard").classList.add("uploaded");
    } catch (err) {
      console.error(err);
      statusEl.textContent = "Couldn't read that file — is it the Weekly Production Plan Attainment workbook (.xlsx)?";
    }
  };
  reader.readAsArrayBuffer(file);
}

function initUpload() {
  const input = document.getElementById("fileInput");
  const dropzone = document.getElementById("dropzone");

  input.addEventListener("change", () => {
    if (input.files && input.files[0]) handleFile(input.files[0]);
  });

  ["dragenter", "dragover"].forEach((evt) =>
    dropzone.addEventListener(evt, (e) => {
      e.preventDefault();
      dropzone.classList.add("drag");
    })
  );
  ["dragleave", "drop"].forEach((evt) =>
    dropzone.addEventListener(evt, (e) => {
      e.preventDefault();
      dropzone.classList.remove("drag");
    })
  );
  dropzone.addEventListener("drop", (e) => {
    const file = e.dataTransfer.files && e.dataTransfer.files[0];
    if (file) handleFile(file);
  });
  dropzone.addEventListener("click", () => input.click());
}

function initWeekSelector() {
  document.getElementById("weekSelect").addEventListener("change", (e) => {
    currentWeekIndex = parseInt(e.target.value, 10);
    currentTab = "week";
    renderDashboard();
  });
}

function initCopyTiles() {
  document.getElementById("copyTilesBtn").addEventListener("click", copyTilesForEmail);
}

document.addEventListener("DOMContentLoaded", () => {
  initUpload();
  initWeekSelector();
  initCopyTiles();
});
