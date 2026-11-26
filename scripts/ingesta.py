"""
Ingesta de taquilla de cine en España.

Descarga y normaliza datos públicos:
  - eCartelera: top 25 de cada fin de semana (recaudación, espectadores, cines, total acumulado).
  - eCartelera: ficha de cada película (país, género, director, distribuidora, presupuesto...).
  - ICAA / Ministerio de Cultura: reparto de la recaudación por comunidad autónoma
    (tabla estática en data/referencia/icaa_ccaa_2025.csv).
  - OpenStreetMap: ubicación de los cines (solo la primera vez, o con --mapa).

Genera:
  - web/data/datos.js   (lo que lee la web)
  - web/data/mapa.js    (contornos de CCAA + cines; solo si no existe o con --mapa)
  - data/taquilla_fines_de_semana.csv y data/peliculas.csv (para Excel)

Uso:
  python scripts/ingesta.py              # actualiza (descarga solo lo nuevo)
  python scripts/ingesta.py --desde 2023 # amplía el histórico
  python scripts/ingesta.py --mapa       # regenera el mapa y los cines
"""

import argparse
import csv
import datetime as dt
import html
import json
import re
import sys
import time
import unicodedata
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import icaa  # noqa: E402  (taquilla semanal del ICAA)

RAIZ = Path(__file__).resolve().parent.parent
CACHE = RAIZ / "data" / "cache"
REFERENCIA = RAIZ / "data" / "referencia" / "icaa_ccaa_2025.csv"
WEB_DATA = RAIZ / "web" / "data"

BASE = "https://www.ecartelera.com"
UA = "Mozilla/5.0 (compatible; taquilla-estudio/1.0; uso personal)"
PAUSA = 1.0  # segundos entre peticiones, para no cargar el servidor

MESES = {
    "enero": 1, "febrero": 2, "marzo": 3, "abril": 4, "mayo": 5, "junio": 6, "julio": 7,
    "agosto": 8, "septiembre": 9, "setiembre": 9, "octubre": 10, "noviembre": 11, "diciembre": 12,
}

if hasattr(sys.stdout, "reconfigure"):  # con pythonw no hay consola
    sys.stdout.reconfigure(encoding="utf-8", line_buffering=True)
_ultima_peticion = 0.0


# --------------------------------------------------------------------------- red

def descargar(url, intentos=3, datos=None, binario=False):
    global _ultima_peticion
    for n in range(intentos):
        espera = PAUSA - (time.time() - _ultima_peticion)
        if espera > 0:
            time.sleep(espera)
        _ultima_peticion = time.time()
        try:
            req = urllib.request.Request(url, data=datos, headers={"User-Agent": UA})
            with urllib.request.urlopen(req, timeout=180) as r:
                cuerpo = r.read()
                return cuerpo if binario else cuerpo.decode("utf-8", errors="replace")
        except urllib.error.HTTPError as e:
            if e.code == 404:
                return None
            print(f"  ! {url} -> HTTP {e.code} (intento {n + 1})")
        except Exception as e:  # red caída, timeout...
            print(f"  ! {url} -> {e} (intento {n + 1})")
        time.sleep(5 * (n + 1))
    return None


def con_cache(ruta, url, refrescar=False, recordar_fallo=False):
    if ruta.exists() and not refrescar:
        return ruta.read_text(encoding="utf-8") or None  # vacío = no existe en la web
    texto = descargar(url)
    if texto is not None:
        ruta.parent.mkdir(parents=True, exist_ok=True)
        ruta.write_text(texto, encoding="utf-8")
    elif ruta.exists():
        return ruta.read_text(encoding="utf-8") or None
    elif recordar_fallo:
        ruta.parent.mkdir(parents=True, exist_ok=True)
        ruta.write_text("", encoding="utf-8")
    return texto


# --------------------------------------------------------------------------- utilidades

def limpiar(s):
    s = re.sub(r"<[^>]+>", " ", s or "")
    return re.sub(r"\s+", " ", html.unescape(s)).strip()


def sin_comillas(s):
    """Quita las comillas que eCartelera pone a veces alrededor del título."""
    s = (s or "").strip()
    while len(s) > 1 and s[0] + s[-1] in ('""', "''", "«»", "“”", "‘’"):
        s = s[1:-1].strip()
    return s


def slugify(s):
    s = unicodedata.normalize("NFKD", s).encode("ascii", "ignore").decode()
    return re.sub(r"[^a-z0-9]+", "-", s.lower()).strip("-")


def numero(s):
    s = limpiar(s).replace("−", "-")
    m = re.search(r"-?[\d.]+(?:,\d+)?", s)
    if not m:
        return None
    return float(m.group().replace(".", "").replace(",", "."))


def dinero(s):
    """'1,01 M€' -> 1010000 ; '755.486 €' -> 755486 ; '44,1 M$' -> (44100000, '$')."""
    s = limpiar(s)
    v = numero(s)
    if v is None:
        return None, None
    if re.search(r"\bM\s*[€$]", s):
        v *= 1_000_000
    elif re.search(r"\bmil\b", s):
        v *= 1_000
    moneda = "$" if "$" in s else "€"
    return round(v), moneda


def eur(s):
    return dinero(s)[0]


# --------------------------------------------------------------------------- fines de semana

def fechas_desde_slug(slug, anio):
    """'6-8-noviembre' / '30-octubre-1-noviembre' -> (viernes, domingo)."""
    partes = slug.split("-")
    nums = [p for p in partes if p.isdigit()]
    meses = [MESES[p] for p in partes if p in MESES]
    if len(nums) < 2 or not meses:
        return None
    dia_fin, mes_fin = int(nums[-1]), meses[-1]
    for a in (anio, anio + 1, anio - 1):
        try:
            domingo = dt.date(a, mes_fin, dia_fin)
        except ValueError:
            continue
        if domingo.weekday() == 6 and (domingo - dt.timedelta(days=2)).day == int(nums[0]):
            return domingo - dt.timedelta(days=2), domingo
    return None


