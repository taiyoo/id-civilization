"""Parse province statistics from the downloaded Wikipedia pages.

Every figure keeps its source page and revision so the viewer can cite it.
"""
import json
import re
from html.parser import HTMLParser
from pathlib import Path

# Map names used on Wikipedia to the province names used on the map
ALIASES = {
    "jakarta": "Jakarta Special Capital Region",
    "special capital region of jakarta": "Jakarta Special Capital Region",
    "dki jakarta": "Jakarta Special Capital Region",
    "yogyakarta": "Special Region of Yogyakarta",
    "special region of yogyakarta": "Special Region of Yogyakarta",
    "bangka belitung islands": "Bangka-Belitung Islands",
    "bangka belitung": "Bangka-Belitung Islands",
    "bangka-belitung islands": "Bangka-Belitung Islands",
    "papua highlands": "Highland Papua",
    "mountain papua": "Highland Papua",
}
PROVINCES = [
    "Aceh", "North Sumatra", "West Sumatra", "Riau", "Jambi", "South Sumatra", "Bengkulu", "Lampung",
    "Bangka-Belitung Islands", "Riau Islands", "Jakarta Special Capital Region", "West Java", "Central Java",
    "Special Region of Yogyakarta", "East Java", "Banten", "Bali", "West Nusa Tenggara", "East Nusa Tenggara",
    "West Kalimantan", "Central Kalimantan", "South Kalimantan", "East Kalimantan", "North Kalimantan",
    "North Sulawesi", "Central Sulawesi", "South Sulawesi", "Southeast Sulawesi", "Gorontalo", "West Sulawesi",
    "Maluku", "North Maluku", "West Papua", "Southwest Papua", "Papua", "Central Papua", "Highland Papua",
    "South Papua",
]
PARENT_2022 = {"South Papua": "Papua", "Central Papua": "Papua", "Highland Papua": "Papua", "Southwest Papua": "West Papua"}
_LOWER = {p.lower(): p for p in PROVINCES}


def canon(name):
    n = re.sub(r"\s+", " ", name.replace(" ", " ")).strip().lower()
    n = re.sub(r"\s*\(province\)$", "", n)
    return ALIASES.get(n) or _LOWER.get(n)


def num(s):
    if s is None:
        return None
    s = s.replace(",", "").replace("%", "").replace("−", "-").strip()
    m = re.fullmatch(r"-?\d+(\.\d+)?", s)
    return float(s) if m else None


class _Tables(HTMLParser):
    def __init__(self):
        super().__init__()
        self.tables, self.depth, self.cell, self.row, self.skip = [], 0, None, None, 0

    def handle_starttag(self, tag, attrs):
        if tag == "table":
            self.depth += 1
            if self.depth == 1:
                self.tables.append([])
        if self.depth != 1:
            return
        if tag == "tr":
            self.row = []
        elif tag in ("td", "th"):
            self.cell = ""
        elif tag in ("sup", "style"):
            self.skip += 1

    def handle_endtag(self, tag):
        if tag in ("sup", "style") and self.skip:
            self.skip -= 1
        if tag == "table":
            self.depth -= 1
        if self.depth != 1:
            return
        if tag in ("td", "th") and self.cell is not None and self.row is not None:
            self.row.append(" ".join(self.cell.split()))
            self.cell = None
        elif tag == "tr" and self.row is not None:
            self.tables[-1].append(self.row)
            self.row = None

    def handle_data(self, data):
        if self.cell is not None and not self.skip:
            self.cell += data


def _page(raw, key):
    d = json.loads((raw / "wiki" / f"{key}.json").read_text())
    p = _Tables()
    p.feed(d["html"])
    src = {"title": d["title"], "revid": d.get("revid"),
           "url": "https://en.wikipedia.org/wiki/" + d["title"].replace(" ", "_")}
    return p.tables, src


def _province_rows(table):
    """Yield (province, row, index_of_name_cell) for rows that name a province."""
    for row in table:
        for k, cell in enumerate(row[:5]):
            p = canon(cell)
            if p:
                yield p, row, k
                break


def _best_table(tables, min_hits=30):
    best = max(tables, key=lambda t: sum(1 for _ in _province_rows(t)))
    return best if sum(1 for _ in _province_rows(best)) >= min_hits else None


