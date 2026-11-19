# Taquilla España

Web para estudiar si una película funciona en taquilla, con datos públicos que se actualizan solos.

## Secciones

- **Explorar.** Mapa con calles: pulsa una comunidad para ver sus provincias y una provincia para ver sus cines. Cada cine abre su cartelera del fin de semana con la estimación por película. Al lado está la ficha de la película:
  - semáforo de éxito o fracaso y previsión de taquilla final;
  - evolución semana a semana y críticas (nota media, prensa y público);
  - próximos estrenos en un bloque plegable.
- **Películas.** Tabla ordenable con filtros por título, director, año y origen. Al elegir un director aparece su resumen: número de películas, taquilla sumada, la más taquillera y veredictos. Los nombres de director de la ficha llevan a este filtro.
- **Calendario.** Próximos fines de semana con estrenos y, para cada fin de semana pasado:
  - qué se estrenó y cuánto hizo cada estreno;
  - qué parte del mercado se llevaron los estrenos;
  - cómo fue el total frente a la media de las 8 semanas anteriores.
- **Cadenas.** Cinesa, Yelmo, Kinépolis…: cines, sesiones, cuota y recaudación estimada, y qué películas programa más cada una.
- **Cara a cara.** Dos películas lado a lado: métricas, críticas y curvas.
- **Administración** (rueda dentada), con un único usuario:
  - actualizar los datos;
  - cambiar el título, el aviso, las pestañas visibles y la película inicial (`web/config.json`);
  - cambiar el usuario, la contraseña o el token.

## Cómo abrirla