def listar_fines(anio, hoy):
    ruta = CACHE / "anios" / f"{anio}.html"
    refrescar = anio >= hoy.year - (1 if hoy.month == 1 else 0)
    t = con_cache(ruta, f"{BASE}/taquilla/espana/{anio}/", refrescar=refrescar)
    if not t:
        return []
    slugs = sorted(set(re.findall(rf'href="(?:{BASE})?/taquilla/espana/{anio}/([a-z0-9-]+)/"', t)))
    fines = []
    for slug in slugs:
        f = fechas_desde_slug(slug, anio)
        if f:
            fines.append({"anio": anio, "slug": slug, "viernes": f[0], "domingo": f[1]})
    return fines


def enlace(li, clase):
    """Devuelve (url, titulo) del elemento con esa clase (sea <a> o <span>)."""
    m = re.search(rf'<(a|span) class="{clase}"([^>]*)>(.*?)</\1>', li, flags=re.S)
    if not m:
        return None, None
    href = re.search(r'href="([^"]+)"', m.group(2))
    return (href.group(1) if href else None), limpiar(m.group(3))


def parsear_fin(t):
    filas = []
    # top 10 (con nº de cines)
    for li in re.findall(r'<li class="bo-row">(.*?)</li>', t, flags=re.S):
        pos = numero(re.search(r'bo-row__position">(.*?)<', li).group(1))
        url, titulo = enlace(li, "bo-row__title")
        meta = limpiar(re.search(r'bo-row__meta">(.*?)</span>\s*</span>', li, flags=re.S).group(1)) \
            if "bo-row__meta" in li else ""
        m_cines = re.search(r"([\d.]+) cines · ([\d.]+) € por cine", meta)
        cines = int(numero(m_cines.group(1))) if m_cines else None
        por_cine = int(numero(m_cines.group(2))) if m_cines else None
        bruto = eur(re.search(r'bo-figure">(.*?)<', li).group(1))
        if cines and por_cine and bruto and bruto >= 1_000_000:
            bruto = cines * por_cine  # más preciso que '1,01 M€'
        msem = re.search(r"(\d+)\.ª semana", meta)
        filas.append({
            "pos": int(pos), "titulo": titulo, "url": url,
            "semana": 1 if "Estreno" in meta else (int(msem.group(1)) if msem else 0),
            "cines": cines, "fin_eur": bruto,
            "espect": int(numero(re.search(r'bo-row__admissions">.*?</span>([\d.]+)', li, flags=re.S).group(1))),
            "total_eur": eur(re.search(r'bo-row__total">.*?</span>(.*?)</span>', li, flags=re.S).group(1)),
        })
    # puestos 11-25
    for li in re.findall(r'<li class="bo-rest__row">(.*?)</li>', t, flags=re.S):
        url, titulo = enlace(li, "bo-rest__title")
        if titulo is None:
            n = re.search(r'bo-rest__name">(.*?)<span class="bo-rest__weeks', li, flags=re.S)
            titulo = limpiar(n.group(1)) if n else "?"
        semanas = limpiar(re.search(r'bo-rest__weeks">(.*?)<', li).group(1)) if "bo-rest__weeks" in li else ""
        msem = re.search(r"(\d+)\.ª semana", semanas)
        figs = re.findall(r'bo-figure">(.*?)<', li)
        filas.append({
            "pos": int(numero(re.search(r'bo-rest__position">(.*?)<', li).group(1))),
            "titulo": titulo, "url": url,
            "semana": 1 if "Estreno" in semanas else (int(msem.group(1)) if msem else 0),
            "cines": None, "fin_eur": eur(figs[0]) if figs else None,
            "espect": int(numero(re.search(r'bo-rest__admissions">(.*?)<', li).group(1)) or 0),
            "total_eur": eur(re.search(r'bo-rest__total">(.*?)<', li).group(1)),
        })
    return filas


def id_peli(fila):
    if fila["url"]:
        m = re.search(r"/peliculas/([^/]+)/", fila["url"])
        if m:
            return m.group(1)
    return "x-" + slugify(fila["titulo"])


# --------------------------------------------------------------------------- fichas de película

def fecha_ficha(pid):
    """Fecha de estreno en España según la ficha de eCartelera (la ficha se descarga igualmente después)."""
    if pid.startswith("x-"):
        return None
    t = con_cache(CACHE / "pelis" / f"{pid}.html", f"{BASE}/peliculas/{pid}/", recordar_fallo=True)
    m = re.search(r'"datePublished"\s*:\s*"(\d{4}-\d{2}-\d{2})', t or "")
    return dt.date.fromisoformat(m.group(1)) if m else None


_buscadas = {}


def buscar_ficha(fila, viernes):
    """Ficha de eCartelera de una película del ICAA que no salió en el top de eCartelera (venía de 2019,
    o puesto 11 a 25 cuando eCartelera solo daba el top 10). Se prueban direcciones hechas con el título
    y se acepta la que tenga un estreno a menos de 3 semanas del que se deduce de la semana del ICAA.
    Las páginas quedan en la caché, así que cada dirección se pide una sola vez."""
    semana = fila.get("semana") or 1
    estreno = viernes - dt.timedelta(days=7 * (semana - 1))
    clave = (icaa.clave_fila(fila), estreno.isoformat()[:7])
    if clave in _buscadas:
        return _buscadas[clave]
    titulos = icaa.variantes(icaa.articulo_delante(fila["titulo"])) + icaa.variantes(fila.get("titulo_original"))
    slugs = []
    for t in titulos:
        s = slugify(icaa.articulo_delante(t))
        if len(s) >= 3:
            slugs += [s, f"{s}-{estreno.year}", f"{s}-{estreno.year - 1}"]
    encontrado = None
    for s in list(dict.fromkeys(slugs))[:9]:
        t = con_cache(CACHE / "pelis" / f"{s}.html", f"{BASE}/peliculas/{s}/", recordar_fallo=True)
        m = re.search(r'"datePublished"\s*:\s*"(\d{4}-\d{2}-\d{2})', t or "")
        if m and abs((dt.date.fromisoformat(m.group(1)) - estreno).days) <= 21:
            encontrado = s
            break
    _buscadas[clave] = encontrado
    return encontrado


