// Entry point: loads the data, builds the map, lenses and advisors, and wires
// the UI (top bar, council panel, lens chooser, legend, inspector, URL state).
import { MapView, RES, RES_RING } from "./render.js";
import { buildLenses, PALETTES, lerpColor } from "./lenses.js";
import { buildAdvisors, COUNCIL_ORDER, FUEL_COLORS } from "./advisors.js";
import { esc, fmtBig, fmtNum, fmtPct, fmtRp, fmtUsd, onTableClick, sign } from "./ui.js";

const $ = (id) => document.getElementById(id);
const PRETTY = {
  ocean: "Ocean", coast: "Coast", lake: "Lake", grassland: "Grassland", plains: "Plains", hills_grassland: "Grassland (Hills)",
  hills_plains: "Plains (Hills)", mountain: "Mountains", snow_mountain: "Snow-capped mountains", rainforest: "Rainforest", woods: "Woods",
  marsh: "Marsh", floodplains: "Floodplains", reef: "Coral reef", volcano: "Volcano", geothermal: "Geothermal fissure",
};
const QUICK_LENSES = ["terrain", "population", "forest", "lights", "gdppc"];

let D, map, LENSES, LENS_BY_ID, ADV, state;

async function boot() {
  D = await (await fetch("map-data.json")).json();
  const S = D.tiles;

  // province centroids (mean of land hexes) for overlays and fly-to
  const sums = D.provinces.map(() => [0, 0, 0]);
  const cents = [];
  map = new MapView($("map"), D, { onCamera: scheduleHash, onDraw: () => map.drawMinimap() });
  for (let i = 0; i < S.land.length; i++) if (S.land[i] && S.prov[i] >= 0) {
    const [lon, lat] = map.hexLonLat(i), s = sums[S.prov[i]];
    s[0] += lon; s[1] += lat; s[2]++;
  }
  sums.forEach((s, k) => (cents[k] = [s[0] / (s[2] || 1), s[1] / (s[2] || 1)]));
  const centroid = (k) => cents[k];

  LENSES = buildLenses(D);
  LENS_BY_ID = new Map(LENSES.map((l) => [l.id, l]));
  ADV = buildAdvisors(D, { centroid });
  window.__map = { D, map, LENSES, ADV }; // console debugging

  state = { lens: "terrain", advisor: "council", sel: -1 };
  readHash();
  resize();
  map.renderMinimap($("minimap"), window.devicePixelRatio || 1);
  setupTopbar();
  setupLensChooser();
  setupToolbar();
  setupSearch();
  setupPointer();
  setupPanelEvents(centroid);
  setLens(state.lens, false);
  openAdvisor(state.advisor, false);
  if (!state.at) {
    // fit the archipelago into the free strip: right of the side panel, between top bar and legend/toolbar
    const panelW = panelWidth();
    const top = $("topbar").getBoundingClientRect().bottom;
    const phone = window.innerWidth <= 900;
    const blockers = phone ? ["legend", "toolbar"].map((id) => $(id).getBoundingClientRect()).filter((r) => r.height).map((r) => r.top) : [];
    const bottom = phone ? Math.min(window.innerHeight, ...blockers) : window.innerHeight - 70;
    const scale = Math.max(8, Math.min((window.innerWidth - panelW - 20) / 47, (bottom - top - 16) / 18));
    map.flyTo(118, -2.6, scale, panelW / 2, window.innerHeight / 2 - (top + bottom) / 2);
  } else map.flyTo(state.at[0], state.at[1], state.at[2]);
  if (state.sel >= 0) inspect(state.sel);
  $("loading").remove();
  window.addEventListener("resize", resize);
  window.addEventListener("keydown", (e) => {
    if (e.key === "Escape") { closePopovers(); inspect(-1); }
    if (e.key === "/" && document.activeElement !== $("search")) { e.preventDefault(); $("search").focus(); }
  });
}

const panelWidth = () => (window.innerWidth > 900 && !$("panel").classList.contains("hidden") ? $("panel").offsetWidth : 0);

function resize() {
  map.resize(window.innerWidth, window.innerHeight, window.devicePixelRatio || 1);
}

