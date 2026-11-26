// Canvas renderer for the hex map: terrain or lens colouring, borders, rivers,
// cities, resources, wonders, highlights and data overlays.

const TERRAIN_COLORS = {
  ocean: "#173f6b", coast: "#2f6fa3", lake: "#3f8fc4", grassland: "#6f9a3e", plains: "#a99a52",
  hills_grassland: "#5f8636", hills_plains: "#958647", mountain: "#7d746a", snow_mountain: "#dfe7ec",
};
const FEATURE_TINT = { rainforest: "#2c5e2a", woods: "#4d7434", marsh: "#4f7a64", floodplains: "#8fae4a" };
const LENS_WATER = { ocean: "#0c1a2a", coast: "#122a42", lake: "#173a57" };
const NO_DATA = "#2b3038";

export const RES = {
  oil: { icon: "🛢️", cls: "strategic", y: [0, 3, 0], label: "Oil" },
  gas: { icon: "🔥", cls: "strategic", y: [0, 2, 1], label: "Natural gas" },
  coal: { icon: "🪨", cls: "strategic", y: [0, 2, 0], label: "Coal" },
  nickel: { icon: "🔩", cls: "strategic", y: [0, 2, 1], label: "Nickel" },
  tin: { icon: "🥫", cls: "strategic", y: [0, 2, 0], label: "Tin" },
  bauxite: { icon: "🧱", cls: "strategic", y: [0, 2, 0], label: "Bauxite" },
  copper: { icon: "🥉", cls: "bonus", y: [0, 1, 2], label: "Copper" },
  horses: { icon: "🐎", cls: "strategic", y: [1, 1, 0], label: "Horses" },
  gold: { icon: "🪙", cls: "luxury", y: [0, 0, 3], label: "Gold" },
  nutmeg: { icon: "🌰", cls: "luxury", y: [1, 0, 3], label: "Nutmeg" },
  cloves: { icon: "🌸", cls: "luxury", y: [1, 0, 3], label: "Cloves" },
  pepper: { icon: "🌶️", cls: "luxury", y: [0, 0, 2], label: "Pepper" },
  cinnamon: { icon: "🪵", cls: "luxury", y: [0, 0, 2], label: "Cinnamon" },
  coffee: { icon: "☕", cls: "luxury", y: [0, 0, 2], label: "Coffee" },
  tea: { icon: "🍵", cls: "luxury", y: [0, 0, 2], label: "Tea" },
  cocoa: { icon: "🍫", cls: "luxury", y: [0, 0, 2], label: "Cocoa" },
  sugar: { icon: "🎋", cls: "luxury", y: [1, 0, 1], label: "Sugarcane" },
  tobacco: { icon: "🍂", cls: "luxury", y: [0, 0, 2], label: "Tobacco" },
  sandalwood: { icon: "🌳", cls: "luxury", y: [0, 1, 2], label: "Sandalwood" },
  pearls: { icon: "🦪", cls: "luxury", y: [0, 0, 3], label: "Pearls" },
  whales: { icon: "🐋", cls: "luxury", y: [0, 1, 1], label: "Whales" },
  salt: { icon: "🧂", cls: "luxury", y: [0, 0, 2], label: "Salt" },
  rice: { icon: "🌾", cls: "bonus", y: [1, 0, 0], label: "Rice" },
  cattle: { icon: "🐄", cls: "bonus", y: [1, 0, 0], label: "Cattle" },
  fish: { icon: "🐟", cls: "bonus", y: [1, 0, 0], label: "Fish" },
  crabs: { icon: "🦀", cls: "bonus", y: [0, 0, 2], label: "Crabs" },
  palm_oil: { icon: "🌴", cls: "bonus", y: [1, 0, 1], label: "Palm oil" },
  rubber: { icon: "🛞", cls: "bonus", y: [0, 1, 1], label: "Rubber" },
};
export const RES_RING = { strategic: "#d0533f", luxury: "#a76bd6", bonus: "#6bbf59" };
const BASE_YIELD = {
  ocean: [1, 0, 0], coast: [1, 0, 1], lake: [1, 0, 1], grassland: [2, 0, 0], plains: [1, 1, 0],
  hills_grassland: [2, 1, 0], hills_plains: [1, 2, 0], mountain: [0, 0, 0], snow_mountain: [0, 0, 0],
};
const FEATURE_YIELD = { rainforest: [1, 0, 0], woods: [0, 1, 0], marsh: [1, 0, 0], floodplains: [1, 0, 0], reef: [0, 1, 0], geothermal: [0, 1, 1], volcano: [0, 0, 0] };
const EMOJI_FONT = `"Apple Color Emoji","Segoe UI Emoji","Noto Color Emoji",sans-serif`;
const SQ3 = Math.sqrt(3);

export class MapView {
  constructor(canvas, D, hooks = {}) {
    this.canvas = canvas;
    this.ctx = canvas.getContext("2d");
    this.D = D; this.M = D.meta; this.S = D.tiles;
    this.hooks = hooks;
    this.cam = { scale: 30, x: 0, y: 0 };
    this.layers = { borders: true, rivers: true, cities: true, resources: true, wonders: true, parks: false, yields: false, grid: false };
    this.lens = null; this.range = null; this.lensColors = null;
    this.highlight = null; this.overlay = null; this.selected = -1; this.hovered = -1; this.hoverOverlay = null;
    this.cityAt = new Map(D.cities.map((c) => [c.hex, c]));
    this.wonderAt = new Map(D.wonders.map((w) => [w.hex, w]));
    this.volcanoAt = new Map(D.volcanoes.map((v) => [v.hex, v]));
    this.provByName = new Map(D.provinces.map((p, k) => [p.name, k]));
    this.N = this.M.cols * this.M.rows;
    this.R = this.M.w / SQ3; // hex circumradius in degrees
    this._precompute();
    this._renderBase();
    this._raf = 0;
  }

