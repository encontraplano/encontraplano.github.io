"""
Taquilla semanal del ICAA (Ministerio de Cultura): top 25 de cada fin de semana en PDF.

  https://www.cultura.gob.es/cultura/areas/cine/datos/taquilla-espectadores.html

El ICAA publica cada jueves el PDF del fin de semana anterior (datos de Rentrak/comScore,
los mismos que usa eCartelera), normalmente antes que eCartelera. Además trae lo que
eCartelera no da o da redondeado:
  - número de cines de las 25 películas (eCartelera solo del top 10);
  - acumulado exacto en euros (eCartelera redondea a decenas de miles por encima de 1 M€);
  - espectadores acumulados, distribuidora y título original.

Qué hace este módulo:
  1. Lee la página del ICAA y localiza los PDF del top 25 (desde 2020).
  2. Descarga solo los que no se han procesado y los convierte en filas.
     La fecha del fin de semana se toma del pie del PDF, no del nombre del archivo,
     porque el nombre y el texto del enlace a veces no coinciden.
  3. Valida cada PDF: puestos seguidos y suma de la recaudación igual a la fila TOTAL.
     Un PDF que no cuadra no se usa (ese fin de semana se queda con eCartelera).
  4. Empareja cada título del ICAA con la película de eCartelera (ver emparejar()).

Archivos:
  data/icaa_top25.csv         filas ya procesadas (para Excel y para no volver a descargar)
  data/icaa_pdfs.json         estado de cada PDF (fin de semana, válido o motivo del rechazo)
  data/icaa_emparejado.csv    título del ICAA -> película de eCartelera. Se puede corregir a mano:
                              una fila con metodo=manual manda siempre.
  data/contraste_fuentes.csv  diferencias entre ICAA y eCartelera cuando ambos tienen el fin de semana
"""

import csv
import datetime as dt
import html
import io
import json
import re
import unicodedata
from difflib import SequenceMatcher
from functools import lru_cache
from pathlib import Path
from urllib.parse import urljoin

RAIZ = Path(__file__).resolve().parent.parent
PAGINA = "https://www.cultura.gob.es/cultura/areas/cine/datos/taquilla-espectadores.html"
CACHE = RAIZ / "data" / "cache" / "icaa"
SEMANAL = RAIZ / "data" / "icaa_top25.csv"
ESTADO = RAIZ / "data" / "icaa_pdfs.json"
EMPAREJADO = RAIZ / "data" / "icaa_emparejado.csv"
CONTRASTE = RAIZ / "data" / "contraste_fuentes.csv"
VERSION_LECTOR = 2  # súbelo si cambia la lectura de los PDF: se vuelven a procesar todos

MES3 = {"ene": 1, "feb": 2, "mar": 3, "abr": 4, "may": 5, "jun": 6, "jul": 7, "ago": 8,
        "sep": 9, "set": 9, "oct": 10, "nov": 11, "dic": 12}
CAMPOS = ["viernes", "puesto", "titulo", "titulo_original", "distribuidora", "semana", "cines",
          "recaudacion_eur", "espectadores", "acumulado_eur", "acumulado_espectadores", "url"]


# --------------------------------------------------------------------------- títulos

ART_ES = {"el", "la", "los", "las", "lo", "un", "una", "unos", "unas"}
ART_OTROS = {"the", "a", "an", "les", "le", "l'", "il", "gli", "die", "der", "das", "els", "os", "as"}
_ARTICULO_DETRAS = re.compile(
    r"^(?P<cuerpo>.+?),\s*(?P<art>" + "|".join(sorted((re.escape(a) for a in ART_ES | ART_OTROS), key=len, reverse=True))
    + r")(?P<resto>(?:\s*[.:;\-–(].*)?)$", re.I)


def articulo_delante(t):
    """'Bola negra, La' -> 'La bola negra'; 'Oveja Shaun, La. Mision calabaza' -> 'La oveja Shaun. Mision calabaza';
    'Invite, The' -> 'The Invite'. El ICAA pospone el artículo como en «apellidos, nombre»."""
    t = re.sub(r"\s+", " ", (t or "").strip())
    m = _ARTICULO_DETRAS.match(t)
    if not m:
        return t
    cuerpo, art, resto = m.group("cuerpo").strip(), m.group("art"), m.group("resto") or ""
    art = art[0].upper() + art[1:].lower()
    if art.lower() in ART_ES:
        primera = cuerpo.split(" ")[0]
        if not primera.isupper():  # 'Bola negra' -> 'bola negra', pero no 'ABBA'
            cuerpo = cuerpo[0].lower() + cuerpo[1:]
    sep = "" if art.endswith("'") else " "
    return f"{art}{sep}{cuerpo}{resto}"


def normalizar(t):
    t = unicodedata.normalize("NFKD", t or "").encode("ascii", "ignore").decode().lower()
    t = t.replace("&", " y ")
    return re.sub(r"[^a-z0-9]+", " ", t).strip()


