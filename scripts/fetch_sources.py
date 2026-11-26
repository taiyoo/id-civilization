#!/usr/bin/env python3
"""Download the raw open datasets used to build the Indonesia hex map.

Everything lands in data/raw/. Re-running skips files that already exist
unless --refresh is passed. Elevation is fetched later by build_map.py,
because it needs the hex grid first.
"""
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

GB = "https://www.geoboundaries.org/data/snapshots/1c423398df24ddf6e730b116567d2181c9782778d0459c3f3b76ca2f9f12b6bc/gbOpen/IDN"
NE = "https://raw.githubusercontent.com/nvkelso/natural-earth-vector/master/geojson"

FILES = {
    # geoBoundaries (OSM-derived, ODbL): 34 provinces (2017) + 519 regencies (2020)
    "adm1.geojson": f"{GB}/ADM1/geoBoundaries-IDN-ADM1_simplified.geojson",
    "adm2.geojson": f"{GB}/ADM2/geoBoundaries-IDN-ADM2_simplified.geojson",
    # Natural Earth 1:10m (public domain)
    "ne_rivers.geojson": f"{NE}/ne_10m_rivers_lake_centerlines.geojson",
    "ne_lakes.geojson": f"{NE}/ne_10m_lakes.geojson",
    "ne_reefs.geojson": f"{NE}/ne_10m_reefs.geojson",
}

# Wikidata SPARQL (CC0). Population picks the most recent dated statement.
LATEST_POP = """
  OPTIONAL {{
    ?{v} p:P1082 ?ps_{v} . ?ps_{v} ps:P1082 ?pop_{v} .
    OPTIONAL {{ ?ps_{v} pq:P585 ?popdate_{v} . }}
  }}
"""

QUERIES = {
    "wd_cities.json": """
SELECT ?item ?itemLabel ?coord ?pop_item ?popdate_item WHERE {
  ?item wdt:P31 wd:Q3199141 ; wdt:P625 ?coord .
""" + LATEST_POP.format(v="item") + """
  SERVICE wikibase:label { bd:serviceParam wikibase:language "en,id". }
}""",
    "wd_provinces.json": """
SELECT ?item ?itemLabel ?area ?pop_item ?popdate_item ?cap ?capLabel ?capCoord ?pop_cap ?popdate_cap WHERE {
  ?item wdt:P31 wd:Q5098 .
  FILTER NOT EXISTS { ?item wdt:P576 ?dissolved . }
  OPTIONAL { ?item wdt:P2046 ?area . }
  OPTIONAL {
    ?item wdt:P36 ?cap . ?cap wdt:P625 ?capCoord .
""" + LATEST_POP.format(v="cap") + """
  }
""" + LATEST_POP.format(v="item") + """
  SERVICE wikibase:label { bd:serviceParam wikibase:language "en,id". }
}""",
    "wd_volcanoes.json": """
SELECT DISTINCT ?item ?itemLabel ?coord ?elev WHERE {
  ?item wdt:P31/wdt:P279* wd:Q8072 ; wdt:P17 wd:Q252 ; wdt:P625 ?coord .
  OPTIONAL { ?item wdt:P2044 ?elev . }
  SERVICE wikibase:label { bd:serviceParam wikibase:language "en,id". }
}""",
    "wd_unesco.json": """
SELECT DISTINCT ?item ?itemLabel ?coord ?inception WHERE {
  ?item wdt:P1435 wd:Q9259 ; wdt:P17 wd:Q252 ; wdt:P625 ?coord .
  OPTIONAL { ?item wdt:P571 ?inception . }
  SERVICE wikibase:label { bd:serviceParam wikibase:language "en,id". }
}""",
    # Seat (capital town) of every regency, e.g. Timika for Mimika, Labuan Bajo for West Manggarai
    "wd_towns.json": """
SELECT ?reg ?regLabel ?item ?itemLabel ?coord ?pop_item ?popdate_item WHERE {
  ?reg wdt:P31 wd:Q3191695 ; wdt:P36 ?item .
  ?item wdt:P625 ?coord .
""" + LATEST_POP.format(v="item") + """
  SERVICE wikibase:label { bd:serviceParam wikibase:language "en,id". }
}""",
    # Alternative names (e.g. "Solo" for Surakarta) for cities, provincial capitals and regency seats
    "wd_place_aliases.json": """
SELECT ?item (GROUP_CONCAT(DISTINCT ?alt; separator="|") AS ?alts) WHERE {
  { ?item wdt:P31 wd:Q3199141 . }
  UNION { ?reg wdt:P31 wd:Q3191695 ; wdt:P36 ?item . }
  UNION { ?prov wdt:P31 wd:Q5098 ; wdt:P36 ?item . }
  ?item skos:altLabel ?alt .
  FILTER(LANG(?alt) IN ("en", "id"))
} GROUP BY ?item""",
    "wd_national_parks.json": """
SELECT DISTINCT ?item ?itemLabel ?coord ?area WHERE {
  ?item wdt:P31/wdt:P279* wd:Q46169 ; wdt:P17 wd:Q252 ; wdt:P625 ?coord .
  # unit-normalised area (m^2): raw values mix hectares and km^2
  OPTIONAL { ?item p:P2046/psn:P2046/wikibase:quantityAmount ?area . }
  SERVICE wikibase:label { bd:serviceParam wikibase:language "en,id". }
}""",
}

