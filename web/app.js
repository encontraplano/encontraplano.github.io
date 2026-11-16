/* Taquilla España
   Lee window.DATOS (scripts/ingesta.py), window.MAPA (contornos y cines) y, bajo demanda,
   data/criticas.js y data/sesiones/<viernes>.js. */
(() => {
  "use strict";
  const D = window.DATOS, M = window.MAPA;
  if (!D || !M) {
    document.querySelector("main").innerHTML =
      `<p class="vacio">Faltan los datos. Ejecuta <code>python scripts/ingesta.py</code> y recarga la página.</p>`;
    return;
  }

  // ================================================================== formatos
  const NADA = "–";
  const nf = new Intl.NumberFormat("es-ES");
  const eur = v => v == null || isNaN(v) ? NADA : Math.abs(v) >= 1e6
    ? (v / 1e6).toLocaleString("es-ES", { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + " M€"
    : nf.format(Math.round(v)) + " €";
  const eurCorto = v => v == null || isNaN(v) ? NADA : Math.abs(v) >= 1e6
    ? (v / 1e6).toLocaleString("es-ES", { maximumFractionDigits: 1 }) + " M€"
    : Math.abs(v) >= 1e3 ? Math.round(v / 1e3) + " mil €" : Math.round(v) + " €";
  const num = v => v == null || isNaN(v) ? NADA : nf.format(Math.round(v));
  const pct = v => v == null || isNaN(v) ? NADA : (v > 0 ? "+" : v < 0 ? "−" : "") + Math.abs(v).toLocaleString("es-ES", { maximumFractionDigits: 0 }) + " %";
  const mult = v => v == null || isNaN(v) ? NADA : v.toLocaleString("es-ES", { maximumFractionDigits: 2 }) + "×";
  const dec = (v, n = 1) => v == null ? NADA : v.toLocaleString("es-ES", { minimumFractionDigits: n, maximumFractionDigits: n });
  const MES = ["ene", "feb", "mar", "abr", "may", "jun", "jul", "ago", "sep", "oct", "nov", "dic"];
  const fechaFin = i => {
    const v = new Date(D.fines[i] + "T12:00:00"), d = new Date(v); d.setDate(v.getDate() + 2);
    return v.getMonth() === d.getMonth()
      ? `${v.getDate()}–${d.getDate()} ${MES[d.getMonth()]} ${d.getFullYear()}`
      : `${v.getDate()} ${MES[v.getMonth()]} a ${d.getDate()} ${MES[d.getMonth()]} ${d.getFullYear()}`;
  };
  const fechaLarga = iso => iso ? new Date(iso + "T12:00:00").toLocaleDateString("es-ES", { day: "numeric", month: "long", year: "numeric" }) : NADA;
  const fechaCorta = iso => new Date(iso + "T12:00:00").toLocaleDateString("es-ES", { weekday: "short", day: "numeric", month: "short" });
  const esc = s => String(s ?? "").replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
  // enlaces e imágenes que vienen de fuera: solo http(s), nunca javascript: ni data:
  const url = u => /^https?:\/\//i.test(String(u || "")) ? esc(u) : "#";
  const css = n => getComputedStyle(document.documentElement).getPropertyValue(n).trim();
  const $ = id => document.getElementById(id);
  const guardar = (k, v) => { try { localStorage.setItem("taq-" + k, JSON.stringify(v)); } catch (e) { /* sin almacenamiento */ } };
  const leer = (k, def) => { try { const v = localStorage.getItem("taq-" + k); return v == null ? def : JSON.parse(v); } catch (e) { return def; } };
  const lista = a => a.length <= 1 ? (a[0] || "") : a.slice(0, -1).join(", ") + " y " + a[a.length - 1];

  // ================================================================== datos
  const [F, P, POS, SEM, FE, ES, CI, TOT, ESEM] = [0, 1, 2, 3, 4, 5, 6, 7, 8];
  const ULT = D.fines.length - 1;
  const pelis = D.pelis;
  const porPeli = pelis.map(() => []);
  const porFin = D.fines.map(() => []);
  D.filas.forEach(r => { porPeli[r[P]].push(r); porFin[r[F]].push(r); });
  porPeli.forEach(rs => rs.sort((a, b) => a[F] - b[F]));
  porFin.forEach(rs => rs.sort((a, b) => a[POS] - b[POS]));
  const ULT_TAQ = D.filas.reduce((m, r) => Math.max(m, r[F]), 0);  // último finde con taquilla publicada
  const SES = D.sesiones || [];                                      // findes con sesiones por cine
  const sesPorPeli = pelis.map(() => []);
  SES.forEach(s => s.pelis.forEach(i => sesPorPeli[i].push(s.fin)));
  const idPeli = new Map(pelis.map((p, i) => [p.id, i]));

  pelis.forEach((p, i) => {
    const rs = porPeli[i];
    const todos = rs.map(r => r[F]).concat(sesPorPeli[i]);
    p.i = i;
    p.anio = (p.primer_fin || p.estreno || "").slice(0, 4);
    p.conTaquilla = rs.length > 0;
    p.ultimoFin = rs.length ? rs[rs.length - 1][F] : -1;
    p.primerFinIdx = todos.length ? Math.min(...todos) : ULT;
    p.ultimoPaso = todos.length ? Math.max(...todos) : ULT;
    p.enCartelera = p.conTaquilla && p.ultimoFin >= ULT_TAQ;
    p.espectFindes = rs.reduce((s, r) => s + (r[ES] || 0), 0);
    p.porCine = p.apertura_cines ? p.apertura_eur / p.apertura_cines : null;
    p.aguante = p.caida_2 == null ? null : 100 + p.caida_2;
    p.genero = (p.generos || [])[0] || NADA;
    p.origen = p.espanola ? "España" : ((p.paises || [])[0] || NADA);
  });

  // directores
  const porDirector = new Map();
  pelis.forEach(p => (p.director || []).forEach(d => {
    if (!porDirector.has(d)) porDirector.set(d, []);
    porDirector.get(d).push(p.i);
  }));

  // pesos por comunidad (ICAA 2025)
  const C = D.ccaa;
  const suma = k => C.reduce((s, c) => s + c[k], 0);
  const sEsp = suma("rec_esp_meur"), sExt = suma("rec_ext_meur");
  const pesoEsp = C.map(c => c.rec_esp_meur / sEsp), pesoExt = C.map(c => c.rec_ext_meur / sExt);
  const espW = pesos => { const raw = pesos.map((w, k) => w / C[k].precio_medio_eur); const t = raw.reduce((a, b) => a + b, 0); return raw.map(x => x / t); };
  const espEsp = espW(pesoEsp), espExt = espW(pesoExt);
  const diaFac = C.map(c => {
    const t = c.pct_viernes + c.pct_sabado + c.pct_domingo;
    return { todo: 1, v: c.pct_viernes / t, s: c.pct_sabado / t, d: c.pct_domingo / t };
  });
  const idxCcaa = Object.fromEntries(C.map((c, k) => [c.ccaa, k]));

  function reparto(euros, espect, espanola, dia, out) {
    const w = espanola ? pesoEsp : pesoExt, we = espanola ? espEsp : espExt;
    for (let k = 0; k < C.length; k++) {
      const f = diaFac[k][dia];
      out[k].eur += euros * w[k] * f;
      out[k].espect += espect * we[k] * f;
    }
    return out;
  }
  const vacio = () => C.map(() => ({ eur: 0, espect: 0 }));

  function valores(st, fin) {
    const out = vacio();
    let hay = false;
    if (st.peli < 0) {
      for (const r of porFin[fin]) { reparto(r[FE] || 0, r[ES] || 0, pelis[r[P]].espanola, st.dia, out); hay = true; }
    } else {
      const p = pelis[st.peli], rs = porPeli[st.peli];
      if (st.periodo === "acum") {
        const hasta = rs.filter(r => r[F] <= fin);
        if (hasta.length) {
          const ult = hasta[hasta.length - 1];
          reparto(Math.max(ult[TOT] || 0, hasta.reduce((s, r) => s + (r[FE] || 0), 0)),
            hasta.reduce((s, r) => s + (r[ES] || 0), 0), p.espanola, "todo", out);
          hay = true;
        }
      } else {
        const r = rs.find(r => r[F] === fin);
        if (r) { reparto(r[FE] || 0, r[ES] || 0, p.espanola, st.dia, out); hay = true; }
      }
    }
    return hay ? out : null;
  }

  // ================================================================== estado
  const st = { peli: -1, fin: ULT, metrica: "eur", periodo: "fin", dia: "todo", cines: true, grupo: "todas", cmp: [null, null], vista: "explorar" };
  const pasos = () => {
    if (st.peli < 0) return D.fines.map((_, i) => i);
    const p = pelis[st.peli], out = [];
    for (let i = p.primerFinIdx; i <= p.ultimoPaso; i++) out.push(i);
    return out.length ? out : [ULT];
  };

  // ================================================================== buscador
  const etiquetas = new Map();
  const dl = $("lista-pelis");
  pelis.slice().sort((a, b) => (b.total_eur || 0) - (a.total_eur || 0)).forEach(p => {
    let e = `${p.titulo} (${p.anio || "sin fecha"})`;
    if (etiquetas.has(e)) e = `${p.titulo} (${p.anio}, ${p.id})`;
    etiquetas.set(e, p.i);
    p.etiqueta = e;
    const o = document.createElement("option"); o.value = e; dl.appendChild(o);
  });
  const buscarPeli = txt => {
    if (etiquetas.has(txt)) return etiquetas.get(txt);
    const t = txt.trim().toLowerCase();
    if (!t) return null;
    const p = pelis.find(p => p.titulo.toLowerCase() === t) || pelis.find(p => p.titulo.toLowerCase().includes(t));
    return p ? p.i : null;
  };
  const inBuscar = $("buscar");
  inBuscar.addEventListener("change", () => { const i = buscarPeli(inBuscar.value); if (i != null) { elegir(i); irVista("explorar"); } });
  $("btn-todas").addEventListener("click", () => { elegir(-1); irVista("explorar"); });
  $("ir-inicio").addEventListener("click", ev => { ev.preventDefault(); elegir(-1); irVista("explorar"); });

  function elegir(i, fin) {
    st.peli = i;
    const ps = pasos();
    const conAmbos = i < 0 ? SES.map(s => s.fin).filter(f => porFin[f].length)
      : sesPorPeli[i].filter(f => porPeli[i].some(r => r[F] === f));
    st.fin = fin != null && ps.includes(fin) ? fin
      : (conAmbos.length ? conAmbos[conAmbos.length - 1] : (i < 0 ? ULT_TAQ : ps[0]));
    if (i < 0) st.periodo = "fin";
    inBuscar.value = i < 0 ? "" : pelis[i].etiqueta;
    history.replaceState(null, "", i < 0 ? "#" : "#p=" + encodeURIComponent(pelis[i].id));
    pintarTodo();
  }

  // ================================================================== pestañas
  const VISTAS = ["explorar", "peliculas", "calendario", "cadenas", "cara"];
  const pintadas = new Set();
  function irVista(v) {
    if (!VISTAS.includes(v)) v = "explorar";
    st.vista = v;
    guardar("vista", v);
    document.querySelectorAll(".pestanas button").forEach(b => b.setAttribute("aria-selected", String(b.dataset.vista === v)));
    document.querySelectorAll("main > .vista").forEach(s => { s.hidden = s.dataset.vista !== v; });
    if (v === "explorar") { reencuadrar(); gSem?.resize(); gAcum?.resize(); }
    if (v === "peliculas") pintarTabla();
    if (v === "calendario" && !pintadas.has(v)) { pintarCalendario(); pintadas.add(v); }
    if (v === "cadenas") pintarCadenas();
    if (v === "cara") pintarCara();
    window.scrollTo({ top: 0 });
  }
  document.querySelectorAll(".pestanas button").forEach(b => b.addEventListener("click", () => irVista(b.dataset.vista)));

  // ================================================================== mapa
  const tip = $("tooltip");
  const VISTA_ESPANA = L.latLngBounds([35.8, -9.6], [43.9, 4.5]);
  const VISTA_CANARIAS = L.latLngBounds([27.6, -18.2], [29.5, -13.3]);
  const mapa = L.map("mapa", { zoomSnap: 0.25, minZoom: 4, maxZoom: 18, scrollWheelZoom: true });
  mapa.fitBounds(VISTA_ESPANA);
  // la caja del mapa puede cambiar de tamaño al cargar la fuente o al cambiar de pestaña
  function reencuadrar() {
    requestAnimationFrame(() => {
      mapa.invalidateSize();
      if (!nav.ccaa) mapa.fitBounds(VISTA_ESPANA);
    });
  }
  addEventListener("load", reencuadrar);
  document.fonts?.ready.then(reencuadrar);
  mapa.attributionControl.setPrefix('<a href="https://leafletjs.com">Leaflet</a>');
  mapa.createPane("ccaa").style.zIndex = 410;
  mapa.createPane("prov").style.zIndex = 420;
  mapa.createPane("cines").style.zIndex = 450;
  mapa.createPane("etiquetas").style.zIndex = 430;
  mapa.getPane("etiquetas").style.pointerEvents = "none";
  const rCcaa = L.svg({ pane: "ccaa" }), rProv = L.svg({ pane: "prov" }), rCines = L.svg({ pane: "cines" });

  const esOscuro = () => document.documentElement.dataset.theme === "dark" ||
    (document.documentElement.dataset.theme !== "light" && matchMedia("(prefers-color-scheme: dark)").matches);
  // Teselas de Esri: sin clave ni cabecera Referer, así que funcionan abriendo el HTML con doble clic.
  const ESRI = "https://server.arcgisonline.com/ArcGIS/rest/services/";
  const ATRIB = '&copy; <a href="https://www.esri.com/">Esri</a>, HERE, Garmin, <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>';
  let capaBase = null;
  function ponerTeselas() {
    if (capaBase) mapa.removeLayer(capaBase);
    const op = { maxZoom: 19, maxNativeZoom: 18, attribution: ATRIB };
    capaBase = esOscuro()
      ? L.layerGroup([
          L.tileLayer(ESRI + "Canvas/World_Dark_Gray_Base/MapServer/tile/{z}/{y}/{x}", { ...op, maxNativeZoom: 16 }),
          L.tileLayer(ESRI + "Canvas/World_Dark_Gray_Reference/MapServer/tile/{z}/{y}/{x}", { ...op, maxNativeZoom: 16, pane: "etiquetas" }),
        ])
      : L.tileLayer(ESRI + "World_Street_Map/MapServer/tile/{z}/{y}/{x}", op);
    capaBase.addTo(mapa);
  }
  ponerTeselas();

  const nav = { ccaa: null, prov: null };
  const migas = $("migas");
  function pintarMigas() {
    const partes = [`<button data-nav="es">España</button>`];
    if (nav.ccaa) partes.push(nav.prov ? `<button data-nav="ccaa">${esc(nav.ccaa)}</button>` : `<span class="actual">${esc(nav.ccaa)}</span>`);
    if (nav.prov) partes.push(`<span class="actual">${esc(nav.prov)}</span>`);
    migas.innerHTML = partes.join(`<span class="sep">/</span>`) + (!nav.ccaa ? `<button data-nav="canarias" class="sec">Canarias</button>` : "");
    migas.querySelectorAll("button").forEach(b => b.addEventListener("click", () => {
      if (b.dataset.nav === "es") irEspana();
      else if (b.dataset.nav === "canarias") mapa.fitBounds(VISTA_CANARIAS);
      else entrarCcaa(nav.ccaa);
    }));
  }
  function irEspana() { nav.ccaa = nav.prov = null; capaProv.clearLayers(); mapa.fitBounds(VISTA_ESPANA); pintarMigas(); pintarMapa(); }
  function entrarCcaa(nombre) {
    nav.ccaa = nombre; nav.prov = null;
    capaProv.clearLayers();
    capaProv.addData({ type: "FeatureCollection", features: M.provincias.features.filter(f => f.properties.ccaa === nombre) });
    const capa = capaCcaa.getLayers().find(l => l.feature.properties.ccaa === nombre);
    if (capa) mapa.fitBounds(capa.getBounds(), { padding: [12, 12] });
    pintarMigas(); pintarMapa();
  }
  function entrarProv(f, capa) {
    nav.prov = f.properties.provincia;
    mapa.fitBounds(capa.getBounds(), { padding: [12, 12] });
    pintarMigas(); pintarMapa();
  }

  let valsActuales = null, escalaActual = null, provActual = new Map();
  const capaCcaa = L.geoJSON(M.geo, {
    renderer: rCcaa, pane: "ccaa",
    style: f => estiloCcaa(f),
    onEachFeature: (f, capa) => {
      capa.bindTooltip(() => tipCcaa(f), { sticky: true, className: "tt", direction: "top", offset: [0, -8] });
      capa.on("click", () => { capa.closeTooltip(); entrarCcaa(f.properties.ccaa); });
    },
  }).addTo(mapa);
  const capaProv = L.geoJSON(null, {
    renderer: rProv, pane: "prov",
    style: f => estiloProv(f),
    onEachFeature: (f, capa) => {
      capa.bindTooltip(() => tipProv(f), { sticky: true, className: "tt", direction: "top", offset: [0, -8] });
      capa.on("click", () => { capa.closeTooltip(); entrarProv(f, capa); });
    },
  }).addTo(mapa);

  function estiloCcaa(f) {
    const k = idxCcaa[f.properties.ccaa];
    const base = { weight: 1, color: css("--map-stroke"), opacity: 1 };
    if (nav.ccaa) {
      return f.properties.ccaa === nav.ccaa
        ? { ...base, weight: 2, color: css("--text-secondary"), fillOpacity: 0 }
        : { ...base, fillColor: css("--map-empty"), fillOpacity: 0.55 };
    }
    return { ...base, fillColor: valsActuales && k != null ? escalaActual(valsActuales[k][st.metrica]) : css("--map-empty"),
      fillOpacity: valsActuales ? 0.62 : 0.35 };
  }
  function estiloProv(f) {
    const sel = nav.prov === f.properties.provincia;
    return { weight: sel ? 2 : 1, color: css("--text-secondary"), opacity: 0.8, dashArray: sel ? null : "3 3",
      fillColor: css("--map-empty"), fillOpacity: nav.prov && !sel ? 0.55 : 0 };
  }
  function tipCcaa(f) {
    const k = idxCcaa[f.properties.ccaa];
    if (k == null) return esc(f.properties.ccaa);
    const c = C[k], v = valsActuales ? valsActuales[k] : null;
    const tot = valsActuales ? valsActuales.reduce((s, x) => s + x.eur, 0) : 0;
    return `<b>${esc(c.ccaa)}</b>` + (v ? `
      <div class="fila"><span>Recaudación</span><span>${eur(v.eur)}</span></div>
      <div class="fila"><span>Espectadores</span><span>${num(v.espect)}</span></div>
      <div class="fila"><span>Cuota</span><span>${dec(100 * v.eur / tot)} %</span></div>
      <div class="fila"><span>Por pantalla</span><span>${eur(v.eur / c.pantallas)}</span></div>` : `<div class="fila"><span>Sin taquilla este fin de semana</span></div>`) +
      `<div class="fila"><span>Cines y pantallas</span><span>${c.salas} y ${c.pantallas}</span></div>
       <div class="pista-clic">Pulsa para ver sus provincias</div>`;
  }
  function tipProv(f) {
    const v = provActual.get(f.properties.provincia);
    return `<b>${esc(f.properties.provincia)}</b>` + (v ? `
      <div class="fila"><span>Cines con sesiones</span><span>${v.n}</span></div>
      <div class="fila"><span>Sesiones</span><span>${num(v.ses)}</span></div>
      ${v.conTaquilla ? `<div class="fila"><span>Recaudación</span><span>${eur(v.eur)}</span></div>` : ""}` :
      `<div class="fila"><span>Sin sesiones capturadas</span></div>`) +
      `<div class="pista-clic">Pulsa para acercarte a sus cines</div>`;
  }

  const capaOsm = L.layerGroup(M.cines.map(c => L.circleMarker([c[1], c[0]], {
    renderer: rCines, radius: 3, weight: 0.6, color: css("--surface-1"), fillColor: css("--cine"), fillOpacity: 0.5,
  }).bindTooltip(`<b>${esc(c[2])}</b>${c[3] ? `<div class="fila"><span>${esc(c[3])}</span></div>` : ""}${c[4] ? `<div class="fila"><span>Pantallas</span><span>${c[4]}</span></div>` : ""}`, { className: "tt" })));
  const capaCines = L.layerGroup().addTo(mapa);

  function maxDominio() {
    let m = 0;
    for (const f of pasos()) {
      const v = valores(st, f);
      if (v) for (const x of v) m = Math.max(m, x[st.metrica]);
    }
    return m || 1;
  }

  function pintarMapa() {
    const rampa = css("--seq").split(",").map(s => s.trim());
    const vals = valores(st, st.fin);
    valsActuales = vals;
    const max = maxDominio();
    escalaActual = d3.scaleQuantize().domain([0, max]).range(rampa);
    capaCcaa.setStyle(estiloCcaa);
    capaProv.setStyle(estiloProv);
    const fmt = st.metrica === "eur" ? eurCorto : num;
    $("leyenda").innerHTML = (vals && !nav.ccaa ?
      `<div>${st.metrica === "eur" ? "Recaudación" : "Espectadores"}${st.periodo === "acum" ? " acumulados" : ""} por comunidad</div>
       <div class="rampa">${rampa.map(c => `<span style="background:${c}"></span>`).join("")}</div>
       <div class="extremos"><span>0</span><span>${fmt(max)}</span></div>` : "") + `<div id="leyenda-cines"></div>`;
    pintarCines();

    const total = vals ? vals.reduce((s, x) => s + x[st.metrica], 0) : null;
    $("mapa-resumen").innerHTML = vals
      ? `<b>${fmt(total)}</b>${st.periodo === "acum" ? "acumulado en España" : "en España este fin de semana"}`
      : !porFin[st.fin].length ? `<span class="badge aviso">Taquilla pendiente: se publica el martes</span>`
        : `<span class="badge">Fuera del top 25 este fin de semana</span>`;
    const filas = vals ? C.map((c, k) => ({ c, v: vals[k] })).sort((a, b) => b.v.eur - a.v.eur) : [];
    const totE = vals ? vals.reduce((s, x) => s + x.eur, 0) : 0;
    $("tabla-ccaa").innerHTML = vals
      ? `<thead><tr><th>Comunidad</th><th>Recaudación</th><th>Espectadores</th><th>Cuota</th><th>Por pantalla</th></tr></thead><tbody>` +
        filas.map(({ c, v }) => `<tr><td>${esc(c.ccaa)}</td><td>${eur(v.eur)}</td><td>${num(v.espect)}</td><td>${dec(100 * v.eur / totE)} %</td><td>${eur(v.eur / c.pantallas)}</td></tr>`).join("") + "</tbody>"
      : `<tbody><tr><td class="sec">Sin taquilla para este fin de semana.</td></tr></tbody>`;
  }

  // ================================================================== sesiones por cine
  const promesasSes = {};
  function cargarSesiones(fin) {
    const v = D.fines[fin];
    if (!SES.some(s => s.fin === fin)) return Promise.resolve(null);
    if (window.SESIONES?.[v]) return Promise.resolve(prepararSes(v));
    return promesasSes[v] ||= new Promise(res => {
      const sc = document.createElement("script");
      sc.src = `data/sesiones/${v}.js`;
      sc.onload = () => res(window.SESIONES?.[v] ? prepararSes(v) : null);
      sc.onerror = () => res(null);
      document.head.appendChild(sc);
    });
  }
  function prepararSes(v) {
    const S = window.SESIONES[v];
    if (S.listo) return S;
    S.k = S.cines.map(c => idxCcaa[c[3]]);
    S.porPeli = new Map();
    S.porCine = S.cines.map(() => []);
    S.s.forEach(e => {
      const id = S.pelis[e[1]];
      if (!S.porPeli.has(id)) S.porPeli.set(id, []);
      S.porPeli.get(id).push(e);
      S.porCine[e[0]].push(e);
    });
    S.cache = new Map();
    S.listo = true;
    return S;
  }
  const DIAS = { todo: [0, 1, 2], v: [0], s: [1], d: [2] }, FAC = ["v", "s", "d"];

  /* Recaudación por cine = taquilla nacional del finde × peso de su comunidad (ICAA, solo comunidades
     donde la película tiene sesiones) × peso del día × (sesiones × precio del cine) / total de su comunidad. */
  function estimarPeli(S, id, fin, dia = st.dia) {
    const clave = `${id}|${fin}|${dia}`;
    if (S.cache.has(clave)) return S.cache.get(clave);
    const out = { conTaquilla: false, cines: new Map() };
    const es = S.porPeli.get(id);
    if (es) {
      const pi = idPeli.get(id), p = pi != null ? pelis[pi] : null;
      const fila = pi != null ? porPeli[pi].find(r => r[F] === fin) : null;
      const G = fila ? fila[FE] : null, E = fila ? fila[ES] : 0;
      out.conTaquilla = G != null;
      const precio = ci => S.cines[ci][6] || C[S.k[ci]].precio_medio_eur;
      const sumW = C.map(() => [0, 0, 0]), sumS = C.map(() => [0, 0, 0]);
      for (const e of es) {
        const k = S.k[e[0]];
        if (k == null) continue;
        for (let d = 0; d < 3; d++) { sumW[k][d] += e[2 + d] * precio(e[0]); sumS[k][d] += e[2 + d]; }
      }
      const w = p?.espanola ? pesoEsp : pesoExt, we = p?.espanola ? espEsp : espExt;
      let tw = 0, twe = 0;
      C.forEach((_, k) => { if (sumS[k][0] + sumS[k][1] + sumS[k][2] > 0) { tw += w[k]; twe += we[k]; } });
      for (const e of es) {
        const ci = e[0], k = S.k[ci];
        if (k == null) continue;
        const r = { eur: 0, espect: 0, ses: [0, 0, 0], peso: 0 };
        for (const d of DIAS[dia]) {
          const n = e[2 + d];
          if (!n) continue;
          r.ses[d] += n;
          r.peso += n * precio(ci);
          if (G != null && sumW[k][d] > 0) {
            const f = diaFac[k][FAC[d]];
            r.eur += G * (w[k] / tw) * f * n * precio(ci) / sumW[k][d];
            r.espect += E * (we[k] / twe) * f * n / sumS[k][d];
          }
        }
        if (r.peso > 0) out.cines.set(ci, r);
      }
    }
    S.cache.set(clave, out);
    return out;
  }
  function estimarCines(S, fin, ids = st.peli < 0 ? S.pelis : [pelis[st.peli].id], dia = st.dia) {
    const res = S.cines.map(() => ({ eur: 0, espect: 0, ses: [0, 0, 0], peso: 0, pelis: 0 }));
    let conTaquilla = false;
    for (const id of ids) {
      const e = estimarPeli(S, id, fin, dia);
      conTaquilla ||= e.conTaquilla;
      for (const [ci, r] of e.cines) {
        const t = res[ci];
        t.eur += r.eur; t.espect += r.espect; t.peso += r.peso; t.pelis++;
        for (let d = 0; d < 3; d++) t.ses[d] += r.ses[d];
      }
    }
    return { conTaquilla, res };
  }

  let turnoCines = 0;
  async function pintarCines() {
    const turno = ++turnoCines;
    const S = st.cines && st.periodo === "fin" ? await cargarSesiones(st.fin) : null;
    if (turno !== turnoCines) return;
    capaCines.clearLayers();
    if (st.cines && !S) capaOsm.addTo(mapa); else capaOsm.remove();
    const leyenda = $("leyenda-cines"), ranking = $("tabla-cines"), pie = $("pie-cines");
    provActual = new Map();
    if (!S) {
      ranking.innerHTML = `<tbody><tr><td class="sec">${st.periodo === "acum" ? "El ranking de cines se calcula por fin de semana." : "No hay sesiones capturadas para este fin de semana. Se capturan cada viernes desde el 13 de noviembre de 2026."}</td></tr></tbody>`;
      pie.textContent = "";
      if (leyenda) leyenda.textContent = "";
      capaProv.setStyle(estiloProv);
      return;
    }
    const est = estimarCines(S, st.fin);
    const valor = d => !est.conTaquilla ? d.r.peso : st.metrica === "eur" ? d.r.eur : d.r.espect;
    const datos = S.cines.map((c, i) => ({ i, c, r: est.res[i] })).filter(d => valor(d) > 0).sort((a, b) => valor(b) - valor(a));
    for (const d of datos) {
      const p = provActual.get(d.c[2]) || { n: 0, ses: 0, eur: 0, conTaquilla: est.conTaquilla };
      p.n++; p.ses += d.r.ses[0] + d.r.ses[1] + d.r.ses[2]; p.eur += d.r.eur;
      provActual.set(d.c[2], p);
    }
    capaProv.setStyle(estiloProv);
    const radio = d3.scaleSqrt().domain([0, d3.max(datos, valor) || 1]).range([0, 14]);
    const color = css("--series-2"), borde = css("--surface-1");
    for (const d of datos.slice().reverse()) {
      L.circleMarker([d.c[5], d.c[4]], {
        renderer: rCines, radius: Math.max(2.5, radio(valor(d))), weight: 1, color: borde, fillColor: color, fillOpacity: 0.75,
      }).bindTooltip(() => tipCine(d, est.conTaquilla), { className: "tt", direction: "top", offset: [0, -6] })
        .bindPopup(() => popupCine(S, d.i), { maxWidth: 340, className: "pop", autoPanPaddingTopLeft: L.point(12, 60) })
        .addTo(capaCines);
    }
    if (leyenda) leyenda.innerHTML = `<span class="punto"></span>${num(datos.length)} cines, tamaño según ${est.conTaquilla ? (st.metrica === "eur" ? "recaudación" : "espectadores") : "sesiones y precio"}`;
    const enZona = d => (!nav.ccaa || d.c[3] === nav.ccaa) && (!nav.prov || d.c[2] === nav.prov);
    const lista = datos.filter(enZona);
    ranking.innerHTML = `<thead><tr><th>Cine</th><th>Ciudad</th><th>Vie</th><th>Sáb</th><th>Dom</th><th>${est.conTaquilla ? "Recaudación" : "Sesiones × precio"}</th><th>Espectadores</th></tr></thead><tbody>` +
      lista.slice(0, 50).map(d => `<tr data-ci="${d.i}"><td class="titulo">${esc(d.c[0])}</td><td class="sec">${esc(d.c[1] || "")}</td>${d.r.ses.map(x => `<td>${Math.round(x)}</td>`).join("")}<td>${est.conTaquilla ? eur(d.r.eur) : num(d.r.peso) + " €"}</td><td>${est.conTaquilla ? num(d.r.espect) : NADA}</td></tr>`).join("") + "</tbody>";
    pie.textContent = `${nav.prov || nav.ccaa || "España"}: ${num(lista.length)} cines ${st.peli >= 0 ? "proyectan esta película" : "con sesiones"}. eCartelera publica la cartelera de ${S.cines.length} de los ${S.revisados || "?"} cines revisados; el reparto se hace entre ellos, así que cada cine puede salir algo sobrestimado.`;
    ranking.querySelectorAll("tr[data-ci]").forEach(tr => tr.addEventListener("click", () => {
      const c = S.cines[+tr.dataset.ci];
      mapa.setView([c[5], c[4]], 14);
      capaCines.eachLayer(l => { const ll = l.getLatLng(); if (ll.lat === c[5] && ll.lng === c[4]) l.openPopup(); });
      $("mapa").scrollIntoView({ behavior: "smooth", block: "center" });
    }));
  }
  function tipCine(d, conTaquilla) {
    const c = d.c, r = d.r;
    return `<b>${esc(c[0])}</b>
      <div class="fila"><span>${esc(c[1] || "")}${c[2] && c[2] !== c[1] ? `, ${esc(c[2])}` : ""}</span></div>
      <div class="fila"><span>Sesiones vie, sáb y dom</span><span>${r.ses.map(x => Math.round(x)).join(" / ")}</span></div>` +
      (conTaquilla ? `<div class="fila"><span>Recaudación</span><span>${eur(r.eur)}</span></div>` : "") +
      `<div class="pista-clic">Pulsa para ver su cartelera</div>`;
  }
  function popupCine(S, ci) {
    const c = S.cines[ci];
    const filas = S.porCine[ci].map(e => {
      const id = S.pelis[e[1]], pi = idPeli.get(id), est = estimarPeli(S, id, st.fin);
      return { id, pi, titulo: pi != null ? pelis[pi].titulo : id, ses: [e[2], e[3], e[4]], est: est.cines.get(ci), conT: est.conTaquilla };
    }).sort((a, b) => (b.ses[0] + b.ses[1] + b.ses[2]) - (a.ses[0] + a.ses[1] + a.ses[2]));
    const sel = st.peli >= 0 ? filas.find(f => f.pi === st.peli) : null;
    const totalEst = filas.reduce((s, f) => s + (f.est?.eur || 0), 0);
    return `<div class="pop-cine">
      <h4>${esc(c[0])}</h4>
      <div class="sub">${esc(c[1] || "")}${c[2] && c[2] !== c[1] ? `, ${esc(c[2])}` : ""}${c[8] && c[8] !== "Independiente" ? `. ${esc(c[8])}` : ""}<br>
        ${c[6] ? `Entrada a ${dec(c[6], 2)} €` : "Precio no publicado"}${c[7] ? ". Ubicación aproximada" : ""}</div>
      ${sel ? `<div class="destacado"><b>${esc(sel.titulo)}</b>${sel.ses.map(x => Math.round(x)).join(" / ")} sesiones (vie, sáb, dom)<br>
        ${sel.conT ? `${eur(sel.est?.eur)} y ${num(sel.est?.espect)} espectadores estimados` : "Taquilla aún no publicada"}</div>` : ""}
      <div class="sub">Cartelera del ${fechaFin(st.fin)}${totalEst ? `. Total estimado ${eur(totalEst)}` : ""}</div>
      <div class="tabla-scroll"><table><thead><tr><th>Película</th><th>V</th><th>S</th><th>D</th><th>Est.</th></tr></thead><tbody>
      ${filas.map(f => `<tr${f.pi === st.peli ? ' class="sel"' : ""}><td>${f.pi != null ? `<a href="#p=${encodeURIComponent(f.id)}">${esc(f.titulo)}</a>` : esc(f.titulo)}</td>${f.ses.map(x => `<td>${Math.round(x)}</td>`).join("")}<td>${f.conT && f.est ? eurCorto(f.est.eur) : NADA}</td></tr>`).join("")}
      </tbody></table></div></div>`;
  }

  // controles del mapa
  document.querySelectorAll("[data-metrica]").forEach(b => b.addEventListener("click", () => { st.metrica = b.dataset.metrica; pintarControles(); pintarMapa(); }));
  document.querySelectorAll("[data-periodo]").forEach(b => b.addEventListener("click", () => { if (b.disabled) return; st.periodo = b.dataset.periodo; pintarControles(); pintarMapa(); }));
  const selDia = $("dia");
  selDia.addEventListener("change", () => { st.dia = selDia.value; pintarMapa(); });
  const chkCines = $("ver-cines");
  chkCines.checked = st.cines;
  chkCines.addEventListener("change", e => { st.cines = e.target.checked; pintarMapa(); });
  function pintarControles() {
    document.querySelectorAll("[data-metrica]").forEach(b => b.classList.toggle("activo", b.dataset.metrica === st.metrica));
    document.querySelectorAll("[data-periodo]").forEach(b => {
      b.classList.toggle("activo", b.dataset.periodo === st.periodo);
      if (b.dataset.periodo === "acum") b.disabled = st.peli < 0;
    });
    selDia.disabled = st.periodo === "acum";
    if (st.periodo === "acum") { selDia.value = "todo"; st.dia = "todo"; }
  }

  // línea temporal
  const slider = $("slider"), sliderEtq = $("slider-etq"), btnPlay = $("play");
  const ICONO_PLAY = `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M8 5.5v13l10-6.5z" fill="currentColor" stroke="none"/></svg>`;
  const ICONO_PAUSA = `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M8 5h3v14H8zM13 5h3v14h-3z" fill="currentColor" stroke="none"/></svg>`;
  btnPlay.innerHTML = ICONO_PLAY;
  let reloj = null;
  function pintarSlider() {
    const ps = pasos();
    slider.max = ps.length - 1;
    slider.value = Math.max(0, ps.indexOf(st.fin));
    const r = st.peli >= 0 ? porPeli[st.peli].find(r => r[F] === st.fin) : null;
    const badge = !porFin[st.fin].length ? `<span class="badge aviso">Taquilla pendiente</span>`
      : st.peli >= 0 ? (r ? `<span class="badge">Semana ${r[SEM]}</span>` : `<span class="badge">Fuera del top</span>`) : "";
    sliderEtq.innerHTML = `<span>${fechaFin(st.fin)}</span>${badge}`;
  }
  const irA = f => { st.fin = f; pintarSlider(); pintarMapa(); if (st.peli < 0) pintarPanel(); };
  slider.addEventListener("input", () => irA(pasos()[+slider.value]));
  const parar = () => { clearInterval(reloj); reloj = null; btnPlay.innerHTML = ICONO_PLAY; btnPlay.setAttribute("aria-label", "Reproducir"); };
  btnPlay.addEventListener("click", () => {
    if (reloj) return parar();
    const ps = pasos();
    btnPlay.innerHTML = ICONO_PAUSA; btnPlay.setAttribute("aria-label", "Pausa");
    irA(+slider.value >= ps.length - 1 ? ps[0] : st.fin);
    reloj = setInterval(() => {
      const ps = pasos(), j = ps.indexOf(st.fin) + 1;
      if (j >= ps.length) return parar();
      irA(ps[j]);
    }, 800);
  });

  // ================================================================== éxito / fracaso
  const METRICAS = [
    { k: "total_eur", nombre: "Taquilla total", fmt: eur },
    { k: "porCine", nombre: "Apertura por cine", fmt: eur },
    { k: "multiplicador", nombre: "Multiplicador", fmt: mult },
    { k: "aguante", nombre: "Caída 2.º finde", fmt: v => pct(v - 100) },
  ];
  const GRUPOS = {
    todas: { nombre: "Todos los estrenos", f: () => true },
    origen: { nombre: "Mismo origen", f: (p, q) => p.espanola === q.espanola },
    genero: { nombre: "Mismo género", f: (p, q) => p.genero === q.genero },
    anio: { nombre: "Mismo año", f: (p, q) => p.anio === q.anio },
  };
  function percentiles(p, grupo) {
    const pares = pelis.filter(q => q.completa && GRUPOS[grupo].f(p, q));
    const res = METRICAS.map(m => {
      const v = p[m.k];
      const vs = pares.map(q => q[m.k]).filter(x => x != null);
      if (v == null || vs.length < 5) return { ...m, v, p: null, n: vs.length };
      const menor = vs.filter(x => x < v).length, igual = vs.filter(x => x === v).length;
      return { ...m, v, p: (menor + igual / 2) / vs.length, n: vs.length };
    });
    const ok = res.filter(r => r.p != null);
    const nota = p.completa && ok.length >= 2 ? ok.reduce((s, r) => s + r.p, 0) / ok.length : null;
    return { res, nota, n: pares.length };
  }
  const estado = nota => nota == null ? { c: "nd", t: "Sin veredicto", i: "?" }
    : nota >= 0.66 ? { c: "bien", t: "Éxito", i: "✓" }
    : nota >= 0.33 ? { c: "medio", t: "En la media", i: "=" }
    : { c: "mal", t: "Fracaso", i: "✕" };
  pelis.forEach(p => { p.notaTodas = percentiles(p, "todas").nota; });
  const veredicto = p => { const e = estado(p.notaTodas); return `<span class="estado mini ${e.c}"><span class="icono" aria-hidden="true">${e.i}</span>${e.t}</span>`; };

  // ================================================================== previsión de taquilla final
  /* Para una película que sigue en cartelera: total final ≈ total actual × (final / total en la misma semana)
     de las 25 películas ya terminadas más parecidas (apertura por cine, cines, género y origen). */
  const totalEnSemana = (q, n) => {
    let t = null;
    for (const r of porPeli[q.i]) if (r[SEM] && r[SEM] <= n && r[TOT]) t = Math.max(t || 0, r[TOT]);
    return t;
  };
  const cuantil = (xs, q) => { const s = xs.slice().sort((a, b) => a - b); const i = (s.length - 1) * q, lo = Math.floor(i); return s[lo] + (s[Math.ceil(i)] - s[lo]) * (i - lo); };
  const cachePrev = new Map();
  function prevision(p) {
    if (cachePrev.has(p.i)) return cachePrev.get(p.i);
    let out = null;
    const n = Math.max(0, ...porPeli[p.i].map(r => r[SEM] || 0));
    if (p.completa && p.enCartelera && n >= 1 && p.porCine && p.total_eur) {
      const cands = pelis.filter(q => q.completa && !q.enCartelera && q.porCine && q.apertura_cines && q.total_eur && q.i !== p.i)
        .map(q => {
          const base = totalEnSemana(q, n);
          if (!base || base <= 0 || q.total_eur < base) return null;
          const dist = Math.abs(Math.log(q.porCine / p.porCine)) + 0.5 * Math.abs(Math.log(q.apertura_cines / p.apertura_cines))
            + (q.genero === p.genero ? 0 : 0.4) + (q.espanola === p.espanola ? 0 : 0.5);
          return { q, base, dist, ratio: q.total_eur / base };
        }).filter(Boolean).sort((a, b) => a.dist - b.dist).slice(0, 25);
      if (cands.length >= 8) {
        const ratios = cands.map(c => c.ratio);
        const maxS = Math.min(16, Math.max(...cands.map(c => Math.max(...porPeli[c.q.i].map(r => r[SEM] || 0)))));
        const curva = [];
        for (let w = n + 1; w <= maxS; w++) {
          const rs = cands.map(c => (totalEnSemana(c.q, w) || c.base) / c.base);
          curva.push({ w, v: p.total_eur * cuantil(rs, 0.5) });
        }
        out = { semana: n, med: p.total_eur * cuantil(ratios, 0.5), lo: p.total_eur * cuantil(ratios, 0.25),
          hi: p.total_eur * cuantil(ratios, 0.75), n: cands.length, curva };
      }
    }
    cachePrev.set(p.i, out);
    return out;
  }

  // ================================================================== panel de película
  const panel = $("panel");
  const kpi = (t, v, s = "", cls = "") => `<div class="kpi ${cls}"><dt>${t}</dt><dd>${v}${s ? `<small>${s}</small>` : ""}</dd></div>`;
  function fichaHtml(p) {
    const fecha = p.proximo || p.estreno;
    const campos = [
      ["Estreno", fecha ? fechaLarga(fecha) : null],
      ["Dirección", p.director?.length ? p.director.map(d => `<button class="enlace-dir" data-director="${esc(d)}">${esc(d)}</button>`).join(", ") : null],
      ["Reparto", p.reparto?.length ? esc(lista(p.reparto)) : null],
      ["Distribuye", p.distribuidora ? esc(p.distribuidora) : null],
      ["País", p.paises?.length ? esc(lista(p.paises)) : null],
    ].filter(c => c[1]);
    const chips = [...(p.generos || []).slice(0, 3), p.duracion ? `${p.duracion} min` : null, p.edad].filter(Boolean);
    return `<div class="ficha${p.cartel ? "" : " sin-cartel"}">
      ${p.cartel ? `<img src="${url(p.cartel)}" alt="Cartel de ${esc(p.titulo)}" referrerpolicy="no-referrer">` : ""}
      <div>
        <h2>${esc(p.titulo)}</h2>
        <div class="chips">${chips.map(c => `<span class="badge">${esc(c)}</span>`).join("")}</div>
        <dl class="datos-ficha">${campos.map(([k, v]) => `<dt>${k}</dt><dd>${v}</dd>`).join("")}</dl>
        ${p.url ? `<p class="nota"><a href="${url(p.url)}" target="_blank" rel="noopener">Ver en eCartelera</a></p>` : ""}
      </div>
    </div>`;
  }
  function enlazarDirectores(raiz) {
    raiz.querySelectorAll("[data-director]").forEach(b => b.addEventListener("click", () => filtrarDirector(b.dataset.director)));
  }

  function pintarPanel() {
    if (st.peli < 0) return pintarPanelSemana();
    const p = pelis[st.peli];
    if (!p.conTaquilla) {
      panel.innerHTML = fichaHtml(p) + `<p class="vacio">${p.proximo ? `Se estrena el ${new Date(p.proximo + "T12:00:00").toLocaleDateString("es-ES", { weekday: "long", day: "numeric", month: "long" })}. ` : ""}
        La taquilla se publica el martes siguiente a su primer fin de semana.<br>
        ${sesPorPeli[p.i].length ? "El mapa muestra en qué cines se proyecta." : "Todavía no hay sesiones a la venta en los cines que publican su cartelera."}</p>`;
      enlazarDirectores(panel);
      return;
    }
    const { res, nota, n } = percentiles(p, st.grupo);
    const e = estado(nota);
    const precio = p.apertura_espect ? p.apertura_eur / p.apertura_espect : null;
    const mismaMoneda = p.presupuesto && p.mundial && p.presupuesto_moneda === p.mundial_moneda;
    const prev = prevision(p);
    panel.innerHTML = fichaHtml(p) + `
      <div class="semaforo">
        <div class="semaforo-cab">
          <span class="estado ${e.c}"><span class="icono" aria-hidden="true">${e.i}</span>${e.t}${nota != null ? `<span class="pct">percentil ${Math.round(nota * 100)}</span>` : ""}</span>
          <select id="grupo" aria-label="Comparar con">${Object.entries(GRUPOS).map(([k, g]) => `<option value="${k}" ${k === st.grupo ? "selected" : ""}>${g.nombre}</option>`).join("")}</select>
        </div>
        <div class="barras">
          ${res.map(r => `<div class="mbar"><span class="nombre">${r.nombre}</span>
            <span class="pista" title="Percentil ${r.p == null ? NADA : Math.round(r.p * 100)}"><i></i>${r.p == null ? "" : `<span style="width:${Math.max(2, r.p * 100)}%"></span>`}</span>
            <span class="valor">${r.fmt(r.v)}</span><span class="p">${r.p == null ? "" : "p" + Math.round(r.p * 100)}</span></div>`).join("")}
        </div>
        <p class="nota">${!p.completa ? "Se estrenó antes del inicio del histórico, así que no hay apertura con la que valorarla." :
          `Comparada con ${num(n)} estrenos. La raya marca la mediana.${p.enCartelera ? " Sigue en cartelera, así que el total y el multiplicador aún pueden subir." : ""}`}</p>
      </div>
      <dl class="kpis">
        ${kpi("Total recaudado", eur(p.total_eur), p.enCartelera ? "Sigue en cartelera" : "")}
        ${prev ? kpi("Previsión final", eur(prev.med), `Entre ${eurCorto(prev.lo)} y ${eurCorto(prev.hi)}`, "destacada") : ""}
        ${kpi("Primer fin de semana", eur(p.apertura_eur), p.completa ? `${num(p.apertura_espect)} espectadores` : "Antes del histórico")}
        ${kpi("Cines en el estreno", num(p.apertura_cines), p.porCine ? `${eur(p.porCine)} por cine` : "")}
        ${kpi("Caída 2.º finde", pct(p.caida_2))}
        ${kpi("Multiplicador", mult(p.multiplicador), "Total entre primer finde")}
        ${kpi("Semanas en top 25", num(p.semanas_top25), `Mejor puesto: ${p.mejor_puesto}.º`)}
        ${kpi("Espectadores", num(p.espectFindes), precio ? `Fines de semana. Entrada a ${dec(precio, 2)} €` : "Fines de semana")}
        ${p.presupuesto ? kpi("Presupuesto", eurCorto(p.presupuesto).replace("€", p.presupuesto_moneda)) : ""}
        ${p.mundial ? kpi("Taquilla mundial", eurCorto(p.mundial).replace("€", p.mundial_moneda), mismaMoneda ? `${mult(p.mundial / p.presupuesto)} su presupuesto` : "") : ""}
      </dl>
      ${prev ? `<p class="nota">Previsión a partir de ${prev.n} películas parecidas ya retiradas, en su semana ${prev.semana}. La línea discontinua del gráfico de acumulado muestra la trayectoria esperada.</p>` : ""}`;
    panel.querySelector("#grupo").addEventListener("change", ev => { st.grupo = ev.target.value; pintarPanel(); });
    enlazarDirectores(panel);
  }

  function pintarPanelSemana() {
    const rs = porFin[st.fin];
    if (!rs.length) {
      panel.innerHTML = `<div class="cab"><h2>Fin de semana del ${fechaFin(st.fin)}</h2></div>
        <p class="vacio">La taquilla se publica el martes. El mapa ya muestra las sesiones por cine.</p>`;
      return;
    }
    const tot = rs.reduce((s, r) => s + (r[FE] || 0), 0), esp = rs.reduce((s, r) => s + (r[ES] || 0), 0);
    const estrenos = rs.filter(r => r[SEM] === 1).length;
    panel.innerHTML = `
      <div class="cab" style="margin:0"><h2>Top del ${fechaFin(st.fin)}</h2></div>
      <dl class="kpis cuatro">
        ${kpi("Recaudación", eur(tot), "Top 25")}
        ${kpi("Espectadores", num(esp))}
        ${kpi("Entrada media", esp ? dec(tot / esp, 2) + " €" : NADA)}
        ${kpi("Estrenos", estrenos)}
      </dl>
      <div class="tabla-scroll alta top-finde"><table><thead><tr><th>Película</th><th>Semana</th><th>Fin de semana</th><th>Total</th></tr></thead><tbody>
      ${rs.map(r => `<tr data-p="${r[P]}"><td class="titulo">${r[POS]}. ${esc(pelis[r[P]].titulo)}</td><td class="sec">${r[SEM] === 1 ? "Estreno" : r[SEM] + ".ª"}</td><td>${eur(r[FE])}</td><td>${eur(r[TOT])}</td></tr>`).join("")}
      </tbody></table></div>`;
    panel.querySelectorAll("tr[data-p]").forEach(tr => tr.addEventListener("click", () => elegir(+tr.dataset.p)));
  }

  // ================================================================== críticas
  let promesaCriticas = null;
  const cargarCriticas = () => promesaCriticas ||= new Promise(res => {
    if (window.CRITICAS) return res(window.CRITICAS);
    const sc = document.createElement("script");
    sc.src = "data/criticas.js";
    sc.onload = () => res(window.CRITICAS || null);
    sc.onerror = () => res(null);
    document.head.appendChild(sc);
  });
  const claseNota = v => v == null ? "" : v >= 7 ? "alta" : v >= 5 ? "media" : "baja";
  function resumenCriticas(c) {
    const frases = [];
    if (c.prensa && c.prensa[1]) {
      const [m, n, pos, mix, neg] = c.prensa;
      if (pos != null) {
        const r = pos / n;
        const tono = r >= 0.75 ? "La prensa la recibe muy bien" : r >= 0.55 ? "La prensa la recibe bien" : r >= 0.4 ? "La prensa está dividida" : "La prensa la recibe mal";
        frases.push(`${tono}: ${pos} de ${n} críticas son positivas${neg ? ` y ${neg} negativas` : ""}, con una media de ${dec(m)}.`);
      } else frases.push(`La prensa le da un ${dec(m)} de media en ${n} críticas.`);
    }
    if (c.usuarios && c.usuarios[1]) {
      const [m, v] = c.usuarios;
      const dif = c.prensa ? m - c.prensa[0] : 0;
      frases.push(v < 10 ? `El público apenas la ha puntuado todavía (${v} ${v === 1 ? "voto" : "votos"}, media ${dec(m)}).`
        : `El público le da un ${dec(m)} con ${num(v)} votos${Math.abs(dif) >= 1 ? (dif > 0 ? ", más que la prensa" : ", menos que la prensa") : ""}.`);
    }
    return frases.join(" ");
  }
  async function pintarResenas() {
    const caja = $("resenas");
    if (st.peli < 0) { caja.hidden = true; return; }
    const p = pelis[st.peli];
    const todas = await cargarCriticas();
    if (st.peli !== p.i) return;
    caja.hidden = false;
    if (!todas) {
      caja.innerHTML = `<header class="cab"><h2>Críticas</h2></header><p class="vacio">Las críticas aparecerán tras la próxima actualización de datos.</p>`;
      return;
    }
    const c = todas[p.id];
    if (!c || (!c.prensa && !c.usuarios && !c.citas)) {
      caja.innerHTML = `<header class="cab"><h2>Críticas</h2></header><p class="vacio">eCartelera aún no tiene críticas de esta película.</p>`;
      return;
    }
    const pr = c.prensa || [];
    const tot = (pr[2] || 0) + (pr[3] || 0) + (pr[4] || 0);
    caja.innerHTML = `
      <header class="cab"><h2>Críticas</h2>${p.url ? `<a class="cab-dato" href="${url(p.url)}criticas/" target="_blank" rel="noopener">Todas en eCartelera</a>` : ""}</header>
      <div class="criticas">
        <div>
          <div class="notas">
            <div class="nota-caja"><span>Nota media</span><b>${dec(c.media)}</b><small>eCartelera</small></div>
            <div class="nota-caja"><span>Prensa</span><b>${dec(pr[0])}</b><small>${pr[1] ? num(pr[1]) + " críticas" : "Sin críticas"}</small></div>
            <div class="nota-caja"><span>Público</span><b>${dec(c.usuarios?.[0])}</b><small>${c.usuarios ? num(c.usuarios[1]) + " votos" : "Sin votos"}</small></div>
          </div>
          ${tot ? `<div class="reparto-prensa">
            <div class="barra-apilada">
              <i style="flex:${pr[2]};background:var(--good)"></i><i style="flex:${pr[3]};background:var(--warning)"></i><i style="flex:${pr[4]};background:var(--critical)"></i>
            </div>
            <div class="lineas"><span style="--c:var(--good)">${pr[2]} positivas</span><span style="--c:var(--warning)">${pr[3]} mixtas</span><span style="--c:var(--critical)">${pr[4]} negativas</span></div>
          </div>` : ""}
          <p class="resumen-criticas">${esc(resumenCriticas(c))}</p>
        </div>
        <div>
          ${c.citas?.length ? `<div class="subtitulo">Prensa</div><div class="citas">${c.citas.map(q => `
            <div class="cita"><q>${esc(q[3])}</q>
              <div class="autor">${q[0] != null ? `<span class="nota-chip ${claseNota(q[0])}">${dec(q[0], q[0] % 1 ? 1 : 0)}</span>` : ""}<b>${esc(q[1])}</b>${q[2] ? `<span>${esc(q[2])}</span>` : ""}${q[4] ? `<a href="${url(q[4])}" target="_blank" rel="noopener nofollow">Leer</a>` : ""}</div>
            </div>`).join("")}</div>` : ""}
          ${c.resenas?.length ? `<div class="subtitulo" style="margin-top:18px">Público</div><div class="citas">${c.resenas.map(r => `
            <div class="cita"><q>${esc(r[2] ? r[2] + ". " : "")}${esc(r[3])}</q>
              <div class="autor">${r[0] != null ? `<span class="nota-chip ${claseNota(r[0])}">${dec(r[0], r[0] % 1 ? 1 : 0)}</span>` : ""}<b>${esc(r[1])}</b></div>
            </div>`).join("")}</div>` : ""}
        </div>
      </div>`;
  }

  // ================================================================== gráficos
  let gSem = null, gAcum = null;
  const cmpIn = [$("cmp1"), $("cmp2")];
  cmpIn.forEach((inp, j) => inp.addEventListener("change", () => { st.cmp[j] = buscarPeli(inp.value); pintarGraficos(); }));
  function opcionesBase() {
    const tc = css("--text-muted"), bc = css("--border");
    Chart.defaults.color = tc;
    Chart.defaults.borderColor = bc;
    Chart.defaults.font.family = getComputedStyle(document.body).fontFamily;
    Chart.defaults.font.size = 12;
    return {
      responsive: true, maintainAspectRatio: false, animation: false,
      interaction: { mode: "index", intersect: false },
      plugins: {
        legend: { position: "top", align: "start", labels: { boxWidth: 10, boxHeight: 10, usePointStyle: true, pointStyle: "rectRounded", padding: 14 } },
        tooltip: { backgroundColor: css("--surface-1"), titleColor: css("--text-primary"), bodyColor: css("--text-secondary"), borderColor: bc, borderWidth: 1, padding: 10, cornerRadius: 8, boxPadding: 4 },
      },
      scales: { x: { grid: { display: false }, border: { display: false } }, y: { beginAtZero: true, grid: { color: bc }, border: { display: false }, ticks: { callback: v => eurCorto(v), maxTicksLimit: 6 } } },
    };
  }
  function pintarGraficos() {
    gSem?.destroy(); gAcum?.destroy();
    const comunes = opcionesBase();
    const seleccion = st.peli >= 0 ? st.peli : null;
    const s1 = css("--series-1"), s2 = css("--series-2"), s3 = css("--series-3");
    if (seleccion == null) {
      gSem = new Chart($("g-semanal"), {
        type: "bar",
        data: { labels: D.fines.map((_, i) => fechaFin(i)), datasets: [{ label: "Top 25", data: porFin.map(rs => rs.reduce((s, r) => s + (r[FE] || 0), 0)), backgroundColor: s1, borderRadius: 3 }] },
        options: { ...comunes, plugins: { ...comunes.plugins, legend: { display: false }, tooltip: { ...comunes.plugins.tooltip, callbacks: { label: c => eur(c.parsed.y) } } }, scales: { ...comunes.scales, x: { ...comunes.scales.x, ticks: { maxTicksLimit: 8 } } } },
      });
    } else {
      const rs = porPeli[seleccion];
      gSem = new Chart($("g-semanal"), {
        type: "bar",
        data: {
          labels: rs.map(r => r[SEM] ? `S${r[SEM]}` : fechaFin(r[F])),
          datasets: [
            { label: "Fin de semana", data: rs.map(r => r[FE]), backgroundColor: s1, borderRadius: 0, stack: "a" },
            { label: "Entre semana (deducido)", data: rs.map(r => r[ESEM]), backgroundColor: s1 + "66", borderRadius: { topLeft: 4, topRight: 4 }, stack: "a" },
          ],
        },
        options: {
          ...comunes,
          scales: { ...comunes.scales, x: { ...comunes.scales.x, stacked: true }, y: { ...comunes.scales.y, stacked: true } },
          plugins: { ...comunes.plugins, tooltip: { ...comunes.plugins.tooltip, callbacks: { title: it => `${it[0].label}, ${fechaFin(rs[it[0].dataIndex][F])}`, label: c => `${c.dataset.label}: ${c.parsed.y == null ? NADA : eur(c.parsed.y)}` } } },
        },
      });
    }
    const series = [seleccion, ...st.cmp].map((p, j) => p == null ? null : { p, color: [s1, s2, s3][j] }).filter(Boolean);
    $("g-acum").closest(".graficos").classList.toggle("una", !series.length);
    $("g-semanal").closest("figure").querySelector("figcaption").textContent = seleccion == null ? "Recaudación del top 25 por fin de semana" : "Recaudación por semana";
    const prev = seleccion != null ? prevision(pelis[seleccion]) : null;
    const maxSem = Math.max(1, ...series.map(s => Math.max(0, ...porPeli[s.p].map(r => r[SEM] || 0))), ...(prev ? prev.curva.map(c => c.w) : []));
    const datasets = series.map(s => {
      const data = Array(maxSem).fill(null);
      porPeli[s.p].forEach(r => { if (r[SEM]) data[r[SEM] - 1] = r[TOT]; });
      return { label: pelis[s.p].titulo, data, borderColor: s.color, backgroundColor: s.color, borderWidth: 2, pointRadius: 2.5, pointHoverRadius: 5, spanGaps: true, tension: 0.2 };
    });
    if (prev && prev.curva.length) {
      const data = Array(maxSem).fill(null);
      data[prev.semana - 1] = pelis[seleccion].total_eur;
      prev.curva.forEach(c => { data[c.w - 1] = c.v; });
      datasets.push({ label: "Previsión", data, borderColor: s1, backgroundColor: s1, borderDash: [5, 4], borderWidth: 1.6, pointRadius: 0, spanGaps: true, tension: 0.2 });
    }
    gAcum = new Chart($("g-acum"), {
      type: "line",
      data: { labels: Array.from({ length: maxSem }, (_, i) => `S${i + 1}`), datasets },
      options: { ...comunes, plugins: { ...comunes.plugins, tooltip: { ...comunes.plugins.tooltip, callbacks: { label: c => `${c.dataset.label}: ${eur(c.parsed.y)}` } } } },
    });
  }

  // ================================================================== tabla de películas y directores
  const COLS = [
    { k: "titulo", t: "Película", f: p => `${esc(p.titulo)}<span class="mini">${esc(lista(p.director || []))}</span>`, cls: "titulo" },
    { k: "primer_fin", t: "Estreno", f: p => p.primer_fin ? p.primer_fin.split("-").reverse().join("/") : NADA, cls: "sec" },
    { k: "origen", t: "Origen", f: p => esc(p.origen), cls: "sec" },
    { k: "genero", t: "Género", f: p => esc(p.genero), cls: "sec" },
    { k: "apertura_eur", t: "Apertura", f: p => p.completa ? eur(p.apertura_eur) : NADA },
    { k: "apertura_cines", t: "Cines", f: p => num(p.apertura_cines) },
    { k: "porCine", t: "Por cine", f: p => eur(p.porCine) },
    { k: "caida_2", t: "Caída 2.º", f: p => pct(p.caida_2) },
    { k: "multiplicador", t: "Multipl.", f: p => mult(p.multiplicador) },
    { k: "total_eur", t: "Total", f: p => eur(p.total_eur) },
    { k: "semanas_top25", t: "Semanas", f: p => num(p.semanas_top25) },
    { k: "notaTodas", t: "Veredicto", f: veredicto },
  ];
  const tabla = { k: "total_eur", asc: false };
  const fTexto = $("f-texto"), fDirector = $("f-director"), fAnio = $("f-anio"), fOrigen = $("f-origen"), fComp = $("f-completas");
  [...new Set(pelis.map(p => p.anio))].filter(Boolean).sort().reverse().forEach(a => fAnio.insertAdjacentHTML("beforeend", `<option>${a}</option>`));
  [...porDirector].sort((a, b) => b[1].length - a[1].length || a[0].localeCompare(b[0], "es"))
    .forEach(([d]) => $("lista-directores").insertAdjacentHTML("beforeend", `<option value="${esc(d)}">`));
  [fTexto, fDirector, fAnio, fOrigen, fComp].forEach(el => el.addEventListener("input", pintarTabla));
  function filtrarDirector(d) {
    fDirector.value = d;
    fComp.checked = false;
    irVista("peliculas");
  }
  function directorActual() {
    const t = fDirector.value.trim().toLowerCase();
    if (!t) return null;
    return [...porDirector.keys()].find(d => d.toLowerCase() === t) || null;
  }
  function pintarDirector(d) {
    const caja = $("director-resumen");
    if (!d) { caja.innerHTML = ""; return; }
    const ps = porDirector.get(d).map(i => pelis[i]).filter(p => p.conTaquilla);
    if (!ps.length) { caja.innerHTML = ""; return; }
    const total = ps.reduce((s, p) => s + (p.total_eur || 0), 0);
    const mejor = ps.slice().sort((a, b) => (b.total_eur || 0) - (a.total_eur || 0))[0];
    const cuenta = c => ps.filter(p => estado(p.notaTodas).c === c).length;
    caja.innerHTML = `<div class="director-caja">
      <div>
        <h3>${esc(d)}</h3>
        <dl class="kpis">
          ${kpi("Películas", num(ps.length), "En el histórico")}
          ${kpi("Taquilla sumada", eur(total))}
          ${kpi("Media por película", eur(total / ps.length))}
          ${kpi("La más taquillera", esc(mejor.titulo), eur(mejor.total_eur))}
          ${kpi("Veredictos", `<span class="estado mini bien"><span class="icono">✓</span>${cuenta("bien")}</span> <span class="estado mini medio"><span class="icono">=</span>${cuenta("medio")}</span> <span class="estado mini mal"><span class="icono">✕</span>${cuenta("mal")}</span>`)}
        </dl>
      </div>
      <button class="btn" id="quitar-director">Quitar filtro</button>
    </div>`;
    $("quitar-director").addEventListener("click", () => { fDirector.value = ""; pintarTabla(); });
  }
  function pintarTabla() {
    const t = fTexto.value.trim().toLowerCase();
    const dir = directorActual();
    const dt = fDirector.value.trim().toLowerCase();
    let lista_ = pelis.filter(p =>
      (!fComp.checked || p.completa) && (!fAnio.value || p.anio === fAnio.value) &&
      (!fOrigen.value || (fOrigen.value === "es") === p.espanola) &&
      (!dt || (p.director || []).some(d => dir ? d === dir : d.toLowerCase().includes(dt))) &&
      (!t || [p.titulo, p.distribuidora, ...(p.generos || [])].join(" ").toLowerCase().includes(t)));
    const k = tabla.k, sentido = tabla.asc ? 1 : -1;
    lista_.sort((a, b) => {
      const x = a[k], y = b[k];
      if (x == null && y == null) return 0;
      if (x == null) return 1;
      if (y == null) return -1;
      return (typeof x === "string" ? x.localeCompare(y, "es") : x - y) * sentido;
    });
    $("n-lista").textContent = num(lista_.length);
    pintarDirector(dir);
    const el = $("tabla-pelis");
    el.innerHTML = `<thead><tr>${COLS.map(c => `<th data-orden="${c.k}" class="${c.k === k ? "ordenado" + (tabla.asc ? " asc" : "") : ""}">${c.t}</th>`).join("")}</tr></thead>
      <tbody>${lista_.slice(0, 600).map(p => `<tr data-p="${p.i}" class="${p.i === st.peli ? "sel" : ""}">${COLS.map(c => `<td class="${c.cls || ""}">${c.f(p)}</td>`).join("")}</tr>`).join("")}</tbody>`;
    el.querySelectorAll("th[data-orden]").forEach(th => th.addEventListener("click", () => {
      tabla.asc = tabla.k === th.dataset.orden ? !tabla.asc : th.dataset.orden === "titulo";
      tabla.k = th.dataset.orden; pintarTabla();
    }));
    el.querySelectorAll("tbody tr").forEach(tr => tr.addEventListener("click", () => { elegir(+tr.dataset.p); irVista("explorar"); }));
  }

  // ================================================================== próximos estrenos (plegable)
  const PROX = (D.proximos || []).map(([i, fecha]) => ({ p: pelis[i], fecha }));
  PROX.forEach(x => { x.p.proximo = x.fecha; });
  const viernesDe = iso => { const d = new Date(iso + "T12:00:00"); d.setDate(d.getDate() - ((d.getDay() + 2) % 7)); return d.toISOString().slice(0, 10); };
  function pintarProximos() {
    const cont = $("proximos"), boton = $("toggle-proximos");
    $("n-proximos").textContent = PROX.length || "";
    if (!PROX.length) { $("caja-proximos").hidden = true; return; }
    const semanas = new Map();
    for (const x of PROX) {
      const k = viernesDe(x.fecha);
      if (!semanas.has(k)) semanas.set(k, []);
      semanas.get(k).push(x);
    }
    const orden = [...semanas].sort(([a], [b]) => a.localeCompare(b));
    const [v0, xs0] = orden[0];
    $("resumen-proximos").textContent = `${new Date(v0 + "T12:00:00").toLocaleDateString("es-ES", { day: "numeric", month: "short" })}: ${lista(xs0.slice(0, 3).map(x => x.p.titulo))}${xs0.length > 3 ? ` y ${xs0.length - 3} más` : ""}`;
    cont.innerHTML = orden.map(([v, xs]) => `
      <div class="semana-prox"><h3>Semana del ${new Date(v + "T12:00:00").toLocaleDateString("es-ES", { day: "numeric", month: "long" })}<span class="contador">${xs.length}</span></h3>
      <div class="fila-prox">${xs.map(({ p, fecha }) => `
        <button class="prox" data-p="${p.i}" title="${esc(p.titulo)}">
          ${p.cartel ? `<img src="${url(p.cartel)}" alt="" loading="lazy" referrerpolicy="no-referrer">` : `<span class="sin-cartel"></span>`}
          <b>${esc(p.titulo)}</b>
          <span>${fechaCorta(fecha)}</span>
          ${p.distribuidora ? `<span>${esc(p.distribuidora)}</span>` : ""}
          ${sesPorPeli[p.i].length ? `<span class="ya">Con sesiones</span>` : ""}
        </button>`).join("")}</div></div>`).join("");
    cont.querySelectorAll(".prox").forEach(b => b.addEventListener("click", () => { elegir(+b.dataset.p); window.scrollTo({ top: 0, behavior: "smooth" }); }));
    const abrir = v => { boton.setAttribute("aria-expanded", String(v)); cont.hidden = !v; guardar("proximos", v); };
    abrir(leer("proximos", false));
    boton.addEventListener("click", () => abrir(cont.hidden));
  }

  // ================================================================== calendario de competencia
  let calLimite = 16, calFuturos = 4;
  function pintarCalendario() {
    const cont = $("calendario");
    const filas = [];
    const hoy = new Date(); hoy.setHours(12, 0, 0, 0);
    const faltan = v => { const d = Math.round((new Date(v + "T12:00:00") - hoy) / 864e5); return d <= 0 ? "Este fin de semana" : d === 1 ? "Mañana" : d < 14 ? `Dentro de ${d} días` : `Dentro de ${Math.round(d / 7)} semanas`; };
    // fines de semana futuros con estrenos programados
    const futuros = new Map();
    PROX.forEach(x => {
      const v = viernesDe(x.fecha);
      if (D.fines.includes(v) && porFin[D.fines.indexOf(v)].length) return;
      if (!futuros.has(v)) futuros.set(v, []);
      futuros.get(v).push(x.p);
    });
    const futurosOrd = [...futuros].sort(([a], [b]) => a.localeCompare(b));
    if (futurosOrd.length) filas.push(`<div class="subtitulo">Próximos fines de semana</div>`);
    futurosOrd.slice(0, calFuturos).forEach(([v, ps]) => filas.push(`
      <div class="semana futura"><button disabled>
        <div class="fecha"><b>${new Date(v + "T12:00:00").toLocaleDateString("es-ES", { day: "numeric", month: "short", year: "numeric" })}</b><span>${faltan(v)}</span></div>
        <div class="total"><b>${ps.length}</b><span>${ps.length === 1 ? "estreno" : "estrenos"}</span></div>
        <div class="estrenos">${ps.map(p => `<span class="chip"><b>${esc(p.titulo)}</b>${p.distribuidora ? `<span>${esc(p.distribuidora)}</span>` : ""}</span>`).join("")}</div>
        <div class="cuota"></div><span></span>
      </button></div>`));
    if (futurosOrd.length > calFuturos) filas.push(`<div class="mas"><button class="btn" id="cal-fut">Ver los ${futurosOrd.length} fines de semana con estrenos anunciados</button></div>`);
    filas.push(`<div class="subtitulo" style="margin-top:20px">Fines de semana con taquilla</div>`);
    // fines de semana con taquilla, del más reciente al más antiguo
    const conTaq = D.fines.map((_, i) => i).filter(i => porFin[i].length).reverse();
    const media = i => { const prev = conTaq.filter(j => j < i).slice(0, 8); return prev.length ? prev.reduce((s, j) => s + porFin[j].reduce((a, r) => a + (r[FE] || 0), 0), 0) / prev.length : null; };
    conTaq.slice(0, calLimite).forEach(i => {
      const rs = porFin[i], tot = rs.reduce((s, r) => s + (r[FE] || 0), 0);
      const nuevos = rs.filter(r => r[SEM] === 1), cuotaE = nuevos.reduce((s, r) => s + (r[FE] || 0), 0) / tot;
      const m = media(i), dif = m ? 100 * (tot / m - 1) : null;
      filas.push(`
      <div class="semana" data-fin="${i}"><button aria-expanded="false">
        <div class="fecha"><b>${fechaFin(i)}</b><span>Número 1: ${esc(pelis[rs[0][P]].titulo)}</span></div>
        <div class="total"><b>${eurCorto(tot)}</b><span>${dif == null ? "Top 25" : `${pct(dif)} sobre la media`}</span></div>
        <div class="estrenos">${nuevos.length ? nuevos.map(r => `<span class="chip"><b>${esc(pelis[r[P]].titulo)}</b><span>${eurCorto(r[FE])}</span></span>`).join("") : `<span class="sec">Sin estrenos en el top 25</span>`}</div>
        <div class="cuota"><span>Estrenos: ${dec(100 * cuotaE, 0)} % del total</span><div class="barra-apilada"><i style="width:${100 * cuotaE}%"></i></div></div>
        <svg class="chevron" viewBox="0 0 24 24" aria-hidden="true"><path d="m6 9 6 6 6-6"/></svg>
      </button><div class="semana-detalle" hidden></div></div>`);
    });
    cont.innerHTML = filas.join("") + (conTaq.length > calLimite ? `<div class="mas"><button class="btn" id="cal-mas">Ver ${Math.min(16, conTaq.length - calLimite)} fines de semana más</button></div>` : "");
    cont.querySelectorAll(".semana[data-fin] > button").forEach(b => b.addEventListener("click", () => {
      const caja = b.parentElement, det = caja.querySelector(".semana-detalle"), i = +caja.dataset.fin;
      const abierta = det.hidden;
      det.hidden = !abierta; caja.classList.toggle("abierta", abierta); b.setAttribute("aria-expanded", String(abierta));
      if (abierta && !det.innerHTML) {
        const rs = porFin[i], tot = rs.reduce((s, r) => s + (r[FE] || 0), 0), max = rs[0][FE] || 1;
        det.innerHTML = `<div class="tabla-scroll"><table><thead><tr><th>Película</th><th>Semana</th><th>Fin de semana</th><th>Cuota</th><th></th></tr></thead><tbody>
          ${rs.slice(0, 12).map(r => `<tr data-p="${r[P]}"><td class="titulo">${r[POS]}. ${esc(pelis[r[P]].titulo)}</td><td class="sec">${r[SEM] === 1 ? "Estreno" : r[SEM] + ".ª"}</td><td>${eur(r[FE])}</td><td>${dec(100 * r[FE] / tot)} %</td>
            <td style="width:30%"><span class="share"><i style="width:${100 * r[FE] / max}%;${r[SEM] === 1 ? "" : "background:var(--border-fuerte)"}"></i></span></td></tr>`).join("")}
          </tbody></table></div>`;
        det.querySelectorAll("tr[data-p]").forEach(tr => tr.addEventListener("click", () => { elegir(+tr.dataset.p, i); irVista("explorar"); }));
      }
    }));
    $("cal-mas")?.addEventListener("click", () => { calLimite += 16; pintarCalendario(); });
    $("cal-fut")?.addEventListener("click", () => { calFuturos = 999; pintarCalendario(); });
  }

  // ================================================================== cadenas de cines
  const selCadFin = $("cad-fin"), chkCadSolo = $("cad-solo");
  SES.slice().reverse().forEach(s => selCadFin.insertAdjacentHTML("beforeend", `<option value="${s.fin}">${fechaFin(s.fin)}${porFin[s.fin].length ? "" : " (taquilla pendiente)"}</option>`));
  selCadFin.addEventListener("change", pintarCadenas);
  chkCadSolo.addEventListener("change", pintarCadenas);
  async function pintarCadenas() {
    const cont = $("cadenas");
    if (!SES.length) { cont.innerHTML = `<p class="vacio">Aún no hay sesiones por cine capturadas.</p>`; return; }
    chkCadSolo.disabled = st.peli < 0;
    if (st.peli < 0) chkCadSolo.checked = false;
    const fin = +selCadFin.value;
    const S = await cargarSesiones(fin);
    if (!S) { cont.innerHTML = `<p class="vacio">No se pudieron cargar las sesiones de ese fin de semana.</p>`; return; }
    const ids = chkCadSolo.checked && st.peli >= 0 ? [pelis[st.peli].id] : S.pelis;
    const est = estimarCines(S, fin, ids, "todo");
    const cad = new Map();
    S.cines.forEach((c, ci) => {
      const r = est.res[ci];
      if (!r.peso) return;
      const k = c[8] || "Independiente";
      if (!cad.has(k)) cad.set(k, { cines: 0, ses: 0, eur: 0, espect: 0, pelis: new Map() });
      const a = cad.get(k);
      a.cines++; a.ses += r.ses[0] + r.ses[1] + r.ses[2]; a.eur += r.eur; a.espect += r.espect;
    });
    for (const id of ids) {
      for (const e of S.porPeli.get(id) || []) {
        const k = S.cines[e[0]][8] || "Independiente", a = cad.get(k);
        if (a) a.pelis.set(id, (a.pelis.get(id) || 0) + e[2] + e[3] + e[4]);
      }
    }
    const filas = [...cad].sort((a, b) => (b[1].eur || b[1].ses) - (a[1].eur || a[1].ses));
    const totS = filas.reduce((s, [, a]) => s + a.ses, 0), totE = filas.reduce((s, [, a]) => s + a.eur, 0);
    const maxS = Math.max(...filas.map(([, a]) => a.ses), 1);
    const grandes = filas.filter(([k]) => k !== "Independiente").slice(0, 4);
    cont.innerHTML = `
      <div class="cadenas-resumen">${grandes.map(([k, a]) => kpi(esc(k), est.conTaquilla ? eurCorto(a.eur) : `${dec(100 * a.ses / totS)} %`, est.conTaquilla ? `${dec(100 * a.eur / totE)} % del total, ${a.cines} cines` : `de las sesiones, ${a.cines} cines`)).join("")}</div>
      <div class="tabla-scroll alta"><table><thead><tr><th>Cadena</th><th>Cines</th><th>Sesiones</th><th>Cuota de sesiones</th><th>Recaudación</th><th>Espectadores</th><th>Películas con más sesiones</th></tr></thead><tbody>
      ${filas.map(([k, a]) => `<tr><td class="titulo">${esc(k)}</td><td>${num(a.cines)}</td><td>${num(a.ses)}</td>
        <td style="min-width:160px"><span class="share"><span class="sec">${dec(100 * a.ses / totS)} %</span><i style="width:${60 * a.ses / maxS}%"></i></span></td>
        <td>${est.conTaquilla ? eur(a.eur) : NADA}</td><td>${est.conTaquilla ? num(a.espect) : NADA}</td>
        <td class="sec" style="text-align:left;white-space:normal;min-width:220px">${esc(lista([...a.pelis].sort((x, y) => y[1] - x[1]).slice(0, 3).map(([id]) => { const pi = idPeli.get(id); return pi != null ? pelis[pi].titulo : id; })))}</td></tr>`).join("")}
      </tbody></table></div>
      <p class="pie-tabla">${est.conTaquilla ? "Recaudación estimada repartiendo la taquilla nacional según las sesiones y el precio de cada cine." : "La taquilla de este fin de semana aún no se ha publicado; la tabla muestra el reparto de sesiones."} La cadena sale de la ficha de cada cine en eCartelera; los cines sin cadena se agrupan como independientes.</p>`;
  }

  // ================================================================== cara a cara
  let gCcA = null, gCcS = null;
  const ccA = $("cc-a"), ccB = $("cc-b"), cara = { a: null, b: null };
  ccA.addEventListener("change", () => { cara.a = buscarPeli(ccA.value); pintarCara(); });
  ccB.addEventListener("change", () => { cara.b = buscarPeli(ccB.value); pintarCara(); });
  function parecida(p) {
    return pelis.filter(q => q.i !== p.i && q.completa && q.genero === p.genero && q.porCine)
      .sort((a, b) => Math.abs(Math.log(a.porCine / p.porCine)) - Math.abs(Math.log(b.porCine / p.porCine)))[0]?.i ?? null;
  }
  function pintarCara() {
    if (cara.a == null) cara.a = st.peli >= 0 && pelis[st.peli].conTaquilla ? st.peli : (porFin[ULT_TAQ][0]?.[P] ?? null);
    if (cara.b == null && cara.a != null) cara.b = st.cmp[0] ?? parecida(pelis[cara.a]);
    ccA.value = cara.a != null ? pelis[cara.a].etiqueta : "";
    ccB.value = cara.b != null ? pelis[cara.b].etiqueta : "";
    const cont = $("cara");
    if (cara.a == null || cara.b == null) { cont.innerHTML = `<p class="vacio">Elige dos películas.</p>`; return; }
    const A = pelis[cara.a], B = pelis[cara.b];
    const s1 = css("--series-1"), s2 = css("--series-2");
    cargarCriticas().then(todas => {
      const crit = todas || {};
      const filas = [
        ["Taquilla total", "total_eur", eur, 1], ["Primer fin de semana", "apertura_eur", eur, 1], ["Cines en el estreno", "apertura_cines", num, 0],
        ["Apertura por cine", "porCine", eur, 1], ["Caída 2.º finde", "caida_2", pct, 1], ["Multiplicador", "multiplicador", mult, 1],
        ["Semanas en top 25", "semanas_top25", num, 1], ["Espectadores", "espectFindes", num, 1], ["Percentil global", "notaTodas", v => v == null ? NADA : "p" + Math.round(v * 100), 1],
      ];
      const notaCrit = (p, j) => crit[p.id]?.prensa?.[j];
      const celda = (va, vb, fmt, mejorAlto) => {
        const gana = mejorAlto && va != null && vb != null && va !== vb ? (va > vb ? "a" : "b") : null;
        return [gana === "a" ? "gana" : "", fmt(va), gana === "b" ? "gana" : "", fmt(vb)];
      };
      const fila = (t, [ca, va, cb, vb]) => `<tr><td class="${ca}">${va}</td><td>${t}</td><td class="${cb}">${vb}</td></tr>`;
      const cabeza = (p, color) => `<div class="cara-peli">${p.cartel ? `<img src="${url(p.cartel)}" alt="" referrerpolicy="no-referrer">` : "<span></span>"}
        <div><h3><span class="marcador" style="background:${color}"></span>${esc(p.titulo)}</h3>
        <p>${esc(lista([p.anio, p.genero, p.origen].filter(x => x && x !== NADA)))}</p>
        <p>${esc(lista(p.director || []))}</p><p>${veredicto(p)}</p></div></div>`;
      cont.innerHTML = `<div class="cara-cab">${cabeza(A, s1)}${cabeza(B, s2)}</div>
        <div class="tabla-scroll"><table class="tabla-cara"><tbody>
          ${filas.map(([t, k, fmt, alto]) => fila(t, celda(A[k], B[k], fmt, alto))).join("")}
          ${fila("Nota de la prensa", celda(notaCrit(A, 0), notaCrit(B, 0), v => dec(v), 1))}
          ${fila("Nota del público", celda(crit[A.id]?.usuarios?.[0], crit[B.id]?.usuarios?.[0], v => dec(v), 1))}
          ${fila("Presupuesto", ["", A.presupuesto ? eurCorto(A.presupuesto).replace("€", A.presupuesto_moneda) : NADA, "", B.presupuesto ? eurCorto(B.presupuesto).replace("€", B.presupuesto_moneda) : NADA])}
        </tbody></table></div>`;
    });
    gCcA?.destroy(); gCcS?.destroy();
    const comunes = opcionesBase();
    const maxSem = Math.max(1, ...[A, B].map(p => Math.max(0, ...porPeli[p.i].map(r => r[SEM] || 0))));
    const serie = (p, k) => { const d = Array(maxSem).fill(null); porPeli[p.i].forEach(r => { if (r[SEM]) d[r[SEM] - 1] = r[k]; }); return d; };
    const labels = Array.from({ length: maxSem }, (_, i) => `S${i + 1}`);
    gCcA = new Chart($("cc-g-acum"), { type: "line", data: { labels, datasets: [A, B].map((p, j) => ({ label: p.titulo, data: serie(p, TOT), borderColor: [s1, s2][j], backgroundColor: [s1, s2][j], borderWidth: 2, pointRadius: 2.5, spanGaps: true, tension: 0.2 })) },
      options: { ...comunes, plugins: { ...comunes.plugins, tooltip: { ...comunes.plugins.tooltip, callbacks: { label: c => `${c.dataset.label}: ${eur(c.parsed.y)}` } } } } });
    gCcS = new Chart($("cc-g-sem"), { type: "bar", data: { labels, datasets: [A, B].map((p, j) => ({ label: p.titulo, data: serie(p, FE), backgroundColor: [s1, s2][j], borderRadius: 3 })) },
      options: { ...comunes, plugins: { ...comunes.plugins, tooltip: { ...comunes.plugins.tooltip, callbacks: { label: c => `${c.dataset.label}: ${eur(c.parsed.y)}` } } } } });
  }

  // ================================================================== administración
  /* Seguridad sin servidor: el token de GitHub (lo único que permite cambiar algo) se guarda en
     web/admin.json cifrado con AES-GCM, con una clave derivada de usuario + contraseña (PBKDF2, 600.000
     iteraciones). Sin la contraseña no se puede descifrar; sin el token no se puede publicar nada.
     La sesión vive en sessionStorage y se borra al cerrar la pestaña. */
  const dlg = $("dev");
  const ITER = 600000;
  const b64 = buf => btoa(String.fromCharCode(...new Uint8Array(buf)));
  const deb64 = s => Uint8Array.from(atob(s), c => c.charCodeAt(0));
  const textoB64 = s => btoa(unescape(encodeURIComponent(s)));
  async function claveDe(usuario, pass, sal) {
    const base = await crypto.subtle.importKey("raw", new TextEncoder().encode(usuario.trim().toLowerCase() + "\n" + pass), "PBKDF2", false, ["deriveKey"]);
    return crypto.subtle.deriveKey({ name: "PBKDF2", salt: sal, iterations: ITER, hash: "SHA-256" }, base, { name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);
  }
  async function cifrarAdmin(usuario, pass, secreto) {
    const sal = crypto.getRandomValues(new Uint8Array(16)), iv = crypto.getRandomValues(new Uint8Array(12));
    const datos = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, await claveDe(usuario, pass, sal), new TextEncoder().encode(JSON.stringify(secreto)));
    return { v: 1, iter: ITER, sal: b64(sal), iv: b64(iv), datos: b64(datos) };
  }
  async function descifrarAdmin(adm, usuario, pass) {
    const clave = await claveDe(usuario, pass, deb64(adm.sal));
    const plano = await crypto.subtle.decrypt({ name: "AES-GCM", iv: deb64(adm.iv) }, clave, deb64(adm.datos));
    return JSON.parse(new TextDecoder().decode(plano));
  }
  const sesion = {
    leer() { try { return JSON.parse(sessionStorage.getItem("taq-admin")); } catch (e) { return null; } },
    poner(v) { try { v ? sessionStorage.setItem("taq-admin", JSON.stringify(v)) : sessionStorage.removeItem("taq-admin"); } catch (e) { /* sin almacenamiento */ } },
  };

  function modoDespliegue() {
    if (location.protocol === "file:") return "archivo";
    if (["localhost", "127.0.0.1", "[::1]"].includes(location.hostname)) return "local";
    return "remoto";
  }
  const leerJson = async ruta => { try { const r = await fetch(ruta, { cache: "no-store" }); return r.ok ? await r.json() : null; } catch (e) { return null; } };
  let apiLocal = null;
  const hayApiLocal = async () => apiLocal ??= modoDespliegue() === "local" && (await leerJson("api/estado")) != null;

  // GitHub: guardar un archivo del repositorio (crea o reemplaza)
  async function gh(s, ruta, opciones = {}) {
    // sin barra final: con ella GitHub rechaza la comprobación CORS y el navegador da «Failed to fetch»
    return fetch(`https://api.github.com/repos/${s.owner}/${s.repo}${ruta ? "/" + ruta : ""}`, {
      ...opciones, headers: { Authorization: `Bearer ${s.token}`, Accept: "application/vnd.github+json", ...(opciones.headers || {}) },
    });
  }
  /* Firma de los commits que hace la administración: nombre neutro y el email privado de GitHub
     (id+usuario@users.noreply.github.com), para que nunca aparezca el nombre real del perfil. */
  let firmaCache = null;
  async function firmaNeutra(s) {
    if (firmaCache) return firmaCache;
    let email = `admin@${s.owner}.github.io`;
    try {
      const r = await fetch("https://api.github.com/user", { headers: { Authorization: `Bearer ${s.token}`, Accept: "application/vnd.github+json" } });
      if (r.ok) { const u = await r.json(); if (u.id && u.login) email = `${u.id}+${u.login}@users.noreply.github.com`; }
    } catch (e) { /* se usa el email genérico */ }
    return firmaCache = { name: "Contraplano", email };
  }
  async function guardarArchivo(s, nombre, obj, mensaje) {
    const contenido = JSON.stringify(obj, null, 2) + "\n";
    if (await hayApiLocal()) {
      const r = await fetch("api/guardar", { method: "POST", headers: { "X-Taquilla": "1", "Content-Type": "application/json" }, body: JSON.stringify({ archivo: nombre, contenido }) });
      if (!r.ok) throw new Error(`el servidor local respondió ${r.status}`);
      if (!s?.token) return "Guardado en este PC.";
    }
    if (!s?.token) throw new Error("hace falta el token de GitHub");
    const ruta = `contents/web/${nombre}`;
    const actual = await gh(s, ruta);
    const sha = actual.ok ? (await actual.json()).sha : undefined;
    const firma = await firmaNeutra(s);
    const r = await gh(s, ruta, { method: "PUT", body: JSON.stringify({ message: mensaje, content: textoB64(contenido), sha, author: firma, committer: firma }) });
    if (!r.ok) throw new Error(`GitHub respondió ${r.status}${r.status === 401 || r.status === 403 ? " (token sin permiso)" : ""}`);
    return "Guardado. La web publicada se actualiza en uno o dos minutos.";
  }
  function descargar(nombre, obj) {
    const a = document.createElement("a");
    a.href = URL.createObjectURL(new Blob([JSON.stringify(obj, null, 2) + "\n"], { type: "application/json" }));
    a.download = nombre; a.click(); URL.revokeObjectURL(a.href);
  }

  $("btn-dev").addEventListener("click", () => { pintarAdmin(); dlg.showModal(); });

  async function pintarAdmin() {
    const cuerpo = $("dev-cuerpo"), modo = modoDespliegue();
    if (modo === "archivo") {
      cuerpo.innerHTML = `<div class="modo"><b>Administración no disponible</b>
        <span>La web está abierta como archivo. Para entrar en la administración, ábrela con <code>servidor.bat</code> o desde la web publicada. Para actualizar los datos sin administración, ejecuta <code>actualizar.bat</code> y recarga.</span></div>`;
      return;
    }
    if (!crypto?.subtle) {
      cuerpo.innerHTML = `<div class="modo"><b>Conexión no segura</b><span>La administración necesita HTTPS. Abre la web con <code>https://</code>.</span></div>`;
      return;
    }
    const adm = await leerJson("admin.json");
    if (!adm) return pintarAlta();
    if (!sesion.leer()) return pintarLogin(adm);
    return pintarPanelAdmin(adm);
  }

  // ---- primera vez: crear el acceso
  async function pintarAlta() {
    const cuerpo = $("dev-cuerpo"), local = await hayApiLocal();
    const [owner] = /\.github\.io$/.test(location.hostname) ? location.hostname.split(".") : [""];
    const repo = owner ? (location.pathname.split("/").filter(Boolean)[0] || `${owner}.github.io`) : "";
    cuerpo.innerHTML = `
      <div class="modo"><b>Crear el acceso de administración</b>
        <span>Solo hay una cuenta. Tu contraseña cifra el token de GitHub, que es lo que permite actualizar y cambiar la web publicada. Si la pierdes, se crea una nueva con un token nuevo.</span></div>
      <form class="form-admin" id="f-alta" autocomplete="off">
        <label class="campo"><span>Usuario</span><input id="a-usuario" required autocomplete="username"></label>
        <label class="campo"><span>Contraseña (mínimo 12 caracteres)</span><input id="a-pass" type="password" required minlength="12" autocomplete="new-password"></label>
        <label class="campo"><span>Repite la contraseña</span><input id="a-pass2" type="password" required autocomplete="new-password"></label>
        <label class="campo"><span>Token de GitHub${local ? " (opcional en este PC)" : ""}</span><input id="a-token" type="password" ${local ? "" : "required"} placeholder="github_pat_…"></label>
        <div class="dos">
          <label class="campo"><span>Usuario de GitHub</span><input id="a-owner" value="${esc(owner)}" ${local ? "" : "required"}></label>
          <label class="campo"><span>Repositorio</span><input id="a-repo" value="${esc(repo)}" ${local ? "" : "required"}></label>
        </div>
        <p class="nota">Token de tipo fine-grained, limitado a este repositorio, con permisos <code>Actions: Read and write</code> y <code>Contents: Read and write</code>.</p>
        <div class="fila-acciones"><button class="btn btn-primario">Crear acceso</button><span class="sec" id="a-estado"></span></div>
      </form>`;
    $("f-alta").addEventListener("submit", async ev => {
      ev.preventDefault();
      const est = $("a-estado"), u = $("a-usuario").value.trim(), p = $("a-pass").value;
      if (p.length < 12) { est.textContent = "La contraseña debe tener al menos 12 caracteres."; return; }
      if (p !== $("a-pass2").value) { est.textContent = "Las contraseñas no coinciden."; return; }
      const secreto = { usuario: u, token: $("a-token").value.trim(), owner: $("a-owner").value.trim(), repo: $("a-repo").value.trim() };
      est.textContent = "Cifrando…";
      const adm = await cifrarAdmin(u, p, secreto);
      try {
        if (!local && secreto.token) {
          const prueba = await gh(secreto, "");
          if (!prueba.ok) throw new Error(`el token no tiene acceso a ${secreto.owner}/${secreto.repo}`);
        }
        est.textContent = await guardarArchivo(secreto, "admin.json", adm, "Acceso de administración");
        sesion.poner(secreto);
        setTimeout(() => pintarPanelAdmin(adm), 900);
      } catch (e) {
        est.innerHTML = `No se pudo guardar: ${esc(e.message)}. <button class="btn" id="a-bajar" type="button">Descargar admin.json</button>`;
        $("a-bajar").addEventListener("click", () => descargar("admin.json", adm));
      }
    });
  }

  // ---- iniciar sesión
  function pintarLogin(adm) {
    const cuerpo = $("dev-cuerpo");
    cuerpo.innerHTML = `
      <form class="form-admin" id="f-login">
        <label class="campo"><span>Usuario</span><input id="l-usuario" required autocomplete="username"></label>
        <label class="campo"><span>Contraseña</span><input id="l-pass" type="password" required autocomplete="current-password"></label>
        <div class="fila-acciones"><button class="btn btn-primario">Entrar</button><span class="sec" id="l-estado"></span></div>
      </form>`;
    $("l-usuario").focus();
    let fallos = 0;
    $("f-login").addEventListener("submit", async ev => {
      ev.preventDefault();
      const est = $("l-estado"), btn = ev.submitter || $("f-login").querySelector("button");
      btn.disabled = true; est.textContent = "Comprobando…";
      try {
        const s = await descifrarAdmin(adm, $("l-usuario").value, $("l-pass").value);
        sesion.poner(s);
        pintarPanelAdmin(adm);
      } catch (e) {
        fallos++;
        est.textContent = "Usuario o contraseña incorrectos.";
        setTimeout(() => { btn.disabled = false; }, Math.min(8000, 500 * 2 ** fallos));
      }
    });
  }

  // ---- panel
  async function pintarPanelAdmin(adm) {
    const s = sesion.leer(), cuerpo = $("dev-cuerpo"), local = await hayApiLocal();
    const gen = new Date(D.generado);
    const cfg = { ...CONFIG_DEF, ...(await leerJson("config.json") || {}) };
    cuerpo.innerHTML = `
      <div class="admin-cab"><span>Sesión iniciada como <b>${esc(s.usuario)}</b></span><button class="btn" id="ad-salir">Cerrar sesión</button></div>

      <section class="admin-sec"><h3>Datos</h3>
        <dl class="estado-datos">
          <dt>Generados</dt><dd>${gen.toLocaleDateString("es-ES", { day: "numeric", month: "long", year: "numeric" })}, ${gen.toLocaleTimeString("es-ES", { hour: "2-digit", minute: "2-digit" })}</dd>
          <dt>Última taquilla</dt><dd>${fechaFin(ULT_TAQ)}</dd>
          <dt>Últimas sesiones</dt><dd>${SES.length ? fechaFin(SES[SES.length - 1].fin) : "Ninguna"}</dd>
          <dt>Histórico</dt><dd>${num(D.fines.length)} fines de semana, ${num(pelis.length)} películas</dd>
        </dl>
        <div class="fila-acciones"><button class="btn btn-primario" id="ad-act">Actualizar datos ahora</button><button class="btn" id="ad-recargar">Recargar la página</button><span class="sec" id="ad-estado"></span></div>
        <pre id="ad-log" hidden></pre>
        <div id="ad-ejec"></div>
      </section>

      <section class="admin-sec"><h3>Contenido público</h3>
        <form class="form-admin" id="f-cfg">
          <label class="campo"><span>Título de la web</span><input id="c-titulo" value="${esc(cfg.titulo)}" maxlength="60"></label>
          <label class="campo"><span>Aviso para los visitantes (vacío para quitarlo)</span><textarea id="c-aviso" rows="2" maxlength="300">${esc(cfg.aviso)}</textarea></label>
          <label class="campo"><span>Película al abrir la web (vacío: la número 1 del último fin de semana)</span><input id="c-peli" list="lista-pelis" value="${esc(cfg.pelicula ? (pelis[idPeli.get(cfg.pelicula)]?.etiqueta || "") : "")}"></label>
          <fieldset class="campo"><span>Pestañas visibles</span>
            <div class="checks">${VISTAS.filter(v => v !== "explorar").map(v => `<label class="check"><input type="checkbox" value="${v}" ${cfg.ocultas.includes(v) ? "" : "checked"}> ${NOMBRE_VISTA[v]}</label>`).join("")}</div></fieldset>
          <div class="fila-acciones"><button class="btn btn-primario">Guardar contenido</button><span class="sec" id="c-estado"></span></div>
        </form>
      </section>

      <section class="admin-sec"><h3>Seguridad</h3>
        <form class="form-admin" id="f-pass">
          <div class="dos">
            <label class="campo"><span>Nuevo usuario</span><input id="p-usuario" value="${esc(s.usuario)}" required autocomplete="username"></label>
            <label class="campo"><span>Nueva contraseña</span><input id="p-pass" type="password" required minlength="12" autocomplete="new-password"></label>
          </div>
          <label class="campo"><span>Nuevo token de GitHub (vacío para mantener el actual)</span><input id="p-token" type="password" placeholder="github_pat_…"></label>
          <div class="fila-acciones"><button class="btn">Cambiar acceso</button><span class="sec" id="p-estado"></span></div>
        </form>
      </section>`;

    $("ad-salir").addEventListener("click", () => { sesion.poner(null); pintarLogin(adm); });
    $("ad-recargar").addEventListener("click", () => location.reload());

    // actualizar datos
    if (local) {
      $("ad-act").addEventListener("click", async () => {
        $("ad-act").disabled = true;
        await fetch("api/actualizar", { method: "POST", headers: { "X-Taquilla": "1" } });
        seguirLocal();
      });
      seguirLocal(true);
    } else {
      $("ad-act").addEventListener("click", async () => {
        const est = $("ad-estado");
        est.textContent = "Enviando…";
        const r = await gh(s, "actions/workflows/actualizar.yml/dispatches", { method: "POST", body: JSON.stringify({ ref: "main" }) }).catch(() => null);
        est.textContent = r && r.status === 204 ? "Tarea lanzada en GitHub. La web se actualizará cuando termine." : `No se pudo lanzar (${r ? r.status : "sin conexión"}).`;
        setTimeout(pintarEjecuciones, 4000);
      });
      pintarEjecuciones();
    }
    async function pintarEjecuciones() {
      const caja = $("ad-ejec");
      if (!caja || !s.token) return;
      const r = await gh(s, "actions/workflows/actualizar.yml/runs?per_page=5").catch(() => null);
      if (!r || !r.ok) { caja.innerHTML = `<p class="nota">No se pudieron leer las ejecuciones de GitHub.</p>`; return; }
      const runs = (await r.json()).workflow_runs || [];
      const est = x => x.status !== "completed" ? "En curso" : x.conclusion === "success" ? "Correcta" : "Con errores";
      caja.innerHTML = runs.length ? `<div class="tabla-scroll"><table><thead><tr><th>Ejecución</th><th>Origen</th><th>Estado</th></tr></thead><tbody>
        ${runs.map(x => `<tr><td><a href="${url(x.html_url)}" target="_blank" rel="noopener">${new Date(x.created_at).toLocaleString("es-ES", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" })}</a></td>
          <td class="sec">${x.event === "schedule" ? "Programada" : "Manual"}</td><td>${est(x)}</td></tr>`).join("")}</tbody></table></div>` : `<p class="nota">Todavía no hay ejecuciones.</p>`;
    }

    // contenido público
    $("f-cfg").addEventListener("submit", async ev => {
      ev.preventDefault();
      const est = $("c-estado"), i = buscarPeli($("c-peli").value);
      const nueva = {
        titulo: $("c-titulo").value.trim() || CONFIG_DEF.titulo,
        aviso: $("c-aviso").value.trim(),
        pelicula: $("c-peli").value.trim() && i != null ? pelis[i].id : null,
        ocultas: [...$("f-cfg").querySelectorAll(".checks input")].filter(c => !c.checked).map(c => c.value),
      };
      est.textContent = "Guardando…";
      try { est.textContent = await guardarArchivo(s, "config.json", nueva, "Contenido público de la web"); aplicarConfig(nueva); }
      catch (e) { est.textContent = `No se pudo guardar: ${e.message}.`; }
    });

    // cambiar usuario, contraseña o token
    $("f-pass").addEventListener("submit", async ev => {
      ev.preventDefault();
      const est = $("p-estado"), u = $("p-usuario").value.trim(), p = $("p-pass").value;
      if (p.length < 12) { est.textContent = "Mínimo 12 caracteres."; return; }
      const nuevo = { ...s, usuario: u, token: $("p-token").value.trim() || s.token };
      est.textContent = "Cifrando…";
      const adm2 = await cifrarAdmin(u, p, nuevo);
      try { est.textContent = await guardarArchivo(s, "admin.json", adm2, "Cambio de acceso de administración"); sesion.poner(nuevo); }
      catch (e) { est.textContent = `No se pudo guardar: ${e.message}.`; }
    });
  }

  let relojDev = null;
  async function seguirLocal(soloUnaVez = false) {
    clearTimeout(relojDev);
    const e = await leerJson("api/estado");
    const log = $("ad-log"), est = $("ad-estado"), btn = $("ad-act");
    if (!e || !log) return;
    if (e.log?.length) { log.hidden = false; log.textContent = e.log.join("\n"); log.scrollTop = log.scrollHeight; }
    if (e.en_curso) {
      btn.disabled = true; est.textContent = "Actualizando…";
      relojDev = setTimeout(() => seguirLocal(), 2500);
    } else {
      btn.disabled = false;
      est.textContent = e.fin ? (e.codigo === 0 ? "Terminado. Recarga la página para ver los datos nuevos." : "Terminó con errores; revisa el registro.") : "";
      if (!soloUnaVez && e.codigo === 0) $("ad-recargar")?.focus();
    }
  }

  // ================================================================== configuración pública (config.json)
  const CONFIG_DEF = { titulo: "Taquilla España", aviso: "", pelicula: null, ocultas: [] };
  const NOMBRE_VISTA = { peliculas: "Películas", calendario: "Calendario", cadenas: "Cadenas", cara: "Cara a cara" };
  let configActual = CONFIG_DEF;
  function aplicarConfig(cfg) {
    configActual = { ...CONFIG_DEF, ...cfg };
    document.title = configActual.titulo;
    document.querySelector(".marca span").textContent = configActual.titulo;
    const aviso = $("aviso");
    aviso.hidden = !configActual.aviso;
    aviso.textContent = configActual.aviso;
    document.querySelectorAll(".pestanas button").forEach(b => { b.hidden = configActual.ocultas.includes(b.dataset.vista); });
    if (configActual.ocultas.includes(st.vista)) irVista("explorar");
  }

  // ================================================================== arranque
  function pintarTodo() {
    parar();
    pintarControles(); pintarSlider(); pintarMapa(); pintarPanel(); pintarGraficos(); pintarResenas();
    if (st.vista === "peliculas") pintarTabla();
    if (st.vista === "cadenas") pintarCadenas();
    if (st.vista === "cara") { cara.a = null; cara.b = null; pintarCara(); }
  }
  matchMedia("(prefers-color-scheme: dark)").addEventListener("change", () => { ponerTeselas(); pintarMapa(); pintarGraficos(); });

  pintarMigas();
  pintarProximos();
  const desdeHash = () => {
    const id = decodeURIComponent((location.hash.match(/p=([^&]+)/) || [])[1] || "");
    return pelis.findIndex(p => p.id === id);
  };
  // los enlaces de los popups de cine mantienen el fin de semana que se está viendo
  addEventListener("hashchange", () => { const i = desdeHash(); if (i >= 0 && i !== st.peli) { mapa.closePopup(); elegir(i, st.fin); } });
  const inicial = desdeHash();
  st.vista = leer("vista", "explorar");
  elegir(inicial >= 0 ? inicial : (porFin[ULT_TAQ][0] ? porFin[ULT_TAQ][0][P] : -1));
  irVista(inicial >= 0 ? "explorar" : st.vista);
  // configuración pública que guarda el administrador (no existe al abrir la web como archivo)
  leerJson("config.json").then(cfg => {
    if (!cfg) return;
    aplicarConfig(cfg);
    const i = cfg.pelicula ? idPeli.get(cfg.pelicula) : null;
    if (inicial < 0 && i != null) elegir(i);
  });
})();