@lru_cache(maxsize=None)
def clave(t):
    """Clave para comparar títulos: artículo delante, sin tildes ni puntuación, sin el artículo inicial."""
    palabras = normalizar(articulo_delante(t)).split()
    if len(palabras) > 1 and palabras[0] in (ART_ES | ART_OTROS | {"l"}):
        palabras = palabras[1:]
    return " ".join(palabras)


def clave_slug(pid):
    """'sentido-y-sensibilidad-2026' -> 'sentido y sensibilidad'."""
    p = pid.split("-")
    if len(p) > 1 and re.fullmatch(r"(19|20)\d\d", p[-1]):
        p = p[:-1]
    return clave(" ".join(p))


@lru_cache(maxsize=None)
def parecido(a, b):
    if not a or not b:
        return 0.0
    if a == b:
        return 1.0
    # Se compara con miles de títulos: primero las cotas rápidas, que nunca son menores que el parecido
    # real; si ya quedan por debajo de 0,85 (los umbrales son 0,9 y 0,92), no hace falta el cálculo entero.
    sm = SequenceMatcher(None, a, b)
    r = sm.real_quick_ratio()
    if r >= 0.85:
        r = sm.quick_ratio()
    if r >= 0.85:
        r = sm.ratio()
    corto, largo = sorted((a, b), key=len)
    if len(corto) >= 8 and largo.startswith(corto + " ") and len(corto) / len(largo) >= 0.6:
        r = max(r, 0.9)  # 'wildwood' frente a 'wildwood el bosque salvaje' no basta; esto sí: subtítulo omitido
    return r


def clave_fila(r):
    return clave(r["titulo"]) + "|" + clave(r.get("titulo_original") or "")


# --------------------------------------------------------------------------- lectura de PDF

_NUM = re.compile(r"^[-+]?(?:\d{1,3}(?:\.\d{3})+|\d+)(?:,\d+)?$")


def _entero(s):
    s = s.replace("−", "-").replace("€", "").replace("%", "").strip()
    return int(s.split(",")[0].replace(".", ""))


def _tipo(tok):
    t = tok.replace("−", "-").strip()
    if t == "€":
        return "signo_eur"
    if t == "%":
        return "signo_pct"
    if t in ("-", "–", "—"):
        return "vacio"
    if t.endswith("€") and _NUM.match(t[:-1].strip()):
        return "eur"
    if t.endswith("%") and _NUM.match(t[:-1].strip()):
        return "pct"
    if _NUM.match(t):
        return "num"
    return None


def _cola_numerica(palabras):
    """Índice donde empiezan las columnas numéricas (desde el final de la línea)."""
    i = len(palabras)
    while i > 0 and _tipo(palabras[i - 1]["text"]) is not None:
        i -= 1
    return i


def _items(palabras):
    """Convierte tokens numéricos en [(tipo, valor)] con tipo eur / pct / num."""
    out, i = [], 0
    while i < len(palabras):
        t = _tipo(palabras[i]["text"])
        sig = _tipo(palabras[i + 1]["text"]) if i + 1 < len(palabras) else None
        if t == "num" and sig == "signo_eur":
            out.append(("eur", _entero(palabras[i]["text"])))
            i += 2
            continue
        if t == "num" and sig == "signo_pct":
            out.append(("pct", None))
            i += 2
            continue
        if t == "eur":
            out.append(("eur", _entero(palabras[i]["text"])))
        elif t == "pct":
            out.append(("pct", None))
        elif t == "num":
            out.append(("num", _entero(palabras[i]["text"])))
        i += 1
    return out


def _lineas(pdf_bytes):
    import pdfplumber  # se instala en GitHub Actions (pip install pdfplumber)
    lineas = []
    with pdfplumber.open(io.BytesIO(pdf_bytes)) as pdf:
        for n, pagina in enumerate(pdf.pages):
            palabras = sorted(pagina.extract_words(x_tolerance=1.5, y_tolerance=2), key=lambda w: (w["top"], w["x0"]))
            actual, arriba = [], None
            for w in palabras:
                if arriba is not None and abs(w["top"] - arriba) > 2.5:
                    lineas.append(sorted(actual, key=lambda w: w["x0"]))
                    actual = []
                if not actual:
                    arriba = w["top"]
                actual.append(w)
            if actual:
                lineas.append(sorted(actual, key=lambda w: w["x0"]))
    return lineas


def _fecha_pie(texto):
    """'(*) Top 25 Fin de Semana. España: 06-08 Noviembre 2026' -> (viernes, domingo)."""
    for linea in texto.splitlines():
        n = normalizar(linea)
        if "espana" not in n and "semana" not in n:
            continue
        parte = n.split("espana", 1)[-1]
        tokens = parte.split()
        anios = [int(t) for t in tokens if re.fullmatch(r"(19|20)\d\d", t)]
        meses = [(k, MES3[t[:3]]) for k, t in enumerate(tokens) if t[:3] in MES3 and not t.isdigit()]
        if not anios or not meses:
            continue
        k_mes, mes = meses[-1]
        dias = [int(t) for t in tokens[:k_mes] if re.fullmatch(r"\d{1,2}", t)]
        if not dias:
            continue
        try:
            fin = dt.date(anios[-1], mes, dias[-1])
        except ValueError:
            continue
        viernes = fin - dt.timedelta(days=(fin.weekday() - 4) % 7)
        if (fin - viernes).days > 3:
            continue
        return viernes, fin
    return None


