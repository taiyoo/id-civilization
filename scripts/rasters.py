"""Decode NASA GIBS raster tiles back into values and summarise them per hex.

GIBS serves colour-mapped PNGs; each layer's colormap XML says which colour
means which value, so we invert it (exact match, else nearest palette colour).
"""
import math
import re
from pathlib import Path

import numpy as np
from PIL import Image

LON0, LAT0, RES = 94.8, 6.4, 0.01   # must match fetch_extended.py
TILE_PX, TILES_X, TILES_Y = 1000, 5, 2

IGBP = ["Evergreen needleleaf forest", "Evergreen broadleaf forest", "Deciduous needleleaf forest",
        "Deciduous broadleaf forest", "Mixed forest", "Closed shrubland", "Open shrubland", "Woody savanna",
        "Savanna", "Grassland", "Permanent wetland", "Cropland", "Urban and built-up",
        "Cropland/natural vegetation mosaic", "Snow and ice", "Barren", "Water"]
FOREST = [0, 1, 2, 3, 4]
SAVANNA = [5, 6, 7, 8, 9]  # shrubland, savanna, grassland
WETLAND, CROPLAND, URBAN, MOSAIC, SNOW, BARREN, WATER = 10, 11, 12, 13, 14, 15, 16


def mosaic(folder: Path):
    rows = []
    for ty in range(TILES_Y):
        rows.append(np.concatenate([np.asarray(Image.open(folder / f"{tx}_{ty}.png").convert("RGBA"))
                                    for tx in range(TILES_X)], axis=1))
    return np.concatenate(rows, axis=0)


def read_colormap(path: Path):
    """[(r,g,b), value] from a GIBS colormap; ranges map to their midpoint."""
    entries = []
    for attrs in re.findall(r"<ColorMapEntry ([^>]*)/>", path.read_text()):
        a = dict(re.findall(r'(\w+)="([^"]*)"', attrs))
        if a.get("transparent") == "true" or a.get("nodata") == "true":
            continue
        rgb = tuple(int(x) for x in a["rgb"].split(","))
        raw = a.get("value") or a.get("sourceValue") or ""
        nums = [float(x) for x in re.findall(r"-?\d+(?:\.\d+)?(?:[eE][-+]?\d+)?", raw)]
        if not nums:
            continue
        if raw.startswith("[") and len(nums) == 2 and raw.endswith(")"):
            val = (nums[0] + nums[1]) / 2
        else:
            val = nums[0]
        entries.append((rgb, val))
    return entries


def decode(img, cmap, tol=40.0):
    """RGBA image -> float array of values (NaN where transparent / unknown)."""
    h, w, _ = img.shape
    rgb = img[..., :3].astype(np.int32)
    key = (rgb[..., 0] << 16) | (rgb[..., 1] << 8) | rgb[..., 2]
    uniq, inv = np.unique(key.ravel(), return_inverse=True)
    pal = np.array([c for c, _ in cmap], dtype=np.float32)
    vals = np.array([v for _, v in cmap], dtype=np.float32)
    ur = np.stack([(uniq >> 16) & 255, (uniq >> 8) & 255, uniq & 255], axis=1).astype(np.float32)
    d = ((ur[:, None, :] - pal[None, :, :]) ** 2).sum(axis=2)
    best = d.argmin(axis=1)
    lut = np.where(np.sqrt(d[np.arange(len(uniq)), best]) <= tol, vals[best], np.nan)
    out = lut[inv].reshape(h, w)
    out[img[..., 3] < 128] = np.nan
    return out


def luminance(img):
    rgb = img[..., :3].astype(np.float32)
    out = 0.299 * rgb[..., 0] + 0.587 * rgb[..., 1] + 0.114 * rgb[..., 2]
    out[img[..., 3] < 128] = np.nan
    return out


def hex_mask(radius_px):
    """Boolean mask of a pointy-top hexagon of the given circumradius."""
    n = int(math.ceil(radius_px))
    ys, xs = np.mgrid[-n:n + 1, -n:n + 1].astype(np.float32)
    ax, ay = np.abs(xs), np.abs(ys)
    inside = (ax <= radius_px * math.sqrt(3) / 2) & (ay + ax / math.sqrt(3) <= radius_px)
    return inside, n


def sample(raw: Path, centers, hex_radius_deg, wanted):
    """Per-hex summaries. centers: list of (lon, lat) or None (skip)."""
    mask, n = hex_mask(hex_radius_deg / RES)
    gib = raw / "gibs"
    layers = {}
    lc = decode(mosaic(gib / "landcover"), read_colormap(gib / "landcover" / "colormap.xml"))
    layers["landcover"] = lc
    for key in ("popdens", "flood", "landslide", "mangrove", "footprint"):
        layers[key] = decode(mosaic(gib / key), read_colormap(gib / key / "colormap.xml"))
    layers["lights"] = luminance(mosaic(gib / "lights"))
    H, W = lc.shape

    res = {k: [None] * len(centers) for k in ("lc", "popdens", "lights", "flood", "landslide", "mangrove", "footprint")}
    for i, c in enumerate(centers):
        if c is None or i not in wanted:
            continue
        lon, lat = c
        px, py = int(round((lon - LON0) / RES)), int(round((LAT0 - lat) / RES))
        x0, y0 = px - n, py - n
        if x0 < 0 or y0 < 0 or x0 + 2 * n + 1 > W or y0 + 2 * n + 1 > H:
            continue
        win = (slice(y0, y0 + 2 * n + 1), slice(x0, x0 + 2 * n + 1))
        cls = layers["landcover"][win][mask]
        cls = cls[~np.isnan(cls)].astype(int)
        cls = np.where(cls == 0, 17, cls)          # colormap lists water as "0,17"
        cls = cls[(cls >= 1) & (cls <= 17)]        # drop "unclassified" (255)
        if cls.size:
            counts = np.bincount(cls - 1, minlength=17)  # IGBP class k -> index k-1
            res["lc"][i] = counts
        for key in ("popdens", "lights", "flood", "landslide", "footprint"):
            v = layers[key][win][mask]
            v = v[~np.isnan(v)]
            res[key][i] = float(v.mean()) if v.size else 0.0
        mg = layers["mangrove"][win][mask]
        res["mangrove"][i] = float(np.count_nonzero(~np.isnan(mg) & (mg > 0)) / mask.sum())
    return res


def landcover_fractions(counts):
    """Fractions of land pixels (water excluded) by group."""
    if counts is None:
        return None
    land = counts.sum() - counts[WATER]
    total = counts.sum()
    if total == 0:
        return None
    f = lambda idx: float(counts[idx].sum() / land) if land else 0.0
    return {
        "forest": f(FOREST), "savanna": f(SAVANNA), "wetland": f([WETLAND]), "cropland": f([CROPLAND]),
        "mosaic": f([MOSAIC]), "urban": f([URBAN]), "barren": f([BARREN, SNOW]),
        "water": float(counts[WATER] / total), "dominant": int(np.argmax(counts[:WATER])) if land else WATER,
    }
