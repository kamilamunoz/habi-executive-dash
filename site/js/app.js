/* ============================================================================
 * habi-dashboard · app.js
 * ----------------------------------------------------------------------------
 * Carga los JSON precomputados por scripts/refresh_data.py, aplica filtros
 * del sidebar y renderiza Snapshot + KPIs + drill-down.
 *
 * Cada KPI trae:
 *   - meses_disponibles: lista de YYYY-MM
 *   - series: serie temporal preagregada (global / pais / subsidiaria / linea)
 *   - facts: lista de filas crudas (mes, pais, subsidiaria, linea, cuenta, ...)
 *
 * Toda la agregacion del drill-down se hace sobre `facts` aplicando los
 * filtros activos. Esto respeta la jerarquia completa: si filtras una
 * subsidiaria, los breakdowns por linea/cuenta solo muestran lo que esa
 * subsidiaria tiene.
 * ========================================================================= */

const STATE = {
  meta: null,
  kpis: {},
  filters: {
    mes: null,
    pais: "Global",
    subsidiaria: "Todas",
    linea: "Todas",
    moneda: "LOCAL",
    elim: "sin_elim",
    fxCOP: 3700,
    fxMXN: 18.5,
  },
};

/* ============================================================ CATALOGOS = */

const PAIS_LIST = ["Global", "Colombia", "Mexico", "Offshore"];
const SUBSIDIARIAS_POR_PAIS = {
  Global:   ["Todas", "Habi", "HabiCapital", "Habicredit", "Corporativo", "Merbos", "Tu HabiPres", "LTD", "Corp", "LLC Colombia", "LLC Mexico"],
  Colombia: ["Todas", "Habi", "HabiCapital", "Habicredit"],
  Mexico:   ["Todas", "Corporativo", "Merbos", "Tu HabiPres"],
  Offshore: ["Todas", "LTD", "Corp", "LLC Colombia", "LLC Mexico"],
};
const LINEAS_POR_PAIS = {
  Global:   ["Todas", "Market Maker", "Brokerage", "HabiCredit", "Other"],
  Colombia: ["Todas", "Market Maker", "Brokerage", "HabiCredit", "Other"],
  Mexico:   ["Todas", "Market Maker", "Brokerage", "HabiCredit", "Other"],
  Offshore: ["Todas"],
};
const KPIS_41 = [
  { id: "ingresos_totales",    nombre: "Ingresos totales",     file: "kpi_ingresos.json" },
  { id: "gmv",                 nombre: "GMV / Valor transado", file: null },
  { id: "margen_bruto",        nombre: "Margen bruto $ y %",   file: null },
  { id: "contribution_margin", nombre: "Contribution margin",  file: null },
  { id: "ebitda",              nombre: "EBITDA",               file: null },
  { id: "opex_ingreso",        nombre: "OpEx / Ingreso",       file: null },
  { id: "burn_runway",         nombre: "Burn neto y runway",   file: null },
];
const KPIS_42 = [
  { id: "inventario_libros",   nombre: "Inventario en libros", file: null },
  { id: "antiguedad_inv",      nombre: "Antigüedad inventario",file: null },
  { id: "capital_roic",        nombre: "Capital desplegado / ROIC", file: null },
  { id: "ciclo_caja",          nombre: "Ciclo de conversión de caja", file: null },
  { id: "rotacion",            nombre: "Rotación / sell-through", file: null },
  { id: "deuda_apalanc",       nombre: "Deuda neta y apalancamiento", file: null },
];

const FMT_MES = {
  "01":"Ene","02":"Feb","03":"Mar","04":"Abr","05":"May","06":"Jun",
  "07":"Jul","08":"Ago","09":"Sep","10":"Oct","11":"Nov","12":"Dic",
};
function mesYYYYMM_a_label(yyyymm){
  const [y,m] = yyyymm.split("-"); return `${FMT_MES[m]} ${y}`;
}