def _fecha_enlace(texto, nombre, anio):
    """Respaldo si el PDF no trae la fecha: '13 - 15 noviembre' + año del apartado, o el nombre del archivo."""
    for fuente in (texto, nombre):
        n = normalizar(fuente)
        tokens = re.findall(r"\d+|[a-z]+", n)
        meses = [(k, MES3[t[:3]]) for k, t in enumerate(tokens) if t[:3] in MES3 and not t.isdigit()]
        anios = [int(t) for t in tokens if re.fullmatch(r"(19|20)\d\d", t)]
        if not meses:
            continue
        k_mes, mes = meses[-1]
        dias = [int(t) for t in tokens[:k_mes] if re.fullmatch(r"\d{1,2}", t)]
        a = anios[-1] if anios else anio
        if not dias or not a:
            continue
        try:
            fin = dt.date(a, mes, dias[-1])
        except ValueError:
            continue
        viernes = fin - dt.timedelta(days=(fin.weekday() - 4) % 7)
        if (fin - viernes).days <= 3:
            return viernes, fin
    return None


def leer_pdf(pdf_bytes):
    """Devuelve {"fecha": (viernes, domingo) | None, "filas": [...], "total": {...} | None, "es_top25": bool,
    "error": str | None}."""
    lineas = _lineas(pdf_bytes)
    texto = "\n".join(" ".join(w["text"] for w in l) for l in lineas)
    n_texto = normalizar(texto)
    out = {"fecha": _fecha_pie(texto), "filas": [], "total": None, "error": None,
           "es_top25": "top 25" in n_texto or "top25" in n_texto or "espanol" not in n_texto}

    # cabecera: posición de las columnas
    cab = {}
    numericas = []
    for l in lineas:
        nl = [normalizar(w["text"]) for w in l]
        if not any(t in ("rank", "titulo", "distribuidora", "cines") for t in nl):
            continue
        for w, t in zip(l, nl):
            if t == "titulo":
                cab.setdefault("titulos", []).append(w["x0"])
            elif t == "original":
                cab["original"] = w["x0"]
            elif t.startswith("distribuidor"):
                cab["distribuidora"] = w["x0"]
            elif t.startswith("sem"):
                numericas.append(("semana", w["x0"]))
            elif t == "cines":
                numericas.append(("cines", w["x0"]))
            elif t in ("pantallas", "copias"):
                numericas.append(("pantallas", w["x0"]))
        if "distribuidora" in cab:
            break
    cols_num = [k for k, _ in sorted(dict(numericas).items(), key=lambda kv: kv[1])] or ["semana", "cines"]

    # filas de datos
    crudas = []
    for l in lineas:
        primero = l[0]["text"].strip()
        if primero.upper() == "TOTAL":
            items = _items(l[1:])
            eur = [v for t, v in items if t == "eur"]
            nums = [v for t, v in items if t == "num"]
            if eur:
                out["total"] = {"fin_eur": eur[0], "espect": nums[0] if nums else None}
            continue
        if not re.fullmatch(r"\d{1,2}", primero) or not any("€" in w["text"] for w in l):
            continue
        cola = _cola_numerica(l)
        items = _items(l[cola:])
        i_eur = next((k for k, (t, _) in enumerate(items) if t == "eur"), None)
        if i_eur is None:
            continue
        previos = [v for t, v in items[:i_eur] if t == "num"]
        sobran = len(previos) - len(cols_num)
        if sobran > 0:  # números que en realidad son el final del título
            cola += sobran
            previos = previos[sobran:]
        resto = items[i_eur + 1:]
        i_eur2 = next((k for k, (t, _) in enumerate(resto) if t == "eur"), None)
        medio = resto if i_eur2 is None else resto[:i_eur2]
        final = [] if i_eur2 is None else resto[i_eur2 + 1:]
        espect = [v for t, v in medio if t == "num"]
        espect_acum = [v for t, v in final if t == "num"]
        fila = {"puesto": int(primero), "texto": l[1:cola],
                "recaudacion_eur": items[i_eur][1],
                "espectadores": espect[0] if espect else None,
                "acumulado_eur": resto[i_eur2][1] if i_eur2 is not None else None,
                "acumulado_espectadores": espect_acum[0] if espect_acum else None}
        for k, v in zip(cols_num[-len(previos):] if previos else [], previos):
            fila[k] = v
        crudas.append(fila)

    # columnas de texto: título | título original | distribuidora
    _repartir_texto(crudas, cab)
    for f in crudas:
        f.pop("texto")
        f.setdefault("semana", None)
        f.setdefault("cines", None)
        f.pop("pantallas", None)
    out["filas"] = crudas
    out["avisos"] = _corregir_filas(out)
    out["error"] = _validar(out)
    return out