  // ------------------------------------------------------------ geometry
  cx(c, r) { return this.M.lon0 + c * this.M.w + (r & 1) * this.M.w / 2; }
  cy(r) { return this.M.lat0 - r * this.M.h; }
  wx(lon) { return lon - this.M.lon0; }
  wy(lat) { return this.M.lat0 - lat; }
  sx(x) { return (x - this.cam.x) * this.cam.scale; }
  sy(y) { return (y - this.cam.y) * this.cam.scale; }
  hexXY(i) { const c = i % this.M.cols, r = (i / this.M.cols) | 0; return [this.wx(this.cx(c, r)), this.wy(this.cy(r))]; }
  hexLonLat(i) { const c = i % this.M.cols, r = (i / this.M.cols) | 0; return [this.cx(c, r), this.cy(r)]; }
  hexAtScreen(px, py) { return this.hexAtWorld(this.cam.x + px / this.cam.scale, this.cam.y + py / this.cam.scale); }
  hexAtWorld(x, y) {
    const s = this.R, M = this.M;
    const q = (SQ3 / 3 * x - y / 3) / s, r = (2 / 3 * y) / s;
    let X = q, Z = r, Y = -X - Z, rx = Math.round(X), ry = Math.round(Y), rz = Math.round(Z);
    const dx = Math.abs(rx - X), dy = Math.abs(ry - Y), dz = Math.abs(rz - Z);
    if (dx > dy && dx > dz) rx = -ry - rz; else if (dy > dz) ry = -rx - rz; else rz = -rx - ry;
    const row = rz, col = rx + ((rz - (rz & 1)) >> 1);
    if (col < 0 || row < 0 || col >= M.cols || row >= M.rows) return -1;
    return row * M.cols + col;
  }
  neighbors(i) {
    const M = this.M, c = i % M.cols, r = (i / M.cols) | 0, out = [];
    const nb = r & 1 ? [[1, 0], [-1, 0], [1, -1], [0, -1], [1, 1], [0, 1]] : [[1, 0], [-1, 0], [0, -1], [-1, -1], [0, 1], [-1, 1]];
    for (const [dc, dr] of nb) { const nc = c + dc, nr = r + dr; if (nc >= 0 && nr >= 0 && nc < M.cols && nr < M.rows) out.push(nr * M.cols + nc); }
    return out;
  }
  terrainName(i) { return this.M.terrains[this.S.terrain[i]]; }
  featureName(i) { return this.M.features[this.S.feature[i]]; }

  // ------------------------------------------------------------ setup
  _precompute() {
    const S = this.S, s = this.R;
    this.borderSegs = []; this.coastSegs = []; this.provLandSegs = new Map();
    const edge = (i, j) => {
      const [x, y] = this.hexXY(i), [x2, y2] = this.hexXY(j);
      const a = Math.atan2(y2 - y, x2 - x);
      return [x + s * Math.cos(a - Math.PI / 6), y + s * Math.sin(a - Math.PI / 6), x + s * Math.cos(a + Math.PI / 6), y + s * Math.sin(a + Math.PI / 6), x, y];
    };
    for (let i = 0; i < this.N; i++) {
      const p = S.prov[i];
      for (const j of this.neighbors(i)) {
        const needBorder = p >= 0 && S.prov[j] !== p;
        const needCoast = S.land[i] && !S.land[j];
        const needLand = S.land[i] && p >= 0 && !(S.land[j] && S.prov[j] === p);
        if (!needBorder && !needCoast && !needLand) continue;
        const [ax, ay, bx, by, x, y] = edge(i, j);
        if (needBorder) {
          const k = 0.12;
          this.borderSegs.push({ p, x1: ax + (x - ax) * k, y1: ay + (y - ay) * k, x2: bx + (x - bx) * k, y2: by + (y - by) * k, mx: x, my: y });
        }
        if (needCoast) this.coastSegs.push([ax, ay, bx, by]);
        if (needLand) {
          if (!this.provLandSegs.has(p)) this.provLandSegs.set(p, []);
          this.provLandSegs.get(p).push([ax, ay, bx, by]);
        }
      }
    }
  }

  tileColor(i) {
    if (this.lensColors) return this.lensColors[i];
    const t = this.terrainName(i), f = this.featureName(i);
    if (f && FEATURE_TINT[f]) return FEATURE_TINT[f];
    return TERRAIN_COLORS[t];
  }

  _renderBase() {
    const M = this.M, bs = 24;
    this.baseScale = bs;
    const c = this.baseImg || document.createElement("canvas");
    c.width = Math.ceil((M.cols + 1) * M.w * bs); c.height = Math.ceil((M.rows + 1) * M.h * bs);
    const g = c.getContext("2d");
    const rad = this.R * bs + 0.6;
    this._fillHexes(g, [...Array(this.N).keys()], (x) => x * bs, (y) => y * bs, rad);
    this.baseImg = c;
  }
  _fillHexes(g, list, tx, ty, rad) {
    const byColor = new Map();
    for (const i of list) {
      const col = this.tileColor(i);
      if (!byColor.has(col)) byColor.set(col, []);
      byColor.get(col).push(i);
    }
    for (const [col, ids] of byColor) {
      g.fillStyle = col; g.beginPath();
      for (const i of ids) { const [x, y] = this.hexXY(i); hexPath(g, tx(x), ty(y), rad); }
      g.fill();
    }
  }