def load_stats(raw: Path):
    out = {p: {} for p in PROVINCES}
    sources = {}
    national = {}

    # --- area, population mid-2025, number of cities / regencies
    tables, src = _page(raw, "provinces")
    sources["population"] = src
    for p, row, k in _province_rows(_best_table(tables)):
        tail = row[-5:]
        area, pop, dens = num(tail[0]), num(tail[1]), num(tail[2])
        if pop:
            out[p].update(areaKm2=area, pop2025=int(pop), density=dens,
                          nCities=int(num(tail[3]) or 0), nRegencies=int(num(tail[4]) or 0))

    # --- nominal GRDP by year (billion rupiah)
    tables, src = _page(raw, "gdp")
    sources["gdp"] = src
    for t in tables:
        if t and t[0] and t[0][0] == "Province" and "2025" in t[0]:
            years = [int(y) for y in t[0][1:]]
            for row in t[1:]:
                name = row[0]
                vals = [num(c) for c in row[1:]]
                vals = [v for v in vals if v is not None]
                series = dict(zip(years[-len(vals):], vals)) if vals else {}
                if name == "Indonesia":
                    national["gdpSeries"] = series
                p = canon(name)
                if p and series:
                    out[p]["gdpSeries"] = series
    for t in tables:  # national nominal USD + PPP from the ranking table
        for row in t:
            if row and len(row) >= 6 and row[1] == "Indonesia":
                national["gdpUsdB"] = num(row[4])
                national["gdpPppB"] = num(row[5])

    # --- GRDP per capita
    tables, src = _page(raw, "gdp_pc")
    sources["gdpPerCapita"] = src
    for p, row, k in _province_rows(_best_table(tables)):
        vals = [num(c) for c in row[k + 1:]]
        vals = [v for v in vals if v is not None]
        if len(vals) >= 3:
            out[p].update(gdpPcKRp=vals[-3], gdpPcUsd=vals[-2], gdpPcPpp=vals[-1])

    # --- HDI with components (latest year in the article)
    tables, src = _page(raw, "hdi")
    sources["hdi"] = src
    hdi_year = None
    for t in tables:
        for row in t[:3]:
            for c in row:
                m = re.fullmatch(r"(20\d\d) score", c)
                if m:
                    hdi_year = int(m.group(1))
        if hdi_year:
            for p, row, k in _province_rows(t):
                v = [num(c) for c in row[k + 1:k + 7]]
                if len(v) == 6 and v[0]:
                    out[p].update(hdi=v[0], hdiChange=v[1], lifeExp=v[2], meanSchool=v[3], expSchool=v[4],
                                  spendKRp=v[5])
            break
    national["hdiYear"] = hdi_year

    # --- World Bank poverty rates + Gini (2022, pre-2022 province boundaries)
    tables, src = _page(raw, "poverty")
    sources["poverty"] = src
    for t in tables:
        if t and t[0] and t[0][0] == "Province":
            for row in t[1:]:
                vals = [num(c) for c in row[1:7]]
                rec = dict(pov215=vals[0], pov365=vals[1], pov685=vals[2], incomePpp=vals[3], gini=vals[4],
                           povYear=int(vals[5]) if vals[5] else None)
                if row[0] == "Indonesia":
                    national.update(rec)
                for part in row[0].split("/"):  # "North Kalimantan/ East Kalimantan" is one row
                    p = canon(part)
                    if p:
                        out[p].update(rec)
    for child, parent in PARENT_2022.items():
        if "gini" not in out[child] and "gini" in out[parent]:
            for k in ("pov215", "pov365", "pov685", "incomePpp", "gini", "povYear"):
                out[child][k] = out[parent][k]
            out[child]["povInherited"] = parent

    # --- religion shares from province infoboxes
    boxes = json.loads((raw / "wiki" / "province_infoboxes.json").read_text())
    sources["religion"] = {"title": "Province articles (infobox 'Religion')", "url": "https://en.wikipedia.org/wiki/Religion_in_Indonesia"}
    for art, b in boxes.items():
        p = canon(art) or canon(b["title"])
        if not p:
            continue
        rel, year = parse_religion(b["wikitext"])
        if rel:
            out[p]["religion"] = rel
            out[p]["religionYear"] = year
    for child, parent in PARENT_2022.items():
        if "religion" not in out[child] and "religion" in out[parent]:
            out[child]["religion"] = out[parent]["religion"]
            out[child]["religionYear"] = out[parent].get("religionYear")
            out[child]["religionInherited"] = parent

    # national derived figures
    national["pop2025"] = sum(v.get("pop2025") or 0 for v in out.values())
    gs = national.get("gdpSeries", {})
    if gs:
        y = max(gs)
        national["gdpYear"] = y
        national["gdpBRp"] = gs[y]
        if y - 1 in gs:
            national["gdpGrowth"] = gs[y] / gs[y - 1] - 1
    for p, v in out.items():
        gs = v.get("gdpSeries") or {}
        if gs:
            y = max(gs)
            v["gdpBRp"] = gs[y]
            v["gdpYear"] = y
            if y - 1 in gs:
                v["gdpGrowth"] = gs[y] / gs[y - 1] - 1
    return {"provinces": out, "national": national, "sources": sources}