def _corregir_filas(r):
    """Datos raros dentro de un PDF que cuadra: se marcan, no tiran el fin de semana entero.
    Los mismos errores aparecen en eCartelera (vienen de la fuente), así que no son fallos de lectura."""
    avisos = []
    for f in r["filas"]:
        e, p = f["recaudacion_eur"], f["espectadores"]
        if p and not (1.5 <= e / p <= 45):
            # la recaudación cuadra con el TOTAL; lo dudoso son los espectadores
            avisos.append(f"puesto {f['puesto']}: {p} espectadores para {e} €; se dejan en blanco")
            f["espectadores"] = None
        if f["acumulado_eur"] is not None and f["acumulado_eur"] < e:
            avisos.append(f"puesto {f['puesto']}: acumulado ({f['acumulado_eur']}) menor que el fin de semana ({e}), como en la fuente")
    return avisos


def _repartir_texto(filas, cab):
    """Separa las palabras de texto en columnas buscando los huecos verticales que ninguna fila cruza."""
    tramos = sorted((w["x0"], w["x1"]) for f in filas for w in f["texto"])
    union = []
    for a, b in tramos:
        if union and a <= union[-1][1] + 0.8:
            union[-1][1] = max(union[-1][1], b)
        else:
            union.append([a, b])
    huecos = [(union[k][1], union[k + 1][0]) for k in range(len(union) - 1)]
    cortes = []
    titulos = sorted(cab.get("titulos", []))
    x_orig = cab.get("original") or (titulos[1] if len(titulos) > 1 else None)
    x_dist = cab.get("distribuidora")
    desde = union[0][0] if union else 0
    for x in (x_orig, x_dist):
        if x is None:
            continue
        cand = [h for h in huecos if h[0] >= desde and h[1] <= x + 3]
        if cand:
            h = max(cand, key=lambda h: h[1] - h[0])
            cortes.append((h[0] + h[1]) / 2)
            desde = h[1]
    if not cortes:  # sin cabecera reconocible: los dos huecos más anchos
        cortes = sorted((h[0] + h[1]) / 2 for h in sorted(huecos, key=lambda h: h[0] - h[1])[:2])
    nombres = ["titulo", "titulo_original", "distribuidora"]
    if len(cortes) == 1 and x_orig is None:
        nombres = ["titulo", "distribuidora"]
    for f in filas:
        partes = [[] for _ in range(len(cortes) + 1)]
        for w in f["texto"]:
            partes[sum(1 for c in cortes if w["x0"] > c)].append(w["text"])
        for nombre, p in zip(nombres, partes):
            f[nombre] = " ".join(p).strip()
        for nombre in nombres:
            f.setdefault(nombre, "")


def _validar(r):
    filas = r["filas"]
    if not r["es_top25"]:
        return "no es un top 25"
    if r["fecha"] is None:
        return "sin fecha"
    if len(filas) < 5:
        return f"solo {len(filas)} filas"
    if [f["puesto"] for f in filas] != list(range(1, len(filas) + 1)):
        return "puestos no consecutivos"
    if any(not f["titulo"] for f in filas):
        return "filas sin título"
    if not r["total"] and len(r.get("avisos") or []) > 2:
        return "sin fila TOTAL con la que comprobar y con datos raros"
    if r["total"] and len(filas) >= 20:
        suma = sum(f["recaudacion_eur"] for f in filas)
        if abs(suma - r["total"]["fin_eur"]) > max(5, 0.002 * r["total"]["fin_eur"]):
            return f"la suma ({suma}) no cuadra con el total ({r['total']['fin_eur']})"
    return None


# --------------------------------------------------------------------------- listado y descarga

def limpiar(s):
    s = re.sub(r"<[^>]+>", " ", s or "")
    return re.sub(r"\s+", " ", html.unescape(s)).strip()


def listar_pdfs(descargar):
    t = descargar(PAGINA)
    if not t:
        return []
    anios = [(m.start(), int(m.group(1)))
             for m in re.finditer(r"<h[1-6][^>]*>(?:\s|<[^>]+>)*(20\d\d)\b", t)]
    vistos, out = set(), []
    for orden, m in enumerate(re.finditer(r'<a\b[^>]*href="([^"]+?\.pdf)"[^>]*>(.*?)</a>', t, flags=re.S | re.I)):
        href, texto = html.unescape(m.group(1)), limpiar(m.group(2))
        nombre = href.rsplit("/", 1)[-1].lower()
        if not (re.match(r"top-?25", nombre) or re.match(r"top\s*25", texto, re.I)):
            continue
        if nombre.startswith("topesp"):  # «Cine español en cartelera» enlazado por error como top 25
            continue
        url = urljoin(PAGINA, href)
        if url in vistos:
            continue
        vistos.add(url)
        anio = None
        for pos, a in anios:
            if pos < m.start():
                anio = a
        out.append({"url": url, "texto": texto, "nombre": nombre, "anio": anio, "orden": orden})
    return out


def _version(nombre):
    m = re.search(r"-v(\d+)\.pdf$", nombre)
    return int(m.group(1)) if m else 1