| Forma | Cómo | Administración |
|---|---|---|
| Archivo | Doble clic en `web/index.html` | No disponible (un archivo no puede guardar ni ejecutar nada) |
| Servidor local | Doble clic en `servidor.bat` (abre http://localhost:8765) | Actualiza en tu PC y guarda la configuración en disco |
| GitHub Pages | Ver más abajo | Lanza la tarea de GitHub Actions y guarda la configuración con un commit |

**Primer uso de la administración:** abre la web con `servidor.bat` o ya publicada, pulsa la rueda dentada y crea el acceso con un usuario y una contraseña de al menos 12 caracteres. Online también te pedirá el token de GitHub.

**Cómo se protege sin servidor:** `web/admin.json` es público, pero guarda el token cifrado (AES-GCM) con una clave que sale de tu usuario y contraseña (PBKDF2, 600.000 iteraciones). Sin la contraseña no se puede descifrar el token, y sin token no se puede cambiar nada del repositorio.

Una contraseña olvidada no se recupera: se crea un acceso nuevo con un token nuevo y se revoca el anterior en GitHub. En local, actualizar los datos no pide contraseña, porque el servidor solo escucha en tu PC.

En los tres casos la web funciona igual. Los datos se actualizan solos en GitHub Actions (ver *Calendario*). Para descargarlos en tu PC sin publicar nada, usa `actualizar.bat`.

## Publicar sin exponer tu cuenta

Antes del primer commit:

1. **Cuenta de GitHub:** activa la verificación en dos pasos. En *Settings › Emails*, marca *Keep my email addresses private* y *Block command line pushes that expose my email*, y copia tu dirección `…@users.noreply.github.com`.
2. **Email solo para este repositorio:** tu git tiene un email global que se vería en cada commit público. En la carpeta del proyecto, ejecuta:
   ```
   git init
   git config user.email "TU_ID+TU_USUARIO@users.noreply.github.com"
   git config user.name "TU_USUARIO"
   ```
   Compruébalo con `git log --format="%an <%ae>"` antes de subir nada.
3. **Repositorio:** créalo público y vacío. En *Settings › Code security*, activa *Secret scanning* y *Push protection*, que bloquean cualquier token subido por error.
4. **Token de la administración:** usa uno *fine-grained* con estas condiciones:
   - *Only select repositories*, solo este repositorio;
   - permisos *Actions* y *Contents* de lectura y escritura, nada más;
   - caducidad de 90 días.
5. **Contraseña de la administración:** crea el acceso en la web ya publicada, no en local. Usa una contraseña larga y única, de 16 o más caracteres o 5 o 6 palabras al azar, guardada en un gestor de contraseñas. Es lo que protege el token frente a quien descargue `admin.json`.

Si alguien llegara a descifrar el token, solo podría modificar este repositorio y lanzar sus tareas. No podría entrar en tu cuenta, ver tu email ni tocar otros repositorios. Se revoca en *Settings › Developer settings › Fine-grained tokens*.

## Publicarla gratis en GitHub Pages (cuando quieras)

1. Crea un repositorio **público** en GitHub y sube esta carpeta.
2. En *Settings › Pages*, elige *Source: GitHub Actions*.
3. En *Actions*, ejecuta «actualizar» una vez. La primera ejecución tarda entre una y dos horas porque descarga el histórico desde 2020.

4. Crea un token *fine-grained* limitado a ese repositorio, con permisos **Actions** y **Contents** de lectura y escritura. Después, en la web publicada, pulsa la rueda dentada y crea el acceso de administración con ese token.

A partir de ahí, `.github/workflows/actualizar.yml` actualiza los datos en la nube sin depender de tu PC. Cuando cambias algo en la administración (aviso, pestañas…), el mismo flujo republica la web en uno o dos minutos sin volver a descargar datos.

## Calendario

El ICAA publica el **jueves** la taquilla del fin de semana anterior.

| Día | Qué hace |
|---|---|
| Jueves 15:37 UTC | Carga la taquilla del ICAA (y la de eCartelera si ya está) |
| Viernes 11:00 UTC | Revisión completa: taquilla, fichas, críticas, estrenos y sesiones de los cines |
| Sábado 10:23 UTC | Solo si todavía falta el fin de semana pasado en el ICAA; si no, termina sin hacer nada |

Un push a `main` solo republica la web, salvo que el mensaje del commit lleve `[datos]`: entonces también descarga los datos.

## Fuentes y qué es estimado

| Dato | Fuente | Granularidad |
|---|---|---|
| Recaudación, espectadores, cines, acumulado en euros y en espectadores, distribuidora | ICAA, top 25 semanal en PDF (datos de Rentrak), desde 2020 | película × fin de semana (top 25) |
| Lo mismo para fines de semana que el ICAA no tenga | eCartelera (datos comScore) | película × fin de semana (top 25) |
| Ficha: país, género, director, distribuidora, presupuesto | eCartelera | película |
| Críticas: nota media, prensa (positivas, mixtas, negativas y citas), público | eCartelera, página de críticas | película |
| Sesiones, precio, cadena y ubicación de cada cine | eCartelera, ficha de cine | cine × película × día (vie, sáb, dom) |
| Próximos estrenos en cines | eCartelera | película × fecha |
| Peso por comunidad, precio medio, reparto por día | ICAA, Estadística de Cinematografía 2025 | comunidad |
| Mapa base | Esri (sin clave; funciona también con doble clic) | |

- **Real:** las cifras nacionales por película y fin de semana.
- **ICAA y eCartelera:** las dos publican los mismos datos de Rentrak/comScore. El ICAA sale antes (el jueves) y trae los acumulados exactos, los cines de las 25 películas y los espectadores totales; eCartelera redondea los acumulados por encima de 1 M€ y solo da los cines del top 10. Por eso, cuando un fin de semana está en las dos, manda el ICAA. Cada PDF se valida (puestos seguidos y suma igual a la fila TOTAL); si no cuadra, ese fin de semana se queda con eCartelera. Las diferencias entre ambas se guardan en `data/contraste_fuentes.csv`.
- **Emparejado de títulos:** el ICAA escribe el artículo al final («Bola negra, La») y a menudo sin tildes. Cada título se empareja con su película de eCartelera, por este orden: corrección manual, mismas cifras el mismo fin de semana, continuidad con la semana anterior y, para los estrenos, parecido de título (en español u original) solo entre las películas en cartelera ese fin de semana. Lo que no se puede emparejar con seguridad entra con un id provisional y se corrige solo cuando eCartelera publica ese fin de semana. Para forzar una pareja, edita `data/icaa_emparejado.csv` y pon `manual` en la columna `metodo`.
- **Pandemia:** las películas cuya carrera cae entre marzo de 2020 y junio de 2021 (cines cerrados o con aforo limitado) se ven en la web, pero no se usan para comparar ni para prever.
- **Estimado:** comunidad, provincia, cine y cadena. La taquilla nacional se reparte con el peso de cada comunidad y, dentro de ella, con las sesiones × el precio de cada cine.
- **Deducido:** la recaudación entre semana, a partir de los totales acumulados.
- **Previsión final:** total actual × la relación «total final / total en la misma semana» de las 25 películas ya retiradas más parecidas (apertura por cine, número de cines, género y origen). Se muestra la mediana y el rango entre el percentil 25 y el 75.

## Archivos

- `scripts/ingesta.py`: taquilla, fichas, críticas, estrenos, métricas y generación de la web.
- `scripts/icaa.py`: lectura de los PDF del ICAA, validación y emparejado con eCartelera. `python scripts/icaa.py --comprobar` dice si falta el último fin de semana.
- `scripts/sesiones.py`: sesiones por cine. Si se corta, continúa donde lo dejó.
- `scripts/servidor.py`: servidor local con el botón de actualizar. Solo escucha en tu PC.
- `scripts/tarea.py` y `scripts/programar_tarea.ps1`: tarea programada de Windows. No está activa porque las actualizaciones se hacen en GitHub.
- `.github/workflows/actualizar.yml`: actualización y publicación en GitHub.
- `data/peliculas.csv` y `data/taquilla_fines_de_semana.csv`: los datos para Excel (separador `;`). La columna `fuente` dice de dónde sale cada fila.
- `data/icaa_top25.csv`: el top 25 del ICAA tal como viene en los PDF. `data/icaa_pdfs.json`: qué PDF se ha leído y por qué se ha descartado alguno.
- `data/icaa_emparejado.csv`: título del ICAA → película. `data/contraste_fuentes.csv`: diferencias entre ICAA y eCartelera.
- `data/cache/`: HTML ya descargado. No se sube a GitHub.
- `web/`: la web.