function fmtMoneda(n, moneda, opts){
  opts = opts || {};
  if(n === null || n === undefined || isNaN(n)) return "—";
  const abs = Math.abs(n), sign = n < 0 ? "-" : "";
  let v, unit;
  if(moneda === "USD"){
    if(abs >= 1e9) [v,unit] = [abs/1e9, "B"];
    else if(abs >= 1e6) [v,unit] = [abs/1e6, "M"];
    else if(abs >= 1e3) [v,unit] = [abs/1e3, "K"];
    else [v,unit] = [abs, ""];
  } else {
    if(abs >= 1e12) [v,unit] = [abs/1e12, "B"];
    else if(abs >= 1e9) [v,unit] = [abs/1e9, "MM"];
    else if(abs >= 1e6) [v,unit] = [abs/1e6, "M"];
    else if(abs >= 1e3) [v,unit] = [abs/1e3, "K"];
    else [v,unit] = [abs, ""];
  }
  const decimals = opts.compact ? (v >= 100 ? 0 : 1) : (v >= 100 ? 0 : 1);
  return `${sign}$${v.toFixed(decimals)}${unit ? (opts.compact ? unit : " "+unit) : ""}`;
}

function fmtDelta(diff){
  if(diff == null || isNaN(diff)) return "";
  const cls = diff > 0 ? "up" : (diff < 0 ? "down" : "flat");
  const arrow = diff > 0 ? "▲" : (diff < 0 ? "▼" : "—");
  return `<span class="${cls}">${arrow} ${Math.abs(diff*100).toFixed(1)}%</span>`;
}

/* ============================================================== PAIS/FX = */

function paisDeSubsidiaria(sub){
  if(["Habi", "HabiCapital", "Habicredit"].includes(sub)) return "Colombia";
  if(["Corporativo", "Merbos", "Tu HabiPres"].includes(sub)) return "Mexico";
  if(["LTD", "Corp", "LLC Colombia", "LLC Mexico"].includes(sub)) return "Offshore";
  return null;
}
function monedaDePais(pais){
  if(pais === "Colombia") return "COP";
  if(pais === "Mexico") return "MXN";
  return "USD";
}
function convertir(monto, paisLocal){
  if(monto == null || isNaN(monto)) return null;
  if(STATE.filters.moneda === "LOCAL") return monto;
  if(paisLocal === "Colombia") return monto / STATE.filters.fxCOP;
  if(paisLocal === "Mexico")   return monto / STATE.filters.fxMXN;
  return monto;
}
function monedaMostrada(paisLocal){
  if(STATE.filters.moneda === "USD") return "USD";
  return monedaDePais(paisLocal || "Colombia");
}

/* ======================================================== FACTS HELPERS = */

/* Aplica filtros activos a la fact table. NO aplica filtro de mes — la mayoria
 * de operaciones quiere ver varios meses (para series). Para el mes corte
 * filtramos aparte. */
function filtrarFacts(facts, filters){
  return facts.filter(r => {
    if(filters.pais && filters.pais !== "Global" && r.pais !== filters.pais) return false;
    if(filters.subsidiaria && filters.subsidiaria !== "Todas" && r.subsidiaria !== filters.subsidiaria) return false;
    if(filters.linea && filters.linea !== "Todas" && r.linea !== filters.linea) return false;
    return true;
  });
}

/* Agrupa filas por una clave y suma actuals/budget en el elim seleccionado.
 * Devuelve [{key, actuals, budget, paisLocal}]. paisLocal se infiere de la
 * primera fila si todas las filas son del mismo pais (para FX). */
function agrupar(facts, keyFn, elim){
  const map = new Map();
  for(const r of facts){
    const k = keyFn(r);
    if(k === null || k === undefined) continue;
    const entry = map.get(k) || {key: k, actuals: 0, budget: 0, paises: new Set()};
    entry.actuals += (r.actuals && r.actuals[elim]) || 0;
    entry.budget  += (r.budget && r.budget[elim]) || 0;
    if(r.pais) entry.paises.add(r.pais);
    map.set(k, entry);
  }
  return [...map.values()].map(e => ({
    key: e.key,
    actuals: e.actuals,
    budget: e.budget,
    paisLocal: e.paises.size === 1 ? [...e.paises][0] : null,
  })).sort((a,b) => Math.abs(b.actuals) - Math.abs(a.actuals));
}

/* Suma un fact con FX a la moneda mostrada. */
function sumarConFX(facts, elim){
  let a = 0, b = 0;
  for(const r of facts){
    const pais = r.pais;
    a += convertir((r.actuals && r.actuals[elim]) || 0, pais) || 0;
    b += convertir((r.budget && r.budget[elim]) || 0, pais) || 0;
  }
  return {actuals: a, budget: b};
}

