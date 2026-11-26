// Advisor dashboards. Each advisor renders HTML for the side panel and may
// set a default lens and a map overlay (circles for plants, airports, quakes...).
import { bars, columns, esc, fmtBig, fmtNum, fmtPct, fmtRp, fmtUsd, kpis, section, sign, sources, stack, table } from "./ui.js";
import { FAITHS, PALETTES, lerpColor } from "./lenses.js";
import { RES } from "./render.js";

export const FUEL_COLORS = { Coal: "#7b7f86", Gas: "#e8a33d", Oil: "#b5651d", Hydro: "#3d8fd6", Geothermal: "#e0553f", Solar: "#f2d23c", Wind: "#9ad0e8", Biomass: "#6bbf59" };
const ISLANDS = ["Sumatra", "Java", "Kalimantan", "Sulawesi", "Lesser Sunda", "Maluku", "Papua"];

export function buildAdvisors(D, ctx) {
  const N = D.national, P = D.provinces;
  const rows = P.map((p, k) => ({ k, p, s: p.stats || {} }));
  const rate = N.gdpBRp && N.gdpUsdB ? N.gdpBRp / N.gdpUsdB : 16500; // Rp per US$ implied by the source table
  const src = (k) => { const s = D.meta.statSources?.[k]; return s ? { name: `Wikipedia — ${s.title}`, url: s.url, note: "CC BY-SA" } : null; };
  const metaSrc = (needle) => D.meta.sources.filter((s) => s.name.includes(needle)).map((s) => ({ name: s.name, url: s.url, note: s.license }));
  const by = (key, desc = true) => rows.filter((r) => r.s[key] != null).sort((a, b) => (desc ? b.s[key] - a.s[key] : a.s[key] - b.s[key]));
  const provBar = (r, value, display, extra = {}) => ({ label: r.p.name, value, display, prov: r.k, sub: r.p.island, ...extra });
  const wavg = (key) => {
    let a = 0, w = 0;
    for (const r of rows) if (r.s[key] != null && r.p.pop) { a += r.s[key] * r.p.pop; w += r.p.pop; }
    return w ? a / w : null;
  };
  const islandAgg = (fn) => ISLANDS.map((isl) => ({ isl, v: rows.filter((r) => r.p.island === isl).reduce((a, r) => a + (fn(r) || 0), 0) }));
  const totalPop = N.pop2025;
  const gdpPcUsd = (N.gdpUsdB * 1e9) / totalPop;
  const centroid = ctx.centroid;

  const A = {};

  // ---------------------------------------------------------------- Economy
  A.economy = {
    id: "economy", role: "Treasurer", name: "Economy", icon: "🏛️", group: "Wealth and work",
    desc: "Who makes what: output by province, and the regions that lead it.",
    lens: "gdppc",
    overlay: () => ({
      legend: "Circle area = provincial GDP 2025 · colour = GDP per person",
      items: rows.filter((r) => r.s.gdpBRp).map((r) => {
        const [lon, lat] = centroid(r.k);
        return { lon, lat, r: 2 + Math.sqrt(r.s.gdpBRp / 1000) * 0.55, color: lerpColor(PALETTES.wealth, Math.log(r.s.gdpPcUsd / 1200) / Math.log(22000 / 1200)),
          prov: r.k, label: r.s.gdpBRp > 900000 ? r.p.name.replace(" Special Capital Region", "") : null,
          tip: `<b>${esc(r.p.name)}</b><br>GDP ${fmtRp(r.s.gdpBRp)} (${fmtUsd(r.s.gdpBRp * 1e9 / rate)})<br>${fmtUsd(r.s.gdpPcUsd)} per person` };
      }),
    }),
    render() {
      const java = rows.filter((r) => r.p.island === "Java").reduce((a, r) => a + (r.s.gdpBRp || 0), 0);
      const series = Object.entries(N.gdpSeries || {}).map(([y, v]) => ({ x: y, y: v / 1000, label: y }));
      const isl = islandAgg((r) => r.s.gdpBRp), islPop = islandAgg((r) => r.p.pop);
      return kpis([
        { label: `GDP ${N.gdpYear}`, value: fmtRp(N.gdpBRp), sub: `≈ ${fmtUsd(N.gdpUsdB * 1e9, 2)} nominal · ${fmtUsd(N.gdpPppB * 1e9, 2)} PPP` },
        { label: "Per person", value: fmtUsd(gdpPcUsd), sub: `Rp${fmtNum(N.gdpBRp * 1e9 / totalPop / 1e6, 1)}M · GDP ÷ residents`, lens: "gdppc" },
        { label: "Growth", value: sign(100 * N.gdpGrowth), sub: `nominal, ${N.gdpYear - 1}→${N.gdpYear}`, lens: "gdpgrowth" },
      ]) +
        section("Output", "Nominal GDP at current prices, trillion rupiah.", columns(series, { fmt: (v) => `Rp${fmtNum(v)}T` }), { kicker: "Indonesia" }) +
        section("Java and the rest", `Java makes <b>${fmtPct(100 * java / N.gdpBRp)}</b> of national output on ${fmtPct(100 * rows.filter((r) => r.p.island === "Java").reduce((a, r) => a + (r.p.areaKm2 || 0), 0) / rows.reduce((a, r) => a + (r.p.areaKm2 || 0), 0))} of the land. Hover an island group to see its provinces.`,
          table([{ key: "isl", label: "Island group" }, { key: "gdp", label: "Share of GDP", num: true, fmt: (v) => fmtPct(v) },
            { key: "pop", label: "Share of people", num: true, fmt: (v) => fmtPct(v) }, { key: "ratio", label: "GDP ÷ people", num: true, fmt: (v) => `×${v.toFixed(2)}` }],
          isl.map((x, k) => ({ isl: x.isl, gdp: 100 * x.v / N.gdpBRp, pop: 100 * islPop[k].v / totalPop, ratio: (x.v / N.gdpBRp) / (islPop[k].v / totalPop), islandKey: x.isl })), { sortKey: "gdp" })) +
        section("Provinces by output", "Gross regional domestic product, 2025. Hover a bar to find the province; click to fly there.",
          bars(by("gdpBRp").map((r) => provBar(r, r.s.gdpBRp, `${fmtRp(r.s.gdpBRp)} <small>${fmtPct(100 * r.s.gdpBRp / N.gdpBRp)}</small>`)), { limit: 12 })) +
        section("Output per person", "GRDP per resident in nominal US$. Mining and LNG provinces rank high because output is counted where it is produced.",
          bars(by("gdpPcUsd").map((r) => provBar(r, r.s.gdpPcUsd, fmtUsd(r.s.gdpPcUsd))), { limit: 12, color: "#4fb39a" }), { lens: "gdppc" }) +
        section("Fastest growing", "Nominal GRDP growth 2024→2025 (includes inflation).",
          bars(by("gdpGrowth").map((r) => provBar(r, 100 * r.s.gdpGrowth, sign(100 * r.s.gdpGrowth), { color: r.s.gdpGrowth < 0 ? "#c8502a" : "#6fbf73" })), { limit: 10 }), { lens: "gdpgrowth" }) +
        sources([src("gdp"), src("gdpPerCapita")].filter(Boolean), [
          "All figures are nominal (current prices); growth therefore includes inflation.",
          `US$ values use the rate implied by the source table (≈ Rp${fmtNum(rate)} per $).`,
          "Central Papua's output is dominated by the Grasberg mine; East Kalimantan's by coal, oil and gas.",
        ]);
    },
  };

  // ---------------------------------------------------------------- Prosperity
  A.prosperity = {
    id: "prosperity", role: "Steward of the Hearth", name: "Prosperity", icon: "🏠", group: "Wealth and work",
    desc: "Living standards, poverty and who is being left behind.",
    lens: "poverty",
    render() {
      return kpis([
        { label: "Below $3.65 / day", value: fmtPct(N.pov365), sub: `World Bank, ${N.povYear}`, lens: "poverty" },
        { label: "Below $6.85 / day", value: fmtPct(N.pov685), sub: "upper-middle-income line" },
        { label: "Inequality", value: N.gini?.toFixed(3), sub: "Gini coefficient", lens: "gini" },
      ]) +
        section("Poverty by province", "Share of people living on less than $3.65 a day (2017 PPP). Papua and the eastern islands are poorest.",
          bars(by("pov365").map((r) => provBar(r, r.s.pov365, fmtPct(r.s.pov365), r.s.povInherited ? { sub: `${r.p.island} · figure for pre-2022 ${r.s.povInherited}` } : {})), { limit: 12, color: "#d0603a" }), { lens: "poverty" }) +
        section("Human development", `BPS Human Development Index, ${N.hdiYear}: health, education and spending combined.`,
          bars(by("hdi").map((r) => provBar(r, r.s.hdi - 0.5, r.s.hdi.toFixed(3))), { limit: 12, color: "#4fb39a" }), { lens: "hdi" }) +
        section("Spending per person", "Adjusted per-capita household expenditure, thousand rupiah a year (PPP-adjusted).",
          bars(by("spendKRp").map((r) => provBar(r, r.s.spendKRp, `Rp${fmtNum(r.s.spendKRp)}k`)), { limit: 10 }), { lens: "spending" }) +
        section("Inequality", "Gini coefficient of consumption (0 = equal, 1 = one person has everything).",
          bars(by("gini").map((r) => provBar(r, r.s.gini, r.s.gini.toFixed(3))), { limit: 10, color: "#c58a3a" }), { lens: "gini" }) +
        sources([src("poverty"), src("hdi")].filter(Boolean), [
          "World Bank international lines are not the BPS national poverty line (≈ 9% of people in 2024); they measure different things.",
          "Poverty and Gini are 2022 estimates on pre-2022 boundaries: the four new Papua provinces inherit their parent's figure.",
        ]);
    },
  };

  // ---------------------------------------------------------------- Commerce
  const airports = D.airports.filter((a) => a.pax);
  A.commerce = {
    id: "commerce", role: "Master of Trade", name: "Commerce", icon: "⚖️", group: "Wealth and work",
    desc: "The busiest airports and seaports, and where the economy glows at night.",
    lens: "lights",
    overlay: () => ({
      legend: "Circles = airports (area = passengers) · squares = major seaports",
      items: [
        ...airports.map((a) => ({ lon: a.lon, lat: a.lat, r: 2 + Math.sqrt(a.pax / 1e6) * 2.4, color: "#5fb3d9", hex: a.hex,
          label: a.pax > 6e6 ? a.iata : null, tip: `<b>${esc(a.name)}</b> (${a.iata})<br>${fmtBig(a.pax)} passengers in ${a.paxYear}` })),
        ...D.ports.map((p) => ({ lon: p.lon, lat: p.lat, r: 6, shape: "square", color: "#3fb6a8", icon: "⚓", hex: p.hex,
          tip: `<b>${esc(p.name)}</b>, ${esc(p.city)}<br>${esc(p.note)}` })),
      ],
    }),
    render() {
      const top = airports[0];
      const tot = airports.reduce((a, x) => a + x.pax, 0);
      return kpis([
        { label: "Busiest airport", value: top.iata, sub: `${fmtBig(top.pax)} passengers (${top.paxYear})` },
        { label: "Top airports", value: fmtBig(tot), sub: `passengers at ${airports.length} airports` },
        { label: "Seaports shown", value: D.ports.length, sub: "main container and hub ports" },
      ]) +
        section("Airports by passengers", "Hover a row to find it on the map. Growth runs from the first year with 100k+ passengers to the last year in the source table.",
          table([{ key: "iata", label: "Code" }, { key: "city", label: "City" }, { key: "pax", label: "Passengers", num: true, fmt: (v) => fmtBig(v) },
            { key: "growth", label: "Growth", num: true, fmt: (v) => (v == null ? "–" : sign(v, 0)) }],
          airports.map((a) => {
            const ys = Object.keys(a.paxSeries || {}).map(Number).sort();
            const base = ys.find((y) => a.paxSeries[y] >= 100000); // skip tiny bases (e.g. Halim before it reopened)
            const g = base != null && base !== ys[ys.length - 1] ? 100 * (a.paxSeries[ys[ys.length - 1]] / a.paxSeries[base] - 1) : null;
            return { iata: a.iata, city: a.city, pax: a.pax, growth: g, hex: a.hex, fly: [a.lon, a.lat, 150] };
          }), { sortKey: "pax", limit: 15 })) +
        section("Seaports", "The main gateways of the archipelago.",
          table([{ key: "name", label: "Port" }, { key: "city", label: "City" }, { key: "note", label: "Role" }],
            D.ports.map((p) => ({ ...p, fly: [p.lon, p.lat, 150] })), { sortKey: "name", desc: false })) +
        section("Night lights", "Mean brightness of each province in the VIIRS Black Marble composite: a proxy for electrification and economic activity.",
          bars(by("lights").map((r) => provBar(r, r.s.lights, fmtNum(r.s.lights, 1))), { limit: 12, color: "#e0b65e" }), { lens: "lights" }) +
        sources([src("airports") || { name: "Wikipedia — List of the busiest airports in Indonesia" }, ...metaSrc("OurAirports"), ...metaSrc("Black Marble")].filter(Boolean), [
          "Passenger counts in the source table stop at 2018 (before the pandemic).",
          "Port roles are curated notes; throughput data is not included.",
        ]);
    },
  };

  // ---------------------------------------------------------------- Energy & resources
  const plants = D.plants;
  const mines = D.resources.map((r, k) => ({ ...r, k })).filter((r) => !r.regional);
  A.energy = {
    id: "energy", role: "Minister of Power", name: "Energy & Resources", icon: "⚡", group: "Wealth and work",
    desc: "Where the power comes from, and what lies underground.",
    lens: "terrain",
    overlay: () => ({
      legend: "Circle area = plant capacity (MW) · colour = fuel",
      items: plants.map((p) => ({ lon: p.lon, lat: p.lat, r: 2 + Math.sqrt(p.mw) * 0.32, color: FUEL_COLORS[p.fuel] || "#999", hex: p.hex,
        label: p.mw >= 1800 ? p.name.replace(/ (power station|Power Station|Steam Power Plant|PLTU)/, "") : null,
        tip: `<b>${esc(p.name)}</b><br>${esc(p.fuel)} · ${fmtNum(p.mw)} MW${p.year ? ` · since ${p.year}` : ""}` })),
    }),
    render() {
      const byFuel = {};
      for (const p of plants) byFuel[p.fuel] = (byFuel[p.fuel] || 0) + p.mw;
      const tot = plants.reduce((a, p) => a + p.mw, 0);
      const fuels = Object.entries(byFuel).sort((a, b) => b[1] - a[1]);
      const kinds = {};
      for (const m of mines) { const k = D.meta.resourceKinds[m.r]; kinds[k] = (kinds[k] || 0) + 1; }
      return kpis([
        { label: "Capacity listed", value: `${fmtNum(tot / 1000, 1)} GW`, sub: `${plants.length} large plants (WRI 2021)` },
        { label: "Coal share", value: fmtPct(100 * (byFuel.Coal || 0) / tot), sub: "of listed capacity" },
        { label: "Geothermal", value: `${fmtNum(byFuel.Geothermal || 0)} MW`, sub: "from the Ring of Fire" },
      ]) +
        section("Capacity by fuel", "Hover a fuel to see its plants.",
          `<div class="bars">${fuels.map(([f, mw], k) => `<div class="bar-row" data-fuel="${f}"><span class="bar-rank">${k + 1}</span><span class="bar-label">${f}</span>
            <span class="bar-track"><span class="bar-fill" style="width:${100 * mw / fuels[0][1]}%;background:${FUEL_COLORS[f]}"></span></span>
            <span class="bar-value">${fmtNum(mw)} MW <small>${fmtPct(100 * mw / tot)}</small></span></div>`).join("")}</div>`) +
        section("Largest plants", "",
          table([{ key: "name", label: "Plant" }, { key: "fuel", label: "Fuel" }, { key: "mw", label: "MW", num: true, fmt: (v) => fmtNum(v) },
            { key: "year", label: "Since", num: true, fmt: (v) => v ?? "–" }],
          plants.map((p) => ({ ...p, fly: [p.lon, p.lat, 160] })), { sortKey: "mw", limit: 15 })) +
        section("Capacity by province", "",
          bars(by("powerMW").filter((r) => r.s.powerMW > 0).map((r) => provBar(r, r.s.powerMW, `${fmtNum(r.s.powerMW)} MW`)), { limit: 10, color: "#e8a33d" })) +
        section("Mines and fields", "Named mines, oil and gas fields, and plantation centres on the map. Click to fly there.",
          `<div class="chips">${Object.entries(kinds).sort((a, b) => b[1] - a[1]).map(([k, n]) => `<span class="chip-res">${RES[k]?.icon || ""} ${RES[k]?.label || k} <b>${n}</b></span>`).join("")}</div>` +
          table([{ key: "kind", label: "Resource", fmt: (v) => `${RES[v]?.icon || ""} ${RES[v]?.label || v}` }, { key: "site", label: "Site" }],
            mines.map((m) => { const hex = D.tiles.res.indexOf(m.k); return { kind: D.meta.resourceKinds[m.r], site: m.site, hex }; }), { sortKey: "kind", desc: false, limit: 12 })) +
        sources([...metaSrc("Power Plant"), { name: "Curated resource sites (data/curated/resources.json)" }], [
          "The WRI database (2021) lists large plants only; national installed capacity is roughly 90 GW including small and captive plants.",
          "Mine and field locations are approximate (within one hex).",
        ]);
    },
  };

  // ---------------------------------------------------------------- People
  A.people = {
    id: "people", role: "Keeper of the Census", name: "People", icon: "👥", group: "People and land",
    desc: "Where people live, how crowded it is, and the great cities.",
    lens: "population",
    render() {
      const area = rows.reduce((a, r) => a + (r.p.areaKm2 || 0), 0);
      const javaPop = rows.filter((r) => r.p.island === "Java").reduce((a, r) => a + r.p.pop, 0);
      const isl = islandAgg((r) => r.p.pop), islArea = islandAgg((r) => r.p.areaKm2);
      return kpis([
        { label: "Population mid-2025", value: fmtBig(totalPop), sub: "4th largest in the world" },
        { label: "Density", value: `${fmtNum(totalPop / area)} /km²`, sub: "people per km² of land", lens: "population" },
        { label: "On Java", value: fmtPct(100 * javaPop / totalPop), sub: "of all Indonesians" },
      ]) +
        section("Island groups", "Share of people versus share of land.",
          `<div class="pair-bars">${isl.map((x, k) => `<div class="pair" data-island="${x.isl}"><span>${x.isl}</span>
            <span class="pair-track"><span style="width:${100 * x.v / totalPop}%" class="p-people"></span></span><b>${fmtPct(100 * x.v / totalPop)}</b>
            <span class="pair-track"><span style="width:${100 * islArea[k].v / area}%" class="p-land"></span></span><b>${fmtPct(100 * islArea[k].v / area)}</b></div>`).join("")}
            <div class="pair-legend"><span class="p-people"></span> people <span class="p-land"></span> land</div></div>`) +
        section("Provinces by population", "Mid-2025 estimates.",
          bars(rows.filter((r) => r.p.pop).sort((a, b) => b.p.pop - a.p.pop).map((r) => provBar(r, r.p.pop, fmtBig(r.p.pop))), { limit: 12, color: "#c76b8f" })) +
        section("Most crowded", "People per km² of land.",
          bars(by("density").map((r) => provBar(r, r.s.density, fmtNum(r.s.density))), { limit: 10, color: "#c76b8f" }), { lens: "population" }) +
        section("Cities", "Cities on the map with their latest population on Wikidata. Size is the Civ-style city size.",
          table([{ key: "name", label: "City" }, { key: "province", label: "Province" }, { key: "pop", label: "Population", num: true, fmt: (v) => fmtBig(v) },
            { key: "popYear", label: "Year", num: true, fmt: (v) => v ?? "–" }, { key: "size", label: "Size", num: true }],
          D.cities.map((c) => ({ ...c, province: (c.province || "").replace(" Special Capital Region", ""), hex: c.hex })), { sortKey: "pop", limit: 15 })) +
        sources([src("population"), ...metaSrc("GPW"), { name: "Wikidata (city populations)", url: "https://www.wikidata.org/" }].filter(Boolean), [
          "The hex population map spreads GPW 2020 density and rescales each province to its mid-2025 total.",
          "City populations are city-proper (kota) figures; some on Wikidata are from the 2010 census.",
        ]);
    },
  };

  // ---------------------------------------------------------------- Knowledge & health
  A.knowledge = {
    id: "knowledge", role: "Royal Scholar", name: "Knowledge & Health", icon: "📖", group: "People and land",
    desc: "Schooling and lifespans, province by province.",
    lens: "schooling",
    render() {
      return kpis([
        { label: "Years of schooling", value: `${wavg("meanSchool")?.toFixed(2)}`, sub: "adults 25+, population-weighted", lens: "schooling" },
        { label: "Expected schooling", value: `${wavg("expSchool")?.toFixed(2)}`, sub: "for a child starting school", lens: "expschool" },
        { label: "Life expectancy", value: `${wavg("lifeExp")?.toFixed(1)} yrs`, sub: "at birth", lens: "lifeexp" },
      ]) +
        section("Years of schooling", "Average years adults have spent in school.",
          bars(by("meanSchool").map((r) => provBar(r, r.s.meanSchool, r.s.meanSchool.toFixed(2))), { limit: 12, color: "#3f8ccc" }), { lens: "schooling" }) +
        section("Expected schooling", "How long a child starting school today can expect to study.",
          bars(by("expSchool").map((r) => provBar(r, r.s.expSchool, r.s.expSchool.toFixed(2))), { limit: 10, color: "#77b5df" }), { lens: "expschool" }) +
        section("Life expectancy", "Years at birth.",
          bars(by("lifeExp").map((r) => provBar(r, r.s.lifeExp - 60, r.s.lifeExp.toFixed(1))), { limit: 10, color: "#d36b7a" }), { lens: "lifeexp" }) +
        section("Shortest lives, least schooling", "",
          bars(by("meanSchool", false).map((r) => provBar(r, r.s.meanSchool, r.s.meanSchool.toFixed(2))), { limit: 6, color: "#8a5a5a" })) +
        sources([src("hdi")].filter(Boolean), ["National values here are population-weighted averages of the province figures."]);
    },
  };

  // ---------------------------------------------------------------- Culture & hazards
  A.culture = {
    id: "culture", role: "Keeper of Wonders", name: "Culture & Hazards", icon: "🌋", group: "People and land",
    desc: "Wonders of the land, faith, and the earthquakes and eruptions places endure.",
    lens: "faith",
    overlay: () => ({
      legend: "Earthquakes of magnitude 7 and above since 1900 (circle size = magnitude)",
      items: D.quakes.map((q) => ({ lon: q.lon, lat: q.lat, r: 2 + Math.pow(q.mag - 6.6, 1.6) * 6, color: "#e0553f", hex: q.hex,
        label: q.mag >= 8.4 ? `M${q.mag} ${q.year}` : null, tip: `<b>M${q.mag}</b> · ${q.date}<br>${esc(q.place)}<br>depth ${fmtNum(q.depth)} km` })),
      alpha: 0.55,
    }),
    render() {
      const faithKeys = ["Islam", "Christian", "Hindu", "Buddhist", "Confucian", "Folk"];
      const nat = {};
      let w = 0;
      for (const r of rows) {
        const rel = r.s.religion;
        if (!rel || !r.p.pop) continue;
        w += r.p.pop;
        for (const k of faithKeys) nat[k] = (nat[k] || 0) + ((rel[k] || 0) * r.p.pop) / 100;
      }
      const fcol = (k) => (FAITHS.find((f) => f.key === k) || { color: "#999" }).color;
      const decades = Object.entries(N.quakesByDecade || {}).map(([d, n]) => ({ x: `${String(d).slice(2)}s`, y: n, label: `${d}s` }));
      const volc = [...D.volcanoes].filter((v) => v.elev).sort((a, b) => b.elev - a.elev);
      return kpis([
        { label: "World Heritage sites", value: D.wonders.filter((x) => x.unesco).length, sub: "UNESCO, on Wikidata" },
        { label: "Volcanoes", value: D.volcanoes.length, sub: "on the map (Wikidata)" },
        { label: "Earthquakes M5+", value: fmtNum(N.quakesM5), sub: "since 1900 (USGS)", lens: "quakes" },
      ]) +
        section("Wonders", "World Heritage sites and natural landmarks. Click to visit.",
          table([{ key: "name", label: "Wonder", fmt: (v, r) => esc(r.short || v) }, { key: "kind", label: "Type" }, { key: "unesco", label: "UNESCO", fmt: (v) => (v ? "✓" : "") }],
            D.wonders.map((x) => ({ ...x, hex: x.hex, fly: [x.lon, x.lat, 170] })), { sortKey: "kind", desc: false })) +
        section("Faith", `The world's largest Muslim population, with Christian, Hindu and folk-religion heartlands in the east and on Bali. Population-weighted across ${rows.filter((r) => r.s.religion).length} provinces.`,
          stack(faithKeys.map((k) => ({ key: k, value: nat[k] || 0, color: fcol(k) }))) +
          `<div class="stack-legend">${faithKeys.filter((k) => nat[k] > 0).map((k) => `<span><i style="background:${fcol(k)}"></i>${k} ${fmtPct(100 * nat[k] / w)}</span>`).join("")}</div>` +
          `<div class="faith-rows">${rows.filter((r) => r.s.religion).sort((a, b) => (a.s.religion.Islam || 0) - (b.s.religion.Islam || 0)).map((r) =>
            `<div class="faith-row" data-prov="${r.k}"><span>${esc(r.p.name.replace(" Special Capital Region", ""))}</span>${stack(faithKeys.map((k) => ({ key: k, value: r.s.religion[k] || 0, color: fcol(k) })))}</div>`).join("")}</div>`,
          { lens: "faith" }) +
        section("Earthquakes by decade", "M5+ events per decade in the USGS catalogue (better instruments find more since the 1970s).",
          columns(decades, { color: "#e0553f" })) +
        section("Great earthquakes", "Magnitude 7 and above. Hover to find; click to fly.",
          table([{ key: "date", label: "Date" }, { key: "mag", label: "M", num: true, fmt: (v) => v.toFixed(1) }, { key: "place", label: "Where" }],
            D.quakes.map((q) => ({ ...q, fly: [q.lon, q.lat, 120] })), { sortKey: "mag", limit: 12 }), { lens: "quakes" }) +
        section("Highest volcanoes", "", bars(volc.map((v) => ({ label: v.name, value: v.elev, display: `${fmtNum(v.elev)} m`, hex: v.hex, fly: [v.lon, v.lat, 170] })), { limit: 10, color: "#b5544a" })) +
        section("Landslide hazard by province", "Mean landslide-hazard class (higher = steeper, wetter, more seismic).",
          bars(by("landslide").map((r) => provBar(r, r.s.landslide, (r.s.landslide / 10).toFixed(1))), { limit: 10, color: "#bd5f1c" }), { lens: "landslide" }) +
        sources([src("religion"), ...metaSrc("USGS"), ...metaSrc("Natural Disaster"), { name: "Wikidata (UNESCO sites, volcanoes)", url: "https://www.wikidata.org/" }].filter(Boolean), [
          "Religion shares come from each province's Wikipedia infobox (BPS / Dukcapil, mostly 2021–24). Jakarta and East Kalimantan have none there; the four new Papua provinces use the pre-split figure.",
        ]);
    },
  };

  // ---------------------------------------------------------------- Land
  A.land = {
    id: "land", role: "Surveyor General", name: "Land", icon: "⛰️", group: "People and land",
    desc: "Forest, farmland, wetland and city: what covers the islands.",
    lens: "forest",
    render() {
      const S = D.tiles;
      const sums = { forest: 0, farm: 0, urban: 0, wetland: 0, savanna: 0 };
      let n = 0;
      for (let i = 0; i < S.land.length; i++) if (S.land[i] && S.forest[i] >= 0) { n++; for (const k in sums) sums[k] += S[k][i]; }
      const pct = (k) => sums[k] / n;
      const other = Math.max(0, 100 - pct("forest") - pct("farm") - pct("urban") - pct("wetland") - pct("savanna"));
      const parts = [["Forest", pct("forest"), "#2f7d35"], ["Farmland", pct("farm"), "#d0aa3a"], ["Savanna & grass", pct("savanna"), "#b59a5a"], ["Wetland", pct("wetland"), "#2c95a5"], ["Built-up", pct("urban"), "#e0553f"], ["Other", other, "#666"]];
      return kpis([
        { label: "Forest", value: fmtPct(pct("forest")), sub: "of land (MODIS 2024)", lens: "forest" },
        { label: "Farmland", value: fmtPct(pct("farm")), sub: "cropland and mosaics", lens: "farmland" },
        { label: "Built-up", value: fmtPct(pct("urban"), 2), sub: "urban land", lens: "builtup" },
      ]) +
        section("What covers the land", "", stack(parts.map(([k, v, c]) => ({ key: k, value: v, color: c }))) +
          `<div class="stack-legend">${parts.map(([k, v, c]) => `<span><i style="background:${c}"></i>${k} ${fmtPct(v)}</span>`).join("")}</div>`) +
        section("Most forested", "", bars(by("forestPct").map((r) => provBar(r, r.s.forestPct, fmtPct(r.s.forestPct))), { limit: 10, color: "#2f7d35" }), { lens: "forest" }) +
        section("Least forested", "", bars(by("forestPct", false).map((r) => provBar(r, r.s.forestPct, fmtPct(r.s.forestPct))), { limit: 8, color: "#7a8a5a" })) +
        section("Farmland", "Share of land in cropland or cropland/natural-vegetation mosaics.",
          bars(by("farmPct").map((r) => provBar(r, r.s.farmPct, fmtPct(r.s.farmPct))), { limit: 10, color: "#d0aa3a" }), { lens: "farmland" }) +
        section("Mangroves", "Share of each province's hexes covered by mangrove forest (2000).",
          bars(by("mangrovePct").map((r) => provBar(r, r.s.mangrovePct, fmtPct(r.s.mangrovePct))), { limit: 8, color: "#2c95a5" }), { lens: "mangrove" }) +
        sources([...metaSrc("MODIS"), ...metaSrc("Mangrove")], [
          "MODIS classifies tree plantations (oil palm, acacia) as forest, so its forest share is higher than the government's ~51% natural-forest figure.",
          "500 m pixels are summarised per ~22 km hex; small clearings and towns blur out.",
        ]);
    },
  };

  // ---------------------------------------------------------------- Explorer
  A.explorer = {
    id: "explorer", role: "Cartographer", name: "Explorer", icon: "🧭", group: "Your own questions",
    desc: "Every province figure in one sortable table.",
    lens: null,
    render() {
      const faith = (rel) => {
        if (!rel) return "–";
        const g = { Islam: rel.Islam || 0, Christian: rel.Christian || 0, Hindu: rel.Hindu || 0 };
        return Object.entries(g).sort((a, b) => b[1] - a[1])[0][0];
      };
      const cols = [
        { key: "name", label: "Province" }, { key: "island", label: "Region" },
        { key: "pop", label: "Pop.", num: true, fmt: (v) => fmtBig(v) }, { key: "density", label: "/km²", num: true, fmt: (v) => fmtNum(v) },
        { key: "gdp", label: "GDP", num: true, fmt: (v) => fmtRp(v) }, { key: "gdppc", label: "GDP/p", num: true, fmt: (v) => fmtUsd(v) },
        { key: "growth", label: "Growth", num: true, fmt: (v) => sign(v) }, { key: "hdi", label: "HDI", num: true, fmt: (v) => v?.toFixed(3) ?? "–" },
        { key: "life", label: "Life", num: true, fmt: (v) => v?.toFixed(1) ?? "–" }, { key: "school", label: "School", num: true, fmt: (v) => v?.toFixed(1) ?? "–" },
        { key: "pov", label: "Poor", num: true, fmt: (v) => fmtPct(v) }, { key: "gini", label: "Gini", num: true, fmt: (v) => v?.toFixed(2) ?? "–" },
        { key: "forest", label: "Forest", num: true, fmt: (v) => fmtPct(v, 0) }, { key: "quakes", label: "Quakes", num: true, fmt: (v) => fmtNum(v) },
        { key: "mw", label: "MW", num: true, fmt: (v) => fmtNum(v) }, { key: "faith", label: "Faith" },
      ];
      return section("All provinces", "Click a column to sort; hover a row to find the province.",
        `<div class="wide">${table(cols, rows.map((r) => ({
          name: r.p.name.replace(" Special Capital Region", ""), island: r.p.island, pop: r.p.pop, density: r.s.density, gdp: r.s.gdpBRp,
          gdppc: r.s.gdpPcUsd, growth: r.s.gdpGrowth != null ? 100 * r.s.gdpGrowth : null, hdi: r.s.hdi, life: r.s.lifeExp, school: r.s.meanSchool,
          pov: r.s.pov365, gini: r.s.gini, forest: r.s.forestPct, quakes: r.s.quakes, mw: r.s.powerMW, faith: faith(r.s.religion), prov: r.k,
        })), { sortKey: "pop" })}</div>`) +
        `<p class="dash-desc"><a href="map-data.json" download>Download all map data (JSON)</a></p>` +
        sources(D.meta.sources.map((s) => ({ name: s.name, url: s.url, note: s.license })));
    },
  };

  return A;
}

export const COUNCIL_ORDER = [
  ["Wealth and work", ["economy", "prosperity", "commerce", "energy"]],
  ["People and land", ["people", "knowledge", "culture", "land"]],
  ["Your own questions", ["explorer"]],
];
