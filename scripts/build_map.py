#!/usr/bin/env python3
"""Build public/map-data.json: a Civilization-style hex map of Indonesia.

Inputs (see fetch_sources.py): geoBoundaries provinces/regencies, Natural Earth
and OpenStreetMap rivers/lakes, Wikidata cities/provinces/volcanoes/UNESCO
sites/national parks, curated resources (data/curated/resources.json), and
Copernicus GLO-90 elevation via the Open-Meteo elevation API (cached).

Run:  python3 -I scripts/build_map.py
"""
import hashlib
import json
import math
import re
import time
import urllib.parse
import urllib.request
from collections import defaultdict, deque
from pathlib import Path
import sys

sys.path.insert(0, str(Path(__file__).resolve().parent))
import rasters  # noqa: E402
import stats  # noqa: E402

ROOT = Path(__file__).resolve().parent.parent
RAW = ROOT / "data" / "raw"
CURATED = ROOT / "data" / "curated" / "resources.json"
OUT = ROOT / "public" / "map-data.json"
ELEV_CACHE = RAW / "elevation_cache.json"

# ---------------------------------------------------------------- hex grid
# Pointy-top hexes, odd rows shifted right ("odd-r"). x = lon, y = lat
# (equirectangular; Indonesia straddles the equator so distortion is ~2%).
W = 0.2                      # degrees between hex centres in a row (~22 km)
H = W * math.sqrt(3) / 2     # degrees between rows
LON0, LON1 = 94.8, 141.2
LAT0, LAT1 = 6.3, -11.2
COLS = int(math.ceil((LON1 - LON0) / W)) + 1
ROWS = int(math.ceil((LAT0 - LAT1) / H)) + 1
N = COLS * ROWS


def center(col, row):
    return LON0 + col * W + (row & 1) * W / 2, LAT0 - row * H


def hex_at(lon, lat):
    """Nearest hex centre (exact for a hex grid via cube rounding)."""
    # pixel -> axial for pointy-top, size s = W/sqrt(3)
    s = W / math.sqrt(3)
    px, py = lon - LON0, LAT0 - lat
    q = (math.sqrt(3) / 3 * px - 1 / 3 * py) / s
    r = (2 / 3 * py) / s
    x, z = q, r
    y = -x - z
    rx, ry, rz = round(x), round(y), round(z)
    dx, dy, dz = abs(rx - x), abs(ry - y), abs(rz - z)
    if dx > dy and dx > dz:
        rx = -ry - rz
    elif dy > dz:
        ry = -rx - rz
    else:
        rz = -rx - ry
    row = rz
    col = rx + (rz - (rz & 1)) // 2
    return col, row


def idx(col, row):
    if 0 <= col < COLS and 0 <= row < ROWS:
        return row * COLS + col
    return -1


def cr(i):
    return i % COLS, i // COLS


NB_EVEN = [(1, 0), (-1, 0), (0, -1), (-1, -1), (0, 1), (-1, 1)]
NB_ODD = [(1, 0), (-1, 0), (1, -1), (0, -1), (1, 1), (0, 1)]


def neighbors(i):
    c, r = cr(i)
    for dc, dr in (NB_ODD if r & 1 else NB_EVEN):
        j = idx(c + dc, r + dr)
        if j >= 0:
            yield j


def to_cube(c, r):
    x = c - (r - (r & 1)) // 2
    return x, -x - r, r


def hex_dist(a, b):
    ax, ay, az = to_cube(*cr(a))
    bx, by, bz = to_cube(*cr(b))
    return max(abs(ax - bx), abs(ay - by), abs(az - bz))


def ring_within(i, radius):
    seen = {i}
    frontier = [i]
    for _ in range(radius):
        nxt = []
        for k in frontier:
            for j in neighbors(k):
                if j not in seen:
                    seen.add(j)
                    nxt.append(j)
        frontier = nxt
    return seen


# ------------------------------------------------------------ geometry utils
def polygons(geom):
    t, c = geom["type"], geom["coordinates"]
    if t == "Polygon":
        return [c]
    if t == "MultiPolygon":
        return c
    return []


def lines(geom):
    t, c = geom["type"], geom["coordinates"]
    if t == "LineString":
        return [c]
    if t == "MultiLineString":
        return c
    return []


def ring_area(ring):
    a = 0.0
    for (x0, y0), (x1, y1) in zip(ring, ring[1:] + ring[:1]):
        a += x0 * y1 - x1 * y0
    return abs(a) / 2


def scan_fill(poly):
    """Hex indices whose centres fall inside a polygon (list of rings, even-odd)."""
    xs_by_row = defaultdict(list)
    for ring in poly:
        for (x0, y0), (x1, y1) in zip(ring, ring[1:] + ring[:1]):
            if y0 == y1:
                continue
            lo, hi = min(y0, y1), max(y0, y1)
            r_start = max(0, int(math.ceil((LAT0 - hi) / H)))
            r_end = min(ROWS - 1, int(math.floor((LAT0 - lo) / H)))
            for r in range(r_start, r_end + 1):
                y = LAT0 - r * H
                if lo <= y < hi:
                    xs_by_row[r].append(x0 + (y - y0) * (x1 - x0) / (y1 - y0))
    out = []
    for r, xs in xs_by_row.items():
        xs.sort()
        off = LON0 + (r & 1) * W / 2
        for a, b in zip(xs[0::2], xs[1::2]):
            c0 = max(0, int(math.ceil((a - off) / W)))
            c1 = min(COLS - 1, int(math.floor((b - off) / W)))
            for c in range(c0, c1 + 1):
                out.append(r * COLS + c)
    return out


def dp_simplify(pts, tol):
    if len(pts) < 3:
        return pts
    keep = [False] * len(pts)
    keep[0] = keep[-1] = True
    stack = [(0, len(pts) - 1)]
    while stack:
        a, b = stack.pop()
        (ax, ay), (bx, by) = pts[a], pts[b]
        dx, dy = bx - ax, by - ay
        norm = math.hypot(dx, dy) or 1e-12
        best, bi = -1.0, -1
        for k in range(a + 1, b):
            px, py = pts[k]
            d = abs(dy * (px - ax) - dx * (py - ay)) / norm
            if d > best:
                best, bi = d, k
        if best > tol:
            keep[bi] = True
            stack += [(a, bi), (bi, b)]
    return [p for p, k in zip(pts, keep) if k]