// ------------------------------------------------------------------ URL state
let hashTimer = 0;
function scheduleHash() {
  clearTimeout(hashTimer);
  hashTimer = setTimeout(() => {
    const v = map.view();
    const parts = [`lens=${state.lens}`, `at=${v.lon.toFixed(2)},${v.lat.toFixed(2)},${Math.round(v.scale)}`];
    if (state.advisor) parts.push(`advisor=${state.advisor}`);
    if (state.sel >= 0) parts.push(`sel=${state.sel}`);
    history.replaceState(null, "", "#" + parts.join("&"));
  }, 250);
}
function readHash() {
  const h = new URLSearchParams(location.hash.slice(1));
  if (h.get("lens") && LENS_BY_ID.has(h.get("lens"))) state.lens = h.get("lens");
  if (h.has("advisor")) state.advisor = h.get("advisor") || null;
  if (h.get("at")) { const a = h.get("at").split(",").map(Number); if (a.length === 3 && a.every(Number.isFinite)) state.at = a; }
  if (h.get("sel")) state.sel = Number(h.get("sel"));
}

// ------------------------------------------------------------------ top bar
function setupTopbar() {
  const N = D.national;
  const chips = [
    { icon: "👥", value: fmtBig(N.pop2025), tip: "Population, mid-2025", adv: "people", cls: "c-people" },
    { icon: "💰", value: fmtRp(N.gdpBRp), tip: `GDP ${N.gdpYear} (≈ ${fmtUsd(N.gdpUsdB * 1e9, 2)})`, adv: "economy", cls: "c-gold" },
    { icon: "📈", value: sign(100 * N.gdpGrowth), tip: "Nominal GDP growth", adv: "economy", cls: "c-green" },
    { icon: "🪙", value: fmtPct(N.pov365), tip: "Living under $3.65 a day (World Bank 2022)", adv: "prosperity", cls: "c-red" },
    { icon: "🌳", value: fmtPct(N.forestPct, 0), tip: "Forest share of land (MODIS 2024)", adv: "land", cls: "c-green" },
    { icon: "⚡", value: `${fmtNum(N.powerMW / 1000, 1)} GW`, tip: "Large power plants listed (WRI)", adv: "energy", cls: "c-amber" },
    { icon: "🌋", value: D.volcanoes.length, tip: "Volcanoes on the map", adv: "culture", cls: "c-red" },
    { icon: "🏛️", value: D.wonders.length, tip: "Wonders", adv: "culture", cls: "c-gold" },
  ];
  $("natstats").innerHTML = chips.map((c) => `<button class="stat ${c.cls}" data-open="${c.adv}" title="${esc(c.tip)}"><span>${c.icon}</span>${c.value}</button>`).join("");
  $("natstats").addEventListener("click", (e) => { const b = e.target.closest("[data-open]"); if (b) openAdvisor(b.dataset.open); });
  $("home").onclick = () => openAdvisor("council");
  $("almanac-btn").onclick = () => openAdvisor("explorer");
}

