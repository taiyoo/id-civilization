// Formatting helpers and small HTML components shared by dashboards.

export const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

export function fmtNum(v, digits = 0) {
  if (v == null || Number.isNaN(v)) return "–";
  return Number(v).toLocaleString("en-US", { maximumFractionDigits: digits, minimumFractionDigits: 0 });
}
export function fmtBig(v, digits = 1) {
  if (v == null) return "–";
  const a = Math.abs(v);
  if (a >= 1e12) return (v / 1e12).toFixed(digits) + "T";
  if (a >= 1e9) return (v / 1e9).toFixed(digits) + "B";
  if (a >= 1e6) return (v / 1e6).toFixed(digits) + "M";
  if (a >= 1e3) return (v / 1e3).toFixed(digits) + "K";
  return fmtNum(v, digits);
}
export const fmtPct = (v, d = 1) => (v == null ? "–" : `${v.toFixed(d)}%`);
export const fmtUsd = (v, d = 1) => (v == null ? "–" : "$" + fmtBig(v, d));
/** billions of rupiah -> "Rp1,236T" (trillion) */
export const fmtRp = (bRp) => (bRp == null ? "–" : bRp >= 1000 ? `Rp${fmtNum(bRp / 1000)}T` : `Rp${fmtNum(bRp)}B`);
export const sign = (v, d = 1) => (v == null ? "–" : `${v >= 0 ? "+" : "−"}${Math.abs(v).toFixed(d)}%`);

export function kpis(items) {
  return `<div class="kpis">${items.map((k) => `
    <div class="kpi"${k.lens ? ` data-lens="${k.lens}"` : ""}>
      <div class="kpi-label">${esc(k.label)}</div>
      <div class="kpi-value">${k.value}</div>
      <div class="kpi-sub">${k.sub ?? ""}</div>
    </div>`).join("")}</div>`;
}

export function section(title, desc, body, opts = {}) {
  return `<section class="dash-section">
    ${opts.kicker ? `<div class="kicker">${esc(opts.kicker)}</div>` : ""}
    <h3>${esc(title)}</h3>
    ${desc ? `<p class="dash-desc">${desc}</p>` : ""}
    ${opts.lens ? `<button class="lens-chip" data-lens="${opts.lens}">◉ Show on map</button>` : ""}
    ${body}
  </section>`;
}

/** Horizontal bar list. rows: {label, value, display, sub?, color?, prov?, hex?, fly?} */
export function bars(rows, { max, color = "var(--gold)", limit, id } = {}) {
  const m = max ?? Math.max(...rows.map((r) => Math.abs(r.value || 0)), 1e-9);
  const shown = limit ? rows.slice(0, limit) : rows;
  const more = limit && rows.length > limit;
  return `<div class="bars"${id ? ` id="${id}"` : ""}>${shown.map((r, k) => barRow(r, k, m, color)).join("")}
    ${more ? `<button class="more" data-more>Show all ${rows.length}</button><div class="more-rows hidden">${rows.slice(limit).map((r, k) => barRow(r, k + limit, m, color)).join("")}</div>` : ""}
  </div>`;
}
function barRow(r, k, m, color) {
  const w = Math.max(0.5, (100 * Math.abs(r.value || 0)) / m);
  return `<div class="bar-row" ${linkAttrs(r)}>
      <span class="bar-rank">${k + 1}</span>
      <span class="bar-label">${esc(r.label)}${r.sub ? `<small>${esc(r.sub)}</small>` : ""}</span>
      <span class="bar-track"><span class="bar-fill" style="width:${w}%;background:${r.color || color}"></span></span>
      <span class="bar-value">${r.display}</span>
    </div>`;
}

export function linkAttrs(r) {
  const a = [];
  if (r.prov != null) a.push(`data-prov="${r.prov}"`);
  if (r.hex != null && r.hex >= 0) a.push(`data-hex="${r.hex}"`);
  if (r.fly) a.push(`data-fly="${r.fly.join(",")}"`);
  if (r.islandKey) a.push(`data-island="${r.islandKey}"`);
  return a.join(" ");
}