/* Serie mensual filtrada con FX aplicado. */
function serieMensualFiltrada(facts, elim){
  const map = new Map();
  for(const r of facts){
    const ex = map.get(r.mes) || {mes: r.mes, actuals: 0, budget: 0};
    ex.actuals += convertir((r.actuals && r.actuals[elim]) || 0, r.pais) || 0;
    ex.budget  += convertir((r.budget && r.budget[elim]) || 0, r.pais) || 0;
    map.set(r.mes, ex);
  }
  return [...map.values()].sort((a,b) => a.mes.localeCompare(b.mes));
}

/* =========================================================== CARGAR === */

async function cargarTodo(){
  STATE.meta = await fetch("data/meta.json").then(r => r.json());
  STATE.filters.fxCOP = STATE.meta.fx_default.COP;
  STATE.filters.fxMXN = STATE.meta.fx_default.MXN;

  for(const kpi of [...KPIS_41, ...KPIS_42]){
    if(!kpi.file) continue;
    try{
      STATE.kpis[kpi.id] = await fetch("data/" + kpi.file).then(r => r.json());
    } catch(e){
      console.warn("No se pudo cargar", kpi.file, e);
    }
  }
  const primero = Object.values(STATE.kpis)[0];
  if(primero && primero.meses_disponibles && primero.meses_disponibles.length){
    STATE.filters.mes = primero.meses_disponibles[primero.meses_disponibles.length - 1];
  }
}

/* ========================================================= LECTURA KPI = */

/* Monto del mes corte aplicando todos los filtros. */
function montoMesActual(kpiData){
  const f = STATE.filters;
  const filtered = filtrarFacts(kpiData.facts, f);
  const delMes = filtered.filter(r => r.mes === f.mes);
  if(delMes.length === 0) return {actuals: null, budget: null, paisLocal: null};
  // Si todas las filas son del mismo pais, podemos mostrarlo en moneda local
  const paises = new Set(delMes.map(r => r.pais).filter(Boolean));
  const paisLocal = paises.size === 1 ? [...paises][0] : null;
  const {actuals, budget} = sumarConFX(delMes, f.elim);
  return {actuals, budget, paisLocal};
}

/* ========================================================= SPARK + CHART = */

function sparkSVG(serie, color){
  const pts = serie.filter(p => p.actuals != null && !isNaN(p.actuals)).map(p => p.actuals);
  if(pts.length < 2) return "";
  const w=260, h=36, pad=3;
  const mn = Math.min(...pts), mx = Math.max(...pts), rng = (mx-mn) || 1;
  const xy = pts.map((v,i) => [
    pad + i*(w-2*pad)/(pts.length-1),
    h - pad - ((v-mn)/rng)*(h-2*pad),
  ]);
  const d = xy.map((p,i) => (i?"L":"M") + p[0].toFixed(1) + " " + p[1].toFixed(1)).join(" ");
  const area = d + ` L ${xy[xy.length-1][0].toFixed(1)} ${h} L ${xy[0][0].toFixed(1)} ${h} Z`;
  const last = xy[xy.length-1];
  const gid = "g" + Math.random().toString(36).slice(2,8);
  return `<svg class="spark" viewBox="0 0 ${w} ${h}" preserveAspectRatio="none">
    <defs><linearGradient id="${gid}" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0%" stop-color="${color}" stop-opacity=".18"/>
      <stop offset="100%" stop-color="${color}" stop-opacity="0"/></linearGradient></defs>
    <path d="${area}" fill="url(#${gid})"/>
    <path d="${d}" fill="none" stroke="${color}" stroke-width="1.8" stroke-linejoin="round" stroke-linecap="round"/>
    <circle cx="${last[0].toFixed(1)}" cy="${last[1].toFixed(1)}" r="2.6" fill="${color}"/>
  </svg>`;
}

/* Line chart con etiquetas de datos. 2 series: actuals y budget.
 * Posicionamiento inteligente de etiquetas: actuals arriba si no choca con
 * el techo, abajo si no. Budget al contrario para no traslapar con actuals. */