def ficha_peli(pid, titulo):
    base = {"id": pid, "titulo": titulo}
    if pid.startswith("x-"):
        return base
    t = con_cache(CACHE / "pelis" / f"{pid}.html", f"{BASE}/peliculas/{pid}/", recordar_fallo=True)
    if not t:
        return base
    movie = {}
    for bloque in re.findall(r'<script type="application/ld\+json">(.*?)</script>', t, flags=re.S):
        try:
            d = json.loads(bloque)
        except json.JSONDecodeError:
            continue
        if isinstance(d, dict) and d.get("@type") == "Movie":
            movie = d
    lista = lambda x: x if isinstance(x, list) else ([x] if x else [])
    nombres = lambda x: [p.get("name") for p in lista(x) if isinstance(p, dict) and p.get("name")]

    def dd(etiqueta):
        m = re.search(rf"<dt>(?:<svg.*?</svg>)?{etiqueta}</dt>\s*<dd>(.*?)</dd>", t, flags=re.S)
        return m.group(1) if m else None

    def hecho(etiqueta):
        m = re.search(rf"</svg>{etiqueta}</dt>\s*<dd>(.*?)</dd>", t, flags=re.S)
        return m.group(1) if m else None

    paises = re.findall(r'fm-country__name"><span class="fm-u">(.*?)</span>', dd("País") or "")
    if not paises:
        paises = nombres(movie.get("countryOfOrigin"))
    distrib = [limpiar(x) for x in re.findall(r'fm-u">(.*?)</span>', dd("Distribuidora") or "")]
    presupuesto = mundial = (None, None)
    if hecho("Presupuesto"):
        presupuesto = dinero(re.search(r'fm-fact__value">(.*?)<', hecho("Presupuesto")).group(1))
    rec = hecho("Recaudación")
    if rec and "todo el mundo" in rec:
        mundial = dinero(re.search(r'fm-fact__value">(.*?)<', rec).group(1))
    dur = re.search(r"PT(\d+)M", movie.get("duration", "") or "")
    nota = movie.get("aggregateRating") or {}
    base.update({
        "titulo": sin_comillas(html.unescape(movie.get("name") or titulo)),
        "estreno": movie.get("datePublished"),
        "duracion": int(dur.group(1)) if dur else None,
        "generos": lista(movie.get("genre")),
        "paises": [limpiar(p) for p in paises],
        "director": nombres(movie.get("director")),
        "reparto": nombres(movie.get("actor"))[:4],
        "productoras": nombres(movie.get("productionCompany"))[:3],
        "distribuidora": distrib[0] if distrib else None,
        "edad": movie.get("contentRating"),
        "nota": nota.get("ratingValue"), "votos": nota.get("ratingCount"),
        "cartel": movie.get("image"),
        "presupuesto": presupuesto[0], "presupuesto_moneda": presupuesto[1],
        "mundial": mundial[0], "mundial_moneda": mundial[1],
        "url": f"{BASE}/peliculas/{pid}/",
    })
    return base


# --------------------------------------------------------------------------- mapa (una vez)

NOMBRES_GEO = {
    "Castilla-Leon": "Castilla y León", "Murcia": "Región de Murcia", "Baleares": "Illes Balears",
    "Andalucia": "Andalucía", "Valencia": "Comunitat Valenciana", "Aragon": "Aragón",
    "Madrid": "Comunidad de Madrid", "Pais Vasco": "País Vasco",
}


def simplificar(anillo, tol=0.008):
    salida = [anillo[0]]
    for x, y in anillo[1:-1]:
        px, py = salida[-1]
        if abs(x - px) > tol or abs(y - py) > tol:
            salida.append([round(x, 3), round(y, 3)])
    salida.append([round(anillo[-1][0], 3), round(anillo[-1][1], 3)])
    return salida if len(salida) >= 4 else None


def punto_en_poligono(x, y, anillo):
    dentro = False
    j = len(anillo) - 1
    for i in range(len(anillo)):
        xi, yi = anillo[i]
        xj, yj = anillo[j]
        if (yi > y) != (yj > y) and x < (xj - xi) * (y - yi) / (yj - yi + 1e-12) + xi:
            dentro = not dentro
        j = i
    return dentro