def stable_hash(*parts):
    return int(hashlib.md5("|".join(map(str, parts)).encode()).hexdigest()[:8], 16)


def wd_point(s):
    m = re.match(r"Point\(([-\d.eE]+) ([-\d.eE]+)\)", s)
    return (float(m.group(1)), float(m.group(2))) if m else None


def wd_rows(name):
    return json.loads((RAW / name).read_text())["results"]["bindings"]


def v(b, k):
    return b[k]["value"] if k in b else None


# --------------------------------------------------------------- provinces
PAPUA_SPLIT = {  # 2022 laws (UU 14, 15, 16 / 2022 and UU 29 / 2022)
    "South Papua": ["Merauke", "Boven Digoel", "Mappi", "Asmat"],
    "Central Papua": ["Nabire", "Puncak Jaya", "Paniai", "Mimika", "Puncak", "Dogiyai", "Intan Jaya", "Deiyai"],
    "Highland Papua": ["Jayawijaya", "Pegunungan Bintang", "Yahukimo", "Tolikara", "Mamberamo Tengah",
                       "Yalimo", "Lanny Jaya", "Nduga"],
    "Southwest Papua": ["Kota Sorong", "Sorong", "Sorong Selatan", "Raja Ampat", "Tambrauw", "Maybrat"],
}
REGENCY_TO_NEW = {r: p for p, rs in PAPUA_SPLIT.items() for r in rs}

# Island groups drive the climate/land-cover rules and the UI legend.
ISLAND = {
    "Aceh": "Sumatra", "North Sumatra": "Sumatra", "West Sumatra": "Sumatra", "Riau": "Sumatra",
    "Jambi": "Sumatra", "South Sumatra": "Sumatra", "Bengkulu": "Sumatra", "Lampung": "Sumatra",
    "Bangka-Belitung Islands": "Sumatra", "Riau Islands": "Sumatra",
    "Jakarta Special Capital Region": "Java", "Banten": "Java", "West Java": "Java", "Central Java": "Java",
    "Special Region of Yogyakarta": "Java", "East Java": "Java",
    "Bali": "Lesser Sunda", "West Nusa Tenggara": "Lesser Sunda", "East Nusa Tenggara": "Lesser Sunda",
    "West Kalimantan": "Kalimantan", "Central Kalimantan": "Kalimantan", "South Kalimantan": "Kalimantan",
    "East Kalimantan": "Kalimantan", "North Kalimantan": "Kalimantan",
    "North Sulawesi": "Sulawesi", "Gorontalo": "Sulawesi", "Central Sulawesi": "Sulawesi",
    "West Sulawesi": "Sulawesi", "South Sulawesi": "Sulawesi", "Southeast Sulawesi": "Sulawesi",
    "Maluku": "Maluku", "North Maluku": "Maluku",
    "Papua": "Papua", "West Papua": "Papua", "South Papua": "Papua", "Central Papua": "Papua",
    "Highland Papua": "Papua", "Southwest Papua": "Papua",
}

# Wikidata English labels -> geoBoundaries names used on the map
WD_PROVINCE_ALIASES = {
    "Jakarta": "Jakarta Special Capital Region",
    "Special Capital Region of Jakarta": "Jakarta Special Capital Region",
    "Daerah Khusus Ibukota Jakarta": "Jakarta Special Capital Region",
    "Yogyakarta": "Special Region of Yogyakarta",
    "Bangka Belitung Islands": "Bangka-Belitung Islands",
    "Bangka Belitung": "Bangka-Belitung Islands",
    "Southwest Papua": "Southwest Papua",
    "South West Papua": "Southwest Papua",
    "Papua Pegunungan": "Highland Papua",
    "Highland Papua": "Highland Papua",
    "Papua Selatan": "South Papua",
    "Papua Tengah": "Central Papua",
    "Papua Barat Daya": "Southwest Papua",
    "Papua Barat": "West Papua",
    "Aceh Province": "Aceh",
}

# Wikidata stores these hectare figures as km^2
PARK_AREA_FIX = {"Mount Gede-Pangrango National Park": 243, "Gunung Maras National Park": 168}
CURRENT_CAPITAL = {"Bali": "Denpasar", "North Sulawesi": "Manado", "South Papua": "Merauke"}
# Wikidata gives the regency rather than the town as capital here
CAPITAL_FIX = {"Highland Papua": {"name": "Wamena", "lon": 138.951, "lat": -4.093}}

PROVINCE_COLORS = [
    "#e6194b", "#3cb44b", "#ffe119", "#4363d8", "#f58231", "#911eb4", "#46f0f0", "#f032e6",
    "#bcf60c", "#fabebe", "#008080", "#e6beff", "#9a6324", "#fffac8", "#800000", "#aaffc3",
    "#808000", "#ffd8b1", "#000075", "#a9a9a9", "#ff6f61", "#6b5b95", "#88b04b", "#f7cac9",
    "#92a8d1", "#955251", "#b565a7", "#009b77", "#dd4124", "#d65076", "#45b8ac", "#efc050",
    "#5b5ea6", "#9b2335", "#dfcfbe", "#55b4b0", "#e15d44", "#7fcdcd", "#bc243c", "#c3447a",
]

# ----------------------------------------------------------------- terrain
TERRAINS = ["ocean", "coast", "lake", "grassland", "plains", "hills_grassland", "hills_plains",
            "mountain", "snow_mountain"]
FEATURES = ["", "rainforest", "woods", "marsh", "floodplains", "reef", "volcano", "geothermal"]
T = {n: k for k, n in enumerate(TERRAINS)}
F = {n: k for k, n in enumerate(FEATURES)}

CULTIVATED = {"Java"}
DRY = {"Lesser Sunda"}
PEAT_PROVINCES = {"Riau", "Jambi", "South Sumatra", "North Sumatra", "West Kalimantan", "Central Kalimantan",
                  "South Kalimantan", "East Kalimantan", "North Kalimantan", "South Papua", "Papua",
                  "Central Papua", "West Papua", "Southwest Papua"}


