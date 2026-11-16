"""
Servidor local de la web, con el botón de actualizar de la zona de desarrollador.

  python scripts/servidor.py            # abre http://localhost:8765 en el navegador
  python scripts/servidor.py --no-abrir

Solo escucha en 127.0.0.1 (no es accesible desde otros equipos).
  GET  /api/estado      -> estado de la última actualización y su registro
  POST /api/actualizar  -> lanza sesiones.py + ingesta.py en segundo plano
"""

import argparse
import datetime as dt
import json
import subprocess
import sys
import threading
import webbrowser
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

RAIZ = Path(__file__).resolve().parent.parent
WEB = RAIZ / "web"
ESTADO = {"en_curso": False, "inicio": None, "fin": None, "codigo": None, "log": []}
CANDADO = threading.Lock()


def actualizar():
    ESTADO.update(en_curso=True, inicio=dt.datetime.now().isoformat(timespec="seconds"), fin=None, codigo=None, log=[])
    codigo = 0
    for script in ("sesiones.py", "ingesta.py"):
        ESTADO["log"].append(f"$ python {script}")
        proc = subprocess.Popen([sys.executable, "-I", str(RAIZ / "scripts" / script)], cwd=RAIZ,
                                stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True, encoding="utf-8", errors="replace")
        for linea in proc.stdout:
            ESTADO["log"].append(linea.rstrip())
            del ESTADO["log"][:-300]
        codigo = codigo or proc.wait()
    ESTADO.update(en_curso=False, fin=dt.datetime.now().isoformat(timespec="seconds"), codigo=codigo)


class Manejador(SimpleHTTPRequestHandler):
    def end_headers(self):
        self.send_header("Cache-Control", "no-store")  # siempre la última versión de datos y código
        super().end_headers()

    def _json(self, datos, codigo=200):
        cuerpo = json.dumps(datos, ensure_ascii=False).encode("utf-8")
        self.send_response(codigo)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(cuerpo)))
        self.end_headers()
        self.wfile.write(cuerpo)

    def do_GET(self):
        if self.path.split("?")[0] == "/api/estado":
            return self._json(ESTADO)
        return super().do_GET()

    def do_POST(self):
        if self.path not in ("/api/actualizar", "/api/guardar"):
            return self._json({"error": "no existe"}, 404)
        # la cabecera propia obliga a una comprobación CORS que este servidor no concede:
        # así ninguna otra web abierta en el navegador puede lanzar estas acciones
        if self.headers.get("X-Taquilla") != "1":
            return self._json({"error": "petición no permitida"}, 403)
        if self.path == "/api/guardar":
            try:
                datos = json.loads(self.rfile.read(int(self.headers.get("Content-Length", 0))))
                if datos.get("archivo") not in ("admin.json", "config.json"):
                    return self._json({"error": "archivo no permitido"}, 400)
                json.loads(datos["contenido"])  # solo JSON válido
                (WEB / datos["archivo"]).write_text(datos["contenido"], encoding="utf-8")
            except (ValueError, KeyError):
                return self._json({"error": "datos no válidos"}, 400)
            return self._json({"ok": True})
        with CANDADO:
            if not ESTADO["en_curso"]:
                ESTADO["en_curso"] = True
                threading.Thread(target=actualizar, daemon=True).start()
        return self._json(ESTADO, 202)

    def log_message(self, *args):
        pass


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--puerto", type=int, default=8765)
    ap.add_argument("--no-abrir", action="store_true")
    args = ap.parse_args()
    servidor = ThreadingHTTPServer(("127.0.0.1", args.puerto), partial(Manejador, directory=str(WEB)))
    url = f"http://localhost:{args.puerto}/"
    print(f"Taquilla España en {url}  (Ctrl+C para cerrar)")
    if not args.no_abrir:
        webbrowser.open(url)
    try:
        servidor.serve_forever()
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()