def generar_mapa(refrescar_cines=False):
    print("Generando mapa de comunidades y cines (OpenStreetMap)...")
    url_geo = "https://raw.githubusercontent.com/codeforgermany/click_that_hood/main/public/data/spain-communities.geojson"
    geo = json.loads(con_cache(CACHE / "geo" / "spain-communities.geojson", url_geo))
    for f in geo["features"]:
        nombre = NOMBRES_GEO.get(f["properties"]["name"], f["properties"]["name"])
        g = f["geometry"]
        polis = g["coordinates"] if g["type"] == "MultiPolygon" else [g["coordinates"]]
        nuevos = []
        for poli in polis:
            anillos = [a for a in (simplificar(r) for r in poli) if a]
            if anillos:
                nuevos.append(anillos)
        f["geometry"] = {"type": "MultiPolygon", "coordinates": nuevos}
        f["properties"] = {"ccaa": nombre}

    url_prov = "https://raw.githubusercontent.com/codeforgermany/click_that_hood/main/public/data/spain-provinces.geojson"
    geo_prov = json.loads(con_cache(CACHE / "geo" / "spain-provinces.geojson", url_prov))
    for f in geo_prov["features"]:
        partes = [p.strip() for p in f["properties"]["name"].split("/")]
        prov = next((p for p in partes if p in PROV_CCAA), None) or \
            next((k for k, v in ALIAS_PROV.items() if v == partes[0].lower()), None)
        prov = {"baleares": "Baleares", "s.c. tenerife": "S.C. Tenerife"}.get(prov, prov)
        g = f["geometry"]
        polis = g["coordinates"] if g["type"] == "MultiPolygon" else [g["coordinates"]]
        nuevos = [[a for a in (simplificar(r, 0.004) for r in poli) if a] for poli in polis]
        f["geometry"] = {"type": "MultiPolygon", "coordinates": [p for p in nuevos if p]}
        f["properties"] = {"provincia": prov or partes[-1], "ccaa": PROV_CCAA.get(prov)}

    consulta = ('[out:json][timeout:180];area["ISO3166-1"="ES"][admin_level=2]->.es;'
                'nwr["amenity"="cinema"](area.es);out center tags;')
    ruta_osm = CACHE / "geo" / "osm_cines.json"
    texto = None
    servidores = ("https://overpass-api.de/api/interpreter", "https://overpass.kumi.systems/api/interpreter")
    if ruta_osm.exists() and not refrescar_cines:
        servidores = ()
    for servidor in servidores:
        texto = descargar(servidor, intentos=2, datos=urllib.parse.urlencode({"data": consulta}).encode())
        if texto and texto.lstrip().startswith("{"):
            ruta_osm.parent.mkdir(parents=True, exist_ok=True)
            ruta_osm.write_text(texto, encoding="utf-8")
            break
        texto = None
    if texto is None and ruta_osm.exists():
        texto = ruta_osm.read_text(encoding="utf-8")
    cines = []
    if texto:
        for e in json.loads(texto)["elements"]:
            tags = e.get("tags", {})
            lat = e.get("lat") or e.get("center", {}).get("lat")
            lon = e.get("lon") or e.get("center", {}).get("lon")
            if lat is None or not tags.get("name"):
                continue
            ccaa = None
            for f in geo["features"]:
                if any(punto_en_poligono(lon, lat, poli[0]) for poli in f["geometry"]["coordinates"]):
                    ccaa = f["properties"]["ccaa"]
                    break
            pant = numero(tags.get("screen", "")) if tags.get("screen") else None
            cines.append([round(lon, 4), round(lat, 4), tags["name"],
                          tags.get("addr:city") or "", int(pant) if pant else None, ccaa])
    else:
        print("  ! No se pudo descargar la lista de cines de OSM; el mapa irá sin cines.")
    WEB_DATA.mkdir(parents=True, exist_ok=True)
    (WEB_DATA / "mapa.js").write_text(
        "window.MAPA = " + json.dumps({"geo": geo, "provincias": geo_prov, "cines": cines},
                                      ensure_ascii=False, separators=(",", ":")) + ";\n",
        encoding="utf-8")
    print(f"  {len(geo['features'])} comunidades, {len(cines)} cines")


# --------------------------------------------------------------------------- sesiones por cine

PROV_CCAA = {
    "Almería": "Andalucía", "Cádiz": "Andalucía", "Córdoba": "Andalucía", "Granada": "Andalucía",
    "Huelva": "Andalucía", "Jaén": "Andalucía", "Málaga": "Andalucía", "Sevilla": "Andalucía",
    "Huesca": "Aragón", "Teruel": "Aragón", "Zaragoza": "Aragón", "Asturias": "Asturias",
    "Baleares": "Illes Balears", "Las Palmas": "Canarias", "S.C. Tenerife": "Canarias", "Cantabria": "Cantabria",
    "Ávila": "Castilla y León", "Burgos": "Castilla y León", "León": "Castilla y León", "Palencia": "Castilla y León",
    "Salamanca": "Castilla y León", "Segovia": "Castilla y León", "Soria": "Castilla y León",
    "Valladolid": "Castilla y León", "Zamora": "Castilla y León",
    "Albacete": "Castilla-La Mancha", "Ciudad Real": "Castilla-La Mancha", "Cuenca": "Castilla-La Mancha",
    "Guadalajara": "Castilla-La Mancha", "Toledo": "Castilla-La Mancha",
    "Barcelona": "Cataluña", "Girona": "Cataluña", "Lleida": "Cataluña", "Tarragona": "Cataluña",
    "Alicante": "Comunitat Valenciana", "Castellón": "Comunitat Valenciana", "Valencia": "Comunitat Valenciana",
    "Badajoz": "Extremadura", "Cáceres": "Extremadura",
    "A Coruña": "Galicia", "Lugo": "Galicia", "Ourense": "Galicia", "Pontevedra": "Galicia",
    "Madrid": "Comunidad de Madrid", "Murcia": "Región de Murcia", "Navarra": "Navarra",
    "Álava": "País Vasco", "Guipúzcoa": "País Vasco", "Vizcaya": "País Vasco",
    "La Rioja": "La Rioja", "Ceuta": "Ceuta", "Melilla": "Melilla",
}
ALIAS_PROV = {"baleares": "illes balears", "s.c. tenerife": "santa cruz de tenerife"}


CADENAS = ["Cinesa", "Yelmo", "Kinépolis", "Ocine", "Odeon", "Odeón", "Artesiete", "Cinemax", "MK2", "Renoir",
           "Verdi", "Golem", "Cinesur", "Cinebox", "Axion", "Neocine", "Aana", "Moon", "Cines Zoco", "Cinemes Girona",
           "Ocimax", "Multicines Cinesa", "Cines Ábaco", "Abaco", "Cinentertainment", "JCA", "Lauren", "Filmax",
           "Mercantil", "Cines Lys", "Cinemaxx", "Siete Palmas", "Callao", "Embajadores", "Phenomena"]


def cadena_por_nombre(nombre):
    n = nombre.lower()
    for c in CADENAS:
        if c.lower() in n:
            return {"Odeón": "Odeon", "Abaco": "Cines Ábaco", "Multicines Cinesa": "Cinesa"}.get(c, c)
    return "Independiente"