  // ------------------------------------------------------------ public API
  setLens(lens) {
    this.lens = lens && lens.kind !== "base" ? lens : null;
    this.range = null;
    this._computeLensColors();
  }
  setRange(range) { this.range = range; this._computeLensColors(); }
  _computeLensColors() {
    const L = this.lens;
    if (!L) { this.lensColors = null; this._renderBase(); this.requestDraw(); return; }
    const S = this.S, cols = new Array(this.N);
    for (let i = 0; i < this.N; i++) {
      const v = L.value(i);
      if (v == null) {
        cols[i] = S.land[i] ? (S.lake[i] >= 0 ? LENS_WATER.lake : NO_DATA) : LENS_WATER[this.terrainName(i)] || LENS_WATER.ocean;
        continue;
      }
      let col = L.color(v);
      if (this.range && !L.categorical && (v < this.range[0] || v > this.range[1])) col = S.land[i] ? "#23272e" : LENS_WATER.ocean;
      if (this.range && L.categorical && v !== this.range) col = "#23272e";
      cols[i] = col;
    }
    this.lensColors = cols;
    this._renderBase();
    this.requestDraw();
  }
  setLayers(obj) { Object.assign(this.layers, obj); this.requestDraw(); }
  setHighlight(h) { this.highlight = h; this.requestDraw(); }
  setOverlay(o) { this.overlay = o; this.hoverOverlay = null; this.requestDraw(); }
  setSelected(i) { this.selected = i; this.requestDraw(); }
  resize(w, h, dpr) {
    this.vw = w; this.vh = h; this.dpr = dpr;
    this.canvas.width = w * dpr; this.canvas.height = h * dpr;
    this.clamp(); this.draw();
  }
  clamp() {
    const W = this.M.cols * this.M.w, H = this.M.rows * this.M.h, vw = this.vw / this.cam.scale, vh = this.vh / this.cam.scale;
    // keep at least ~30% of the map (or of the screen, if smaller) in view; never force-centre
    const kx = 0.3 * Math.min(W, vw), ky = 0.3 * Math.min(H, vh);
    this.cam.x = Math.max(-vw + kx, Math.min(W - kx, this.cam.x));
    this.cam.y = Math.max(-vh + ky, Math.min(H - ky, this.cam.y));
  }
  /** Centre (lon, lat) in the free part of the screen: offsetX shifts right (side panel), offsetY shifts up (bottom sheet). */
  flyTo(lon, lat, scale = this.cam.scale, offsetX = 0, offsetY = 0) {
    this.cam.scale = Math.max(8, Math.min(420, scale));
    this.cam.x = this.wx(lon) - (this.vw / 2 + offsetX) / this.cam.scale;
    this.cam.y = this.wy(lat) - (this.vh / 2 - offsetY) / this.cam.scale;
    this.clamp(); this.requestDraw(); this.hooks.onCamera?.();
  }
  zoomAt(f, px, py) {
    const x0 = this.cam.x + px / this.cam.scale, y0 = this.cam.y + py / this.cam.scale;
    this.cam.scale = Math.max(8, Math.min(420, this.cam.scale * f));
    this.cam.x = x0 - px / this.cam.scale; this.cam.y = y0 - py / this.cam.scale;
    this.clamp(); this.requestDraw(); this.hooks.onCamera?.();
  }
  panBy(dx, dy) { this.cam.x -= dx / this.cam.scale; this.cam.y -= dy / this.cam.scale; this.clamp(); this.requestDraw(); this.hooks.onCamera?.(); }
  view() { return { lon: this.M.lon0 + this.cam.x + this.vw / 2 / this.cam.scale, lat: this.M.lat0 - (this.cam.y + this.vh / 2 / this.cam.scale), scale: this.cam.scale }; }
  requestDraw() { if (!this._raf) this._raf = requestAnimationFrame(() => { this._raf = 0; this.draw(); }); }

  yields(i) {
    const t = this.terrainName(i), f = this.featureName(i), S = this.S;
    const y = [...BASE_YIELD[t]];
    if (f && FEATURE_YIELD[f]) FEATURE_YIELD[f].forEach((v, k) => (y[k] += v));
    if (S.river[i] >= 0) y[2] += 1;
    if (S.res[i] >= 0) (RES[this.M.resourceKinds[this.D.resources[S.res[i]].r]]?.y || [0, 0, 0]).forEach((v, k) => (y[k] += v));
    if (this.cityAt.has(i)) { y[0] = Math.max(y[0], 2); y[1] = Math.max(y[1], 1); y[2] += 1; }
    return y;
  }

  overlayAt(px, py) {
    if (!this.overlay) return null;
    let best = null, bd = Infinity;
    for (const o of this.overlay.items) {
      const X = this.sx(this.wx(o.lon)), Y = this.sy(this.wy(o.lat)), r = this._ovR(o);
      const d = Math.hypot(px - X, py - Y);
      if (d <= Math.max(r, 5) && d < bd) { best = o; bd = d; }
    }
    return best;
  }
  _ovR(o) { return o.r * Math.max(0.55, Math.min(3, Math.sqrt(this.cam.scale / 30))); }