# ----------------------------------------------------------------- elevation
def fetch_elevations(points):
    cache = json.loads(ELEV_CACHE.read_text()) if ELEV_CACHE.exists() else {}
    key = lambda p: f"{p[1]:.4f},{p[0]:.4f}"
    todo = [p for p in points if key(p) not in cache]
    print(f"elevation: {len(points)} points, {len(todo)} uncached")
    for start in range(0, len(todo), 100):
        batch = todo[start:start + 100]
        q = urllib.parse.urlencode({
            "latitude": ",".join(f"{p[1]:.4f}" for p in batch),
            "longitude": ",".join(f"{p[0]:.4f}" for p in batch),
        })
        for attempt in range(6):
            try:
                req = urllib.request.Request("https://api.open-meteo.com/v1/elevation?" + q,
                                             headers={"User-Agent": "id-civilization-hexmap/0.1"})
                with urllib.request.urlopen(req, timeout=60) as r:
                    elev = json.loads(r.read())["elevation"]
                break
            except Exception as e:  # noqa: BLE001 - network retry
                print(f"  retry {attempt + 1}: {e}")
                time.sleep(10 * (attempt + 1))
        else:
            raise SystemExit("elevation API kept failing; re-run later (progress is cached)")
        for p, e in zip(batch, elev):
            cache[key(p)] = e
        ELEV_CACHE.write_text(json.dumps(cache))
        print(f"  {min(start + 100, len(todo))}/{len(todo)}")
        time.sleep(0.4)
    return {i: cache[key(p)] for i, p in enumerate(points)}