def provincias_geo():
    url = "https://raw.githubusercontent.com/codeforgermany/click_that_hood/main/public/data/spain-provinces.geojson"
    geo = json.loads(con_cache(CACHE / "geo" / "spain-provinces.geojson", url))
    out = {}
    for f in geo["features"]:
        g = f["geometry"]
        polis = g["coordinates"] if g["type"] == "MultiPolygon" else [g["coordinates"]]
        anillos = [p[0] for p in polis]
        mayor = max(anillos, key=len)
        centro = [sum(x for x, _ in mayor) / len(mayor), sum(y for _, y in mayor) / len(mayor)]
        for nombre in f["properties"]["name"].split("/"):
            out[nombre.strip().lower()] = {"anillos": anillos, "centro": centro}
    return out


def procesar_sesiones():
    """Convierte data/sesiones/*.json en web/data/sesiones/*.js. Devuelve [(viernes, pelis{slug: titulo})]."""
    origen = RAIZ / "data" / "sesiones"
    if not origen.exists():
        return []
    destino = WEB_DATA / "sesiones"
    destino.mkdir(parents=True, exist_ok=True)
    provs = None
    salida = []
    for ruta in sorted(origen.glob("*.json")):
        snap = json.loads(ruta.read_text(encoding="utf-8"))
        v = snap["viernes"]
        salida.append((v, {s: snap["pelis"].get(s, s) for c in snap["cines"].values() for s in c["ses"]}))
        js = destino / f"{v}.js"
        if js.exists() and js.stat().st_mtime >= ruta.stat().st_mtime:
            continue
        provs = provs or provincias_geo()
        cines, pelis_idx, filas = [], {}, []
        for i, (url, c) in enumerate(sorted(snap["cines"].items())):
            if not c.get("ses"):
                continue
            prov = (c.get("provincia") or "").strip()
            gp = provs.get(ALIAS_PROV.get(prov.lower(), prov.lower()))
            lon, lat, aprox = c.get("lon"), c.get("lat"), 0
            if gp and (lon is None or not any(punto_en_poligono(lon, lat, a) for a in gp["anillos"])):
                # coordenadas ausentes o fuera de su provincia: se coloca cerca del centro de la provincia
                lon = gp["centro"][0] + ((i * 37) % 11 - 5) * 0.03
                lat = gp["centro"][1] + ((i * 53) % 11 - 5) * 0.02
                aprox = 1
            if lon is None:
                continue
            ci = len(cines)
            cines.append([c.get("nombre"), c.get("ciudad"), prov, PROV_CCAA.get(prov), round(lon, 4), round(lat, 4),
                          c.get("precio_finde") or c.get("precio"), aprox,
                          c.get("cadena") or cadena_por_nombre(c.get("nombre") or "")])
            for slug, dias in c["ses"].items():
                conocidos = [d for d in dias if d is not None]
                if not conocidos:
                    continue
                media = round(sum(conocidos) / len(conocidos), 1)
                pi = pelis_idx.setdefault(slug, len(pelis_idx))
                filas.append([ci, pi] + [d if d is not None else media for d in dias])
        datos = {"capturado": snap.get("capturado"), "revisados": len(snap["cines"]),
                 "cines": cines, "pelis": list(pelis_idx), "s": filas}
        js.write_text("window.SESIONES = window.SESIONES || {};\nwindow.SESIONES[" + json.dumps(v) + "] = " +
                      json.dumps(datos, ensure_ascii=False, separators=(",", ":")) + ";\n", encoding="utf-8")
        print(f"  sesiones {v}: {len(cines)} cines, {len(pelis_idx)} películas")
    return salida


# --------------------------------------------------------------------------- críticas

def parsear_criticas(t):
    texto = limpiar(re.sub(r"<script.*?</script>|<style.*?</style>", "", t, flags=re.S))
    num = lambda s: float(s.replace(",", ".")) if s else None
    out = {}
    m = re.search(r"([\d,]+) Nota media eCartelera", texto)
    if m:
        out["media"] = num(m.group(1))
    m = re.search(r"([\d,]+) Usuarios ([\d.]+) votos?", texto)
    if m:
        out["usuarios"] = [num(m.group(1)), int(m.group(2).replace(".", ""))]
    m = re.search(r'fm-press__avg">media <strong>([\d,]+)</strong> de ([\d.]+) medios', t)
    if m:
        reparto = re.search(r"valora la prensa: (\d+) positivas?, (\d+) mixtas? y (\d+) negativas?", t)
        out["prensa"] = [num(m.group(1)), int(m.group(2).replace(".", ""))] + \
            ([int(x) for x in reparto.groups()] if reparto else [None, None, None])
    citas = []
    for li in re.findall(r'<li class="fm-press__item">(.*?)</li>', t, flags=re.S):
        nota = re.search(r'fm-score[^"]*">([\d,]+)<', li)
        medio = re.search(r'fm-press__outlet">(.*?)(?:<small>(.*?)</small>)?</span>', li, flags=re.S)
        cita = re.search(r'<q class="fm-press__quote">(.*?)</q>', li, flags=re.S)
        url = re.search(r'fm-press__link" href="([^"]+)"', li)
        if cita and medio:
            citas.append([num(nota.group(1)) if nota else None, limpiar(medio.group(1)),
                          limpiar(medio.group(2) or ""), limpiar(cita.group(1)), url.group(1) if url else None])
    if citas:
        con_nota = sorted([c for c in citas if c[0] is not None], key=lambda c: -c[0])
        elegidas = con_nota[:3]
        peor = con_nota[-1] if con_nota else None
        if peor and peor not in elegidas and peor[0] < 7:
            elegidas.append(peor)  # que también se vea la voz discordante
        out["citas"] = elegidas or citas[:3]
    resenas = []
    for li in re.findall(r'<li class="fm-rv"[^>]*data-score="([\d.]*)"[^>]*>(.*?)</li>\s*(?=<li class="fm-rv"|</ul>)', t, flags=re.S):
        nota, cuerpo = li
        nombre = re.search(r'fm-rv__name">(.*?)<', cuerpo)
        titulo = re.search(r'fm-rv__title">.*?<span class="fm-u">(.*?)</span>', cuerpo, flags=re.S)
        texto_r = re.search(r'fm-rv__text">(.*?)</p>', cuerpo, flags=re.S)
        if texto_r:
            resenas.append([float(nota) if nota else None, limpiar(nombre.group(1)) if nombre else "",
                            limpiar(titulo.group(1)) if titulo else "", limpiar(texto_r.group(1))])
    if resenas:
        out["resenas"] = resenas[:3]
    return out