// ------------------------------------------------------------------ advisors panel
function advisorTabs() {
  const ids = COUNCIL_ORDER.flatMap(([, ids]) => ids);
  return `<div class="adv-tabs"><button class="adv-tab council${state.advisor === "council" ? " on" : ""}" data-adv="council" title="Council">👑</button>
    ${ids.map((id) => `<button class="adv-tab${state.advisor === id ? " on" : ""}" data-adv="${id}" title="${esc(ADV[id].name)}">${ADV[id].icon}</button>`).join("")}
    <button class="adv-close" data-adv="" title="Close panel">×</button></div>`;
}
function openAdvisor(id, push = true) {
  state.advisor = id || null;
  const panel = $("panel");
  document.body.classList.toggle("panel-closed", !id);
  map.setHighlight(null);
  if (!id) {
    panel.classList.add("hidden"); $("council-btn").classList.remove("hidden");
    map.setOverlay(null); renderLegend(); scheduleHash(); return;
  }
  panel.classList.remove("hidden"); $("council-btn").classList.add("hidden");
  let html = advisorTabs();
  if (id === "council") {
    html += `<div class="panel-head"><div class="kicker">Your council</div><h2>Advisors</h2>
      <p>Each advisor opens a dashboard on one part of Indonesia. Hover anything to see it on the map; hover the map to find it in the charts; click to fly there.</p></div>`;
    for (const [group, ids] of COUNCIL_ORDER) {
      html += `<div class="council-group">${esc(group)}</div>`;
      html += ids.map((a) => `<button class="council-card" data-adv="${a}"><span class="medal">${ADV[a].icon}</span>
        <span><span class="role">${esc(ADV[a].role)}</span><span class="cname">${esc(ADV[a].name)}</span><span class="cdesc">${esc(ADV[a].desc)}</span></span></button>`).join("");
    }
    html += `<p class="panel-foot">All figures are public data: BPS via Wikipedia, NASA GIBS (MODIS, VIIRS, SEDAC), USGS, WRI, Wikidata, OpenStreetMap and geoBoundaries. Each dashboard lists its sources and caveats.</p>`;
    map.setOverlay(null);
  } else {
    const a = ADV[id];
    if (!a) return openAdvisor("council", push);
    html += `<div class="panel-head adv-head"><span class="medal big">${a.icon}</span><div><div class="kicker">${esc(a.role)}</div><h2>${esc(a.name)}</h2><p>${esc(a.desc)}</p></div></div>`;
    html += `<div class="dash">${a.render()}</div>`;
    map.setOverlay(a.overlay ? a.overlay() : null);
    if (push && a.lens !== undefined && a.lens !== null) setLens(a.lens);
  }
  $("panel-body").innerHTML = html;
  $("panel-body").scrollTop = 0;
  renderLegend();
  scheduleHash();
}

function setupPanelEvents(centroid) {
  const body = $("panel-body");
  body.addEventListener("click", (e) => {
    if (onTableClick(e)) return;
    const adv = e.target.closest("[data-adv]");
    if (adv) return openAdvisor(adv.dataset.adv);
    const more = e.target.closest("[data-more]");
    if (more) { more.nextElementSibling.classList.toggle("hidden"); more.remove(); return; }
    const lens = e.target.closest("[data-lens]");
    if (lens) return setLens(lens.dataset.lens);
    const fly = e.target.closest("[data-fly]");
    if (fly) { const [lon, lat, z] = fly.dataset.fly.split(",").map(Number); map.flyTo(lon, lat, Math.max(map.cam.scale, z), panelWidth() / 2); const h = fly.dataset.hex; if (h) inspect(Number(h)); return; }
    const prov = e.target.closest("[data-prov]");
    if (prov) { const k = Number(prov.dataset.prov), [lon, lat] = centroid(k); map.flyTo(lon, lat, Math.max(map.cam.scale, 70), panelWidth() / 2); return; }
    const hex = e.target.closest("[data-hex]");
    if (hex) { const i = Number(hex.dataset.hex); const [lon, lat] = map.hexLonLat(i); map.flyTo(lon, lat, Math.max(map.cam.scale, 150), panelWidth() / 2); inspect(i); }
  });
  body.addEventListener("mouseover", (e) => {
    const el = e.target.closest("[data-prov],[data-hex],[data-island],[data-fuel],[data-fly]");
    if (!el) return;
    const h = {};
    if (el.dataset.prov != null) h.provs = [Number(el.dataset.prov)];
    if (el.dataset.island) h.provs = D.provinces.map((p, k) => (p.island === el.dataset.island ? k : -1)).filter((k) => k >= 0);
    if (el.dataset.fuel) h.points = D.plants.filter((p) => p.fuel === el.dataset.fuel).map((p) => ({ lon: p.lon, lat: p.lat, r: 2 + Math.sqrt(p.mw) * 0.32 }));
    if (el.dataset.fly) { const [lon, lat] = el.dataset.fly.split(",").map(Number); h.points = [{ lon, lat }]; }
    else if (el.dataset.hex != null) { const [lon, lat] = map.hexLonLat(Number(el.dataset.hex)); h.points = [{ lon, lat }]; }
    map.setHighlight(h);
  });
  body.addEventListener("mouseleave", () => map.setHighlight(null));
  body.addEventListener("mouseout", (e) => { if (!e.relatedTarget || !body.contains(e.relatedTarget)) map.setHighlight(null); });
  $("council-btn").onclick = () => openAdvisor("council");
}