# --------------------------------------------------------------------- main
def main():
    cur = json.loads(CURATED.read_text())
    print(f"grid {COLS} x {ROWS} = {N} hexes")

    # ---- land + provinces (ADM1)
    prov_of = [None] * N
    adm1 = json.loads((RAW / "adm1.geojson").read_text())
    islands = []
    for f in adm1["features"]:
        name = f["properties"]["shapeName"]
        for poly in polygons(f["geometry"]):
            filled = scan_fill(poly)
            for i in filled:
                prov_of[i] = name
            if not filled:
                a = ring_area(poly[0])
                if a > 0.0004:  # ~5 km^2: keep small named islands (Banda, Ternate...)
                    xs = [p[0] for p in poly[0]]
                    ys = [p[1] for p in poly[0]]
                    islands.append((a, name, sum(xs) / len(xs), sum(ys) / len(ys)))
    for a, name, x, y in sorted(islands, reverse=True):
        i = idx(*hex_at(x, y))
        if i >= 0 and prov_of[i] is None:
            prov_of[i] = name

    # ---- regencies (ADM2), Papua re-split into the 2022 provinces
    reg_of = [None] * N
    adm2 = json.loads((RAW / "adm2.geojson").read_text())
    small = []
    for f in adm2["features"]:
        name = f["properties"]["shapeName"]
        for poly in polygons(f["geometry"]):
            filled = scan_fill(poly)
            for i in filled:
                if prov_of[i]:
                    reg_of[i] = name
            if not filled:
                xs = [p[0] for p in poly[0]]
                ys = [p[1] for p in poly[0]]
                small.append((ring_area(poly[0]), name, sum(xs) / len(xs), sum(ys) / len(ys)))
    for a, name, x, y in sorted(small, reverse=True):
        i = idx(*hex_at(x, y))
        if i >= 0 and prov_of[i] and reg_of[i] is None:
            reg_of[i] = name
    for i in range(N):
        if prov_of[i] in ("Papua", "West Papua") and reg_of[i] in REGENCY_TO_NEW:
            prov_of[i] = REGENCY_TO_NEW[reg_of[i]]
    land = [p is not None for p in prov_of]

    # ---- lakes (Natural Earth polygons + curated centres) carve into land
    lake_of = {}
    for f in json.loads((RAW / "ne_lakes.geojson").read_text())["features"]:
        nm = f["properties"].get("name") or "Lake"
        for poly in polygons(f["geometry"]):
            for i in scan_fill(poly):
                if land[i]:
                    lake_of[i] = nm
    for lk in cur["lakes"]:
        i = idx(*hex_at(lk["lon"], lk["lat"]))
        if i >= 0 and land[i]:
            lake_of[i] = lk["name"]
            if lk.get("hexes", 1) > 1:
                for j in list(neighbors(i))[: lk["hexes"] - 1]:
                    if land[j]:
                        lake_of[j] = lk["name"]
    for i, nm in lake_of.items():
        lake_of[i] = {"Danau Toba": "Lake Toba", "Kenohan Jempang": "Lake Jempang"}.get(nm, nm)

    # ---- elevation for land + lake hexes
    land_idx = [i for i in range(N) if land[i]]
    elev_list = fetch_elevations([center(*cr(i)) for i in land_idx])
    elev = [None] * N
    for k, i in enumerate(land_idx):
        e = elev_list[k]
        elev[i] = None if e is None or (isinstance(e, float) and math.isnan(e)) else round(e)

    # ---- distance to land (for coast/ocean and territorial waters)
    dist = [None] * N
    owner = [None] * N
    dq = deque()
    for i in land_idx:
        dist[i] = 0
        owner[i] = prov_of[i]
        dq.append(i)
    while dq:
        i = dq.popleft()
        if dist[i] >= 3:
            continue
        for j in neighbors(i):
            if dist[j] is None:
                dist[j] = dist[i] + 1
                owner[j] = owner[i]
                dq.append(j)

    # ---- rivers: OSM relations (preferred) + Natural Earth remainder
    rivers = []
    osm = json.loads((RAW / "osm_rivers.json").read_text())
    osm_names = set()
    for rel in osm["elements"]:
        nm = re.sub(r"^(Sungai|Air|Walungan|Way) ", "", rel.get("tags", {}).get("name", "River"))
        nm = nm.replace(" River", "")
        segs = []
        for m in rel.get("members", []):
            if m.get("type") == "way" and m.get("role") in ("main_stream", "", "side_stream") and m.get("geometry"):
                pts = [[g["lon"], g["lat"]] for g in m["geometry"]]
                segs.append(pts)
        segs = [dp_simplify(s, 0.01) for s in segs]
        segs = [[[round(x, 3), round(y, 3)] for x, y in s] for s in segs if len(s) >= 2]
        if segs:
            rivers.append({"name": nm, "lines": segs, "src": "OpenStreetMap"})
            osm_names.add(nm.split(" (")[0].lower())
    for f in json.loads((RAW / "ne_rivers.geojson").read_text())["features"]:
        nm = f["properties"].get("name") or "River"
        if nm.lower() in osm_names:
            continue
        segs = []
        for ln in lines(f["geometry"]):
            if any(LON0 <= x <= LON1 and LAT1 <= y <= LAT0 for x, y in ln):
                segs.append([[round(x, 3), round(y, 3)] for x, y in dp_simplify(ln, 0.01)])
        if not segs:
            continue
        pts = [p for s in segs for p in s]
        inside = sum(1 for x, y in pts if (k := idx(*hex_at(x, y))) >= 0 and land[k])
        if inside / len(pts) < 0.5:  # mostly Malaysia / PNG
            continue
        rivers.append({"name": nm, "lines": segs, "src": "Natural Earth"})
    river_of = {}
    for rv in rivers:
        for s in rv["lines"]:
            for (x0, y0), (x1, y1) in zip(s, s[1:]):
                steps = max(1, int(math.hypot(x1 - x0, y1 - y0) / 0.04))
                for t in range(steps + 1):
                    k = idx(*hex_at(x0 + (x1 - x0) * t / steps, y0 + (y1 - y0) * t / steps))
                    if k >= 0 and land[k]:
                        river_of.setdefault(k, rv["name"])

    # ---- NASA GIBS rasters summarised per hex (land + near-shore hexes)
    want = {i for i in range(N) if land[i] or (dist[i] is not None and dist[i] <= 2)}
    centers = [center(*cr(i)) for i in range(N)]
    print("sampling rasters...")
    rs = rasters.sample(RAW, centers, W / math.sqrt(3), want)
    lcf = [rasters.landcover_fractions(rs["lc"][i]) if land[i] else None for i in range(N)]

    # ---- base terrain from elevation; features from MODIS land cover
    terr = [T["ocean"]] * N
    feat = [F[""]] * N
    for i in range(N):
        if not land[i]:
            terr[i] = T["coast"] if dist[i] is not None and dist[i] <= 2 else T["ocean"]
            continue
        if i in lake_of:
            terr[i] = T["lake"]
            continue
        e = elev[i] if elev[i] is not None else 0
        region = ISLAND.get(prov_of[i], "?")
        fr = lcf[i] or {"forest": 0.6, "savanna": 0, "wetland": 0, "cropland": 0, "mosaic": 0, "urban": 0}
        farm = fr["cropland"] + fr["mosaic"]
        mangrove = rs["mangrove"][i] or 0
        dry = fr["savanna"] > max(fr["forest"], farm) and fr["savanna"] >= 0.3
        forest_feat = F["woods"] if (dry or region in DRY) else F["rainforest"]
        if e >= 4200:
            terr[i] = T["snow_mountain"]
        elif e >= 1500:
            terr[i] = T["mountain"]
        elif e >= 250:
            terr[i] = T["hills_plains"] if dry else T["hills_grassland"]
            feat[i] = forest_feat if fr["forest"] >= 0.45 else F[""]
        else:
            if fr["wetland"] >= 0.3 or mangrove >= 0.25 or (e <= 10 and prov_of[i] in PEAT_PROVINCES and fr["forest"] >= 0.4):
                terr[i] = T["plains"]
                feat[i] = F["marsh"]
            elif fr["forest"] >= 0.45:
                terr[i] = T["plains"]
                feat[i] = forest_feat
            elif farm + fr["urban"] >= 0.4:
                terr[i] = T["grassland"]
                feat[i] = F["floodplains"] if i in river_of and e < 60 else F[""]
            elif dry:
                terr[i] = T["plains"]
            else:
                terr[i] = T["grassland"] if farm >= 0.25 else T["plains"]
                feat[i] = forest_feat if fr["forest"] >= 0.3 else F[""]

    # ---- reefs (Coral Triangle hot spots), geothermal fields
    reef_of = {}
    for rf in cur["reefs"]:
        c = idx(*hex_at(rf["lon"], rf["lat"]))
        for j in ring_within(c, rf.get("radius", 1)):
            if not land[j] and terr[j] == T["coast"]:
                feat[j] = F["reef"]
                reef_of[j] = rf["name"]
    for g in cur["geothermal"]:
        j = idx(*hex_at(g["lon"], g["lat"]))
        if j >= 0 and land[j] and terr[j] not in (T["lake"],):
            feat[j] = F["geothermal"]

    # ---- volcanoes (Wikidata)
    volcanoes = []
    seen_v = {}
    for b in wd_rows("wd_volcanoes.json"):
        pt = wd_point(v(b, "coord"))
        if not pt:
            continue
        nm = v(b, "itemLabel")
        if re.fullmatch(r"Q\d+", nm or "") or "mud" in nm.lower():
            continue  # unnamed items and mud volcanoes (Bledug Kuwu, Lusi) aren't mountains
        e = v(b, "elev")
        e = round(float(e)) if e else None
        if e is not None and e < 150 and "krakatau" not in nm.lower():
            continue  # submarine / low vents
        j = idx(*hex_at(*pt))
        if j < 0:
            continue
        if not land[j]:
            # tiny volcanic islands (Anak Krakatau, Banda Api...) that the simplified coastline drops
            if e is None or e <= 0 or dist[j] is None or dist[j] > 2:
                continue
            land[j] = True
            prov_of[j] = owner[j]
            elev[j] = e
            land_idx.append(j)
        if j in seen_v:
            if e and (seen_v[j]["elev"] or 0) < e:
                seen_v[j].update(name=nm, elev=e, lon=pt[0], lat=pt[1])
            continue
        rec = {"name": nm, "elev": e, "lon": pt[0], "lat": pt[1], "hex": j, "qid": v(b, "item").rsplit("/", 1)[-1]}
        seen_v[j] = rec
        volcanoes.append(rec)
    for rec in volcanoes:
        j = rec["hex"]
        if terr[j] == T["lake"]:
            continue
        terr[j] = T["snow_mountain"] if (rec["elev"] or 0) >= 4200 else T["mountain"]
        feat[j] = F["volcano"]
        if rec["elev"]:
            elev[j] = max(elev[j] or 0, rec["elev"])

    # ---- provinces (Wikidata stats)
    wd_prov = {}
    for b in wd_rows("wd_provinces.json"):
        nm = v(b, "itemLabel")
        nm = WD_PROVINCE_ALIASES.get(nm, nm)
        rec = wd_prov.setdefault(nm, {"qid": v(b, "item").rsplit("/", 1)[-1], "pops": {}, "cap": None})
        if v(b, "pop_item"):
            rec["pops"][v(b, "popdate_item") or "0"] = float(v(b, "pop_item"))
        if v(b, "area"):
            rec["area"] = float(v(b, "area"))
        if v(b, "cap") and v(b, "capCoord"):
            caps = rec.setdefault("caps", {})
            qid = v(b, "cap").rsplit("/", 1)[-1]
            cap = caps.setdefault(qid, {"qid": qid, "name": v(b, "capLabel"), "pt": wd_point(v(b, "capCoord")), "pops": {}})
            if v(b, "pop_cap"):
                cap["pops"][v(b, "popdate_cap") or "0"] = float(v(b, "pop_cap"))
    # Wikidata keeps former/planned capitals as extra P36 values; pick the current seat.
    for pnm, rec in wd_prov.items():
        caps = list(rec.pop("caps", {}).values())
        want = CURRENT_CAPITAL.get(pnm)
        pick = next((c for c in caps if c["name"] == want), caps[0] if caps else None)
        if pick and pnm in CAPITAL_FIX:
            fix = CAPITAL_FIX[pnm]
            pick = {**pick, "name": fix["name"], "pt": (fix["lon"], fix["lat"]), "pops": {}}
        rec["cap"] = pick

    def latest(pops):
        if not pops:
            return None, None
        k = max(pops)
        return int(pops[k]), (k[:4] if k != "0" else None)

    prov_names = sorted({p for p in prov_of if p})
    missing = [p for p in prov_names if p not in wd_prov]
    if missing:
        print("WARNING: no Wikidata match for provinces:", missing)
    prov_index = {p: k for k, p in enumerate(prov_names)}

    # ---- cities: Wikidata kota + province capitals
    cand = {}
    for b in wd_rows("wd_cities.json"):
        q = v(b, "item").rsplit("/", 1)[-1]
        pt = wd_point(v(b, "coord"))
        c = cand.setdefault(q, {"qid": q, "name": v(b, "itemLabel"), "pt": pt, "pops": {}})
        if v(b, "pop_item"):
            c["pops"][v(b, "popdate_item") or "0"] = float(v(b, "pop_item"))
    capital_of = {}
    for pnm, rec in wd_prov.items():
        cap = rec.get("cap")
        if not cap or not cap["pt"]:
            continue
        c = cand.setdefault(cap["qid"], {"qid": cap["qid"], "name": cap["name"], "pt": cap["pt"], "pops": {}})
        for k2, val in cap["pops"].items():
            c["pops"].setdefault(k2, val)
        capital_of[cap["qid"]] = pnm
    # Jakarta is a province on Wikidata, not a kota: add it from the province record (at Monas)
    if not any(c["name"] == "Jakarta" for c in cand.values()):
        jk = wd_prov.get("Jakarta Special Capital Region", {})
        cand["jakarta"] = {"qid": jk.get("qid"), "name": "Jakarta", "pt": (106.8272, -6.1754),
                           "pops": dict(jk.get("pops", {}))}
        capital_of.pop((jk.get("cap") or {}).get("qid"), None)
        capital_of[jk.get("qid")] = "Jakarta Special Capital Region"
        cand["jakarta"]["qid"] = jk.get("qid")
        cand[jk.get("qid")] = cand.pop("jakarta")
    for c in cand.values():
        c["name"] = re.sub(r"^(Kota|City of) ", "", c["name"]).replace(" City", "")
        c["pop"], c["popYear"] = latest(c["pops"])
        c["capital"] = "national" if c["name"] == "Jakarta" else ("provincial" if c["qid"] in capital_of else None)
        if c["name"] in ("Central Jakarta", "Jakarta Pusat"):
            c["capital"] = "national"
    order = sorted(cand.values(), key=lambda c: (c["capital"] != "national", c["capital"] is None, -(c["pop"] or 0)))
    cities = []
    city_hex = {}
    for c in order:
        if not c["pt"]:
            continue
        j = idx(*hex_at(*c["pt"]))
        if j < 0:
            continue
        if not land[j] or j in lake_of:
            near = [k for k in ring_within(j, 2) if land[k] and k not in lake_of]
            if not near:
                continue
            j = min(near, key=lambda k: hex_dist(j, k))
        min_d = 2 if c["capital"] else 3
        clash = next((o for o in cities if hex_dist(o["hex"], j) < min_d), None)
        if clash:
            clash.setdefault("absorbed", []).append({"name": c["name"], "pop": c["pop"]})
            continue
        size = max(1, round((c["pop"] or 20000) ** (1 / 3) / 10))
        rec = {"name": c["name"], "qid": c["qid"], "pop": c["pop"], "popYear": c["popYear"],
               "lon": c["pt"][0], "lat": c["pt"][1], "hex": j, "size": size, "capital": c["capital"],
               "province": prov_of[j]}
        if c["qid"] in capital_of:
            rec["capitalOf"] = capital_of[c["qid"]]
        cities.append(rec)
        city_hex[j] = rec
    # city centre tiles are cleared (surrounding farmland/urban comes from MODIS land cover)
    for c in cities:
        j = c["hex"]
        if terr[j] in (T["mountain"], T["snow_mountain"]):
            terr[j] = T["hills_grassland"]
        if feat[j] in (F["rainforest"], F["woods"], F["marsh"], F["volcano"]):
            feat[j] = F[""]

    # ---- national parks (Wikidata) as Civ-style park overlays
    parks = []
    park_of = {}
    for b in wd_rows("wd_national_parks.json"):
        pt = wd_point(v(b, "coord"))
        nm = v(b, "itemLabel")
        if not pt or re.fullmatch(r"Q\d+", nm or ""):
            continue
        if any(p["name"] == nm for p in parks):
            continue
        area = float(v(b, "area")) / 1e6 if v(b, "area") else None  # normalised m^2 -> km^2
        area = PARK_AREA_FIX.get(nm, area)
        if area is not None and not (1 <= area <= 30000):
            area = None
        nhex = max(1, (area or 500) / 350)
        radius = 0
        while 3 * radius * (radius + 1) + 1 < nhex and radius < 4:
            radius += 1
        j = idx(*hex_at(*pt))
        if j < 0:
            continue
        cells = [k for k in ring_within(j, radius) if land[k] and k not in lake_of and k not in city_hex]
        if not cells and land[j]:
            cells = [j]
        for k in cells:
            park_of.setdefault(k, len(parks))
        parks.append({"name": nm, "lon": pt[0], "lat": pt[1], "areaKm2": round(area) if area else None, "hex": j,
                      "qid": v(b, "item").rsplit("/", 1)[-1]})

    # ---- wonders: UNESCO (Wikidata) + curated landmarks
    wonders = []
    wonder_of = {}
    for b in wd_rows("wd_unesco.json"):
        pt = wd_point(v(b, "coord"))
        nm = v(b, "itemLabel")
        if not pt or re.fullmatch(r"Q\d+", nm or ""):
            continue
        j = idx(*hex_at(*pt))
        if j < 0 or j in wonder_of or any(w["name"] == nm for w in wonders):
            continue  # multi-component sites (e.g. Lorentz) appear once
        if not land[j]:
            near = [k for k in ring_within(j, 2) if land[k]]
            if not near:
                continue
            j = near[0]
        natural = any(w in nm.lower() for w in ("national park", "rainforest", "forest", "lorentz", "komodo", "ujung kulon"))
        wonder_of[j] = len(wonders)
        wonders.append({"name": nm, "short": "Subak System of Bali" if "Subak" in nm else nm.split(":")[0],
                        "lon": pt[0], "lat": pt[1], "hex": j, "kind": "natural" if natural else "cultural",
                        "unesco": True, "qid": v(b, "item").rsplit("/", 1)[-1]})
    for w in cur["extraWonders"]:
        j = idx(*hex_at(w["lon"], w["lat"]))
        if j < 0:
            continue
        if j in wonder_of:
            wonders[wonder_of[j]].setdefault("alsoHere", []).append(w["name"])
            continue
        wonder_of[j] = len(wonders)
        wonders.append({"name": w["name"], "lon": w["lon"], "lat": w["lat"], "hex": j, "kind": w["kind"],
                        "desc": w["desc"], "unesco": False})

    # ---- resources: curated sites, then regional production
    res_of = {}
    for r in cur["resources"]:
        j = idx(*hex_at(r["lon"], r["lat"]))
        if j < 0:
            continue
        if j in res_of or (j in city_hex and r["r"] not in ("fish",)):
            # nudge to a free neighbour of the same kind (land vs water)
            want_land = land[j]
            alt = [k for k in ring_within(j, 1) if k not in res_of and land[k] == want_land and k not in city_hex]
            if not alt:
                continue
            j = alt[0]
        res_of[j] = {"r": r["r"], "site": r["site"]}
    for rg in cur["regional"]:
        provs = set(rg["provinces"])
        for i in range(N):
            if i in res_of or i in city_hex or owner[i] not in provs:
                continue
            if rg.get("water"):
                if land[i] or terr[i] != T["coast"]:
                    continue
            else:
                if not land[i] or i in lake_of or (elev[i] or 0) > rg.get("maxElev", 9999):
                    continue
                if feat[i] in (F["marsh"], F["volcano"], F["geothermal"]) or terr[i] in (T["mountain"], T["snow_mountain"]):
                    continue
                fr = lcf[i]
                if rg.get("minFarm") and (not fr or fr["cropland"] + fr["mosaic"] < rg["minFarm"]):
                    continue  # place crops where MODIS actually sees farmland
            if stable_hash(rg["r"], i) % rg["every"]:
                continue
            res_of[i] = {"r": rg["r"], "site": rg["note"], "regional": True}

    # ---- extended layers: population, earthquakes, power, airports, ports, province stats
    st = stats.load_stats(RAW)
    pstats = st["provinces"]

    def hex_km2(i):
        return (math.sqrt(3) / 2) * W * W * 111.32 ** 2 * math.cos(math.radians(center(*cr(i))[1]))

    # GPW 2020 density x hex area, then scaled so each province sums to its mid-2025 population
    pop_raw = [(rs["popdens"][i] or 0) * hex_km2(i) if land[i] else 0.0 for i in range(N)]
    by_prov = defaultdict(float)
    for i in range(N):
        if land[i]:
            by_prov[prov_of[i]] += pop_raw[i]
    scale = {p: (pstats.get(p, {}).get("pop2025") or v) / v if v else 1.0 for p, v in by_prov.items()}
    pop_hex = [int(round(pop_raw[i] * scale.get(prov_of[i], 1.0))) if land[i] else 0 for i in range(N)]

    # USGS earthquakes M5+ since 1900: per-hex counts (epicentre hex + neighbours, ~35 km)
    quakes = json.loads((RAW / "usgs_quakes_m5.geojson").read_text())
    q_count = [0] * N
    q_prov = defaultdict(int)
    q_decade = defaultdict(int)
    for q in quakes:
        j = idx(*hex_at(q["lon"], q["lat"]))
        q_decade[time.gmtime(q["time"] / 1000).tm_year // 10 * 10] += 1
        if j < 0:
            continue
        for k in ring_within(j, 1):
            q_count[k] += 1
        if owner[j]:
            q_prov[owner[j]] += 1
    big_quakes = []
    for q in sorted(quakes, key=lambda q: -q["mag"]):
        if q["mag"] < 7.0:
            break
        j = idx(*hex_at(q["lon"], q["lat"]))
        big_quakes.append({"mag": q["mag"], "place": q["place"], "year": time.gmtime(q["time"] / 1000).tm_year,
                           "date": time.strftime("%Y-%m-%d", time.gmtime(q["time"] / 1000)),
                           "depth": q["depth"], "lon": q["lon"], "lat": q["lat"], "hex": j,
                           "province": owner[j] if j >= 0 else None, "id": q["id"]})

    # WRI Global Power Plant Database (v1.3, 2021): Indonesia's large plants
    plants = []
    for r in json.loads((RAW / "wri_power_plants.json").read_text()):
        lon, lat = float(r["longitude"]), float(r["latitude"])
        j = idx(*hex_at(lon, lat))
        yr = r.get("commissioning_year")
        plants.append({"name": r["name"], "fuel": r["primary_fuel"], "mw": round(float(r["capacity_mw"]), 1),
                       "year": int(float(yr)) if yr else None, "owner": r.get("owner") or None,
                       "lon": lon, "lat": lat, "hex": j, "province": owner[j] if j >= 0 else None,
                       "gwh": round(float(r["estimated_generation_gwh_2017"])) if r.get("estimated_generation_gwh_2017") else None})

    # Airports: OurAirports (location, type) + passenger counts from Wikipedia by IATA code
    pax = stats.airport_passengers(RAW)
    airports = []
    for a in json.loads((RAW / "ourairports.json").read_text()):
        if a["type"] not in ("large_airport", "medium_airport") or not a.get("iata_code"):
            continue
        lon, lat = float(a["longitude_deg"]), float(a["latitude_deg"])
        j = idx(*hex_at(lon, lat))
        pinfo = pax.get(a["iata_code"], {})
        airports.append({"name": a["name"], "iata": a["iata_code"], "type": a["type"].split("_")[0],
                         "city": a.get("municipality") or None, "lon": lon, "lat": lat, "hex": j,
                         "province": owner[j] if j >= 0 else None, "pax": pinfo.get("pax"), "paxYear": pinfo.get("year"),
                         "paxSeries": pinfo.get("series")})
    airports.sort(key=lambda a: -(a["pax"] or 0))
    ports = []
    for pt in cur.get("ports", []):
        j = idx(*hex_at(pt["lon"], pt["lat"]))
        ports.append({**pt, "hex": j, "province": owner[j] if j >= 0 else None})

    # Province aggregates from the hex layers
    agg = defaultdict(lambda: defaultdict(float))
    for i in range(N):
        if not land[i] or i in lake_of:
            continue
        p = prov_of[i]
        a = agg[p]
        a["n"] += 1
        fr = lcf[i]
        if fr:
            for k in ("forest", "cropland", "mosaic", "urban", "wetland", "savanna"):
                a[k] += fr[k]
            a["nlc"] += 1
        a["lights"] += rs["lights"][i] or 0
        a["mangrove"] += rs["mangrove"][i] or 0
        a["flood"] += rs["flood"][i] or 0
        a["landslide"] += rs["landslide"][i] or 0
    for p in prov_names:
        a = agg[p]
        n, nl = a["n"] or 1, a["nlc"] or 1
        ps = pstats.setdefault(p, {})
        ps.update(forestPct=round(100 * a["forest"] / nl, 1), farmPct=round(100 * (a["cropland"] + a["mosaic"]) / nl, 1),
                  urbanPct=round(100 * a["urban"] / nl, 2), wetlandPct=round(100 * a["wetland"] / nl, 1),
                  savannaPct=round(100 * a["savanna"] / nl, 1), mangrovePct=round(100 * a["mangrove"] / n, 1),
                  lights=round(a["lights"] / n, 1), flood=round(a["flood"] / n, 2), landslide=round(a["landslide"] / n, 2),
                  quakes=q_prov.get(p, 0),
                  powerMW=round(sum(x["mw"] for x in plants if x["province"] == p)),
                  airportPax=sum(x["pax"] or 0 for x in airports if x["province"] == p),
                  volcanoes=sum(1 for v in volcanoes if prov_of[v["hex"]] == p),
                  parks=sum(1 for pk in parks if 0 <= pk["hex"] < N and prov_of[pk["hex"]] == p))

    # ---- pack output
    reg_names = sorted({r for r in reg_of if r})
    reg_index = {r: k for k, r in enumerate(reg_names)}
    river_names = [rv["name"] for rv in rivers]
    river_index = {n: k for k, n in enumerate(river_names)}
    lake_names = sorted(set(lake_of.values()))
    reef_names = sorted(set(reef_of.values()))
    res_kinds = sorted({r["r"] for r in res_of.values()})
    res_sites = []
    tile_res = [-1] * N
    for i, r in res_of.items():
        tile_res[i] = len(res_sites)
        res_sites.append({"r": res_kinds.index(r["r"]), "site": r["site"], "regional": r.get("regional", False)})

    prov_out = []
    for p in prov_names:
        rec = wd_prov.get(p, {})
        pop, year = latest(rec.get("pops", {}))
        cap = next((c for c in cities if c.get("capitalOf") == p), None)
        ps = {k: v for k, v in pstats.get(p, {}).items() if k != "gdpSeries"}
        prov_out.append({
            "name": p, "island": ISLAND.get(p, "?"), "color": PROVINCE_COLORS[prov_index[p] % len(PROVINCE_COLORS)],
            "pop": ps.get("pop2025") or pop, "popYear": 2025 if ps.get("pop2025") else year,
            "areaKm2": round(ps.get("areaKm2") or rec.get("area") or 0) or None,
            "capital": cap["name"] if cap else (rec.get("cap") or {}).get("name"), "qid": rec.get("qid"),
            "hexes": sum(1 for x in prov_of if x == p),
            "stats": ps, "gdpSeries": pstats.get(p, {}).get("gdpSeries"),
        })

    tiles = {
        "terrain": terr,
        "feature": feat,
        "elev": [e if e is not None else None for e in elev],
        "prov": [prov_index[owner[i]] if owner[i] in prov_index and (land[i] or (dist[i] or 9) <= 2) else -1 for i in range(N)],
        "land": [1 if l else 0 for l in land],
        "reg": [reg_index[reg_of[i]] if reg_of[i] in reg_index else -1 for i in range(N)],
        "river": [river_index[river_of[i]] if i in river_of else -1 for i in range(N)],
        "lake": [lake_names.index(lake_of[i]) if i in lake_of else -1 for i in range(N)],
        "reef": [reef_names.index(reef_of[i]) if i in reef_of else -1 for i in range(N)],
        "res": tile_res,
        "park": [park_of.get(i, -1) for i in range(N)],
        # measured layers (NASA GIBS rasters summarised per hex)
        "forest": [round(100 * lcf[i]["forest"]) if lcf[i] else -1 for i in range(N)],
        "farm": [round(100 * (lcf[i]["cropland"] + lcf[i]["mosaic"])) if lcf[i] else -1 for i in range(N)],
        "urban": [round(100 * lcf[i]["urban"]) if lcf[i] else -1 for i in range(N)],
        "wetland": [round(100 * lcf[i]["wetland"]) if lcf[i] else -1 for i in range(N)],
        "savanna": [round(100 * lcf[i]["savanna"]) if lcf[i] else -1 for i in range(N)],
        "lcdom": [lcf[i]["dominant"] if lcf[i] else -1 for i in range(N)],
        "mangrove": [round(100 * (rs["mangrove"][i] or 0)) for i in range(N)],
        "lights": [round(rs["lights"][i] or 0) for i in range(N)],
        "pop": pop_hex,
        "popd": [round(pop_hex[i] / hex_km2(i)) if land[i] else 0 for i in range(N)],
        "flood": [round(10 * (rs["flood"][i] or 0)) for i in range(N)],
        "landslide": [round(10 * (rs["landslide"][i] or 0)) for i in range(N)],
        "footprint": [round(rs["footprint"][i] or 0) for i in range(N)],
        "quakes": q_count,
    }
    data = {
        "meta": {
            "cols": COLS, "rows": ROWS, "lon0": LON0, "lat0": LAT0, "w": W, "h": H,
            "built": time.strftime("%Y-%m-%d"),
            "terrains": TERRAINS, "features": FEATURES, "resourceKinds": res_kinds,
            "sources": [
                {"name": "geoBoundaries IDN ADM1 (2017) & ADM2 (2020)", "license": "ODbL", "url": "https://www.geoboundaries.org/"},
                {"name": "Copernicus GLO-90 DEM via Open-Meteo Elevation API", "license": "CC BY 4.0", "url": "https://open-meteo.com/en/docs/elevation-api"},
                {"name": "Wikidata (cities, provinces, volcanoes, UNESCO sites, national parks)", "license": "CC0", "url": "https://www.wikidata.org/"},
                {"name": "OpenStreetMap river relations", "license": "ODbL", "url": "https://www.openstreetmap.org/"},
                {"name": "Natural Earth 1:10m rivers & lakes", "license": "Public domain", "url": "https://www.naturalearthdata.com/"},
                {"name": "Curated resource sites (data/curated/resources.json)", "license": "-", "url": ""},
                {"name": "MODIS MCD12Q1 land cover (IGBP), 2024 · NASA GIBS", "license": "NASA open data", "url": "https://gibs.earthdata.nasa.gov/"},
                {"name": "GPW v4 population density 2020 · SEDAC via NASA GIBS", "license": "CC BY 4.0", "url": "https://sedac.ciesin.columbia.edu/data/collection/gpw-v4"},
                {"name": "VIIRS Black Marble night lights · NASA GIBS", "license": "NASA open data", "url": "https://blackmarble.gsfc.nasa.gov/"},
                {"name": "Natural Disaster Hotspots: flood & landslide · SEDAC via NASA GIBS", "license": "CC BY 3.0", "url": "https://sedac.ciesin.columbia.edu/data/collection/ndh"},
                {"name": "Mangrove forests 2000 & Human Footprint · SEDAC via NASA GIBS", "license": "CC BY", "url": "https://sedac.ciesin.columbia.edu/"},
                {"name": "USGS earthquake catalogue (M5+, 1900–present)", "license": "Public domain", "url": "https://earthquake.usgs.gov/fdsnws/event/1/"},
                {"name": "WRI Global Power Plant Database v1.3", "license": "CC BY 4.0", "url": "https://datasets.wri.org/dataset/globalpowerplantdatabase"},
                {"name": "OurAirports", "license": "Public domain", "url": "https://ourairports.com/data/"},
            ] + [{"name": f"Wikipedia: {v['title']}", "license": "CC BY-SA 4.0", "url": v["url"]} for v in st["sources"].values()],
            "statSources": st["sources"],
        },
        "tiles": tiles,
        "provinces": prov_out,
        "regencies": reg_names,
        "rivers": rivers,
        "lakes": lake_names,
        "reefs": reef_names,
        "cities": cities,
        "volcanoes": volcanoes,
        "parks": parks,
        "wonders": wonders,
        "resources": res_sites,
        "national": {**st["national"], "forestPct": round(100 * sum(lcf[i]["forest"] for i in range(N) if lcf[i]) / max(1, sum(1 for i in range(N) if lcf[i])), 1),
                     "powerMW": round(sum(p["mw"] for p in plants)), "quakesM5": len(quakes),
                     "quakesByDecade": dict(sorted(q_decade.items()))},
        "quakes": big_quakes,
        "plants": plants,
        "airports": airports,
        "ports": ports,
        "igbp": rasters.IGBP,
    }
    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text(json.dumps(data, separators=(",", ":"), ensure_ascii=False))
    n_land = sum(tiles["land"])
    print(f"land hexes {n_land}, provinces {len(prov_out)}, regencies {len(reg_names)}, cities {len(cities)}, "
          f"volcanoes {len(volcanoes)}, wonders {len(wonders)}, parks {len(parks)}, resources {len(res_sites)}, "
          f"rivers {len(rivers)}")
    from collections import Counter
    print("terrain:", {TERRAINS[k]: n for k, n in Counter(terr[i] for i in range(N) if land[i]).items()})
    print("feature:", {FEATURES[k] or "none": n for k, n in Counter(feat[i] for i in range(N) if land[i]).items()})
    print(f"wrote {OUT} ({OUT.stat().st_size // 1024} KB)")


if __name__ == "__main__":
    main()