def actualizar(descargar, desde, hoy):
    """Descarga y lee los PDF nuevos. Devuelve {viernes_iso: [filas]} solo con fines de semana válidos."""
    try:
        import pdfplumber  # noqa: F401
    except ImportError:
        print("  ! ICAA: falta pdfplumber (pip install pdfplumber). Se sigue solo con eCartelera.")
        return cargar_csv()
    estado = json.loads(ESTADO.read_text(encoding="utf-8")) if ESTADO.exists() else {}
    if estado.get("_version") != VERSION_LECTOR:
        estado = {"_version": VERSION_LECTOR}
    semanas = cargar_csv() if len(estado) > 1 else {}
    pdfs = listar_pdfs(descargar)
    if not pdfs:
        print("  ! ICAA: no se pudo leer la página de taquilla; se usa lo ya guardado.")
        return semanas
    orden = {p["url"]: p["orden"] for p in pdfs}
    nuevos = [p for p in pdfs if p["url"] not in estado]
    if nuevos:
        print(f"ICAA: {len(nuevos)} PDF sin procesar de {len(pdfs)}")
    for p in nuevos:
        fecha_enlace = _fecha_enlace(p["texto"], p["nombre"], p["anio"])
        if fecha_enlace and fecha_enlace[0].year < desde:
            continue  # anterior al histórico pedido: ni se descarga
        jcr = re.search(r"jcr:([0-9a-f-]+)", p["url"])
        ruta = CACHE / f"{jcr.group(1) if jcr else 'x'}_{p['nombre']}"
        if ruta.exists():
            datos = ruta.read_bytes()
        else:
            datos = descargar(p["url"], binario=True)
            if not datos or not datos.startswith(b"%PDF"):
                print(f"  ! ICAA: no se pudo descargar {p['nombre']}")
                continue  # sin estado: se reintenta en la siguiente ejecución
            ruta.parent.mkdir(parents=True, exist_ok=True)
            ruta.write_bytes(datos)
        try:
            r = leer_pdf(datos)
        except Exception as ex:  # PDF raro: se apunta y se sigue
            r = {"fecha": None, "filas": [], "total": None, "es_top25": True, "error": f"no se pudo leer: {ex}"}
        if r["fecha"] is None and fecha_enlace and r["filas"]:
            r["fecha"] = fecha_enlace  # el pie no trae fecha legible: se usa la del enlace
            r["error"] = _validar(r)
        v = r["fecha"][0].isoformat() if r["fecha"] else None
        estado[p["url"]] = {"viernes": v, "archivo": p["nombre"], "filas": len(r["filas"]), "error": r["error"]}
        if r.get("avisos") and not r["error"]:
            estado[p["url"]]["avisos"] = r["avisos"]
            print(f"  · ICAA {p['nombre']}: " + "; ".join(r["avisos"]))
        if r["error"]:
            print(f"  ! ICAA {p['nombre']}: {r['error']} (no se usa)")
            continue
        if fecha_enlace and fecha_enlace[0] != r["fecha"][0]:
            print(f"  · ICAA {p['nombre']}: el enlace dice {fecha_enlace[0]} y el PDF {r['fecha'][0]}; manda el PDF")
        semanas.setdefault(v, [])
        semanas[v] = [f for f in semanas[v] if f["url"] != p["url"]] + \
            [dict(f, viernes=v, url=p["url"]) for f in r["filas"]]
        print(f"  + ICAA {v}  {len(r['filas'])} películas")

    # un PDF por fin de semana: el de versión más alta (-v2...) y, a igualdad, el que va antes en la página
    elegido = {}
    for url, e in estado.items():
        if url.startswith("_") or not e.get("viernes") or e.get("error"):
            continue
        k = (_version(e["archivo"]), -orden.get(url, 10 ** 6))
        if e["viernes"] not in elegido or k > elegido[e["viernes"]][0]:
            elegido[e["viernes"]] = (k, url)
    semanas = {v: [f for f in fs if f["url"] == elegido[v][1]] for v, fs in semanas.items()
               if v >= f"{desde}-01-01" and v in elegido}
    semanas = {v: fs for v, fs in semanas.items() if fs}
    guardar_csv(semanas)
    ESTADO.write_text(json.dumps(estado, ensure_ascii=False, indent=1, sort_keys=True), encoding="utf-8")
    return semanas


def cargar_csv():
    semanas = {}
    if not SEMANAL.exists():
        return semanas
    with open(SEMANAL, encoding="utf-8-sig") as fh:
        for r in csv.DictReader(fh, delimiter=";"):
            for k in ("puesto", "semana", "cines", "recaudacion_eur", "espectadores", "acumulado_eur",
                      "acumulado_espectadores"):
                r[k] = int(r[k]) if r[k] not in ("", None) else None
            semanas.setdefault(r["viernes"], []).append(r)
    return semanas