// map hover -> light up matching rows in the dashboard
let hotProv = -1;
function markHot(k) {
  if (k === hotProv) return;
  document.querySelectorAll("#panel-body .hot").forEach((el) => el.classList.remove("hot"));
  hotProv = k;
  if (k >= 0) document.querySelectorAll(`#panel-body [data-prov="${k}"]`).forEach((el) => el.classList.add("hot"));
}

// ------------------------------------------------------------------ lenses
function setLens(id, push = true) {
  const l = LENS_BY_ID.get(id) || LENS_BY_ID.get("terrain");
  state.lens = l.id;
  map.setLens(l);
  document.querySelectorAll("[data-qlens]").forEach((b) => b.classList.toggle("on", b.dataset.qlens === l.id));
  document.querySelectorAll("#lens-chooser [data-lens]").forEach((b) => b.classList.toggle("on", b.dataset.lens === l.id));
  $("lens-current").textContent = l.name;
  renderLegend();
  if (state.sel >= 0) inspect(state.sel);
  if (push) scheduleHash();
}
function setupLensChooser() {
  const groups = [];
  for (const l of LENSES) { let g = groups.find((x) => x[0] === l.group); if (!g) groups.push((g = [l.group, []])); g[1].push(l); }
  $("lens-chooser").innerHTML = `<div class="chooser-head"><h2>Choose a lens</h2><button class="close" data-close-chooser>×</button></div>
    <div class="chooser-grid">${groups.map(([g, ls]) => `<div class="chooser-group"><div class="kicker">${esc(g)}</div>
      ${ls.map((l) => `<button class="lens-btn" data-lens="${l.id}"><span class="lens-ico">${l.icon}</span>${esc(l.name)}
        <span class="lens-swatch" style="background:${swatch(l)}"></span></button>`).join("")}</div>`).join("")}</div>`;
  $("lens-chooser").addEventListener("click", (e) => {
    if (e.target.closest("[data-close-chooser]")) return closePopovers();
    const b = e.target.closest("[data-lens]");
    if (b) { setLens(b.dataset.lens); closePopovers(); }
  });
}
function swatch(l) {
  if (l.categorical) return `linear-gradient(90deg,${l.cats.map((c) => c.color).join(",")})`;
  if (l.kind === "base") return "linear-gradient(90deg,#2f6fa3,#6f9a3e,#a99a52,#7d746a)";
  return `linear-gradient(90deg,${PALETTES[l.palette].join(",")})`;
}

function renderLegend() {
  const el = $("legend"), l = LENS_BY_ID.get(state.lens), ov = map.overlay;
  let html = "";
  if (l && l.kind !== "base") {
    html += `<div class="lg-title">${l.icon} ${esc(l.name)}${l.kind === "province" ? ' <span class="muted">· by province</span>' : ""}</div>`;
    if (l.categorical) {
      html += `<div class="lg-cats">${l.cats.map((c) => `<span class="lg-cat" data-cat="${c.key}"><i style="background:${c.color}"></i>${c.key}</span>`).join("")}</div>`;
    } else {
      const [a, b] = l.domain, ticks = [0, 0.25, 0.5, 0.75, 1].map((t) => (l.log ? a * Math.pow(b / a, t) : a + (b - a) * t));
      html += `<div class="lg-bar" style="background:${swatch(l)}"><div class="lg-band hidden"></div></div>
        <div class="lg-ticks">${ticks.map((v, k) => `<span>${k === 4 ? "≥ " : k === 0 ? "≤ " : ""}${esc(l.fmt(v))}</span>`).join("")}</div>`;
    }
    html += `<div class="lg-src">${l.unit ? esc(l.unit) + " · " : ""}${esc(l.source || "")}</div>`;
    html += `<div class="lg-hint">${l.categorical ? "Hover a category" : "Hover the scale"} to show only that range</div>`;
  }
  if (ov?.legend) html += `<div class="lg-ov">◯ ${esc(ov.legend)}</div>`;
  el.innerHTML = html;
  el.classList.toggle("hidden", !html);
  const bar = el.querySelector(".lg-bar");
  if (bar) {
    const band = bar.querySelector(".lg-band");
    bar.onmousemove = (e) => {
      const r = bar.getBoundingClientRect(), t = Math.max(0, Math.min(1, (e.clientX - r.left) / r.width));
      const t0 = Math.max(0, t - 0.1), t1 = Math.min(1, t + 0.1);
      const inv = (t) => (l.log ? l.domain[0] * Math.pow(l.domain[1] / l.domain[0], t) : l.domain[0] + (l.domain[1] - l.domain[0]) * t);
      const lo = t0 <= 0 ? -Infinity : inv(t0), hi = t1 >= 1 ? Infinity : inv(t1);
      band.classList.remove("hidden"); band.style.left = `${t0 * 100}%`; band.style.width = `${(t1 - t0) * 100}%`;
      map.setRange([lo, hi]);
    };
    bar.onmouseleave = () => { band.classList.add("hidden"); map.setRange(null); };
  }
  el.querySelectorAll("[data-cat]").forEach((c) => {
    c.onmouseenter = () => map.setRange(c.dataset.cat);
    c.onmouseleave = () => map.setRange(null);
  });
}