  // ------------------------------------------------------------ drawing
  visible() {
    const M = this.M, x0 = this.cam.x, y0 = this.cam.y, x1 = x0 + this.vw / this.cam.scale, y1 = y0 + this.vh / this.cam.scale;
    return { c0: Math.max(0, Math.floor(x0 / M.w) - 1), c1: Math.min(M.cols - 1, Math.ceil(x1 / M.w) + 1),
      r0: Math.max(0, Math.floor(y0 / M.h) - 1), r1: Math.min(M.rows - 1, Math.ceil(y1 / M.h) + 1), x0, y0, x1, y1 };
  }
  draw() {
    const ctx = this.ctx, M = this.M;
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    ctx.fillStyle = this.lensColors ? LENS_WATER.ocean : TERRAIN_COLORS.ocean;
    ctx.fillRect(0, 0, this.vw, this.vh);
    const rad = this.R * this.cam.scale, V = this.visible();
    this.placed = [];
    if (rad < 7) {
      ctx.imageSmoothingEnabled = true;
      ctx.drawImage(this.baseImg, this.sx(0), this.sy(0), this.baseImg.width * this.cam.scale / this.baseScale, this.baseImg.height * this.cam.scale / this.baseScale);
    } else {
      const list = [];
      for (let r = V.r0; r <= V.r1; r++) for (let c = V.c0; c <= V.c1; c++) list.push(r * M.cols + c);
      this._fillHexes(ctx, list, (x) => this.sx(x), (y) => this.sy(y), rad + 0.5);
      if (rad >= 11 && !this.lensColors) this._glyphs(V, rad);
    }
    this._segs(this.coastSegs, V, this.lensColors ? "rgba(200,210,220,0.35)" : "rgba(235,220,170,0.55)", Math.max(0.6, rad * 0.08));
    if (this.layers.grid && rad >= 6) {
      ctx.strokeStyle = "rgba(0,0,0,0.18)"; ctx.lineWidth = 1; ctx.beginPath();
      for (let r = V.r0; r <= V.r1; r++) for (let c = V.c0; c <= V.c1; c++) { const [x, y] = this.hexXY(r * M.cols + c); hexPath(ctx, this.sx(x), this.sy(y), rad); }
      ctx.stroke();
    }
    if (this.layers.rivers) this._rivers(rad);
    if (!this.lensColors) this._tint(V, rad);
    if (this.layers.parks) this._parks(V, rad);
    if (this.layers.borders) this._borders(V, rad);
    if (this.layers.yields && rad >= 16 && !this.lensColors) this._yields(V, rad);
    if (this.layers.resources && rad >= 9 && !this.overlay) this._resources(V, rad);
    const laid = this.layers.cities ? this._layoutCities(V, rad) : [];
    if (this.layers.wonders && !this.overlay) this._wonders(V, rad);
    if (rad >= 14 && !this.lensColors) this._volcanoLabels(V, rad);
    if (this.overlay) this._overlay(rad);
    this._highlight(rad);
    if (this.layers.cities) this._cities(laid, rad);
    if (this.hovered >= 0) this._outline(this.hovered, rad, "rgba(255,255,255,0.75)", 1.5);
    if (this.selected >= 0) this._outline(this.selected, rad, "#ffe08a", 2.5);
    this.hooks.onDraw?.();
  }
  _segs(segs, V, color, w) {
    const ctx = this.ctx;
    ctx.strokeStyle = color; ctx.lineWidth = w; ctx.beginPath();
    for (const [ax, ay, bx, by] of segs) {
      if (ax < V.x0 - 1 || ax > V.x1 + 1 || ay < V.y0 - 1 || ay > V.y1 + 1) continue;
      ctx.moveTo(this.sx(ax), this.sy(ay)); ctx.lineTo(this.sx(bx), this.sy(by));
    }
    ctx.stroke();
  }
  _outline(i, rad, color, w) {
    const [x, y] = this.hexXY(i), ctx = this.ctx;
    ctx.strokeStyle = color; ctx.lineWidth = w; ctx.beginPath(); hexPath(ctx, this.sx(x), this.sy(y), rad * 0.94); ctx.stroke();
  }
  _tint(V, rad) {
    const ctx = this.ctx, M = this.M, S = this.S;
    ctx.globalAlpha = rad < 7 ? 0.18 : 0.14;
    const byP = new Map();
    for (let r = V.r0; r <= V.r1; r++) for (let c = V.c0; c <= V.c1; c++) {
      const i = r * M.cols + c, p = S.prov[i];
      if (p < 0) continue;
      if (!byP.has(p)) byP.set(p, []);
      byP.get(p).push(i);
    }
    for (const [p, list] of byP) {
      ctx.fillStyle = this.D.provinces[p].color; ctx.beginPath();
      for (const i of list) { const [x, y] = this.hexXY(i); hexPath(ctx, this.sx(x), this.sy(y), rad + 0.5); }
      ctx.fill();
    }
    ctx.globalAlpha = 1;
  }
  _borders(V, rad) {
    const ctx = this.ctx, lens = !!this.lensColors;
    const w = lens ? Math.max(0.8, Math.min(2, rad * 0.08)) : Math.max(1.2, Math.min(4, rad * 0.16));
    const byP = new Map();
    for (const s of this.borderSegs) {
      if (s.mx < V.x0 - 0.3 || s.mx > V.x1 + 0.3 || s.my < V.y0 - 0.3 || s.my > V.y1 + 0.3) continue;
      if (!byP.has(s.p)) byP.set(s.p, []);
      byP.get(s.p).push(s);
    }
    ctx.lineCap = "round";
    if (lens) {
      ctx.strokeStyle = "rgba(10,14,20,0.55)"; ctx.lineWidth = w; ctx.beginPath();
      for (const list of byP.values()) for (const s of list) { ctx.moveTo(this.sx(s.x1), this.sy(s.y1)); ctx.lineTo(this.sx(s.x2), this.sy(s.y2)); }
      ctx.stroke();
      return;
    }
    ctx.strokeStyle = "rgba(0,0,0,0.55)"; ctx.lineWidth = w + 1.5; ctx.beginPath();
    for (const list of byP.values()) for (const s of list) { ctx.moveTo(this.sx(s.x1), this.sy(s.y1)); ctx.lineTo(this.sx(s.x2), this.sy(s.y2)); }
    ctx.stroke();
    ctx.lineWidth = w;
    for (const [p, list] of byP) {
      ctx.strokeStyle = this.D.provinces[p].color; ctx.beginPath();
      for (const s of list) { ctx.moveTo(this.sx(s.x1), this.sy(s.y1)); ctx.lineTo(this.sx(s.x2), this.sy(s.y2)); }
      ctx.stroke();
    }
  }
  _highlight(rad) {
    const h = this.highlight;
    if (!h) return;
    const ctx = this.ctx, V = this.visible();
    if (h.provs?.length) {
      ctx.save();
      ctx.shadowColor = "rgba(255,214,120,0.9)"; ctx.shadowBlur = 10;
      for (const p of h.provs) {
        const segs = this.provLandSegs.get(p) || [];
        this._segs(segs, { x0: -1e9, x1: 1e9, y0: -1e9, y1: 1e9 }, "#ffd978", Math.max(2, Math.min(4, rad * 0.2)));
      }
      ctx.restore();
    }
    if (h.hexes?.length) for (const i of h.hexes) this._outline(i, rad, "#ffd978", 2.5);
    if (h.points?.length) {
      ctx.save(); ctx.strokeStyle = "#ffd978"; ctx.lineWidth = 2.5; ctx.shadowColor = "rgba(255,214,120,0.9)"; ctx.shadowBlur = 8;
      for (const pt of h.points) {
        const X = this.sx(this.wx(pt.lon)), Y = this.sy(this.wy(pt.lat));
        ctx.beginPath(); ctx.arc(X, Y, Math.max(9, (pt.r || 0) + 5), 0, 7); ctx.stroke();
      }
      ctx.restore();
    }
  }
  _overlay(rad) {
    const ctx = this.ctx, o = this.overlay;
    const items = [...o.items].sort((a, b) => b.r - a.r);
    for (const it of items) {
      const X = this.sx(this.wx(it.lon)), Y = this.sy(this.wy(it.lat)), r = this._ovR(it);
      if (X < -50 || Y < -50 || X > this.vw + 50 || Y > this.vh + 50) continue;
      ctx.globalAlpha = it === this.hoverOverlay ? 1 : (o.alpha ?? 0.78);
      ctx.fillStyle = it.color; ctx.beginPath();
      if (it.shape === "square") ctx.rect(X - r, Y - r, 2 * r, 2 * r); else ctx.arc(X, Y, r, 0, 7);
      ctx.fill();
      ctx.globalAlpha = 1;
      ctx.strokeStyle = it === this.hoverOverlay ? "#fff" : (it.stroke || "rgba(0,0,0,0.6)"); ctx.lineWidth = it === this.hoverOverlay ? 2 : 1; ctx.stroke();
      if (it.icon && r >= 7) {
        ctx.font = `${Math.min(r * 1.2, 18)}px ${EMOJI_FONT}`; ctx.textAlign = "center"; ctx.textBaseline = "middle";
        ctx.fillText(it.icon, X, Y + 1);
      }
    }
    if (rad >= 9) {
      ctx.font = `600 ${Math.max(10, Math.min(13, rad * 0.3))}px "Source Sans 3", sans-serif`;
      ctx.textAlign = "center"; ctx.textBaseline = "top";
      for (const it of items.filter((x) => x.label).slice(0, 60)) {
        const X = this.sx(this.wx(it.lon)), Y = this.sy(this.wy(it.lat)) + this._ovR(it) + 3;
        this._label(it.label, X, Y + 6, "#f1e6c8");
      }
    }
  }
  _glyphs(V, rad) {
    const ctx = this.ctx, M = this.M, S = this.S;
    ctx.lineJoin = "round";
    for (let r = V.r0; r <= V.r1; r++) for (let c = V.c0; c <= V.c1; c++) {
      const i = r * M.cols + c;
      if (!S.land[i] && this.featureName(i) !== "reef") continue;
      const [wx, wy] = this.hexXY(i), x = this.sx(wx), y = this.sy(wy);
      const t = this.terrainName(i), f = this.featureName(i);
      if (t === "mountain" || t === "snow_mountain" || f === "volcano") {
        const h = rad * 0.75, peaks = f === "volcano" ? [[0, 1.1]] : [[-0.35, 0.8], [0.3, 1.0]];
        for (const [dx, sc] of peaks) {
          const px = x + dx * rad, base = y + rad * 0.45, top = base - h * sc;
          ctx.fillStyle = f === "volcano" ? "#5a4a44" : "#6b625a";
          ctx.beginPath(); ctx.moveTo(px - rad * 0.42 * sc, base); ctx.lineTo(px, top); ctx.lineTo(px + rad * 0.42 * sc, base); ctx.closePath(); ctx.fill();
          ctx.fillStyle = t === "snow_mountain" ? "#ffffff" : f === "volcano" ? "#d8492f" : "#d9d4cb";
          ctx.beginPath(); ctx.moveTo(px - rad * 0.14 * sc, top + h * sc * 0.33); ctx.lineTo(px, top); ctx.lineTo(px + rad * 0.14 * sc, top + h * sc * 0.33); ctx.closePath(); ctx.fill();
          if (f === "volcano") {
            ctx.fillStyle = "rgba(200,200,200,0.55)";
            ctx.beginPath(); ctx.arc(px + rad * 0.08, top - rad * 0.18, rad * 0.12, 0, 7); ctx.arc(px + rad * 0.22, top - rad * 0.32, rad * 0.09, 0, 7); ctx.fill();
          }
        }
      } else if (t.startsWith("hills")) {
        ctx.strokeStyle = "rgba(40,50,20,0.55)"; ctx.lineWidth = Math.max(1, rad * 0.08); ctx.beginPath();
        ctx.arc(x - rad * 0.3, y + rad * 0.35, rad * 0.32, Math.PI * 1.1, Math.PI * 1.9);
        ctx.moveTo(x + rad * 0.55, y + rad * 0.15);
        ctx.arc(x + rad * 0.25, y + rad * 0.15, rad * 0.3, Math.PI * 1.9, Math.PI * 1.1, true);
        ctx.stroke();
      }
      if (f === "rainforest" || f === "woods") {
        const pts = [[-0.4, -0.25], [0.35, -0.3], [-0.05, 0.05], [0.4, 0.3], [-0.45, 0.35]].slice(0, f === "rainforest" ? 4 : 3);
        for (const [dx, dy] of pts) {
          const px = x + dx * rad, py = y + dy * rad;
          ctx.fillStyle = "#3b2a1a"; ctx.fillRect(px - rad * 0.03, py, rad * 0.06, rad * 0.16);
          ctx.fillStyle = f === "rainforest" ? "#3f8f3a" : "#6f9a3c";
          ctx.strokeStyle = "rgba(10,30,10,0.7)"; ctx.lineWidth = Math.max(0.8, rad * 0.03); ctx.beginPath();
          if (f === "rainforest") ctx.arc(px, py - rad * 0.02, rad * 0.16, 0, 7);
          else { ctx.moveTo(px - rad * 0.14, py + rad * 0.04); ctx.lineTo(px, py - rad * 0.26); ctx.lineTo(px + rad * 0.14, py + rad * 0.04); ctx.closePath(); }
          ctx.fill(); ctx.stroke();
        }
      } else if (f === "marsh") {
        ctx.strokeStyle = "rgba(160,200,170,0.75)"; ctx.lineWidth = Math.max(1, rad * 0.06); ctx.beginPath();
        for (const [dx, dy] of [[-0.35, -0.1], [0.1, 0.2], [0.35, -0.25]]) {
          const px = x + dx * rad, py = y + dy * rad;
          ctx.moveTo(px - rad * 0.18, py); ctx.lineTo(px + rad * 0.18, py);
          ctx.moveTo(px, py); ctx.lineTo(px - rad * 0.05, py - rad * 0.2);
          ctx.moveTo(px, py); ctx.lineTo(px + rad * 0.07, py - rad * 0.18);
        }
        ctx.stroke();
      } else if (f === "floodplains") {
        ctx.strokeStyle = "rgba(220,235,160,0.6)"; ctx.lineWidth = Math.max(1, rad * 0.05); ctx.beginPath();
        for (let k = -1; k <= 1; k++) { ctx.moveTo(x - rad * 0.4, y + k * rad * 0.22); ctx.lineTo(x + rad * 0.4, y + k * rad * 0.22); }
        ctx.stroke();
      } else if (f === "reef") {
        ctx.fillStyle = "rgba(255,150,140,0.75)";
        for (const [dx, dy] of [[-0.3, -0.2], [0.25, -0.1], [-0.05, 0.3], [0.35, 0.3]]) { ctx.beginPath(); ctx.arc(x + dx * rad, y + dy * rad, rad * 0.08, 0, 7); ctx.fill(); }
      } else if (f === "geothermal") {
        ctx.fillStyle = "rgba(240,240,240,0.7)";
        for (const [dx, dy, s] of [[0, 0, 0.14], [0.12, -0.22, 0.1], [-0.08, -0.4, 0.08]]) { ctx.beginPath(); ctx.arc(x + dx * rad, y + dy * rad, rad * s, 0, 7); ctx.fill(); }
      }
      if (S.urban[i] >= 30 && !this.cityAt.has(i)) { // dense built-up land from MODIS
        ctx.fillStyle = "rgba(205,190,160,0.85)";
        for (const [dx, dy, w, h] of [[-0.3, 0.05, 0.16, 0.22], [-0.08, -0.12, 0.14, 0.38], [0.14, 0.0, 0.16, 0.26]]) ctx.fillRect(x + dx * rad, y + dy * rad, w * rad, h * rad);
      }
    }
  }
  _rivers(rad) {
    const ctx = this.ctx;
    ctx.strokeStyle = this.lensColors ? "rgba(110,180,230,0.55)" : "#4fa6dd"; ctx.lineCap = "round"; ctx.lineJoin = "round";
    ctx.lineWidth = Math.max(1, Math.min(5, rad * 0.16)); ctx.beginPath();
    for (const rv of this.D.rivers) for (const ln of rv.lines) ln.forEach(([lon, lat], k) => {
      const X = this.sx(this.wx(lon)), Y = this.sy(this.wy(lat));
      k ? ctx.lineTo(X, Y) : ctx.moveTo(X, Y);
    });
    ctx.stroke();
  }
  _parks(V, rad) {
    const ctx = this.ctx, M = this.M;
    ctx.strokeStyle = "rgba(140,255,150,0.9)"; ctx.lineWidth = Math.max(1, rad * 0.08);
    ctx.setLineDash([Math.max(2, rad * 0.25), Math.max(2, rad * 0.18)]); ctx.beginPath();
    for (let r = V.r0; r <= V.r1; r++) for (let c = V.c0; c <= V.c1; c++) {
      const i = r * M.cols + c;
      if (this.S.park[i] >= 0) { const [x, y] = this.hexXY(i); hexPath(ctx, this.sx(x), this.sy(y), rad * 0.78); }
    }
    ctx.stroke(); ctx.setLineDash([]);
  }
  _yields(V, rad) {
    const ctx = this.ctx, M = this.M, S = this.S, fs = Math.max(8, rad * 0.3);
    ctx.font = `700 ${fs}px "Source Sans 3", sans-serif`; ctx.textAlign = "center"; ctx.textBaseline = "middle";
    for (let r = V.r0; r <= V.r1; r++) for (let c = V.c0; c <= V.c1; c++) {
      const i = r * M.cols + c;
      if (!S.land[i] && S.prov[i] < 0) continue;
      const y = this.yields(i), [wx, wy] = this.hexXY(i), X = this.sx(wx), Y = this.sy(wy) + rad * 0.55;
      const parts = [[y[0], "#8fd16a"], [y[1], "#e0a35a"], [y[2], "#f1d36b"]].filter((p) => p[0] > 0);
      parts.forEach(([n, col], k) => {
        const px = X + (k - (parts.length - 1) / 2) * fs * 0.95;
        ctx.fillStyle = "rgba(0,0,0,0.6)"; ctx.beginPath(); ctx.arc(px, Y, fs * 0.48, 0, 7); ctx.fill();
        ctx.fillStyle = col; ctx.fillText(n, px, Y + 0.5);
      });
    }
  }
  _resources(V, rad) {
    const ctx = this.ctx, M = this.M, S = this.S, R = Math.max(6, Math.min(16, rad * 0.32));
    ctx.textAlign = "center"; ctx.textBaseline = "middle"; ctx.font = `${R * 1.25}px ${EMOJI_FONT}`;
    for (let r = V.r0; r <= V.r1; r++) for (let c = V.c0; c <= V.c1; c++) {
      const i = r * M.cols + c, ri = S.res[i];
      if (ri < 0 || this.cityAt.has(i)) continue;
      const site = this.D.resources[ri], meta = RES[M.resourceKinds[site.r]];
      if (!meta || (rad < 13 && site.regional)) continue;
      const [wx, wy] = this.hexXY(i), X = this.sx(wx) + rad * 0.32, Y = this.sy(wy) - rad * 0.3;
      ctx.fillStyle = "rgba(12,18,26,0.85)"; ctx.beginPath(); ctx.arc(X, Y, R, 0, 7); ctx.fill();
      ctx.strokeStyle = RES_RING[meta.cls]; ctx.lineWidth = Math.max(1.5, R * 0.18); ctx.stroke();
      ctx.fillStyle = "#fff"; ctx.fillText(meta.icon, X, Y + R * 0.08);
    }
  }
  _wonders(V, rad) {
    const ctx = this.ctx, M = this.M, R = Math.max(6, Math.min(15, rad * 0.34));
    ctx.textAlign = "center"; ctx.textBaseline = "middle";
    for (const w of this.D.wonders) {
      const c = w.hex % M.cols, r = (w.hex / M.cols) | 0;
      if (c < V.c0 || c > V.c1 || r < V.r0 || r > V.r1) continue;
      const [wx, wy] = this.hexXY(w.hex), X = this.sx(wx) - rad * 0.3, Y = this.sy(wy) - rad * 0.3;
      ctx.fillStyle = "rgba(30,20,6,0.9)"; ctx.beginPath(); ctx.arc(X, Y, R, 0, 7); ctx.fill();
      ctx.strokeStyle = "#e2c37a"; ctx.lineWidth = Math.max(1.5, R * 0.2); ctx.stroke();
      ctx.font = `${R * 1.15}px ${EMOJI_FONT}`; ctx.fillStyle = "#fff";
      ctx.fillText(w.kind === "natural" ? "⛰️" : "🏛️", X, Y + R * 0.08);
      if (rad >= 20) { ctx.font = `600 ${Math.max(10, rad * 0.26)}px Cinzel, Georgia, serif`; this._label(w.short || w.name, X, Y + R + rad * 0.22, "#f3dfa6"); }
    }
  }
  _volcanoLabels(V, rad) {
    const ctx = this.ctx, M = this.M;
    ctx.font = `600 ${Math.max(9, rad * 0.22)}px "Source Sans 3", sans-serif`; ctx.textAlign = "center"; ctx.textBaseline = "middle";
    for (const v of this.D.volcanoes) {
      const c = v.hex % M.cols, r = (v.hex / M.cols) | 0;
      if (c < V.c0 || c > V.c1 || r < V.r0 || r > V.r1 || this.cityAt.has(v.hex) || this.wonderAt.has(v.hex)) continue;
      if (rad < 24 && !(v.elev >= 2500)) continue;
      const [wx, wy] = this.hexXY(v.hex);
      this._label(`${v.name}${v.elev ? ` ${v.elev.toLocaleString()} m` : ""}`, this.sx(wx), this.sy(wy) + rad * 0.7, "#ffcbb8");
    }
  }
  _label(text, x, y, color) {
    const ctx = this.ctx, w = ctx.measureText(text).width, h = parseFloat(ctx.font.match(/(\d+(?:\.\d+)?)px/)[1]);
    const box = [x - w / 2 - 2, y - h / 2 - 1, x + w / 2 + 2, y + h / 2 + 1];
    if (this.placed.some((b) => box[0] < b[2] && box[2] > b[0] && box[1] < b[3] && box[3] > b[1])) return;
    this.placed.push(box);
    ctx.lineWidth = 3; ctx.strokeStyle = "rgba(0,0,0,0.75)"; ctx.strokeText(text, x, y);
    ctx.fillStyle = color; ctx.fillText(text, x, y);
  }
  _cityFont(rad) { return rad < 5 ? 9 : Math.max(10, Math.min(15, rad * 0.42)); }
  _layoutCities(V, rad) {
    const ctx = this.ctx, M = this.M;
    const minSize = rad < 4 ? 14 : rad < 7 ? 9 : rad < 11 ? 6 : rad < 16 ? 3 : 0;
    const fs = this._cityFont(rad);
    const prio = (c) => (c.capital === "national" ? 1e6 : 0) + (c.capitalOf ? 1e4 : 0) + c.size;
    const list = this.D.cities.filter((c) => c.size >= minSize || c.capital === "national" || (c.capitalOf && rad >= 3)).sort((a, b) => prio(b) - prio(a));
    ctx.font = `700 ${fs}px "Source Sans 3", sans-serif`;
    const laid = [];
    for (const c of list) {
      const col = c.hex % M.cols, row = (c.hex / M.cols) | 0;
      if (col < V.c0 - 3 || col > V.c1 + 3 || row < V.r0 - 2 || row > V.r1 + 2) continue;
      const [wx, wy] = this.hexXY(c.hex), X = this.sx(wx), Y = this.sy(wy);
      const name = (c.capital === "national" ? "★ " : c.capitalOf ? "✦ " : "") + c.name;
      const tw = ctx.measureText(name).width, bh = fs * 1.5, sz = bh, bw = tw + sz + fs * 0.9;
      const bx = X - bw / 2, by = Y - (rad >= 7 ? rad * 0.95 : 6) - bh;
      const box = [bx - 1, by - 1, bx + bw + 1, by + bh + 1];
      const banner = !this.placed.some((b) => box[0] < b[2] && box[2] > b[0] && box[1] < b[3] && box[3] > b[1]);
      if (banner) this.placed.push(box);
      laid.push({ c, X, Y, name, bh, sz, bw, bx, by, banner, fs });
    }
    return laid;
  }
  _cities(laid, rad) {
    const ctx = this.ctx;
    for (const { c, X, Y, name, bh, sz, bw, bx, by, banner, fs } of [...laid].reverse()) {
      const pk = this.provByName.get(c.province), pcol = pk != null ? this.D.provinces[pk].color : "#888";
      if (rad >= 7) {
        ctx.fillStyle = "#c9b48a"; ctx.strokeStyle = "#3b2f1e"; ctx.lineWidth = 1;
        const s = rad * 0.42;
        ctx.beginPath(); hexPath(ctx, X, Y, s); ctx.fill(); ctx.stroke();
        ctx.fillStyle = "#8a6d3b";
        ctx.fillRect(X - s * 0.45, Y - s * 0.35, s * 0.25, s * 0.55); ctx.fillRect(X + s * 0.05, Y - s * 0.6, s * 0.3, s * 0.8);
      } else {
        ctx.fillStyle = "#f3e6c4"; ctx.strokeStyle = "#111"; ctx.lineWidth = 1;
        ctx.beginPath(); ctx.arc(X, Y, c.capital === "national" ? 4 : 2.6, 0, 7); ctx.fill(); ctx.stroke();
      }
      if (!banner) continue;
      ctx.font = `700 ${fs}px "Source Sans 3", sans-serif`;
      ctx.fillStyle = "rgba(14,20,30,0.92)"; roundRect(ctx, bx, by, bw, bh, bh * 0.35); ctx.fill();
      ctx.strokeStyle = pcol; ctx.lineWidth = 2; ctx.stroke();
      ctx.fillStyle = pcol; roundRect(ctx, bx, by, sz, bh, bh * 0.35); ctx.fill();
      ctx.fillStyle = luminance(pcol) > 0.55 ? "#111" : "#fff"; ctx.textAlign = "center"; ctx.textBaseline = "middle";
      ctx.fillText(String(c.size), bx + sz / 2, by + bh / 2 + 0.5);
      ctx.fillStyle = c.capital === "national" ? "#ffe08a" : "#f4ecd8"; ctx.textAlign = "left";
      ctx.fillText(name, bx + sz + fs * 0.45, by + bh / 2 + 0.5);
    }
  }

