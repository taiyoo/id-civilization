// Lens definitions: every lens maps a hex index to a number (or category) plus
// a palette, legend and source line. Hex lenses come from measured rasters;
// province lenses colour every hex of a province with that province's figure.
import { fmtNum, fmtPct, fmtRp, fmtUsd } from "./ui.js";

export const PALETTES = {
  forest: ["#14201a", "#1d3b25", "#245a2d", "#2f7d35", "#56a647", "#a6d670", "#e3f5a8"],
  farm: ["#211c10", "#4a3b17", "#7a5f1d", "#a98423", "#d0aa3a", "#ecd36a", "#fbf0b0"],
  urban: ["#17171c", "#352a33", "#5b3742", "#8a434a", "#bf5a4b", "#e98a55", "#fcd28a"],
  water: ["#0f1a24", "#143247", "#17506b", "#1b708a", "#2c95a5", "#5cbcbc", "#a8e3d8"],
  people: ["#110d20", "#33184f", "#5f2370", "#922d74", "#c43f62", "#ec6c48", "#fbbf5a", "#fff1a6"],
  lights: ["#05060c", "#141834", "#2c2a55", "#5b4566", "#9b7357", "#e0b65e", "#fff2b8"],
  wealth: ["#1a1430", "#2b3474", "#225f97", "#1e8aa0", "#33b28a", "#8fd263", "#eff27a"],
  bad: ["#14161c", "#3a2219", "#682c1b", "#97361d", "#c8502a", "#ec8538", "#fbcf6a"],
  hazard: ["#141820", "#33281e", "#5b3a1c", "#8a4c1a", "#bd5f1c", "#e8812c", "#ffc35a"],
  learn: ["#141a2c", "#1d2f57", "#23498a", "#2867b0", "#3f8ccc", "#77b5df", "#c4e3f2"],
  elev: ["#24583a", "#4f8a43", "#a7a85a", "#c9a76b", "#a37a5a", "#8d7b78", "#f2f2f2"],
  growth: ["#7a2d2d", "#b8553a", "#e0a65e", "#e8e3c2", "#8ec7a1", "#3f9d7c", "#1f6f6a"],
};

export const FAITHS = [
  { key: "Islam", color: "#3fa06a" },
  { key: "Protestant", color: "#4f7fd6" },
  { key: "Catholic", color: "#8f6ad6" },
  { key: "Christian", color: "#6b9be0" },
  { key: "Hindu", color: "#e3913b" },
  { key: "Buddhist", color: "#e8c547" },
  { key: "Folk", color: "#c2577c" },
];