// ------------------------------------------------------------------ toolbar & popovers
function setupToolbar() {
  $("quick-lenses").innerHTML = QUICK_LENSES.map((id) => { const l = LENS_BY_ID.get(id); return `<button class="tb-btn" data-qlens="${id}">${l.icon} ${esc(l.name)}</button>`; }).join("");
  $("quick-lenses").addEventListener("click", (e) => { const b = e.target.closest("[data-qlens]"); if (b) setLens(b.dataset.qlens); });
  $("lens-toggle").onclick = (e) => { e.stopPropagation(); togglePopover("lens-chooser"); };
  $("map-toggle").onclick = (e) => { e.stopPropagation(); togglePopover("map-menu"); };
  $("map-menu").addEventListener("change", (e) => {
    const inp = e.target.closest("input[data-layer]");
    if (inp) { map.setLayers({ [inp.dataset.layer]: inp.checked }); updateMapCount(); }
  });
  updateMapCount();
  document.addEventListener("click", (e) => { if (!e.target.closest(".popover") && !e.target.closest("#toolbar")) closePopovers(); });
  $("minimap").addEventListener("click", (e) => {
    const r = $("minimap").getBoundingClientRect(), k = map.mini.k;
    map.flyTo(map.M.lon0 + (e.clientX - r.left) / k, map.M.lat0 - (e.clientY - r.top) / k);
  });
}
function updateMapCount() { $("map-count").textContent = Object.values(map.layers).filter(Boolean).length; }
function togglePopover(id) { const el = $(id), open = el.classList.contains("hidden"); closePopovers(); if (open) el.classList.remove("hidden"); }
function closePopovers() { document.querySelectorAll(".popover").forEach((p) => p.classList.add("hidden")); }

// ------------------------------------------------------------------ pointer
function setupPointer() {
  const canvas = $("map"), pointers = new Map();
  let drag = null;
  canvas.addEventListener("pointerdown", (e) => {
    canvas.setPointerCapture(e.pointerId);
    pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    drag = { x: e.clientX, y: e.clientY, moved: false };
    canvas.classList.add("dragging");
  });
  canvas.addEventListener("pointermove", (e) => {
    if (pointers.has(e.pointerId)) {
      const prev = pointers.get(e.pointerId);
      pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (pointers.size === 2) {
        const [a, b] = [...pointers.values()], other = [...pointers.entries()].find(([id]) => id !== e.pointerId)[1];
        const d0 = Math.hypot(prev.x - other.x, prev.y - other.y), d1 = Math.hypot(a.x - b.x, a.y - b.y);
        if (d0 > 0) map.zoomAt(d1 / d0, (a.x + b.x) / 2, (a.y + b.y) / 2);
        drag.moved = true; return;
      }
      const dx = e.clientX - prev.x, dy = e.clientY - prev.y;
      if (Math.abs(e.clientX - drag.x) + Math.abs(e.clientY - drag.y) > 4) drag.moved = true;
      if (drag.moved) { map.panBy(dx, dy); hideTip(); }
      return;
    }
    hover(e.clientX, e.clientY);
  });
  const end = (e) => {
    pointers.delete(e.pointerId);
    if (drag && !drag.moved && pointers.size === 0 && e.type === "pointerup") click(e.clientX, e.clientY);
    if (pointers.size === 0) { drag = null; canvas.classList.remove("dragging"); }
  };
  canvas.addEventListener("pointerup", end);
  canvas.addEventListener("pointercancel", end);
  canvas.addEventListener("pointerleave", () => { map.hovered = -1; map.hoverOverlay = null; hideTip(); markHot(-1); map.requestDraw(); });
  canvas.addEventListener("wheel", (e) => { e.preventDefault(); map.zoomAt(Math.exp(-e.deltaY * (e.ctrlKey ? 0.01 : 0.0015)), e.clientX, e.clientY); }, { passive: false });
}