/** Sortable table. cols: {key, label, fmt?, num?}; rows: objects (+ prov/hex/fly for linking) */
export function table(cols, rows, { sortKey, desc = true, limit = 0, id } = {}) {
  const tid = id || "t" + Math.random().toString(36).slice(2, 8);
  TABLES.set(tid, { cols, rows, sortKey: sortKey ?? cols.find((c) => c.num)?.key, desc, limit });
  return `<div class="tbl-wrap" id="${tid}">${renderTable(tid)}</div>`;
}
const TABLES = new Map();
export function renderTable(tid) {
  const t = TABLES.get(tid);
  const rows = [...t.rows].sort((a, b) => {
    const va = a[t.sortKey], vb = b[t.sortKey];
    if (va == null) return 1;
    if (vb == null) return -1;
    return (typeof va === "string" ? va.localeCompare(vb) : va - vb) * (t.desc ? -1 : 1);
  });
  const shown = t.limit && !t.expanded ? rows.slice(0, t.limit) : rows;
  return `<table class="tbl"><thead><tr><th>#</th>${t.cols.map((c) =>
    `<th class="${c.num ? "num" : ""} sortable" data-sort="${tid}:${c.key}">${esc(c.label)}${t.sortKey === c.key ? (t.desc ? " ▼" : " ▲") : ""}</th>`).join("")}</tr></thead>
    <tbody>${shown.map((r, k) => `<tr ${linkAttrs(r)}><td class="rank">${k + 1}</td>${t.cols.map((c) =>
      `<td class="${c.num ? "num" : ""}">${c.fmt ? c.fmt(r[c.key], r) : esc(r[c.key] ?? "–")}</td>`).join("")}</tr>`).join("")}</tbody></table>
    ${t.limit && rows.length > t.limit ? `<button class="more" data-expand="${tid}">${t.expanded ? "Show fewer" : `Show all ${rows.length}`}</button>` : ""}`;
}
export function onTableClick(e) {
  const th = e.target.closest("[data-sort]");
  if (th) {
    const [tid, key] = th.dataset.sort.split(":");
    const t = TABLES.get(tid);
    if (t.sortKey === key) t.desc = !t.desc; else { t.sortKey = key; t.desc = true; }
    document.getElementById(tid).innerHTML = renderTable(tid);
    return true;
  }
  const ex = e.target.closest("[data-expand]");
  if (ex) {
    const tid = ex.dataset.expand, t = TABLES.get(tid);
    t.expanded = !t.expanded;
    document.getElementById(tid).innerHTML = renderTable(tid);
    return true;
  }
  return false;
}

/** Simple column chart (SVG). points: [{x, y, label}] */
export function columns(points, { height = 90, color = "var(--gold)", fmt = fmtNum } = {}) {
  const w = 100 / points.length, max = Math.max(...points.map((p) => p.y), 1e-9);
  return `<div class="cols" style="height:${height}px">${points.map((p) => `
    <div class="col" style="width:${w}%" title="${esc(p.label)}: ${esc(fmt(p.y))}">
      <div class="col-bar" style="height:${(100 * p.y) / max}%;background:${color}"></div>
      <div class="col-x">${esc(p.x)}</div>
    </div>`).join("")}</div>`;
}

/** Stacked 100% bar. parts: [{key, value, color}] */
export function stack(parts) {
  const tot = parts.reduce((a, p) => a + p.value, 0) || 1;
  return `<div class="stack">${parts.filter((p) => p.value > 0).map((p) =>
    `<span style="width:${(100 * p.value) / tot}%;background:${p.color}" title="${esc(p.key)} ${(100 * p.value / tot).toFixed(1)}%"></span>`).join("")}</div>`;
}

export function sources(list, caveats = []) {
  return `<section class="dash-section sources">
    ${caveats.length ? `<div class="kicker">Read with care</div><ul class="caveats">${caveats.map((c) => `<li>${c}</li>`).join("")}</ul>` : ""}
    <div class="kicker">Sources</div>
    <ul>${list.map((s) => `<li>${s.url ? `<a href="${esc(s.url)}" target="_blank" rel="noopener">${esc(s.name)}</a>` : esc(s.name)}${s.note ? ` <span class="muted">· ${esc(s.note)}</span>` : ""}</li>`).join("")}</ul>
  </section>`;
}