function lineChartSVG(serie, moneda){
  if(!serie || serie.length === 0) return "<div class='chart-empty'>Sin datos</div>";
  const W = 1200, H = 460, pad = {l: 78, r: 28, t: 30, b: 58};
  const cw = W - pad.l - pad.r, ch = H - pad.t - pad.b;

  const vals = serie.flatMap(r => [r.actuals, r.budget]).filter(v => v != null && !isNaN(v));
  if(vals.length === 0) return "<div class='chart-empty'>Sin datos</div>";
  const max = Math.max(...vals), min = Math.min(...vals);
  const yMin = Math.min(0, min);
  const range = (max - yMin) || 1;
  // Mas margen arriba para que las etiquetas no se corten
  const yMax = max + range * 0.18;
  const yRng = yMax - yMin;

  const n = serie.length;
  const xAt = i => pad.l + (n === 1 ? cw/2 : i * cw / (n-1));
  const yAt = v => pad.t + ch - ((v - yMin) / yRng) * ch;

  // Eje Y · 5 ticks
  const ticks = 5;
  let yAxis = "";
  for(let i=0; i<=ticks; i++){
    const v = yMin + (yRng * i / ticks);
    const y = pad.t + ch - (ch * i / ticks);
    yAxis += `<line x1="${pad.l}" x2="${pad.l + cw}" y1="${y}" y2="${y}" stroke="#EFEFF4" stroke-width="1"/>
              <text x="${pad.l - 10}" y="${y + 4}" text-anchor="end" font-size="12" fill="#5C5C70" font-family="IBM Plex Mono, monospace">${fmtMoneda(v, moneda, {compact:true})}</text>`;
  }
  if(yMin < 0){
    const yZero = yAt(0);
    yAxis += `<line x1="${pad.l}" x2="${pad.l + cw}" y1="${yZero}" y2="${yZero}" stroke="#5C5C70" stroke-width="1" stroke-dasharray="3 3"/>`;
  }

  // Puntos
  const pointsA = serie.map((r,i) => (r.actuals == null || isNaN(r.actuals))
    ? null
    : {x: xAt(i), y: yAt(r.actuals), v: r.actuals, i}).filter(Boolean);
  const pointsB = serie.map((r,i) => (r.budget == null || isNaN(r.budget) || r.budget === 0)
    ? null
    : {x: xAt(i), y: yAt(r.budget), v: r.budget, i}).filter(Boolean);

  // Paths
  const dA = pointsA.map((p,i) => (i?"L":"M") + p.x.toFixed(1) + " " + p.y.toFixed(1)).join(" ");
  const dB = pointsB.map((p,i) => (i?"L":"M") + p.x.toFixed(1) + " " + p.y.toFixed(1)).join(" ");

  // Decision: actuals arriba salvo que choque con el techo; budget abajo.
  // Si actuals > budget en el punto, actuals va arriba y budget abajo (lo natural).
  // Si actuals < budget, actuals va abajo y budget arriba.
  let dotsA = "", dotsB = "", labelsA = "", labelsB = "";
  const labelOffset = 18;
  pointsA.forEach(p => {
    const pB = pointsB.find(pb => pb.i === p.i);
    const aArriba = !pB || p.v >= pB.v;
    const yLabel = aArriba ? p.y - labelOffset : p.y + labelOffset + 4;
    dotsA += `<circle cx="${p.x.toFixed(1)}" cy="${p.y.toFixed(1)}" r="5" fill="#6B2FD4">
      <title>${serie[p.i].mes} · Actuals: ${fmtMoneda(p.v, moneda)}</title></circle>`;
    labelsA += `<text x="${p.x.toFixed(1)}" y="${yLabel.toFixed(1)}" text-anchor="middle" font-size="12.5" font-weight="700" fill="#3A1980" font-family="IBM Plex Mono, monospace" paint-order="stroke" stroke="#FFFFFF" stroke-width="4">${fmtMoneda(p.v, moneda, {compact:true})}</text>`;
  });
  pointsB.forEach(p => {
    const pA = pointsA.find(pa => pa.i === p.i);
    const bArriba = !pA || p.v > pA.v;
    const yLabel = bArriba ? p.y - labelOffset : p.y + labelOffset + 4;
    dotsB += `<circle cx="${p.x.toFixed(1)}" cy="${p.y.toFixed(1)}" r="4.5" fill="#FFFFFF" stroke="#8B4FE8" stroke-width="2">
      <title>${serie[p.i].mes} · Budget: ${fmtMoneda(p.v, moneda)}</title></circle>`;
    labelsB += `<text x="${p.x.toFixed(1)}" y="${yLabel.toFixed(1)}" text-anchor="middle" font-size="11.5" font-weight="500" fill="#7A3FE0" font-family="IBM Plex Mono, monospace" paint-order="stroke" stroke="#FFFFFF" stroke-width="3">${fmtMoneda(p.v, moneda, {compact:true})}</text>`;
  });

  // Eje X
  let xLabels = "";
  serie.forEach((r,i) => {
    const x = xAt(i);
    const [y, m] = r.mes.split("-");
    xLabels += `<text x="${x.toFixed(1)}" y="${H - 30}" text-anchor="middle" font-size="13" font-weight="600" fill="#1A1A2E" font-family="IBM Plex Mono, monospace">${FMT_MES[m]}</text>
                <text x="${x.toFixed(1)}" y="${H - 14}" text-anchor="middle" font-size="11" fill="#5C5C70" font-family="IBM Plex Mono, monospace">${y}</text>`;
  });

  return `<div class="chart-wrap">
    <svg viewBox="0 0 ${W} ${H}" class="chart" preserveAspectRatio="xMidYMid meet">
      ${yAxis}
      ${dB ? `<path d="${dB}" fill="none" stroke="#8B4FE8" stroke-width="2.4" stroke-dasharray="6 4" stroke-linejoin="round" stroke-linecap="round" opacity="0.85"/>` : ""}
      ${dA ? `<path d="${dA}" fill="none" stroke="#6B2FD4" stroke-width="3" stroke-linejoin="round" stroke-linecap="round"/>` : ""}
      ${dotsB}
      ${dotsA}
      ${labelsB}
      ${labelsA}
      ${xLabels}
    </svg>
  </div>
  <div class="chart-legend">
    <span><span class="lg-line lg-actuals"></span>Actuals</span>
    <span><span class="lg-line lg-budget"></span>Budget</span>
  </div>`;
}