function hover(x, y) {
  const ov = map.overlayAt(x, y);
  if (ov !== map.hoverOverlay) { map.hoverOverlay = ov; map.requestDraw(); }
  const i = map.hexAtScreen(x, y);
  if (i !== map.hovered) { map.hovered = i; map.requestDraw(); }
  markHot(i >= 0 ? D.tiles.prov[i] : -1);
  if (ov?.tip) return showTip(ov.tip, x, y);
  if (i < 0) return hideTip();
  showTip(hexTip(i), x, y);
}
function click(x, y) {
  const ov = map.overlayAt(x, y);
  if (ov?.prov != null) { openAdvisor(state.advisor); }
  const i = ov?.hex >= 0 ? ov.hex : map.hexAtScreen(x, y);
  inspect(i);
}

function lensValue(i) {
  const l = LENS_BY_ID.get(state.lens);
  if (!l || l.kind === "base") return null;
  const v = l.value(i);
  return v == null ? null : { l, v, text: l.fmt(v) };
}
function hexTip(i) {
  const S = D.tiles, t = map.terrainName(i), f = map.featureName(i), p = S.prov[i] >= 0 ? D.provinces[S.prov[i]] : null;
  const city = map.cityAt.get(i), lv = lensValue(i);
  let s = city ? `<b>${esc(city.name)}</b> · ${fmtBig(city.pop)}<br>` : "";
  if (lv) s += `<span class="tip-lens">${lv.l.icon} ${esc(lv.l.name)}: <b>${esc(lv.text)}</b></span><br>`;
  s += `${PRETTY[t]}${f ? " · " + PRETTY[f] : ""}`;
  if (S.land[i] && S.elev[i] != null) s += ` · ${fmtNum(S.elev[i])} m`;
  if (S.res[i] >= 0) { const k = D.meta.resourceKinds[D.resources[S.res[i]].r]; s += `<br>${RES[k]?.icon || ""} ${RES[k]?.label || k}`; }
  if (p) s += `<br><span class="muted">${esc(p.name)}</span>`;
  return s;
}
const tip = () => $("tooltip");
function showTip(html, x, y) {
  const t = tip();
  t.innerHTML = html; t.classList.remove("hidden");
  t.style.left = Math.min(window.innerWidth - 280, x + 14) + "px"; t.style.top = Math.min(window.innerHeight - 120, y + 14) + "px";
}
function hideTip() { tip().classList.add("hidden"); }