def criticas(pelis, recientes):
    """Críticas de eCartelera por película. Se refrescan cada 7 días las de películas en cartelera o por estrenar."""
    ruta_dir = CACHE / "criticas"
    ruta_dir.mkdir(parents=True, exist_ok=True)
    pendientes = []
    for pid in pelis:
        if pid.startswith("x-"):
            continue
        ruta = ruta_dir / f"{pid}.html"
        viejo = ruta.exists() and (time.time() - ruta.stat().st_mtime) > 7 * 86400
        if not ruta.exists() or (viejo and pid in recientes):
            pendientes.append(pid)
    if pendientes:
        print(f"Descargando críticas de {len(pendientes)} películas...")
    salida = {}
    for n, pid in enumerate(pelis):
        if pid.startswith("x-"):
            continue
        t = con_cache(ruta_dir / f"{pid}.html", f"{BASE}/peliculas/{pid}/criticas/",
                      refrescar=pid in pendientes, recordar_fallo=True)
        if pid in pendientes and n % 100 == 0:
            print(f"  críticas {n}/{len(pelis)}")
        if t:
            c = parsear_criticas(t)
            if c:
                salida[pid] = c
    return salida


# --------------------------------------------------------------------------- próximos estrenos

def proximos_estrenos(hoy):
    """[(slug, titulo, fecha)] de los estrenos en cines a partir de hoy (sin los de plataformas)."""
    t = descargar(f"{BASE}/peliculas/estrenos/")
    if not t:
        return []
    salida = []
    bloques = re.split(r'<h3 class="fm-team__title">', t)[1:]
    for b in bloques:
        cab = limpiar(b.split("</h3>")[0])
        m = re.search(r"del (\d+)(?: de ([a-z]+))? al (\d+) de ([a-z]+)", cab)
        if not m:
            continue
        d_ini, d_fin, mes_fin = int(m.group(1)), int(m.group(3)), MESES[m.group(4)]
        mes_ini = MESES[m.group(2)] if m.group(2) else mes_fin
        for tile in re.findall(r'<a class="fm-rel fm-tile" (.*?)</a>', b.split("</ul>")[0], flags=re.S):
            if 'class="fm-badge"' in tile:  # Netflix, Prime Video, Apple TV+...: no pasa por taquilla
                continue
            slug = re.search(r'href="[^"]*/peliculas/([^/]+)/"', tile)
            dia = re.search(r'fm-rel__year">\D*(\d+)<', tile)
            titulo = re.search(r'fm-rel__title"><span class="fm-u">(.*?)</span>', tile, flags=re.S)
            if not (slug and dia and titulo):
                continue
            d = int(dia.group(1))
            mes = mes_ini if (mes_ini != mes_fin and d >= d_ini) or mes_ini == mes_fin else mes_fin
            anio = hoy.year + (1 if mes < hoy.month - 2 else 0)
            try:
                fecha = dt.date(anio, mes, d)
            except ValueError:
                continue
            if fecha >= hoy:
                salida.append((slug.group(1), limpiar(titulo.group(1)), fecha.isoformat()))
    return salida


