#!/usr/bin/env python3
"""Download the datasets behind the lenses and advisor dashboards.

  * NASA GIBS WMS rasters (land cover, population density, night lights,
    hazards, mangroves, human footprint) as 0.01-degree PNG tiles
  * USGS earthquake catalogue (M5+ since 1900)
  * WRI Global Power Plant Database (Indonesia rows)
  * OurAirports (Indonesia rows)
  * Wikipedia statistics tables (province GDP, HDI, poverty, airports...)
  * Wikipedia province infoboxes (religion shares)

Everything lands in data/raw/ and is skipped on re-runs unless --refresh.
"""
import csv
import io
import json
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
RAW = ROOT / "data" / "raw"
UA = "id-civilization-hexmap/0.1 (open-data map build)"

# Raster window: 0.01 degree per pixel, 10x10 degree tiles of 1000x1000 px
LON0, LAT0 = 94.8, 6.4
TILE_DEG, TILE_PX = 10, 1000
TILES_X, TILES_Y = 5, 2  # 94.8..144.8, 6.4..-13.6

GIBS = "https://gibs.earthdata.nasa.gov/wms/epsg4326/best/wms.cgi"
RASTERS = {
    "landcover": ("MODIS_Combined_L3_IGBP_Land_Cover_Type_Annual", "2024-01-01"),
    "popdens": ("GPW_Population_Density_2020", None),
    "lights": ("VIIRS_Black_Marble", None),
    "flood": ("NDH_Flood_Hazard_Frequency_Distribution_1985-2003", None),
    "landslide": ("NDH_Landslide_Hazard_Distribution_2000", None),
    "mangrove": ("Mangrove_Forest_Distribution_2000", None),
    "footprint": ("Human_Footprint_1995-2004", None),
}
COLORMAPS = {
    "landcover": "MODIS_IGBP_Land_Cover_Type",
    "popdens": "GPW_Population_Density_2020",
    "flood": "NDH_Flood_Hazard_Frequency_Distribution_1985-2003",
    "landslide": "NDH_Landslide_Hazard_Distribution_2000",
    "mangrove": "Mangrove_Forest_Distribution_2000",
    "footprint": "Human_Footprint_1995-2004",
}

WIKI_PAGES = {
    "gdp": "List of Indonesian provinces by GDP",
    "gdp_pc": "List of Indonesian provinces by GDP per capita",
    "hdi": "List of Indonesian provinces by Human Development Index",
    "poverty": "List of Indonesian provinces by poverty rate",
    "provinces": "Provinces of Indonesia",
    "airports": "List of the busiest airports in Indonesia",
    "ports": "List of ports in Indonesia",
}

PROVINCE_ARTICLES = [
    "Aceh", "North Sumatra", "West Sumatra", "Riau", "Jambi", "South Sumatra", "Bengkulu", "Lampung",
    "Bangka Belitung Islands", "Riau Islands", "Jakarta", "West Java", "Central Java",
    "Special Region of Yogyakarta", "East Java", "Banten", "Bali", "West Nusa Tenggara", "East Nusa Tenggara",
    "West Kalimantan", "Central Kalimantan", "South Kalimantan", "East Kalimantan", "North Kalimantan",
    "North Sulawesi", "Central Sulawesi", "South Sulawesi", "Southeast Sulawesi", "Gorontalo (province)",
    "West Sulawesi", "Maluku (province)", "North Maluku", "West Papua (province)", "Southwest Papua",
    "Papua (province)", "Central Papua", "Highland Papua", "South Papua",
]


def get(url: str, tries: int = 5, data: bytes | None = None) -> bytes:
    req = urllib.request.Request(url, data=data, headers={"User-Agent": UA})
    for attempt in range(tries):
        try:
            with urllib.request.urlopen(req, timeout=180) as r:
                return r.read()
        except (urllib.error.HTTPError, urllib.error.URLError, TimeoutError) as e:
            code = getattr(e, "code", None)
            if (code is not None and code not in (429, 500, 502, 503, 504)) or attempt == tries - 1:
                raise
            wait = 15 * (attempt + 1)
            print(f"      {e}; retrying in {wait}s", flush=True)
            time.sleep(wait)
    raise RuntimeError("unreachable")


def want(path: Path, refresh: bool) -> bool:
    if path.exists() and not refresh:
        print(f"skip  {path.relative_to(RAW)}")
        return False
    path.parent.mkdir(parents=True, exist_ok=True)
    return True