// ------------------------------------------------------------------ inspector
const row = (k, v) => `<div class="insp-row"><span>${k}</span><span>${v}</span></div>`;
const wd = (q, text) => (q ? `<a href="https://www.wikidata.org/wiki/${q}" target="_blank" rel="noopener">${esc(text)}</a>` : esc(text));
function inspect(i) {
  state.sel = i;
  map.setSelected(i);
  scheduleHash();
  const el = $("inspector");
  if (i < 0 || i == null) { el.classList.add("hidden"); return; }
  const S = D.tiles, [lon, lat] = map.hexLonLat(i), t = map.terrainName(i), f = map.featureName(i);
  const p = S.prov[i] >= 0 ? D.provinces[S.prov[i]] : null, ps = p?.stats || {};
  const city = map.cityAt.get(i), wonder = map.wonderAt.get(i), volc = map.volcanoAt.get(i), lv = lensValue(i);
  const title = city ? city.name : wonder ? (wonder.short || wonder.name) : volc ? volc.name : S.lake[i] >= 0 ? D.lakes[S.lake[i]] : PRETTY[t];
  const y = map.yields(i);
  let h = `<div class="insp-title">${esc(title)}</div><div class="insp-sub">${lat.toFixed(2)}°, ${lon.toFixed(2)}°${S.reg[i] >= 0 ? ` · ${esc(D.regencies[S.reg[i]])}` : ""}</div>`;
  h += `<div class="yields"><span class="y-food">🌾 ${y[0]}</span><span class="y-prod">⚒ ${y[1]}</span><span class="y-gold">🪙 ${y[2]}</span></div>`;
  if (lv) h += `<div class="insp-lens" style="border-color:${lv.l.categorical ? lv.l.color(lv.v) : lv.l.color(lv.v)}">${lv.l.icon} ${esc(lv.l.name)} <b>${esc(lv.text)}</b></div>`;
  if (city) {
    h += `<div class="insp-section"><h3>City</h3>${row("Population", `${fmtNum(city.pop)}${city.popYear ? ` (${city.popYear})` : ""}`)}${row("City size", city.size)}`;
    if (city.capital === "national") h += row("Status", "★ National capital");
    if (city.capitalOf) h += row("Capital of", esc(city.capitalOf));
    if (city.absorbed?.length) h += row("Also nearby", city.absorbed.map((a) => esc(a.name)).join(", "));
    h += row("Wikidata", wd(city.qid, city.qid)) + `</div>`;
  }
  h += `<div class="insp-section"><h3>Tile</h3>${row("Terrain", PRETTY[t])}${f ? row("Feature", PRETTY[f]) : ""}`;
  if (S.land[i]) {
    h += row("Elevation", S.elev[i] != null ? `${fmtNum(S.elev[i])} m` : "–");
    if (S.forest[i] >= 0) h += row("Land cover", `<span class="lc">🌳 ${S.forest[i]}% · 🌾 ${S.farm[i]}% · 🏙️ ${S.urban[i]}%</span>`);
    h += row("People", `${fmtNum(S.pop[i])} <span class="muted">(${fmtNum(S.popd[i])}/km²)</span>`);
    h += row("Night lights", `${S.lights[i]} / 255`);
    if (S.quakes[i]) h += row("M5+ quakes nearby", fmtNum(S.quakes[i]));
  }
  if (S.river[i] >= 0) h += row("River", esc(D.rivers[S.river[i]].name));
  if (S.reef[i] >= 0) h += row("Reef", esc(D.reefs[S.reef[i]]));
  if (S.park[i] >= 0) { const pk = D.parks[S.park[i]]; h += row("Protected", wd(pk.qid, pk.name)); }
  h += `</div>`;
  if (S.res[i] >= 0) {
    const site = D.resources[S.res[i]], kind = D.meta.resourceKinds[site.r], m = RES[kind] || { label: kind, icon: "", cls: "" };
    h += `<div class="insp-section"><h3>Resource</h3>${row(`${m.icon} ${m.label}`, `<span style="color:${RES_RING[m.cls]}">${m.cls}</span>`)}<div class="muted small">${esc(site.site)}</div></div>`;
  }
  const plants = D.plants.filter((x) => x.hex === i), airports = D.airports.filter((x) => x.hex === i);
  if (plants.length || airports.length) {
    h += `<div class="insp-section"><h3>Infrastructure</h3>`;
    for (const x of plants) h += row(`<i class="dot" style="background:${FUEL_COLORS[x.fuel]}"></i>${esc(x.name)}`, `${fmtNum(x.mw)} MW ${esc(x.fuel)}`);
    for (const x of airports) h += row(`✈️ ${esc(x.iata)}`, x.pax ? `${fmtBig(x.pax)} pax (${x.paxYear})` : esc(x.type));
    h += `</div>`;
  }
  if (volc) h += `<div class="insp-section"><h3>Volcano</h3>${row("Name", wd(volc.qid, volc.name))}${row("Summit", volc.elev ? `${fmtNum(volc.elev)} m` : "–")}</div>`;
  if (wonder) {
    h += `<div class="insp-section"><h3>${wonder.unesco ? "UNESCO World Heritage" : "Wonder"}</h3>${row("Type", wonder.kind === "natural" ? "Natural wonder" : "Cultural wonder")}`;
    if (wonder.qid) h += row("Wikidata", wd(wonder.qid, wonder.qid));
    if (wonder.desc) h += `<div class="muted small">${esc(wonder.desc)}</div>`;
    h += `</div>`;
  }
  if (p) {
    h += `<div class="insp-section"><h3>Province</h3>${row("Name", `<span class="chip" style="background:${p.color}"></span>${wd(p.qid, p.name)}`)}`;
    h += row("Capital", esc(p.capital || "–")) + row("Population", `${fmtBig(p.pop)}${p.popYear ? ` (${p.popYear})` : ""}`);
    if (ps.gdpBRp) h += row("GDP", `${fmtRp(ps.gdpBRp)} · ${fmtUsd(ps.gdpPcUsd)}/person`);
    if (ps.hdi) h += row("HDI", `${ps.hdi.toFixed(3)} · life ${ps.lifeExp?.toFixed(1)} yrs`);
    if (ps.pov365 != null) h += row("Under $3.65/day", fmtPct(ps.pov365));
    if (ps.religion) { const top = Object.entries(ps.religion).filter(([k]) => !["Protestant", "Catholic"].includes(k)).sort((a, b) => b[1] - a[1]).slice(0, 2); h += row("Faith", top.map(([k, v]) => `${k} ${v.toFixed(0)}%`).join(" · ")); }
    h += row("Forest", fmtPct(ps.forestPct, 0));
    h += `</div>`;
  }
  $("inspector-body").innerHTML = h;
  el.classList.remove("hidden");
}