# --------------------------------------------------------------------------- principal

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--desde", type=int, default=2020, help="primer año del histórico (el ICAA publica desde 2020)")
    ap.add_argument("--mapa", action="store_true", help="regenerar mapa y cines")
    args = ap.parse_args()
    hoy = dt.date.today()

    mapa = WEB_DATA / "mapa.js"
    if args.mapa or not mapa.exists() or '"provincias"' not in mapa.read_text(encoding="utf-8"):
        generar_mapa(refrescar_cines=args.mapa)

    # 1. lista de fines de semana
    fines = []
    for anio in range(args.desde, hoy.year + 1):
        fines += listar_fines(anio, hoy)
    fines = sorted({f["viernes"]: f for f in fines}.values(), key=lambda f: f["viernes"])
    print(f"{len(fines)} fines de semana entre {fines[0]['viernes']} y {fines[-1]['domingo']}")

    # 2. cada fin de semana (los 2 últimos se vuelven a bajar por si hay correcciones)
    recientes = {f["slug"] for f in fines[-2:]}
    ec_por_fin = {}
    for f in fines:
        ruta = CACHE / "fines" / f"{f['anio']}_{f['slug']}.html"
        nuevo = not ruta.exists()
        t = con_cache(ruta, f"{BASE}/taquilla/espana/{f['anio']}/{f['slug']}/", refrescar=f["slug"] in recientes)
        if not t:
            continue
        datos = parsear_fin(t)
        if not datos:
            ruta.unlink(missing_ok=True)  # aún sin datos: se reintentará
            continue
        if nuevo:
            print(f"  + {f['viernes']}  {len(datos)} películas")
        for d in datos:
            d.update({"viernes": f["viernes"].isoformat(), "id": id_peli(d), "fuente": "eCartelera"})
        ec_por_fin[f["viernes"].isoformat()] = datos

    # 2b. ICAA: top 25 semanal en PDF (sale los jueves, antes que eCartelera, con acumulados exactos)
    semanas_icaa = icaa.actualizar(descargar, args.desde, hoy)
    sesiones = procesar_sesiones()
    proximos = proximos_estrenos(hoy)
    candidatos = {}
    for v in sorted(ec_por_fin):
        for d in ec_por_fin[v]:
            candidatos[d["id"]] = d["titulo"]
    for v, titulos in sesiones:
        for slug, titulo in titulos.items():
            candidatos.setdefault(slug, titulo)
    for slug, titulo, _ in proximos:
        candidatos.setdefault(slug, titulo)
    en_cartelera = {v: set(titulos) for v, titulos in sesiones}
    emparejado, contraste = icaa.emparejar(semanas_icaa, ec_por_fin, candidatos, en_cartelera, buscar_ficha, fecha_ficha)

    # 2c. una sola tabla: el ICAA manda en los fines de semana que publica; eCartelera cubre el resto
    filas, fuente_fin = [], {}
    for v in sorted(set(ec_por_fin) | set(emparejado)):
        if v in emparejado:
            fuente_fin[v] = "ICAA" + (" + eCartelera" if v in ec_por_fin else "")
            for r, pid, metodo, e in emparejado[v]:
                filas.append({
                    "viernes": v, "id": pid, "pos": r["puesto"],
                    "titulo": (e or {}).get("titulo") or candidatos.get(pid) or icaa.articulo_delante(r["titulo"]),
                    "url": (e or {}).get("url"), "semana": r["semana"] or (e or {}).get("semana") or 0,
                    "cines": r["cines"] if r["cines"] is not None else (e or {}).get("cines"),
                    "fin_eur": r["recaudacion_eur"], "espect": r["espectadores"],
                    "total_eur": r["acumulado_eur"] if r["acumulado_eur"] is not None else (e or {}).get("total_eur"),
                    "total_espect": r["acumulado_espectadores"], "distribuidora_icaa": r["distribuidora"],
                    "titulos_icaa": (r["titulo"], r.get("titulo_original") or ""),
                    "fuente": "ICAA", "emparejado": metodo})
        else:
            fuente_fin[v] = "eCartelera"
            filas.extend(ec_por_fin[v])

    # 2d. ICAA, cine español en cartelera: las semanas fuera del top 25 de películas que sí entraron en él
    # (sin puesto: no cuentan para el top ni para el total del fin de semana)
    espanol = icaa.contrastar_espanol(icaa.actualizar(descargar, args.desde, hoy, tipo="espanol"), semanas_icaa)
    una_fila = {d["id"]: d for d in filas}
    for v, pares in icaa.emparejar_espanol(espanol, semanas_icaa, filas).items():
        for r, pid in pares:
            previa = una_fila[pid]
            filas.append({
                "viernes": v, "id": pid, "pos": None, "titulo": previa["titulo"], "url": previa.get("url"),
                "semana": r["semana"] or 0, "cines": r["cines"], "fin_eur": r["recaudacion_eur"],
                "espect": r["espectadores"], "total_eur": r["acumulado_eur"],
                "total_espect": r["acumulado_espectadores"], "distribuidora_icaa": r["distribuidora"],
                "fuente": "ICAA cine español", "emparejado": "cine español"})
    metodos = {}
    for v in emparejado:
        for _, _, metodo, _ in emparejado[v]:
            metodos[metodo] = metodos.get(metodo, 0) + 1
    if emparejado:
        ult = max(emparejado)
        sin = [r["titulo"] for r, pid, m, _ in emparejado[ult] if m == "sin pareja"]
        print(f"ICAA: {len(emparejado)} fines de semana; emparejado {metodos}")
        if sin:
            print(f"  sin pareja en eCartelera el {ult}: {', '.join(sin)}")
        if contraste:
            print(f"  {len(contraste)} diferencias con eCartelera (data/contraste_fuentes.csv)")

    # 3. fichas de película
    ids = {}
    for d in filas:
        ids.setdefault(d["id"], d["titulo"])
    pendientes = [i for i in ids if not i.startswith("x-") and not (CACHE / "pelis" / f"{i}.html").exists()]
    if pendientes:
        print(f"Descargando {len(pendientes)} fichas de película nuevas...")
    pelis = {}
    for n, (pid, titulo) in enumerate(ids.items()):
        pelis[pid] = ficha_peli(pid, titulo)
        if pid in pendientes and n % 25 == 0:
            print(f"  {n}/{len(ids)}")

    # la distribuidora del ICAA completa las fichas que no la tienen
    for d in filas:
        if d.get("distribuidora_icaa") and not pelis[d["id"]].get("distribuidora"):
            pelis[d["id"]]["distribuidora"] = d["distribuidora_icaa"]

    # 4. métricas por película
    viernes_ord = sorted({f["viernes"].isoformat() for f in fines} | set(fuente_fin))
    idx_fin = {v: i for i, v in enumerate(viernes_ord)}
    por_peli = {}
    for d in filas:
        por_peli.setdefault(d["id"], []).append(d)
    for pid, ds in por_peli.items():
        ds.sort(key=lambda d: d["viernes"])
        # recaudación entre semana deducida: total(n+1) - finde(n+1) - total(n)
        for a, b in zip(ds, ds[1:]):
            if idx_fin[b["viernes"]] - idx_fin[a["viernes"]] == 1 and a["total_eur"] and b["total_eur"]:
                a["entre_semana"] = max(0, b["total_eur"] - (b["fin_eur"] or 0) - a["total_eur"])
        p = pelis[pid]
        primera = ds[0]
        p["completa"] = primera["semana"] == 1
        p["primer_fin"] = primera["viernes"]
        p["apertura_eur"] = primera["fin_eur"]
        p["apertura_espect"] = primera["espect"]
        p["apertura_cines"] = primera["cines"]
        p["total_eur"] = max((d["total_eur"] or 0) for d in ds)
        p["total_espect"] = max((d.get("total_espect") or 0) for d in ds) or None
        en_top = [d for d in ds if d["pos"] is not None]  # las semanas de cine español fuera del top 25 no tienen puesto
        p["semanas_top25"] = len(en_top)
        p["max_cines"] = max((d["cines"] or 0) for d in ds) or None
        p["mejor_puesto"] = min(d["pos"] for d in en_top)
        segunda = next((d for d in ds if d["semana"] == 2), None)
        p["caida_2"] = round(100 * (segunda["fin_eur"] / primera["fin_eur"] - 1), 1) \
            if p["completa"] and segunda and primera["fin_eur"] else None
        p["multiplicador"] = round(p["total_eur"] / primera["fin_eur"], 2) \
            if p["completa"] and primera["fin_eur"] else None
        p["espanola"] = "España" in (p.get("paises") or [])

    # 5. referencia ICAA por CCAA
    with open(REFERENCIA, encoding="utf-8") as fh:
        ccaa = [{k: (v if k == "ccaa" else float(v)) for k, v in r.items()} for r in csv.DictReader(fh)]

    # 5b. sesiones por cine: fines de semana capturados y películas que aún no tienen taquilla
    extra = []
    for v, titulos in sesiones:
        if v not in idx_fin:
            viernes_ord.append(v)
        for slug, titulo in titulos.items():
            if slug not in pelis:
                p = ficha_peli(slug, titulo)
                p.update({"completa": False, "espanola": "España" in (p.get("paises") or []),
                          "primer_fin": None, "total_eur": None})
                pelis[slug] = p
                extra.append(slug)
    viernes_ord.sort()
    idx_fin = {v: i for i, v in enumerate(viernes_ord)}

    # 5c. próximos estrenos en cines
    nuevas = [s for s, _, _ in proximos if s not in pelis and not (CACHE / "pelis" / f"{s}.html").exists()]
    if nuevas:
        print(f"Descargando {len(nuevas)} fichas de próximos estrenos...")
    for slug, titulo, fecha in proximos:
        if slug not in pelis:
            p = ficha_peli(slug, titulo)
            p.update({"completa": False, "espanola": "España" in (p.get("paises") or []),
                      "primer_fin": None, "total_eur": None})
            pelis[slug] = p
            extra.append(slug)
    print(f"  {len(proximos)} próximos estrenos en cines")

    # 6. salida para la web (compacta)
    orden_pelis = sorted(por_peli, key=lambda i: por_peli[i][0]["viernes"]) + extra
    idx_peli = {pid: i for i, pid in enumerate(orden_pelis)}
    salida = {
        "generado": dt.datetime.now().isoformat(timespec="minutes"),
        "fines": viernes_ord,
        "sesiones": [{"v": v, "fin": idx_fin[v], "pelis": sorted(idx_peli[s] for s in titulos if s in idx_peli)}
                     for v, titulos in sesiones],
        "proximos": [[idx_peli[s], fecha] for s, _, fecha in proximos],
        "fuentes": [fuente_fin.get(v) for v in viernes_ord],
        "campos": ["fin", "peli", "pos", "semana", "fin_eur", "espect", "cines", "total_eur", "entre_semana",
                   "total_espect"],
        "filas": [[idx_fin[d["viernes"]], idx_peli[d["id"]], d["pos"], d["semana"], d["fin_eur"],
                   d["espect"], d["cines"], d["total_eur"], d.get("entre_semana"), d.get("total_espect")]
                  for d in filas],
        "pelis": [pelis[pid] for pid in orden_pelis],
        "ccaa": ccaa,
    }
    WEB_DATA.mkdir(parents=True, exist_ok=True)

    # 6b. críticas (archivo aparte: la web lo carga sin bloquear)
    fines_recientes = set(viernes_ord[-5:])
    recientes = {pid for pid, ds in por_peli.items() if ds[-1]["viernes"] in fines_recientes} | set(extra)
    crit = criticas(orden_pelis, recientes)
    (WEB_DATA / "criticas.js").write_text(
        "window.CRITICAS = " + json.dumps(crit, ensure_ascii=False, separators=(",", ":")) + ";\n", encoding="utf-8")
    print(f"  críticas de {len(crit)} películas")

    (WEB_DATA / "datos.js").write_text(
        "window.DATOS = " + json.dumps(salida, ensure_ascii=False, separators=(",", ":")) + ";\n", encoding="utf-8")

    # 7. CSV para Excel
    with open(RAIZ / "data" / "taquilla_fines_de_semana.csv", "w", newline="", encoding="utf-8-sig") as fh:
        w = csv.writer(fh, delimiter=";")
        w.writerow(["viernes", "pelicula_id", "titulo", "puesto", "semana", "recaudacion_finde_eur",
                    "espectadores_finde", "cines", "total_acumulado_eur", "entre_semana_siguiente_eur",
                    "total_acumulado_espectadores", "fuente"])
        for d in sorted(filas, key=lambda d: (d["viernes"], d["pos"] or 999)):
            w.writerow([d["viernes"], d["id"], d["titulo"], d["pos"], d["semana"], d["fin_eur"],
                        d["espect"], d["cines"], d["total_eur"], d.get("entre_semana"), d.get("total_espect"),
                        d.get("fuente")])
    campos = ["id", "titulo", "estreno", "primer_fin", "completa", "espanola", "paises", "generos", "director",
              "distribuidora", "duracion", "edad", "nota", "presupuesto", "presupuesto_moneda", "mundial",
              "mundial_moneda", "apertura_eur", "apertura_espect", "apertura_cines", "total_eur", "total_espect",
              "multiplicador", "caida_2", "semanas_top25", "mejor_puesto", "max_cines", "url"]
    with open(RAIZ / "data" / "peliculas.csv", "w", newline="", encoding="utf-8-sig") as fh:
        w = csv.writer(fh, delimiter=";")
        w.writerow(campos)
        for pid in orden_pelis:
            if pid in extra:
                continue
            p = pelis[pid]
            w.writerow([", ".join(map(str, p.get(c))) if isinstance(p.get(c), list) else p.get(c) for c in campos])

    ult_taq = max(d["viernes"] for d in filas)
    print(f"Listo: {len(filas)} filas, {len(pelis)} películas, último fin de semana con taquilla {ult_taq} "
          f"({fuente_fin.get(ult_taq)})")


if __name__ == "__main__":
    main()