RELIGION_KEYS = [
    ("islam", "Islam"), ("muslim", "Islam"),
    ("protestant", "Protestant"), ("catholic", "Catholic"), ("christian", "Christian"),
    ("hindu", "Hindu"), ("buddh", "Buddhist"), ("confuci", "Confucian"), ("khong", "Confucian"),
    ("marapu", "Folk"), ("kaharingan", "Folk"), ("folk", "Folk"), ("other", "Other"),
]


def _param_value(wt, start):
    """Text of an infobox parameter value, stopping at the next top-level '|'."""
    depth_t = depth_l = 0
    k = start
    while k < len(wt):
        two = wt[k:k + 2]
        if two == "{{":
            depth_t += 1; k += 2; continue
        if two == "}}":
            if depth_t == 0:
                break
            depth_t -= 1; k += 2; continue
        if two == "[[":
            depth_l += 1; k += 2; continue
        if two == "]]":
            depth_l = max(0, depth_l - 1); k += 2; continue
        if wt[k] == "|" and depth_t == 0 and depth_l == 0:
            break
        k += 1
    return wt[start:k]


def parse_religion(wt):
    m = None
    for t in re.finditer(r"\|\s*demographics(\d)_title(\d)\s*=(.*?)(?=\|\s*demographics|\n\s*\|)", wt, flags=re.S):
        visible = t.group(3).split("<ref")[0]  # citation titles may mention religion too
        if "religion" in visible.lower():
            m = t
            break
    if not m:
        return None, None
    year_m = re.search(r"\((\d{4})\)", m.group(0))
    key = f"demographics{m.group(1)}_info{m.group(2)}"
    i = wt.find(key, m.end())
    if i < 0:
        return None, None
    seg = _param_value(wt, i + len(key))
    seg = re.sub(r"<ref[^>]*/>|<ref[^>]*>.*?</ref>", "", seg, flags=re.S)
    shares = {}
    seg = re.sub(r"(\d),(\d{1,2})\s*%", r"\1.\2%", seg)  # "74,50%" decimal commas
    pairs = re.findall(r"(\d+(?:\.\d+)?)\s*%\s*([^\n*<{|]{0,80}(?:\|[^\]\n]{0,40}\]\])?)", seg)
    # also "[[Christianity]] (85.25%)" -- name first, share in brackets
    pairs += [(pct, name) for name, pct in re.findall(r"\[\[([^\]]{1,60})\]\]\s*\((\d+(?:\.\d+)?)\s*%\)", seg)]
    for pct, rest in pairs:
        label = rest.lower()
        for k, canon_name in RELIGION_KEYS:
            if k in label:
                shares.setdefault(canon_name, float(pct))
                break
    # Use Christian = Protestant + Catholic when only the sub-groups were listed
    if "Christian" not in shares and ("Protestant" in shares or "Catholic" in shares):
        shares["Christian"] = round(shares.get("Protestant", 0) + shares.get("Catholic", 0), 2)
    if "Islam" not in shares:
        return None, None
    top = sum(shares.get(k, 0) for k in ("Islam", "Christian", "Hindu", "Buddhist", "Confucian", "Folk", "Other"))
    if not 94 <= top <= 106:  # parse picked up something else (e.g. ethnic shares): drop it
        return None, None
    return shares, int(year_m.group(1)) if year_m else None


def airport_passengers(raw: Path):
    """IATA -> {pax, year, series} from 'List of the busiest airports in Indonesia'."""
    tables, _ = _page(raw, "airports")
    out = {}
    for t in tables:
        if not t or "IATA" not in t[0]:
            continue
        head = t[0]
        ci = head.index("IATA")
        years = {k: int(h) for k, h in enumerate(head) if re.fullmatch(r"(19|20)\d\d", h)}
        for row in t[1:]:
            if len(row) <= ci:
                continue
            series = {}
            for k, y in years.items():
                if k < len(row):
                    v = num(row[k])
                    if v:
                        series[y] = int(v)
            if series:
                y = max(series)
                out[row[ci]] = {"pax": series[y], "year": y, "series": series}
    return out
