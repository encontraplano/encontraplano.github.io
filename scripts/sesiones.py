"""
Captura las sesiones de cada cine (eCartelera) para el fin de semana en curso.

Solo hace algo de viernes a domingo: guarda cuántas sesiones tiene cada película
en cada cine el viernes, el sábado y el domingo. Con eso, ingesta.py estima
la recaudación por cine en cuanto se publica la taquilla nacional (el martes).

  - Directorio de cines: se recorre una vez al mes (provincias + ciudades).
  - Instantánea: data/sesiones/AAAA-MM-DD.json (viernes del fin de semana).
    Si se interrumpe, al relanzar continúa donde lo dejó.

Uso:
  python scripts/sesiones.py           # captura si hoy es vie/sáb/dom
  python scripts/sesiones.py --forzar  # captura el próximo fin de semana aunque no lo sea
"""

import argparse
import datetime as dt
import json
import re
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import ingesta as ing  # noqa: E402  (reutiliza descarga con pausa, limpieza de texto...)

RAIZ = ing.RAIZ
DIRECTORIO = RAIZ / "data" / "cines_directorio.json"
SESIONES = RAIZ / "data" / "sesiones"
BASE = ing.BASE
NO_CINE = {"cadenas", "comprar", "estrenos", "buscar"}


# --------------------------------------------------------------------------- directorio de cines

def enlaces_cines(t):
    urls = set(re.findall(rf'href="({BASE}/cines/\d+,0,1\.html)"', t))
    for slug in re.findall(rf'href="{BASE}/cines/([a-z0-9-]+)/"', t):
        if slug not in NO_CINE:
            urls.add(f"{BASE}/cines/{slug}/")
    return urls


def directorio(forzar=False):
    if DIRECTORIO.exists() and not forzar:
        d = json.loads(DIRECTORIO.read_text(encoding="utf-8"))
        if (dt.date.today() - dt.date.fromisoformat(d["actualizado"])).days < 30:
            return d["urls"]
    print("Actualizando el directorio de cines (una vez al mes)...")
    t = ing.descargar(f"{BASE}/cartelera/") or ""
    provincias = sorted(set(re.findall(rf"{BASE}/cines/0,(\d+),0\.html", t)), key=int)
    urls, ciudades = set(), set()
    for p in provincias:
        tp = ing.descargar(f"{BASE}/cines/0,{p},0.html") or ""
        urls |= enlaces_cines(tp)
        ciudades |= {(p, c) for c in re.findall(rf"{BASE}/cines/0,{p},(\d+)\.html", tp) if c != "0"}
    print(f"  {len(provincias)} provincias, {len(ciudades)} ciudades")
    for n, (p, c) in enumerate(sorted(ciudades)):
        urls |= enlaces_cines(ing.descargar(f"{BASE}/cines/0,{p},{c}.html") or "")
        if n % 100 == 0:
            print(f"  ciudades {n}/{len(ciudades)} · {len(urls)} cines")
    urls = sorted(urls)
    DIRECTORIO.write_text(json.dumps({"actualizado": dt.date.today().isoformat(), "urls": urls}, indent=0),
                          encoding="utf-8")
    print(f"  {len(urls)} cines en el directorio")
    return urls


# --------------------------------------------------------------------------- ficha de cine

def parsear_cine(t):
    if "data-lat" not in t and 'class="titem"' not in t:
        return None
    migas = re.findall(r'<span class="wa"><a href="[^"]+">(.*?)</a></span>', t)
    lat = re.search(r'data-lat="(-?[\d.]+)" data-long="(-?[\d.]+)"', t)
    precios = re.search(r"<b>Precios:</b>(.*?)</p>", t, flags=re.S)
    precios = ing.limpiar(precios.group(1)) if precios else ""
    finde = re.search(r"([\d]+,\d+) euros fin de semana", precios)
    normal = re.search(r"([\d]+,\d+) euros", precios)
    dias = []
    bloque = re.search(r'<ul class="days">(.*?)</ul>', t, flags=re.S)
    if bloque:
        for url, etiqueta in re.findall(r'<a href="([^"]+)" title="Cartelera del ([^"]+)"', bloque.group(1)):
            m = re.search(r"(\d+)$", ing.limpiar(etiqueta))
            if m:
                dias.append((int(m.group(1)), url))
    pelis = {}
    for item in t.split('<div class="titem"')[1:]:
        a = re.search(rf'<p class="tit"><a href="{BASE}/peliculas/([^/]+)/"[^>]*>(.*?)</a>', item, flags=re.S)
        if not a:
            continue
        n = item.split('<div class="tdata">')[0].count("data-session-time=")
        if n:
            pelis[a.group(1)] = (ing.limpiar(a.group(2)), n)
    nombre = re.search(r'<h1 class="std-tit">(.*?)</h1>', t, flags=re.S)
    cadena = re.search(r"<b>Cadena:</b>\s*<a[^>]*>(.*?)</a>", t, flags=re.S)
    return {
        "nombre": ing.limpiar(nombre.group(1)) if nombre else "?",
        "cadena": ing.limpiar(cadena.group(1)) if cadena else None,
        "provincia": re.sub(r"\s+provincia$", "", ing.limpiar(migas[2])) if len(migas) > 2 else None,
        "ciudad": ing.limpiar(migas[3]) if len(migas) > 3 else None,
        "lat": float(lat.group(1)) if lat else None,
        "lon": float(lat.group(2)) if lat else None,
        "precio": float(normal.group(1).replace(",", ".")) if normal else None,
        "precio_finde": float(finde.group(1).replace(",", ".")) if finde else None,
        "dias": dias, "pelis": pelis,
    }