/* ====================================================== RENDER · CARD == */

const SPARK_COLOR = { real:"#1F9D6B", parcial:"#B5790E", ejemplo:"#8B4FE8", pendiente:"#9A9AAE" };
const TAG_LABEL = { real:"Real", parcial:"Parcial", ejemplo:"Ejemplo", pendiente:"Pendiente" };

function renderCard(kpiDef){
  const data = STATE.kpis[kpiDef.id];
  if(!data){
    return `<div class="card pendiente">
      <div class="kpi-name"><span class="nm">${kpiDef.nombre}</span><span class="tag pendiente">Pendiente</span></div>
      <div class="val">Sin fuente aún</div>
      <div class="src">Por construir</div>
    </div>`;
  }
  const {actuals, budget, paisLocal} = montoMesActual(data);
  const mon = monedaMostrada(paisLocal);
  const valor = fmtMoneda(actuals, mon);
  const budgetTxt = budget != null && budget !== 0 ? fmtMoneda(budget, mon) : "—";
  const diff = (actuals != null && budget != null && budget !== 0) ? (actuals - budget)/Math.abs(budget) : null;

  // Sparkline: serie del KPI con los filtros activos
  const filtered = filtrarFacts(data.facts, STATE.filters);
  const serie = serieMensualFiltrada(filtered, STATE.filters.elim);
  const idxCorte = serie.findIndex(r => r.mes === STATE.filters.mes);
  const prev = idxCorte > 0 ? serie[idxCorte-1] : null;
  const last = idxCorte >= 0 ? serie[idxCorte] : null;
  const diffMoM = (last && prev && prev.actuals !== 0) ? (last.actuals - prev.actuals)/Math.abs(prev.actuals) : null;
  const color = SPARK_COLOR[data.estado] || SPARK_COLOR.ejemplo;

  return `<div class="card ${data.estado}" onclick="abrirDrill('${kpiDef.id}')">
    <div class="kpi-name"><span class="nm">${kpiDef.nombre}</span><span class="tag ${data.estado}">${TAG_LABEL[data.estado]}</span></div>
    <div class="val">${valor}</div>
    <div class="budget-line">Budget: <b>${budgetTxt}</b></div>
    <div class="delta">
      ${diff != null ? fmtDelta(diff) + ' <span class="vs">vs budget</span>' : ''}
      ${diffMoM != null ? fmtDelta(diffMoM) + ' <span class="vs">vs mes ant.</span>' : ''}
    </div>
    ${sparkSVG(serie, color)}
    <div class="src">◷ ${data.fuente || ""}</div>
    <div class="card-cta">Click para drill-down →</div>
  </div>`;
}

/* ================================================== HEALTH SNAPSHOT === */