  // Minimap: province-coloured land plus the viewport rectangle
  renderMinimap(canvas, dpr) {
    const W = 300, H = 120, M = this.M, S = this.S;
    canvas.width = W * dpr; canvas.height = H * dpr;
    const k = Math.min(W / ((M.cols + 0.5) * M.w), H / ((M.rows + 0.5) * M.h));
    const c = document.createElement("canvas"); c.width = W * dpr; c.height = H * dpr;
    const g = c.getContext("2d"); g.scale(dpr, dpr);
    g.fillStyle = "#0e2a47"; g.fillRect(0, 0, W, H);
    for (let i = 0; i < this.N; i++) {
      if (!S.land[i]) continue;
      const [x, y] = this.hexXY(i), p = S.prov[i];
      g.fillStyle = p >= 0 ? this.D.provinces[p].color : "#888";
      g.fillRect(x * k - 0.8, y * k - 0.8, 1.8, 1.8);
    }
    this.mini = { canvas, base: c, k, dpr };
  }
  drawMinimap() {
    const m = this.mini;
    if (!m) return;
    const g = m.canvas.getContext("2d");
    g.setTransform(1, 0, 0, 1, 0, 0); g.drawImage(m.base, 0, 0);
    g.setTransform(m.dpr, 0, 0, m.dpr, 0, 0);
    g.strokeStyle = "#ffe08a"; g.lineWidth = 1.5;
    g.strokeRect(this.cam.x * m.k, this.cam.y * m.k, (this.vw / this.cam.scale) * m.k, (this.vh / this.cam.scale) * m.k);
  }
}

export function hexPath(c2, x, y, rad) {
  c2.moveTo(x + rad * 0.8660254, y - rad * 0.5); c2.lineTo(x + rad * 0.8660254, y + rad * 0.5); c2.lineTo(x, y + rad);
  c2.lineTo(x - rad * 0.8660254, y + rad * 0.5); c2.lineTo(x - rad * 0.8660254, y - rad * 0.5); c2.lineTo(x, y - rad); c2.closePath();
}
function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath(); ctx.moveTo(x + r, y); ctx.arcTo(x + w, y, x + w, y + h, r); ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r); ctx.arcTo(x, y, x + w, y, r); ctx.closePath();
}
function luminance(hex) {
  const n = parseInt(hex.slice(1), 16);
  return (0.299 * ((n >> 16) & 255) + 0.587 * ((n >> 8) & 255) + 0.114 * (n & 255)) / 255;
}