# --------------------------------------------------------------------------- captura

def fin_de_semana(hoy, forzar):
    wd = hoy.weekday()  # lunes = 0 ... viernes = 4
    if wd >= 4:
        return hoy - dt.timedelta(days=wd - 4)
    if forzar:
        return hoy + dt.timedelta(days=4 - wd)
    return None


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--forzar", action="store_true", help="capturar aunque hoy no sea fin de semana")
    ap.add_argument("--directorio", action="store_true", help="rehacer el directorio de cines")
    args = ap.parse_args()
    ing.PAUSA = 1.2  # ritmo tranquilo: ~3.000 peticiones/hora como máximo
    hoy = dt.date.today()
    viernes = fin_de_semana(hoy, args.forzar)
    if viernes is None:
        print("Sesiones: hoy no es fin de semana, no hay nada que capturar.")
        return
    fechas = [viernes + dt.timedelta(days=i) for i in range(3)]
    objetivo = [f for f in fechas if f >= hoy]  # los días ya pasados no se pueden ver

    urls = directorio(args.directorio)
    ruta = SESIONES / f"{viernes.isoformat()}.json"
    SESIONES.mkdir(parents=True, exist_ok=True)
    snap = json.loads(ruta.read_text(encoding="utf-8")) if ruta.exists() else \
        {"viernes": viernes.isoformat(), "cines": {}, "pelis": {}, "hechos": []}
    hechos = set(snap["hechos"])  # (url|fecha) ya capturados
    # lo que no se pudo capturar (el cine aún no publicó ese día) se reintenta, pero no antes de 12 horas
    ultima = snap.get("capturado")
    if ultima and (dt.datetime.now() - dt.datetime.fromisoformat(ultima)).total_seconds() < 12 * 3600:
        pendientes = [u for u in urls if u not in snap["cines"] and any(f"{u}|{f}" not in hechos for f in objetivo)]
    else:
        pendientes = [u for u in urls if any(f"{u}|{f}" not in hechos for f in objetivo)]
    if not pendientes:
        print(f"Sesiones del {viernes} ya capturadas.")
        return
    print(f"Capturando sesiones del fin de semana {viernes} en {len(pendientes)} cines "
          f"(días: {', '.join(f.strftime('%a %d') for f in objetivo)})...")

    def guardar():
        snap["hechos"] = sorted(hechos)
        snap["capturado"] = dt.datetime.now().isoformat(timespec="minutes")
        ruta.write_text(json.dumps(snap, ensure_ascii=False), encoding="utf-8")

    for n, url in enumerate(pendientes):
        t = ing.descargar(url)
        info = parsear_cine(t) if t else None
        if info is None:
            hechos.update(f"{url}|{f}" for f in objetivo)
            continue
        cine = snap["cines"].setdefault(url, {"ses": {}})
        cine.update({k: info[k] for k in ("nombre", "cadena", "provincia", "ciudad", "lat", "lon", "precio", "precio_finde")})
        por_dia = {hoy.day: info} if hoy in fechas else {}
        enlaces = dict(info["dias"])
        for f in objetivo:
            if f.day in por_dia:
                continue
            if f.day in enlaces and enlaces[f.day] != url:
                t2 = ing.descargar(enlaces[f.day])
                if t2:
                    por_dia[f.day] = parsear_cine(t2)
        for i, f in enumerate(fechas):
            datos = por_dia.get(f.day)
            if f in objetivo and (datos or f == hoy):
                hechos.add(f"{url}|{f}")  # si el cine aún no publicó ese día, se reintenta otro día
            if not datos:
                continue
            for slug, (titulo, ses) in datos["pelis"].items():
                snap["pelis"][slug] = titulo
                cine["ses"].setdefault(slug, [None, None, None])[i] = ses
        if n % 25 == 0:
            guardar()
            print(f"  {n}/{len(pendientes)} cines")
    guardar()
    con = sum(1 for c in snap["cines"].values() if c["ses"])
    print(f"Sesiones guardadas: {con} cines con programación, {len(snap['pelis'])} películas")


if __name__ == "__main__":
    main()