function renderSnapshot(){
  function semaforoDelta(diff){
    if(diff == null) return "gray";
    if(diff >= -0.05) return "green";
    if(diff >= -0.15) return "amber";
    return "red";
  }
  function emoji(s){ return s==="green"?"🟢":s==="amber"?"🟡":s==="red"?"🔴":"⚪"; }

  let resSem = "gray", resTxt = "Sin KPIs reales aún";
  if(STATE.kpis.ingresos_totales){
    const {actuals, budget} = montoMesActual(STATE.kpis.ingresos_totales);
    const diff = (actuals && budget) ? (actuals-budget)/Math.abs(budget) : null;
    resSem = semaforoDelta(diff);
    resTxt = diff != null ? `Ingresos ${(diff*100).toFixed(1)}% vs budget` : "Ingresos sin budget en mes corte";
  }
  const areas = [
    { area: "Resultado",   sem: resSem, txt: resTxt },
    { area: "Capital",     sem: "gray", txt: "Inventario en libros pendiente" },
    { area: "Crecimiento", sem: "gray", txt: "GMV y cobertura pipeline pendientes" },
    { area: "Riesgo",      sem: "gray", txt: "Antigüedad inventario y NPS pendientes" },
  ];
  document.getElementById("snapshot").innerHTML = areas.map(a => `
    <div class="snap ${a.sem}">
      <div class="area">${a.area}</div>
      <div class="light">${emoji(a.sem)}</div>
      <div class="summary">${a.txt}</div>
    </div>`).join("");
}

/* ============================================================ DRILL === */