export function lerpColor(stops, t) {
  t = Math.max(0, Math.min(1, t));
  const x = t * (stops.length - 1), k = Math.min(stops.length - 2, Math.floor(x)), f = x - k;
  const a = hex2rgb(stops[k]), b = hex2rgb(stops[k + 1]);
  return `rgb(${Math.round(a[0] + (b[0] - a[0]) * f)},${Math.round(a[1] + (b[1] - a[1]) * f)},${Math.round(a[2] + (b[2] - a[2]) * f)})`;
}
function hex2rgb(h) {
  const n = parseInt(h.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

export function buildLenses(D) {
  const S = D.tiles, P = D.provinces, N = S.land.length;
  const provVal = (get) => (i) => {
    const p = S.prov[i];
    if (p < 0 || !S.land[i]) return null;
    const v = get(P[p].stats || {}, P[p]);
    return v == null || Number.isNaN(v) ? null : v;
  };
  const hexVal = (arr, { landOnly = true, skipNeg = true } = {}) => (i) => {
    if (landOnly && !S.land[i]) return null;
    const v = arr[i];
    return skipNeg && v < 0 ? null : v;
  };
  const src = (k) => D.meta.statSources?.[k];
  const wiki = (k, extra = "") => {
    const s = src(k);
    return s ? `${s.title}${extra} · Wikipedia` : extra;
  };
  const majority = (rel) => {
    if (!rel) return null;
    const groups = { Islam: rel.Islam || 0, Christian: rel.Christian || (rel.Protestant || 0) + (rel.Catholic || 0), Hindu: rel.Hindu || 0, Buddhist: rel.Buddhist || 0, Folk: rel.Folk || 0 };
    let best = null;
    for (const [k, v] of Object.entries(groups)) if (!best || v > best[1]) best = [k, v];
    // split Christian into Protestant / Catholic only when the source gives the breakdown
    if (best[0] === "Christian" && (rel.Protestant || rel.Catholic)) best[0] = (rel.Catholic || 0) > (rel.Protestant || 0) ? "Catholic" : "Protestant";
    return best[0];
  };

  const L = [
    // ------------------------------------------------ base
    { id: "terrain", name: "Terrain", group: "Base map", icon: "🗺️", kind: "base" },
    { id: "elevation", name: "Elevation", group: "Base map", icon: "⛰️", kind: "hex", palette: "elev",
      value: hexVal(S.elev.map((e) => (e == null ? -1 : e))), domain: [0, 3500], fmt: (v) => `${fmtNum(v)} m`,
      source: "Copernicus GLO-90 DEM via Open-Meteo · sampled at each hex centre" },

    // ------------------------------------------------ people
    { id: "population", name: "Population", group: "People", icon: "👥", kind: "hex", palette: "people", log: true,
      value: (i) => (S.land[i] && S.popd[i] > 0 ? S.popd[i] : null), domain: [5, 5000],
      fmt: (v) => `${fmtNum(v)} /km²`, unit: "people per km²",
      source: "GPW v4 2020 density (SEDAC/NASA), scaled to mid-2025 province totals" },
    { id: "faith", name: "Faith", group: "People", icon: "🕌", kind: "province", categorical: true,
      value: provVal((s) => majority(s.religion)),
      cats: FAITHS,
      fmt: (v) => v, source: "Largest religion by province · province articles on Wikipedia (BPS / Dukcapil 2022–24)" },
    { id: "muslim", name: "Muslim share", group: "People", icon: "☪️", kind: "province", palette: "forest",
      value: provVal((s) => s.religion?.Islam), domain: [0, 100], fmt: (v) => `${v.toFixed(1)}%`,
      source: "Province articles on Wikipedia (BPS / Dukcapil 2022–24)" },
    { id: "christian", name: "Christian share", group: "People", icon: "✝️", kind: "province", palette: "learn",
      value: provVal((s) => s.religion?.Christian), domain: [0, 100], fmt: (v) => `${v.toFixed(1)}%`,
      source: "Province articles on Wikipedia (BPS / Dukcapil 2022–24)" },

    // ------------------------------------------------ prosperity
    { id: "gdppc", name: "GDP per person", group: "Prosperity", icon: "💰", kind: "province", palette: "wealth", log: true,
      value: provVal((s) => s.gdpPcUsd), fmt: (v) => fmtUsd(v), source: wiki("gdpPerCapita", " (2025, nominal US$)") },
    { id: "gdpgrowth", name: "GDP growth", group: "Prosperity", icon: "📈", kind: "province", palette: "growth", diverging: true,
      value: provVal((s) => (s.gdpGrowth != null ? 100 * s.gdpGrowth : null)), domain: [0, 16],
      fmt: (v) => `${v >= 0 ? "+" : ""}${v.toFixed(1)}%`, source: wiki("gdp", " · nominal GRDP 2024→2025") },
    { id: "hdi", name: "Human development", group: "Prosperity", icon: "🌱", kind: "province", palette: "wealth",
      value: provVal((s) => s.hdi), domain: [0.55, 0.86], fmt: (v) => v.toFixed(3), source: wiki("hdi", " (BPS method)") },
    { id: "spending", name: "Spending per person", group: "Prosperity", icon: "🛒", kind: "province", palette: "wealth",
      value: provVal((s) => s.spendKRp), fmt: (v) => `Rp${fmtNum(v)}k / yr`,
      source: wiki("hdi", " · adjusted per-capita expenditure (thousand Rp, PPP)") },
    { id: "poverty", name: "Poverty", group: "Prosperity", icon: "🪙", kind: "province", palette: "bad",
      value: provVal((s) => s.pov365), domain: [0, 50], fmt: (v) => `${v.toFixed(1)}%`,
      unit: "share living under $3.65 a day (2017 PPP)", source: wiki("poverty", " · World Bank 2022") },
    { id: "gini", name: "Inequality", group: "Prosperity", icon: "⚖️", kind: "province", palette: "bad",
      value: provVal((s) => s.gini), domain: [0.22, 0.45], fmt: (v) => v.toFixed(3), unit: "Gini coefficient",
      source: wiki("poverty", " · World Bank 2022") },

    // ------------------------------------------------ knowledge & health
    { id: "schooling", name: "Years of schooling", group: "Knowledge", icon: "🎓", kind: "province", palette: "learn",
      value: provVal((s) => s.meanSchool), domain: [4, 12], fmt: (v) => `${v.toFixed(2)} yrs`,
      unit: "mean years of schooling, adults 25+", source: wiki("hdi", " (BPS)") },
    { id: "expschool", name: "Expected schooling", group: "Knowledge", icon: "📚", kind: "province", palette: "learn",
      value: provVal((s) => s.expSchool), domain: [9.5, 16.5], fmt: (v) => `${v.toFixed(2)} yrs`,
      unit: "expected years of schooling for a child entering school", source: wiki("hdi", " (BPS)") },
    { id: "lifeexp", name: "Life expectancy", group: "Knowledge", icon: "❤️", kind: "province", palette: "learn",
      value: provVal((s) => s.lifeExp), domain: [64, 77], fmt: (v) => `${v.toFixed(1)} yrs`, source: wiki("hdi", " (BPS)") },

    // ------------------------------------------------ activity
    { id: "lights", name: "Night lights", group: "Activity", icon: "🌃", kind: "hex", palette: "lights",
      value: (i) => (S.land[i] || S.prov[i] >= 0 ? S.lights[i] : null), domain: [4, 140], log: true,
      fmt: (v) => `${Math.round(v)} / 255`, unit: "mean brightness", source: "VIIRS Black Marble (NASA GIBS) · brightness of the composite image" },
    { id: "footprint", name: "Human footprint", group: "Activity", icon: "👣", kind: "hex", palette: "urban",
      value: hexVal(S.footprint), domain: [0, 60], fmt: (v) => `${Math.round(v)} / 100`,
      source: "Human Footprint index 1995–2004 (WCS/CIESIN, NASA GIBS)" },

    // ------------------------------------------------ land
    { id: "forest", name: "Forest", group: "Land", icon: "🌳", kind: "hex", palette: "forest",
      value: hexVal(S.forest), domain: [0, 100], fmt: (v) => `${v}%`, unit: "share of land",
      source: "MODIS MCD12Q1 land cover 2024 (IGBP forest classes) · 500 m pixels summarised per hex" },
    { id: "farmland", name: "Farmland", group: "Land", icon: "🌾", kind: "hex", palette: "farm",
      value: hexVal(S.farm), domain: [0, 100], fmt: (v) => `${v}%`, unit: "share of land",
      source: "MODIS MCD12Q1 2024 · croplands + cropland/natural mosaic" },
    { id: "builtup", name: "Built-up", group: "Land", icon: "🏙️", kind: "hex", palette: "urban",
      value: hexVal(S.urban), domain: [0, 60], fmt: (v) => `${v}%`, unit: "share of land",
      source: "MODIS MCD12Q1 2024 · urban and built-up lands" },
    { id: "mangrove", name: "Mangroves", group: "Land", icon: "🌿", kind: "hex", palette: "water",
      value: (i) => (S.mangrove[i] > 0 ? S.mangrove[i] : S.land[i] ? 0 : null), domain: [0, 60], fmt: (v) => `${v}%`,
      unit: "share of hex", source: "Global mangrove forests 2000 (Giri et al., SEDAC/NASA GIBS)" },
    { id: "wetland", name: "Wetlands", group: "Land", icon: "🦆", kind: "hex", palette: "water",
      value: hexVal(S.wetland), domain: [0, 80], fmt: (v) => `${v}%`, unit: "share of land",
      source: "MODIS MCD12Q1 2024 · permanent wetlands" },
    { id: "savanna", name: "Savanna & grass", group: "Land", icon: "🦬", kind: "hex", palette: "farm",
      value: hexVal(S.savanna), domain: [0, 100], fmt: (v) => `${v}%`, unit: "share of land",
      source: "MODIS MCD12Q1 2024 · shrubland, savanna and grassland classes" },

    // ------------------------------------------------ hazards
    { id: "quakes", name: "Earthquakes", group: "Hazards", icon: "🌐", kind: "hex", palette: "hazard", log: true,
      value: (i) => (S.land[i] || S.prov[i] >= 0 ? S.quakes[i] : null), domain: [1, 120],
      fmt: (v) => `${v} quakes`, unit: "M5+ epicentres within ~35 km since 1900", source: "USGS earthquake catalogue" },
    { id: "landslide", name: "Landslide hazard", group: "Hazards", icon: "⛰", kind: "hex", palette: "hazard",
      value: (i) => (S.land[i] ? S.landslide[i] / 10 : null), domain: [2, 8], fmt: (v) => `${v.toFixed(1)} / 9`,
      source: "Global landslide hazard distribution (NGI, SEDAC Natural Disaster Hotspots)" },
    { id: "flood", name: "Flood frequency", group: "Hazards", icon: "🌊", kind: "hex", palette: "water",
      value: (i) => (S.land[i] ? S.flood[i] / 10 : null), domain: [0, 6], fmt: (v) => `${v.toFixed(1)} / 10`,
      unit: "flood-hazard frequency decile, 1985–2003", source: "Global flood hazard frequency (Dartmouth Flood Observatory, SEDAC Natural Disaster Hotspots)" },
  ];

  // Domains: fixed where given, otherwise robust 2nd–98th percentile
  for (const l of L) {
    if (!l.value || l.categorical) continue;
    if (!l.domain) {
      const vals = [];
      for (let i = 0; i < N; i++) { const v = l.value(i); if (v != null) vals.push(v); }
      vals.sort((a, b) => a - b);
      l.domain = [vals[Math.floor(vals.length * 0.02)], vals[Math.floor(vals.length * 0.98)]];
    }
    const [a, b] = l.domain;
    l.t = l.log
      ? (v) => (Math.log(Math.max(v, a * 0.5)) - Math.log(a)) / (Math.log(b) - Math.log(a))
      : (v) => (v - a) / (b - a);
    l.color = (v) => lerpColor(PALETTES[l.palette], l.t(v));
  }
  for (const l of L.filter((l) => l.categorical)) {
    const m = new Map(l.cats.map((c) => [c.key, c.color]));
    l.color = (v) => m.get(v) || "#666";
  }
  return L;
}