def fetch_rasters(refresh):
    for key, (layer, tm) in RASTERS.items():
        for ty in range(TILES_Y):
            for tx in range(TILES_X):
                out = RAW / "gibs" / key / f"{tx}_{ty}.png"
                if not want(out, refresh):
                    continue
                w = LON0 + tx * TILE_DEG
                n = LAT0 - ty * TILE_DEG
                q = {
                    "SERVICE": "WMS", "VERSION": "1.1.1", "REQUEST": "GetMap", "LAYERS": layer, "STYLES": "",
                    "SRS": "EPSG:4326", "BBOX": f"{w},{n - TILE_DEG},{w + TILE_DEG},{n}",
                    "WIDTH": TILE_PX, "HEIGHT": TILE_PX, "FORMAT": "image/png", "TRANSPARENT": "TRUE",
                }
                if tm:
                    q["TIME"] = tm
                print(f"fetch gibs/{key}/{tx}_{ty}.png", flush=True)
                body = get(GIBS + "?" + urllib.parse.urlencode(q))
                if not body.startswith(b"\x89PNG"):
                    raise SystemExit(f"GIBS returned non-PNG for {key}: {body[:200]!r}")
                out.write_bytes(body)
        if key in COLORMAPS:
            out = RAW / "gibs" / key / "colormap.xml"
            if want(out, refresh):
                out.write_bytes(get(f"https://gibs.earthdata.nasa.gov/colormaps/v1.3/{COLORMAPS[key]}.xml"))


def fetch_quakes(refresh):
    out = RAW / "usgs_quakes_m5.geojson"
    if not want(out, refresh):
        return
    print("fetch usgs_quakes_m5.geojson", flush=True)
    feats = []
    # the API caps one request at 20k events; split by period to stay well under it
    for start, end in [("1900-01-01", "1990-01-01"), ("1990-01-01", "2010-01-01"), ("2010-01-01", "2030-01-01")]:
        q = urllib.parse.urlencode({
            "format": "geojson", "minmagnitude": 5, "starttime": start, "endtime": end,
            "minlatitude": -11.5, "maxlatitude": 6.5, "minlongitude": 94.5, "maxlongitude": 141.5,
        })
        d = json.loads(get("https://earthquake.usgs.gov/fdsnws/event/1/query?" + q))
        for f in d["features"]:
            p = f["properties"]
            lon, lat, depth = f["geometry"]["coordinates"]
            feats.append({"id": f["id"], "mag": p["mag"], "place": p["place"], "time": p["time"],
                          "lon": lon, "lat": lat, "depth": depth, "tsunami": p.get("tsunami", 0)})
        print(f"      {start[:4]}-{end[:4]}: {len(d['features'])} events", flush=True)
    out.write_text(json.dumps(feats))


def fetch_csv_filtered(name, url, col, value, refresh):
    out = RAW / name
    if not want(out, refresh):
        return
    print(f"fetch {name}", flush=True)
    text = get(url).decode("utf-8")
    rows = [r for r in csv.DictReader(io.StringIO(text)) if r.get(col) == value]
    out.write_text(json.dumps(rows))
    print(f"      {len(rows)} rows", flush=True)


def wiki(page, lang="en", prop="text", section=None):
    q = {"action": "parse", "page": page, "prop": prop, "format": "json", "formatversion": 2, "redirects": 1}
    if section is not None:
        q["section"] = section
    return json.loads(get(f"https://{lang}.wikipedia.org/w/api.php?" + urllib.parse.urlencode(q)))["parse"]


def fetch_wiki(refresh):
    for key, page in WIKI_PAGES.items():
        out = RAW / "wiki" / f"{key}.json"
        if not want(out, refresh):
            continue
        print(f"fetch wiki/{key}.json ({page})", flush=True)
        p = wiki(page)
        out.write_text(json.dumps({"title": p["title"], "revid": p.get("revid"), "html": p["text"]}))
        time.sleep(1)
    out = RAW / "wiki" / "province_infoboxes.json"
    if want(out, refresh):
        boxes = {}
        for art in PROVINCE_ARTICLES:
            print(f"fetch infobox {art}", flush=True)
            p = wiki(art, prop="wikitext", section=0)
            boxes[art] = {"title": p["title"], "revid": p.get("revid"), "wikitext": p["wikitext"]}
            time.sleep(0.5)
        out.write_text(json.dumps(boxes))


def main():
    refresh = "--refresh" in sys.argv
    fetch_rasters(refresh)
    fetch_quakes(refresh)
    fetch_csv_filtered("wri_power_plants.json",
                       "https://raw.githubusercontent.com/wri/global-power-plant-database/master/output_database/global_power_plant_database.csv",
                       "country", "IDN", refresh)
    fetch_csv_filtered("ourairports.json", "https://davidmegginson.github.io/ourairports-data/airports.csv",
                       "iso_country", "ID", refresh)
    fetch_wiki(refresh)
    print("done")


if __name__ == "__main__":
    main()