def guardar_csv(semanas):
    SEMANAL.parent.mkdir(parents=True, exist_ok=True)
    with open(SEMANAL, "w", newline="", encoding="utf-8-sig") as fh:
        w = csv.DictWriter(fh, CAMPOS, delimiter=";", extrasaction="ignore")
        w.writeheader()
        for v in sorted(semanas):
            for f in sorted(semanas[v], key=lambda f: f["puesto"]):
                w.writerow(f)


# --------------------------------------------------------------------------- emparejado con eCartelera

def cargar_emparejado():
    mapa = {}
    if EMPAREJADO.exists():
        with open(EMPAREJADO, encoding="utf-8-sig") as fh:
            for r in csv.DictReader(fh, delimiter=";"):
                mapa[r["clave"]] = r
    return mapa


def guardar_emparejado(mapa):
    campos = ["clave", "titulo_icaa", "titulo_original", "pelicula_id", "metodo", "ultimo_fin"]
    with open(EMPAREJADO, "w", newline="", encoding="utf-8-sig") as fh:
        w = csv.DictWriter(fh, campos, delimiter=";", extrasaction="ignore")
        w.writeheader()
        for r in sorted(mapa.values(), key=lambda r: (r.get("ultimo_fin") or "", r["clave"]), reverse=True):
            w.writerow(r)


def _cifras_iguales(r, e):
    if r["espectadores"] is None or e.get("espect") is None or r["espectadores"] != e["espect"]:
        return False
    a, b = r["recaudacion_eur"], e.get("fin_eur")
    return b is not None and abs(a - b) <= max(2, 0.005 * a)  # eCartelera redondea por encima de 1 M€


def _eur_igual(r, e):
    """Misma recaudación del fin de semana (eCartelera redondea por encima de 1 M€). Las páginas antiguas
    de eCartelera traen los espectadores mal, así que la recaudación sola, con el puesto, ya identifica."""
    a, b = r["recaudacion_eur"], e.get("fin_eur")
    return bool(b) and abs(a - b) <= max(2, 0.0005 * a)  # al euro; con margen solo por encima de 1 M€


def variantes(t):
    """'Ballena, La (The Whale)' -> el título entero, sin el paréntesis y lo que va dentro."""
    t = t or ""
    out = [t, re.sub(r"\s*\([^)]*\)", "", t)] + re.findall(r"\(([^)]*)\)", t)
    return [v for v in dict.fromkeys(v.strip() for v in out) if v]


@lru_cache(maxsize=None)
def _claves(*titulos):
    """Claves de comparación de un título y sus variantes ('(re)' de un reestreno no es un título)."""
    return tuple(dict.fromkeys(k for t in titulos for v in variantes(t) if len(k := clave(v)) >= 3))


def _sim(r, titulo, pid):
    mias = _claves(r["titulo"], r.get("titulo_original") or "")
    suyas = _claves(titulo or "") + ((clave_slug(pid),) if pid and not pid.startswith("x-") else ())
    return max((parecido(a, b) for a in mias for b in suyas if len(b) >= 3), default=0.0)


def estreno_deducido(r, viernes):
    """Fecha de estreno que se deduce de la semana del ICAA (que cuenta desde el estreno)."""
    return viernes - dt.timedelta(days=7 * ((r.get("semana") or 1) - 1))


def coherencia(resultado, buscar=None, fecha=None):
    """Todas las semanas de un mismo estreno (misma clave y misma fecha de estreno deducida) con una sola
    película. eCartelera a veces enlaza mal una fila de su tabla (Barbie de 2023 a la de 2017, una semana
    de Guardianes de la Galaxia 3 a Guardianes de la noche...): se elige la película cuya ficha tiene un
    estreno que cuadra y, entre esas, la más repetida. Devuelve {(viernes, índice): id nuevo}."""
    grupos = {}
    for v in sorted(resultado):
        vd = dt.date.fromisoformat(v)
        for k, (r, pid, metodo, _) in enumerate(resultado[v]):
            est = estreno_deducido(r, vd)
            lista = grupos.setdefault(clave_fila(r), [])
            g = next((g for g in lista if abs((g["est"] - est).days) <= 14), None)
            if g is None:
                g = {"est": est, "filas": []}
                lista.append(g)
            g["filas"].append((v, k, r, pid, metodo))
    cambios = {}
    for lista in grupos.values():
        for g in lista:
            if any(m == "manual" for *_, m in g["filas"]):
                continue
            votos = {}
            for *_, pid, _ in g["filas"]:
                if not pid.startswith("x-"):
                    votos[pid] = votos.get(pid, 0) + 1
            def cuadra(pid):
                f = fecha(pid) if fecha else None
                return None if f is None else abs((f - g["est"]).days) <= 31
            buenos = [p for p in votos if cuadra(p)] or [p for p in votos if cuadra(p) is None]
            elegido = max(buenos, key=lambda p: votos[p]) if buenos else None
            if elegido is None and buscar:
                v0, _, r0, _, _ = g["filas"][0]
                elegido = buscar(r0, dt.date.fromisoformat(v0))
            if elegido is None and votos:
                # ninguna cuadra: la de fecha más cercana (Drácula de 2025 trae la fecha del estreno
                # internacional, pero mejor esa que la de 1931); sin fechas, la más repetida
                fechas = {p: fecha(p) for p in votos} if fecha else {}
                cerca = sorted((abs((f - g["est"]).days), -votos[p], p) for p, f in fechas.items() if f)
                elegido = cerca[0][2] if cerca and cerca[0][0] <= 365 else max(votos, key=votos.get)
            if elegido is None:
                continue
            for v, k, _, pid, _ in g["filas"]:
                if pid != elegido:
                    cambios[(v, k)] = elegido
    return cambios


