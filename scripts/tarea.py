"""
Actualización completa, pensada para el Programador de tareas de Windows (se lanza con pythonw, sin ventana).

  1. sesiones.py  -> solo trabaja de viernes a domingo (sesiones por cine)
  2. ingesta.py   -> taquilla nueva + regenera la web

Todo queda registrado en data/actualizacion.log.
"""

import datetime as dt
import sys
import traceback
from pathlib import Path

RAIZ = Path(__file__).resolve().parent.parent
LOG = RAIZ / "data" / "actualizacion.log"
sys.path.insert(0, str(Path(__file__).resolve().parent))


def main():
    LOG.parent.mkdir(parents=True, exist_ok=True)
    with open(LOG, "a", encoding="utf-8", buffering=1) as log:
        sys.stdout = sys.stderr = log
        print(f"\n===== {dt.datetime.now():%Y-%m-%d %H:%M} =====")
        try:
            import ingesta
            import sesiones
            sys.stdout = sys.stderr = log  # ingesta reconfigura stdout al importarse
            sys.argv = ["sesiones.py"]
            sesiones.main()
            sys.argv = ["ingesta.py"]
            ingesta.main()
        except Exception:
            traceback.print_exc()


if __name__ == "__main__":
    main()