function abrirDrill(kpiId){
  const data = STATE.kpis[kpiId];
  if(!data) return;
  const f = STATE.filters;
  const elim = f.elim;

  // Filtrar facts segun filtros activos
  const filtered = filtrarFacts(data.facts, f);
  const delMes = filtered.filter(r => r.mes === f.mes);

  document.getElementById("drillEyebrow").textContent = "DRILL-DOWN · " + data.seccion;
  document.getElementById("drillTitle").textContent = data.nombre;
  const monedaTxt = f.moneda === "USD" ? "USD" : "moneda local";
  const filtrosTxt = [
    f.pais !== "Global" ? f.pais : null,
    f.subsidiaria !== "Todas" ? f.subsidiaria : null,
    f.linea !== "Todas" ? f.linea : null,
  ].filter(Boolean).join(" · ") || "Global · todas";
  document.getElementById("drillSub").innerHTML =
    `Mes: <b>${mesYYYYMM_a_label(f.mes)}</b> · Vista: <b>${filtrosTxt}</b> · Moneda: <b>${monedaTxt}</b> · Eliminaciones: <b>${f.elim}</b>`;

  // Helper para pintar lista agrupada
  function pintarLista(rows, totalAbs){
    if(!rows.length) return `<div class="drill-empty">Sin datos para esta vista.</div>`;
    let html = "";
    for(const r of rows){
      const a = f.moneda === "USD" ? convertir(r.actuals, r.paisLocal) : r.actuals;
      const b = f.moneda === "USD" ? convertir(r.budget, r.paisLocal) : r.budget;
      if((a == null || a === 0) && (b == null || b === 0)) continue;
      const pct = totalAbs ? Math.abs(a / totalAbs) : 0;
      const mon = f.moneda === "USD" ? "USD" : monedaDePais(r.paisLocal || "Colombia");
      const diff = (a != null && b != null && b !== 0) ? (a - b) / Math.abs(b) : null;
      html += `<div class="drill-row">
        <span class="k"><span class="bar" style="width:${(pct*70).toFixed(0)}px"></span>${r.key}</span>
        <span class="v-pair">
          <span class="v">${fmtMoneda(a, mon)}</span>
          <span class="v-bud">/ ${b != null ? fmtMoneda(b, mon) : "—"}</span>
          ${diff != null ? fmtDelta(diff) : ""}
        </span>
      </div>`;
    }
    return html || `<div class="drill-empty">Sin datos.</div>`;
  }

  // Agrupar por pais/subsidiaria/linea sobre los facts del mes
  const totales = sumarConFX(delMes, elim);
  const totalAbs = Math.abs(totales.actuals);

  let html = `<div class="drill-grid">`;
  // Por pais SOLO si vista=Global (sino seria 1 fila)
  if(f.pais === "Global"){
    const porPais = agrupar(delMes, r => r.pais, elim);
    html += `<div class="drill-block">
      <h3>Por país</h3>
      ${pintarLista(porPais, totalAbs)}
    </div>`;
  }
  // Por subsidiaria SOLO si subsidiaria=Todas (sino seria 1 fila)
  if(f.subsidiaria === "Todas"){
    const porSub = agrupar(delMes, r => r.subsidiaria || "(sin asignar)", elim);
    html += `<div class="drill-block">
      <h3>Por subsidiaria${f.pais !== "Global" ? " · " + f.pais : ""}</h3>
      ${pintarLista(porSub, totalAbs)}
    </div>`;
  }
  // Por linea SOLO si linea=Todas
  if(f.linea === "Todas"){
    const porLinea = agrupar(delMes, r => r.linea || "(sin asignar)", elim);
    html += `<div class="drill-block">
      <h3>Por línea de negocio${f.subsidiaria !== "Todas" ? " · " + f.subsidiaria : ""}</h3>
      ${pintarLista(porLinea, totalAbs)}
    </div>`;
  }
  html += `</div>`;

  // Grafico mensual: serie de los facts filtrados (sin filtro de mes)
  const serieMensual = serieMensualFiltrada(filtered, elim);
  const monedaSerie = f.moneda === "USD" ? "USD" : (
    f.subsidiaria !== "Todas" ? monedaDePais(paisDeSubsidiaria(f.subsidiaria)) :
    f.pais !== "Global" ? monedaDePais(f.pais) :
    "COP" // global LOCAL: dominante CO
  );
  html += `<div class="drill-block chart-block">
    <h3>Ejecución mensual · Actuals vs Budget (${monedaSerie})</h3>
    ${lineChartSVG(serieMensual, monedaSerie)}
  </div>`;

  // Top 20 cuentas — ahora respetan TODOS los filtros incluyendo subsidiaria/linea
  const porCuenta = (() => {
    const map = new Map();
    for(const r of delMes){
      const k = `${r.cuenta || "—"}|${r.cuenta_desc || ""}`;
      const e = map.get(k) || {cuenta: r.cuenta, desc: r.cuenta_desc, actuals: 0, budget: 0, pais: r.pais};
      e.actuals += (r.actuals && r.actuals[elim]) || 0;
      e.budget  += (r.budget && r.budget[elim]) || 0;
      map.set(k, e);
    }
    return [...map.values()].sort((a,b) => Math.abs(b.actuals) - Math.abs(a.actuals)).slice(0, 20);
  })();
  html += `<div class="drill-block">
    <h3>Top 20 cuentas contables${filtrosTxt && filtrosTxt !== "Global · todas" ? " · " + filtrosTxt : ""}</h3>
    <table class="drill-table">
      <thead><tr>
        <th>Cuenta</th><th>Descripción</th><th style="text-align:right">Actuals</th><th style="text-align:right">Budget</th><th style="text-align:right">vs Bud</th>
      </tr></thead>
      <tbody>`;
  for(const c of porCuenta){
    const a = f.moneda === "USD" ? convertir(c.actuals, c.pais) : c.actuals;
    const b = c.budget !== 0 ? (f.moneda === "USD" ? convertir(c.budget, c.pais) : c.budget) : null;
    const mon = f.moneda === "USD" ? "USD" : monedaDePais(c.pais || "Colombia");
    const diff = (a != null && b != null && b !== 0) ? (a - b) / Math.abs(b) : null;
    html += `<tr>
      <td><code>${c.cuenta ?? "—"}</code></td>
      <td>${c.desc || "(sin descripción)"}</td>
      <td class="num">${fmtMoneda(a, mon)}</td>
      <td class="num">${b != null ? fmtMoneda(b, mon) : "—"}</td>
      <td class="num">${diff != null ? fmtDelta(diff) : "—"}</td>
    </tr>`;
  }
  html += `</tbody></table>
  </div>
  <div class="drill-note">
    <b>Nota</b>: Si los valores no cuadran con tu referencia, el primer sospechoso es el filtro <code>m_metrica != '01. Total Revenue'</code> que excluye el marcador agregado.
  </div>`;

  document.getElementById("drillBody").innerHTML = html;
  document.getElementById("drillModal").hidden = false;
}

function cerrarDrill(){ document.getElementById("drillModal").hidden = true; }

/* ============================================================ RENDER === */

function rebuildSubsidiariaOptions(){
  const sel = document.getElementById("fSubsidiaria");
  const opts = SUBSIDIARIAS_POR_PAIS[STATE.filters.pais];
  sel.innerHTML = opts.map(s => `<option value="${s}">${s}</option>`).join("");
  if(!opts.includes(STATE.filters.subsidiaria)) STATE.filters.subsidiaria = "Todas";
  sel.value = STATE.filters.subsidiaria;
}
function rebuildLineaOptions(){
  const sel = document.getElementById("fLinea");
  const opts = LINEAS_POR_PAIS[STATE.filters.pais];
  sel.innerHTML = opts.map(s => `<option value="${s}">${s}</option>`).join("");
  if(!opts.includes(STATE.filters.linea)) STATE.filters.linea = "Todas";
  sel.value = STATE.filters.linea;
}
function rebuildMesOptions(){
  const primero = Object.values(STATE.kpis)[0];
  if(!primero || !primero.meses_disponibles) return;
  const sel = document.getElementById("fMes");
  sel.innerHTML = primero.meses_disponibles
    .slice().reverse()
    .map(m => `<option value="${m}">${mesYYYYMM_a_label(m)}</option>`).join("");
  sel.value = STATE.filters.mes;
}