def emparejar(semanas, ec_por_fin, candidatos, en_cartelera, buscar=None, fecha=None):
    """Asigna a cada fila del ICAA el id de película de eCartelera.

    semanas      {viernes: [filas ICAA]}
    ec_por_fin   {viernes: [filas eCartelera con 'id', 'titulo', 'pos', 'fin_eur', 'espect'...]}
    candidatos   {id: título} de eCartelera (películas con taquilla, sesiones y próximos estrenos)
    en_cartelera {viernes: set(id)} películas con sesiones ese fin de semana (captura de los viernes)
    buscar       función (fila, viernes) -> id | None que localiza la ficha de eCartelera por el título
                 (para películas que nunca salieron en el top de eCartelera)

    Orden de confianza:
      1. manual: data/icaa_emparejado.csv con metodo=manual.
      2. cifras: el mismo fin de semana en eCartelera con los mismos espectadores y recaudación
         (ambas fuentes son Rentrak/comScore, así que coinciden), o con la misma recaudación y casi
         el mismo puesto (las páginas antiguas de eCartelera traen mal los espectadores).
      3. continuidad: la película ya estaba emparejada la semana anterior (semana > 1 en el ICAA).
      4. título: artículo pospuesto, tildes y puntuación normalizados; se compara el título en
         español y el original con el título y el identificador de eCartelera. Solo se acepta un
         parecido muy alto y sin otro candidato cercano; en estrenos solo entre películas en cartelera
         ese fin de semana o próximos estrenos.
      4b. ficha: se busca la página de la película en eCartelera a partir del título y solo se acepta
         si su fecha de estreno cuadra con la semana que da el ICAA (películas que venían de 2019,
         o puestos 11 a 25 de años en que eCartelera solo publicaba el top 10).
      5. sin pareja: id provisional 'x-<título>'.
      6. coherencia: todas las semanas de un mismo estreno se quedan con una sola película, la que tenga
         una ficha con la fecha de estreno que cuadra (ver coherencia()). Cuando eCartelera publique ese fin de semana,
         la siguiente ejecución la empareja por cifras.
    Devuelve ({viernes: [(fila, id, metodo, fila_ec | None)]}, [diferencias entre fuentes]).
    """
    mapa = cargar_emparejado()
    primera_vez = {}
    for v in sorted(ec_por_fin):
        for e in ec_por_fin[v]:
            primera_vez.setdefault(e["id"], v)
    resultado, contraste = {}, []
    for v in sorted(semanas):
        filas = semanas[v]
        ec = ec_por_fin.get(v, [])
        asign = {}
        # 1. manual
        for i, r in enumerate(filas):
            m = mapa.get(clave_fila(r))
            if m and m.get("metodo") == "manual" and m.get("pelicula_id"):
                asign[i] = (m["pelicula_id"], "manual", next((e for e in ec if e["id"] == m["pelicula_id"]), None))
        # 2. cifras (y título + puesto como desempate) contra eCartelera del mismo fin de semana
        if ec:
            usados = {a[0] for a in asign.values()}
            pares = []
            for i, r in enumerate(filas):
                if i in asign:
                    continue
                for j, e in enumerate(ec):
                    c = _cifras_iguales(r, e)
                    cerca = abs(r["puesto"] - e["pos"]) <= 2
                    ce = cerca and _eur_igual(r, e)
                    s = _sim(r, e.get("titulo"), e["id"])
                    if c or ce or (s >= 0.9 and cerca):
                        pares.append((c, ce, s, i, j))
            hechos = set()
            for c, ce, s, i, j in sorted(pares, reverse=True):
                if i in asign or j in hechos or ec[j]["id"] in usados:
                    continue
                asign[i] = (ec[j]["id"], "cifras" if c or ce else "titulo", ec[j])
                hechos.add(j)
                usados.add(ec[j]["id"])
        # 3 y 4. continuidad y título
        usados = {a[0] for a in asign.values()}
        vd = dt.date.fromisoformat(v)
        cartelera = en_cartelera.get(v, set())
        for i, r in enumerate(filas):
            if i in asign:
                continue
            m = mapa.get(clave_fila(r))
            if m and m.get("pelicula_id") and m["pelicula_id"] not in usados and (r.get("semana") or 0) > 1 \
                    and m.get("ultimo_fin"):
                dias = (vd - dt.date.fromisoformat(m["ultimo_fin"])).days
                if 0 < dias <= 35:
                    asign[i] = (m["pelicula_id"], "continuidad", None)
                    usados.add(m["pelicula_id"])
                    continue
            estreno = (r.get("semana") or 0) <= 1
            puntos = []
            for pid, titulo in candidatos.items():
                if pid in usados:
                    continue
                previa = primera_vez.get(pid)
                if estreno and previa is not None and previa < v:
                    continue  # una película que ya tuvo taquilla antes no puede ser un estreno
                s = _sim(r, titulo, pid)
                if pid in cartelera:
                    s += 0.01  # a igualdad, la que tiene sesiones ese fin de semana
                puntos.append((s, pid))
            puntos.sort(reverse=True)
            if puntos and puntos[0][0] >= 0.92 and (len(puntos) == 1 or puntos[1][0] <= puntos[0][0] - 0.04):
                asign[i] = (puntos[0][1], "titulo", None)
                usados.add(puntos[0][1])
                continue
            # 4b. ficha de eCartelera buscada por el título, validada con la fecha de estreno
            if buscar:
                pid = buscar(r, vd)
                if pid and pid not in usados:
                    asign[i] = (pid, "ficha", None)
                    usados.add(pid)
        # 5. sin pareja
        salida = []
        for i, r in enumerate(filas):
            if i in asign:
                pid, metodo, e = asign[i]
            else:
                pid, metodo, e = "x-" + re.sub(r"[^a-z0-9]+", "-", normalizar(articulo_delante(r["titulo"]))).strip("-"), "sin pareja", None
            salida.append((r, pid, metodo, e))
            if not pid.startswith("x-") and metodo != "manual":
                k = clave_fila(r)
                previo = mapa.get(k)
                if not previo or previo.get("metodo") != "manual":
                    mapa[k] = {"clave": k, "titulo_icaa": r["titulo"], "titulo_original": r.get("titulo_original") or "",
                               "pelicula_id": pid, "metodo": metodo if metodo != "continuidad" else (previo or {}).get("metodo", metodo),
                               "ultimo_fin": v}
            elif metodo == "manual":
                mapa[clave_fila(r)]["ultimo_fin"] = v
            if e:
                for campo, a, b, tol in (("recaudacion", r["recaudacion_eur"], e.get("fin_eur"), 0.005),
                                         ("espectadores", r["espectadores"], e.get("espect"), 0),
                                         ("acumulado", r["acumulado_eur"], e.get("total_eur"), 0.006),
                                         ("cines", r.get("cines"), e.get("cines"), 0),
                                         ("semana", r.get("semana"), e.get("semana"), 0)):
                    if a is not None and b is not None and abs(a - b) > max(tol * a, 2 if tol else 0):
                        contraste.append({"viernes": v, "pelicula_id": pid, "titulo": r["titulo"], "campo": campo,
                                          "icaa": a, "ecartelera": b})
        resultado[v] = salida
    # 6. una sola película por estreno (corrige enlaces equivocados de eCartelera y semanas sueltas)
    for (v, k), pid in sorted(coherencia(resultado, buscar, fecha).items()):
        r = resultado[v][k][0]
        resultado[v][k] = (r, pid, "coherencia", None)  # la fila de eCartelera enlazaba otra ficha
        clave_r = clave_fila(r)
        previo = mapa.get(clave_r) or {}
        if previo.get("metodo") != "manual" and v >= (previo.get("ultimo_fin") or ""):
            mapa[clave_r] = {"clave": clave_r, "titulo_icaa": r["titulo"], "titulo_original": r.get("titulo_original") or "",
                             "pelicula_id": pid, "metodo": "coherencia", "ultimo_fin": v}
    guardar_emparejado(mapa)
    with open(CONTRASTE, "w", newline="", encoding="utf-8-sig") as fh:
        w = csv.DictWriter(fh, ["viernes", "pelicula_id", "titulo", "campo", "icaa", "ecartelera"], delimiter=";")
        w.writeheader()
        w.writerows(contraste)
    return resultado, contraste


# --------------------------------------------------------------------------- comprobación para el calendario

def fin_esperado(hoy):
    """Último fin de semana que el ICAA ya debería tener: el anterior al último jueves (incluido hoy)."""
    jueves = hoy - dt.timedelta(days=(hoy.weekday() - 3) % 7)
    return jueves - dt.timedelta(days=6)


def falta(hoy=None):
    v = fin_esperado(hoy or dt.date.today()).isoformat()
    return v not in cargar_csv(), v


if __name__ == "__main__":
    import argparse
    import os
    ap = argparse.ArgumentParser(description="Comprueba si falta la taquilla del ICAA del último fin de semana.")
    ap.add_argument("--comprobar", action="store_true")
    args = ap.parse_args()
    if args.comprobar:
        hace_falta, v = falta()
        print(f"Fin de semana del {v}: {'falta' if hace_falta else 'ya está'} en data/icaa_top25.csv")
        if os.environ.get("GITHUB_OUTPUT"):
            with open(os.environ["GITHUB_OUTPUT"], "a", encoding="utf-8") as fh:
                fh.write(f"falta={'true' if hace_falta else 'false'}\n")
