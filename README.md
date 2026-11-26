# Nusantara: Indonesia as a strategy game

This is a Civilization-style hex map of Indonesia built entirely from open data. Every one of about 24,000 hexes (each roughly 22 km across) carries measured terrain, land cover, population, night lights and hazard values. On top of the map sit province statistics, lenses that recolour it, and a council of advisor dashboards.

```bash
python3 -I scripts/fetch_sources.py    # boundaries, rivers, Wikidata (cities, volcanoes, UNESCO, parks)
python3 -I scripts/fetch_extended.py   # NASA GIBS rasters, USGS quakes, WRI plants, airports, Wikipedia stats
python3 -I scripts/build_map.py        # builds public/map-data.json (fetches + caches elevation)
python3 -m http.server 8765 --directory public   # open http://localhost:8765
```

Downloads are cached in `data/raw/`; pass `--refresh` to re-download. Wikidata may throttle to one query a minute, so the first fetch is slow.

## What's on the map

**Lenses** (bottom toolbar → *Lenses*). Hover the legend scale to show only that range of values.

| Group | Lens | Level | Source |
|---|---|---|---|
| Base | Terrain, Elevation | hex | Copernicus GLO-90 DEM (Open-Meteo) |
| People | Population | hex | GPW v4 2020 density (SEDAC/NASA GIBS), rescaled to mid-2025 province totals |
| People | Faith, Muslim share, Christian share | province | Province infoboxes on Wikipedia (BPS / Dukcapil) |
| Prosperity | GDP per person, GDP growth, HDI, Spending per person | province | Wikipedia lists (BPS figures) |
| Prosperity | Poverty, Inequality | province | World Bank, 2022 |
| Knowledge | Years of schooling, Expected schooling, Life expectancy | province | BPS HDI components (Wikipedia) |
| Activity | Night lights | hex | VIIRS Black Marble (NASA GIBS) |
| Activity | Human footprint | hex | WCS/CIESIN (NASA GIBS) |
| Land | Forest, Farmland, Built-up, Wetlands, Savanna | hex | MODIS MCD12Q1 2024 land cover, 500 m pixels summarised per hex |
| Land | Mangroves | hex | Giri et al. 2000 |
| Hazards | Earthquakes | hex | USGS catalogue, M5+ since 1900 |
| Hazards | Landslide, Flood | hex | SEDAC Natural Disaster Hotspots |

**Advisors** (left panel). Each dashboard has KPI cards, ranked charts and tables. Hovering a row highlights its province or point on the map; hovering the map lights up the matching rows; clicking flies to it.

- **Economy:** GDP 2020–2025, Java versus the other island groups, provinces by output, per person and growth. Map overlay: GDP circles.
- **Prosperity:** poverty, HDI, spending and inequality.
- **Commerce:** the busiest airports (with passenger series), major seaports, night lights.
- **Energy & Resources:** power plants by fuel and province (WRI), plus named mines and fields.
- **People:** population, density, island groups, cities.
- **Knowledge & Health:** schooling and life expectancy.
- **Culture & Hazards:** wonders, faith, earthquakes (M7+ overlay), volcanoes, landslide hazard.
- **Land:** land-cover breakdown, forest, farmland, mangroves.
- **Explorer:** every province figure in one sortable table.

The view (lens, position, advisor and selected tile) is stored in the URL hash, so any view can be shared as a link.

## How terrain is derived
- **Elevation:** at least 4,200 m is snow mountain, 1,500 m and above is mountains, 250–1,500 m is hills.
- **Features:** taken from the MODIS land-cover fractions of each hex.
  - Forest of 45% or more becomes rainforest, or woods in dry areas.
  - Wetland or mangrove becomes marsh.
  - Cropland plus urban of 40% or more becomes grassland (farmland).
  - Savanna-dominant hexes become plains.
- **Crops:** rice and palm-oil resources are only placed on hexes where MODIS sees farmland.
- **Cities, volcanoes, wonders, parks, rivers and lakes** come from Wikidata, OpenStreetMap and Natural Earth. Mines, fields and ports are hand-curated in `data/curated/resources.json`.

## Read with care
- MODIS counts tree plantations as forest, so its 62% forest share is higher than the government's ~51% figure.
- Poverty and Gini (World Bank 2022) predate the Papua split; the four new Papua provinces inherit their parent's values. They do the same for religion when their own article has none. Jakarta and East Kalimantan have no religion shares in their infoboxes.
- Airport passenger counts in the Wikipedia table stop at 2018.
- The WRI plant list (2021) covers large plants only: about 49 GW, against roughly 90 GW installed nationally.
- GDP figures are nominal; growth includes inflation.

## Layout
- `scripts/fetch_sources.py`, `scripts/fetch_extended.py`: download the raw data.
- `scripts/build_map.py`: builds the grid, terrain, cities and overlays.
- `scripts/rasters.py`: decodes the GIBS colour-mapped tiles back into values per hex.
- `scripts/stats.py`: parses the Wikipedia tables and infoboxes.
- `public/js/`:
  - `render.js`: canvas renderer.
  - `lenses.js`: lens definitions.
  - `advisors.js`: dashboards.
  - `ui.js`: charts and tables.
  - `app.js`: wiring and URL state.

Licences: geoBoundaries and OSM are ODbL; Wikidata is CC0; Wikipedia is CC BY-SA; NASA GIBS, MODIS and VIIRS are open; SEDAC (GPW, NDH, mangroves) is CC BY; USGS and OurAirports are public domain; WRI is CC BY 4.0; Natural Earth is public domain.
