// Renders the Nusantara trailer frame by frame by driving the real app in
// headless Chrome. Every frame sets the camera/lens/advisor explicitly, so the
// motion is perfectly smooth regardless of how long a screenshot takes.
//
//   node capture.mjs            -> frames/00000.jpg ... (1920x1080, 30 fps)
//   node capture.mjs --preview  -> every 15th frame only (quick check)
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import puppeteer from "puppeteer-core";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC = path.resolve(HERE, "../public");
const FRAMES = path.join(HERE, "frames");
const W = 1920, H = 1080, FPS = 30;
const PREVIEW = process.argv.includes("--preview");
const CHROME = process.env.CHROME || "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const REPO_URL = process.env.TRAILER_URL || "github.com/taiyoo/id-civilization";

// ------------------------------------------------------------------ static server for ../public
const MIME = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".json": "application/json" };
const server = http.createServer((req, res) => {
  const p = path.join(PUBLIC, decodeURIComponent(req.url.split("?")[0].split("#")[0]).replace(/^\/$/, "/index.html"));
  if (!p.startsWith(PUBLIC) || !fs.existsSync(p)) { res.writeHead(404); return res.end(); }
  res.writeHead(200, { "Content-Type": MIME[path.extname(p)] || "application/octet-stream" });
  fs.createReadStream(p).pipe(res);
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const PORT = server.address().port;

// ------------------------------------------------------------------ browser
fs.rmSync(FRAMES, { recursive: true, force: true });
fs.mkdirSync(FRAMES, { recursive: true });
const browser = await puppeteer.launch({ executablePath: CHROME, headless: true, args: ["--hide-scrollbars", "--force-color-profile=srgb"] });
const page = await browser.newPage();
await page.setViewport({ width: W, height: H, deviceScaleFactor: 1 });
await page.goto(`http://127.0.0.1:${PORT}/#lens=terrain&advisor=`, { waitUntil: "networkidle0" });
await page.waitForFunction(() => window.__map && !document.getElementById("loading"));
await page.evaluate(() => document.fonts.ready);

// Trailer helpers inside the page: captions, title cards, clean mode, cross-fades
await page.evaluate((REPO_URL) => {
  const css = document.createElement("style");
  css.textContent = `
    body.clean #topbar, body.clean #panel, body.clean #toolbar, body.clean #legend, body.clean #minimap-wrap,
    body.clean #inspector, body.clean #council-btn, body.clean #tooltip { display: none !important; }
    #toolbar, #minimap-wrap { display: none !important; }
    #tcap { position: fixed; left: 50%; transform: translateX(-50%); text-align: center; pointer-events: none; z-index: 60;
      padding: 22px 90px 26px; background: radial-gradient(ellipse at center, rgba(6,10,18,.82) 0%, rgba(6,10,18,.55) 55%, rgba(6,10,18,0) 75%); white-space: nowrap; }
    body.clean #tcap { bottom: 96px; } body:not(.clean) #tcap { top: 76px; left: calc(50% + 220px); }
    body.panel-closed:not(.clean) #tcap { left: 50%; }
    #tcap .t { font: 700 50px Cinzel, Georgia, serif; color: #e9cd85; letter-spacing: .07em; text-shadow: 0 2px 14px rgba(0,0,0,.9); }
    #tcap .s { font: 600 23px "Source Sans 3", sans-serif; color: #f3ead6; margin-top: 4px; text-shadow: 0 2px 8px rgba(0,0,0,.9); }
    #tcard { position: fixed; inset: 0; z-index: 70; display: grid; place-items: center; pointer-events: none; text-align: center;
      background: radial-gradient(ellipse at center, rgba(5,9,16,.55) 0%, rgba(5,9,16,.85) 70%); }
    #tcard .k { font: 600 22px Cinzel, Georgia, serif; letter-spacing: .5em; color: #b99c5e; text-transform: uppercase; }
    #tcard .h { font: 700 150px Cinzel, Georgia, serif; letter-spacing: .12em; color: #ecd08a; text-shadow: 0 0 40px rgba(226,195,122,.45), 0 4px 18px rgba(0,0,0,.9); line-height: 1.1; }
    #tcard .p { font: 600 30px "Source Sans 3", sans-serif; color: #efe6d0; margin-top: 8px; }
    #tcard .src { font: 400 20px "Source Sans 3", sans-serif; color: #b8b09c; margin-top: 34px; letter-spacing: .04em; }
    #tcard .url { font: 600 24px "Source Sans 3", sans-serif; color: #7fc6e8; margin-top: 14px; }
    #tcard .rule { width: 420px; height: 1px; margin: 22px auto; background: linear-gradient(90deg, transparent, #b99c5e, transparent); }
    #tblack { position: fixed; inset: 0; z-index: 80; background: #000; pointer-events: none; }
    #xfade { position: fixed; inset: 0; width: 100%; height: 100%; z-index: 1; pointer-events: none; }`;
  document.head.appendChild(css);
  const mk = (id) => { const d = document.createElement("div"); d.id = id; document.body.appendChild(d); return d; };
  const cap = mk("tcap"), card = mk("tcard"), black = mk("tblack");
  const xf = document.createElement("canvas"); xf.id = "xfade";
  document.getElementById("map").after(xf);
  const M = window.__map, map = M.map;
  window.T = {
    clean(on) { document.body.classList.toggle("clean", on); },
    cam(lon, lat, scale, offX = 0) { map.flyTo(lon, lat, scale, offX); },
    caption(t, s, a) { cap.innerHTML = t ? `<div class="t">${t}</div><div class="s">${s || ""}</div>` : ""; cap.style.opacity = a; },
    card(html, a) { card.innerHTML = html; card.style.opacity = a; card.style.display = a > 0 ? "grid" : "none"; },
    black(a) { black.style.opacity = a; },
    snap() { const c = document.getElementById("map"); xf.width = c.width; xf.height = c.height; xf.getContext("2d").drawImage(c, 0, 0); xf.style.opacity = 1; },
    fade(a) { xf.style.opacity = a; },
    lens(id) { M.setLens(id); },
    advisor(id) { M.openAdvisor(id); document.getElementById("panel-body").scrollTop = 0; },
    hot(sel, on) { const el = document.querySelector(sel); if (!el) return; el.classList.toggle("hot", on); if (on) el.dispatchEvent(new MouseEvent("mouseover", { bubbles: true })); else map.setHighlight(null); },
    unhover() { map.hovered = -1; map.hoverOverlay = null; document.getElementById("tooltip").classList.add("hidden"); M.markHot(-1); },
    screen(lon, lat) { return [map.sx(map.wx(lon)), map.sy(map.wy(lat))]; },
    draw() { map.draw(); },
    REPO_URL,
  };
  T.card("", 0); T.black(0); T.fade(0);
}, REPO_URL);

// ------------------------------------------------------------------ timeline helpers
let frame = 0;
const ease = (t) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);
const lerp = (a, b, t) => a + (b - a) * t;
const lerpLog = (a, b, t) => Math.exp(lerp(Math.log(a), Math.log(b), t));
const clamp01 = (x) => Math.max(0, Math.min(1, x));
/** opacity ramp: fade in over `fin` s from `t0`, out over `fout` s ending at `t1` (seconds within a shot) */
const ramp = (s, t0, t1, fin = 0.5, fout = 0.5) => clamp01(Math.min((s - t0) / fin, (t1 - s) / fout));

async function snap() {
  if (!PREVIEW || frame % 15 === 0) {
    await page.evaluate(() => T.draw());
    await page.screenshot({ path: path.join(FRAMES, `${String(PREVIEW ? frame / 15 : frame).padStart(5, "0")}.jpg`), type: "jpeg", quality: 92 });
  }
  frame++;
  if (frame % 150 === 0) console.log(`  ${frame / FPS}s`);
}
/** Run a shot of `secs` seconds; fn(t 0..1, seconds) sets the scene for each frame. */
async function shot(secs, fn) {
  const n = Math.round(secs * FPS);
  for (let i = 0; i < n; i++) { await fn(i / (n - 1 || 1), i / FPS); await snap(); }
}
const ev = (fn, ...args) => page.evaluate(fn, ...args);

const FULL = 1920 / 47;          // scale that fits the whole archipelago
const PANEL = 220;               // half the advisor panel width (camera offset)

// ------------------------------------------------------------------ 1. Title (5 s)
console.log("1 title");
await ev(() => { T.clean(true); T.lens("terrain"); });
await shot(5, async (t, s) => {
  await ev((sc, a, b) => {
    T.cam(118, -2.4, sc);
    T.black(b);
    T.card(`<div><div class="k">A strategy-game map of Indonesia</div><div class="h">NUSANTARA</div><div class="rule"></div>
      <div class="p">Seventeen thousand islands, rebuilt from open data</div></div>`, a);
    T.caption("", "", 0);
  }, lerp(FULL * 0.94, FULL * 1.02, t), ramp(s, 0.6, 4.9, 1.0, 0.7), 1 - clamp01(s / 0.8));
});

// ------------------------------------------------------------------ 2. Dive into Java (7 s)
console.log("2 dive");
await shot(7, async (t, s) => {
  const e = ease(t);
  await ev((lon, lat, sc, a) => {
    T.card("", 0); T.cam(lon, lat, sc);
    T.caption("24,000 hexes", "Each tile built from real elevation, land cover and census data", a);
  }, lerp(118, 110.4, e), lerp(-2.4, -7.5, e), lerpLog(FULL * 1.02, 300, e), ramp(s, 1.2, 6.9, 0.6, 0.5));
});

// ------------------------------------------------------------------ 3. Volcano pan (5 s)
console.log("3 volcanoes");
await shot(5, async (t, s) => {
  const e = ease(t);
  await ev((lon, lat, sc, a) => { T.cam(lon, lat, sc); T.caption("110 volcanoes · 21 wonders", "Merapi, Borobudur, Bromo: where they really are", a); },
    lerp(110.4, 112.75, e), lerp(-7.5, -7.85, e), lerp(300, 270, e), ramp(s, 0.2, 4.9, 0.5, 0.5));
});

// ------------------------------------------------------------------ 4. Pull back, UI appears (4 s)
console.log("4 pull back");
const LV = [111.5, -2.6, 46]; // lens-tour view: Sumatra, Java, Kalimantan, Sulawesi
await ev(() => T.clean(false));
await shot(4, async (t, s) => {
  const e = ease(t);
  await ev((lon, lat, sc, a) => { T.cam(lon, lat, sc); T.caption("Lenses", "See what the terrain hides", a); },
    lerp(112.75, LV[0], e), lerp(-7.85, LV[1], e), lerpLog(270, LV[2], e), ramp(s, 1.4, 4.0, 0.5, 0.4));
});

// ------------------------------------------------------------------ 5. Lens tour (4 x 3.5 s)
console.log("5 lenses");
const LENS_TOUR = [
  ["forest", "Forest", "MODIS satellite land cover, 2024"],
  ["population", "Population", "284 million people, mapped hex by hex"],
  ["lights", "Night lights", "Where the economy glows · NASA VIIRS"],
  ["faith", "Faith", "Majority religion in all 38 provinces"],
];
let drift = 0;
for (const [id, title, sub] of LENS_TOUR) {
  await ev((id) => { T.snap(); T.lens(id); }, id);
  await shot(3.5, async (t, s) => {
    drift += 1 / FPS;
    await ev((lon, sc, xf, a, title, sub) => { T.cam(lon, -2.6, sc); T.fade(xf); T.caption(title, sub, a); },
      LV[0] + drift * 0.12, LV[2] * (1 + drift * 0.006), 1 - clamp01(s / 0.4), ramp(s, 0.25, 3.5, 0.35, 0.35), title, sub);
  });
}
await ev(() => T.fade(0));

// ------------------------------------------------------------------ 6. Advisors (economy 4.5 s, energy 4 s, culture 4.5 s)
console.log("6 advisors");
const PV = [118, -2.6, (1920 - 440 - 110) / 47]; // whole country beside the panel
const advisorShot = async (id, secs, title, sub, extra) => {
  await ev((id) => { T.snap(); T.advisor(id); }, id);
  await shot(secs, async (t, s) => {
    await ev((lon, lat, sc, off, xf, a, title, sub) => { T.cam(lon, lat, sc, off); T.fade(xf); T.caption(title, sub, a); },
      PV[0], PV[1], PV[2] * (1 + 0.02 * t), PANEL, 1 - clamp01(s / 0.35), ramp(s, 0.3, secs, 0.4, 0.35), title, sub);
    if (extra) await extra(s);
  });
};
await advisorShot("economy", 4.5, "A council of advisors", "Real dashboards for the economy, people, energy and land");
let lit = false;
await advisorShot("energy", 4, "Energy & resources", "178 power plants · 48.8 GW · coal, gas, hydro, geothermal", async (s) => {
  if (s === 0) await ev(() => T.lens("lights")); // plants read best over the night-lights lens
  if (s > 1.6 && !lit) { lit = true; await ev(() => T.hot('#panel-body [data-fuel="Geothermal"]', true)); }
});
await ev(() => T.hot('#panel-body [data-fuel="Geothermal"]', false));
await advisorShot("culture", 4.5, "14,678 earthquakes since 1900", "Magnitude 7+ shown · USGS catalogue");

// ------------------------------------------------------------------ 7. Hover linking (6 s)
console.log("7 hover");
await ev(() => { T.snap(); T.advisor("prosperity"); });
const path7 = [[132.6, -1.4], [134.4, -3.0], [136.6, -3.9], [138.7, -4.1], [139.8, -6.6]];
await shot(6, async (t, s) => {
  const view = [136.2, -4.2, 84];
  const e = ease(clamp01(s / 1.4));
  await ev((lon, lat, sc, off, xf, a) => { T.cam(lon, lat, sc, off); T.fade(xf); T.caption("Hover the map, find it in the charts", "Poverty in Papua, province by province", a); },
    lerp(PV[0], view[0], e), lerp(PV[1], view[1], e), lerpLog(PV[2], view[2], e), PANEL, 1 - clamp01(s / 0.35), ramp(s, 0.3, 6, 0.4, 0.4));
  if (s > 1.5) {
    const u = clamp01((s - 1.5) / 4.2) * (path7.length - 1), k = Math.min(path7.length - 2, Math.floor(u)), f = u - k;
    const [lon, lat] = [lerp(path7[k][0], path7[k + 1][0], f), lerp(path7[k][1], path7[k + 1][1], f)];
    const [x, y] = await ev((lon, lat) => T.screen(lon, lat), lon, lat);
    await page.mouse.move(x, y);
  }
});
await page.mouse.move(5, 5);
await ev(() => T.unhover());

// ------------------------------------------------------------------ 8. End card (6 s)
console.log("8 end");
await ev(() => { T.snap(); T.clean(true); T.advisor(""); T.lens("terrain"); });
await shot(6, async (t, s) => {
  await ev((sc, xf, a, b) => {
    T.cam(118, -2.4, sc); T.fade(xf); T.caption("", "", 0); T.black(b);
    T.card(`<div><div class="h" style="font-size:120px">NUSANTARA</div><div class="rule"></div>
      <div class="src">Built entirely from open data · BPS · NASA · USGS · WRI · Wikidata · OpenStreetMap · geoBoundaries</div>
      <div class="url">${T.REPO_URL}</div></div>`, a);
  }, lerp(FULL * 1.04, FULL * 0.96, ease(t)), 1 - clamp01(s / 0.6), ramp(s, 0.4, 6.5, 0.9, 1), clamp01((s - 5.0) / 1.0));
});

console.log(`captured ${frame} frames (${(frame / FPS).toFixed(1)} s)${PREVIEW ? " [preview: every 15th]" : ""}`);
await browser.close();
server.close();