// ------------------------------------------------------------------ search
function setupSearch() {
  const entries = [];
  D.cities.forEach((c) => entries.push({ label: `${c.name} (city)`, hex: c.hex }));
  D.provinces.forEach((p, k) => entries.push({ label: `${p.name} (province)`, prov: k }));
  D.wonders.forEach((w) => entries.push({ label: `${w.short || w.name} (wonder)`, hex: w.hex }));
  D.volcanoes.forEach((v) => entries.push({ label: `${v.name} (volcano)`, hex: v.hex }));
  D.airports.filter((a) => a.pax).forEach((a) => entries.push({ label: `${a.name} ${a.iata} (airport)`, hex: a.hex }));
  D.plants.forEach((p) => entries.push({ label: `${p.name} (${p.fuel.toLowerCase()} plant)`, hex: p.hex }));
  $("search-list").innerHTML = entries.map((e) => `<option value="${esc(e.label)}"></option>`).join("");
  const input = $("search");
  const go = () => {
    const q = input.value.trim().toLowerCase();
    if (!q) return;
    const hit = entries.find((e) => e.label.toLowerCase() === q) || entries.find((e) => e.label.toLowerCase().startsWith(q)) || entries.find((e) => e.label.toLowerCase().includes(q));
    if (!hit) return;
    if (hit.prov != null) {
      const cap = D.cities.find((c) => c.capitalOf === D.provinces[hit.prov].name);
      const i = cap ? cap.hex : D.tiles.prov.indexOf(hit.prov);
      const [lon, lat] = map.hexLonLat(i);
      map.flyTo(lon, lat, 70, panelWidth() / 2); map.setHighlight({ provs: [hit.prov] }); inspect(i);
    } else {
      const [lon, lat] = map.hexLonLat(hit.hex);
      map.flyTo(lon, lat, 170, panelWidth() / 2); inspect(hit.hex);
    }
    input.blur();
  };
  input.addEventListener("change", go);
  input.addEventListener("keydown", (e) => { if (e.key === "Enter") go(); });
  $("close-inspector").onclick = () => inspect(-1);
}

boot().catch((err) => {
  console.error(err);
  $("loading").textContent = "Could not load map-data.json — run scripts/build_map.py first.";
});