# OpenStreetMap (ODbL) river relations that Natural Earth 1:10m lacks or draws coarsely.
OSM_RIVERS = {
    "Asahan": 14630296, "Batang Hari": 2190742, "Bengawan Solo": 305535, "Mahakam": 7910696,
    "Mamberamo": 7908582, "Seruyan": 12604253, "Barito": 611307, "Brantas": 313474,
    "Digul": 659650, "Kahayan": 12413298, "Kampar": 10353290, "Kapuas (West Kalimantan)": 317445,
    "Kapuas (Central Kalimantan)": 16780547, "Katingan": 317405, "Kayan": 11180429,
    "Komering": 17746515, "Musi": 302110, "Rokan": 1166309, "Siak": 6880755,
    "Cimanuk": 2913758, "Ogan": 13605708, "Eilanden (Pulau)": 8435545,
}


def get(url: str, tries: int = 6, data: bytes | None = None) -> bytes:
    req = urllib.request.Request(url, data=data, headers={"User-Agent": UA, "Accept": "application/sparql-results+json, */*"})
    for attempt in range(tries):
        try:
            with urllib.request.urlopen(req, timeout=180) as r:
                return r.read()
        except urllib.error.HTTPError as e:
            if e.code not in (429, 500, 502, 503, 504) or attempt == tries - 1:
                raise
            wait = max(70, int(e.headers.get("Retry-After") or 0))
            print(f"      HTTP {e.code}, waiting {wait}s", flush=True)
            time.sleep(wait)
    raise RuntimeError("unreachable")


def main() -> None:
    refresh = "--refresh" in sys.argv
    RAW.mkdir(parents=True, exist_ok=True)
    for name, url in FILES.items():
        out = RAW / name
        if out.exists() and not refresh:
            print(f"skip  {name}")
            continue
        print(f"fetch {name}")
        out.write_bytes(get(url))
    out = RAW / "osm_rivers.json"
    if not out.exists() or refresh:
        print("query osm_rivers.json (Overpass)")
        ids = ",".join(str(i) for i in OSM_RIVERS.values())
        q = f"[out:json][timeout:170];relation(id:{ids});out geom;"
        out.write_bytes(get("https://overpass-api.de/api/interpreter",
                            data=urllib.parse.urlencode({"data": q}).encode()))
    else:
        print("skip  osm_rivers.json")
    for name, q in QUERIES.items():
        out = RAW / name
        if out.exists() and not refresh:
            print(f"skip  {name}")
            continue
        print(f"query {name} (pausing 70s first: Wikidata may limit to 1 query/minute)", flush=True)
        time.sleep(70)
        body = urllib.parse.urlencode({"query": q, "format": "json"}).encode()
        data = json.loads(get("https://query.wikidata.org/sparql", data=body))
        out.write_text(json.dumps(data))
        print(f"      {len(data['results']['bindings'])} rows", flush=True)


if __name__ == "__main__":
    main()