function render(){
  document.getElementById("mesCorte").textContent = mesYYYYMM_a_label(STATE.filters.mes);
  document.getElementById("refreshAt").textContent = STATE.meta.generado_en.replace("T", " ").slice(0,16);
  const ctx = `${STATE.filters.pais}${STATE.filters.subsidiaria !== "Todas" ? " · " + STATE.filters.subsidiaria : ""}${STATE.filters.linea !== "Todas" ? " · " + STATE.filters.linea : ""} · ${STATE.filters.moneda === "USD" ? "USD" : "Moneda local"}`;
  document.getElementById("contextLabel").innerHTML = ctx;
  document.getElementById("ctx41").textContent = ctx;

  renderSnapshot();
  document.getElementById("grid41").innerHTML = KPIS_41.map(renderCard).join("");
  document.getElementById("grid42").innerHTML = KPIS_42.map(renderCard).join("");

  document.getElementById("pageFoot").innerHTML =
    `<b>Refresh manual</b> · corre <code>make refresh</code> para regenerar los JSON desde BigQuery.<br>` +
    `Los KPIs en estado <b>pendiente</b> esperan su receta. Solo Ingresos (4.1.1) tiene datos reales en v1.`;
}

/* ============================================================ INIT ===== */

function bindFiltros(){
  document.getElementById("fMes").addEventListener("change", e => { STATE.filters.mes = e.target.value; render(); });
  document.getElementById("fPais").addEventListener("change", e => {
    STATE.filters.pais = e.target.value;
    rebuildSubsidiariaOptions(); rebuildLineaOptions(); render();
  });
  document.getElementById("fSubsidiaria").addEventListener("change", e => { STATE.filters.subsidiaria = e.target.value; render(); });
  document.getElementById("fLinea").addEventListener("change", e => { STATE.filters.linea = e.target.value; render(); });
  document.getElementById("segMoneda").querySelectorAll("button").forEach(b => {
    b.addEventListener("click", () => {
      document.querySelectorAll("#segMoneda button").forEach(x => x.classList.remove("on"));
      b.classList.add("on"); STATE.filters.moneda = b.dataset.val; render();
    });
  });
  document.getElementById("segElim").querySelectorAll("button").forEach(b => {
    b.addEventListener("click", () => {
      document.querySelectorAll("#segElim button").forEach(x => x.classList.remove("on"));
      b.classList.add("on"); STATE.filters.elim = b.dataset.val; render();
    });
  });
  document.getElementById("fxCOP").addEventListener("input", e => { STATE.filters.fxCOP = parseFloat(e.target.value) || STATE.filters.fxCOP; render(); });
  document.getElementById("fxMXN").addEventListener("input", e => { STATE.filters.fxMXN = parseFloat(e.target.value) || STATE.filters.fxMXN; render(); });
  document.getElementById("drillClose").addEventListener("click", cerrarDrill);
  document.getElementById("drillModal").addEventListener("click", e => { if(e.target.id === "drillModal") cerrarDrill(); });
}

function poblarFiltros(){
  document.getElementById("fPais").innerHTML = PAIS_LIST.map(p => `<option value="${p}">${p}</option>`).join("");
  rebuildMesOptions();
  rebuildSubsidiariaOptions();
  rebuildLineaOptions();
  document.getElementById("fxCOP").value = STATE.filters.fxCOP;
  document.getElementById("fxMXN").value = STATE.filters.fxMXN;
}

async function init(){
  try { await cargarTodo(); }
  catch(e){
    document.querySelector(".main").innerHTML =
      `<div style="padding:20px;color:var(--txt2)">
        <b>No pude cargar los datos.</b><br>
        Verifica que <code>site/data/meta.json</code> existe (corre <code>make refresh</code>).<br>
        Error: ${e.message}
      </div>`;
    return;
  }
  poblarFiltros();
  bindFiltros();
  render();
}

window.abrirDrill = abrirDrill;
init();
