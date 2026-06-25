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
    subsidiaria: "All",
    linea: "All",
    moneda: "LOCAL",
    elim: "sin_elim",
    ajustes: "sin_ajustes",  // sin_ajustes (default) | con_ajustes | solo_ajustes
    fxCOP: 3700,
    fxMXN: 18.5,
  },
};

/* ============================================================ CATALOGOS = */

const PAIS_LIST = ["Global", "Colombia", "Mexico", "Offshore"];
const SUBSIDIARIAS_POR_PAIS = {
  Global:   ["All", "Habi", "HabiCapital", "Habicredit", "Corporativo", "Merbos", "Tu HabiPres", "LTD", "Corp", "LLC Colombia", "LLC Mexico"],
  Colombia: ["All", "Habi", "HabiCapital", "Habicredit"],
  Mexico:   ["All", "Corporativo", "Merbos", "Tu HabiPres"],
  Offshore: ["All", "LTD", "Corp", "LLC Colombia", "LLC Mexico"],
};
const LINEAS_POR_PAIS = {
  Global:   ["All", "Market Maker", "Brokerage", "HabiCredit", "Other"],
  Colombia: ["All", "Market Maker", "Brokerage", "HabiCredit", "Other"],
  Mexico:   ["All", "Market Maker", "Brokerage", "HabiCredit", "Other"],
  Offshore: ["All"],
};
const KPIS_41 = [
  { id: "ingresos_totales",    nombre: "Total Revenue",          file: "kpi_ingresos.json" },
  { id: "ingresos_ajustados",  nombre: "Adjusted Revenue",       file: "kpi_ingresos_ajustados.json" },
  { id: "gmv",                 nombre: "GMV / Transacted Value", file: "kpi_gmv.json" },
  { id: "margen_bruto",        nombre: "Gross Margin",           file: "kpi_margen_bruto.json" },
  { id: "contribution_margin", nombre: "Contribution Margin",    file: "kpi_contribution.json" },
  { id: "ebitda",              nombre: "EBITDA",                 file: "kpi_ebitda.json" },
  { id: "opex_ingreso",        nombre: "OpEx",                   file: "kpi_opex.json" },
  { id: "burn_runway",         nombre: "Net Burn",               file: null, pendingMsg: "Confirming data source" },
];
const KPIS_42 = [
  { id: "inventario",          nombre: "Inventory on books",         file: "kpi_inventario.json" },
  { id: "antiguedad_inv",      nombre: "Inventory aging",            file: null },
  { id: "capital_roic",        nombre: "Capital deployed / ROIC",    file: null },
  { id: "ciclo_caja",          nombre: "Cash conversion cycle",      file: null },
  { id: "rotacion",            nombre: "Rotation / sell-through",    file: null },
  { id: "deuda_apalanc",       nombre: "Net debt & leverage",        file: null },
];

const FMT_MES = {
  "01":"Jan","02":"Feb","03":"Mar","04":"Apr","05":"May","06":"Jun",
  "07":"Jul","08":"Aug","09":"Sep","10":"Oct","11":"Nov","12":"Dec",
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

function fmtDelta(diff, invertir, asPill){
  if(diff == null || isNaN(diff)) return "";
  // Por default: ▲ verde, ▼ rojo. Si invertir=true (ej. OpEx, Burn): ▲ rojo,
  // ▼ verde — el arrow refleja la direccion del numero, el color si es bueno o malo.
  // asPill=true wraps with background color (drill rows). Default = text only (cards).
  const arrow = diff > 0 ? "▲" : (diff < 0 ? "▼" : "—");
  let cls = diff > 0 ? "up" : (diff < 0 ? "down" : "flat");
  if(invertir){
    if(cls === "up") cls = "down";
    else if(cls === "down") cls = "up";
  }
  const wrapper = asPill ? "delta-pill " + cls : cls;
  return `<span class="${wrapper}">${arrow} ${Math.abs(diff*100).toFixed(1)}%</span>`;
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

/* Aplica filtros activos a la fact table. NO aplica filtro de mes.
 *
 * Graceful degradation: si el filtro de subsidiaria/linea no aplica porque el
 * KPI no tiene esa dimension poblada (ej. GMV no tiene c_subsidiaria), caemos
 * al pais inferido. Asi el usuario no ve la card vacia cuando filtra Habi —
 * en su lugar ve el dato de Colombia, con un indicador visual en la card. */
function filtrarFacts(facts, filters){
  // Detectar si el KPI tiene la dimension de subsidiaria/linea poblada
  const tieneSubKPI = facts.some(r => r.subsidiaria != null);
  const tieneLineaKPI = facts.some(r => r.linea != null);

  return facts.filter(r => {
    // Filtro de pais
    let paisActivo = filters.pais;
    // Si filtro de subsidiaria activo y el KPI no la tiene, fall back a pais inferido
    if(filters.subsidiaria !== "All" && !tieneSubKPI && paisActivo === "Global"){
      paisActivo = paisDeSubsidiaria(filters.subsidiaria);
    }
    if(paisActivo && paisActivo !== "Global" && r.pais !== paisActivo) return false;

    // Filtro de subsidiaria SOLO si el KPI la tiene
    if(filters.subsidiaria !== "All" && tieneSubKPI){
      if(r.subsidiaria !== filters.subsidiaria) return false;
    }
    // Filtro de linea SOLO si el KPI la tiene
    if(filters.linea !== "All" && tieneLineaKPI){
      if(r.linea !== filters.linea) return false;
    }
    // Filtro de ajustes contables (dummie_ajustes en bet_data_p2)
    // Si la fact no expone es_ajuste, asumimos no es ajuste (compatibilidad).
    const esAj = !!r.es_ajuste;
    if(filters.ajustes === "sin_ajustes" && esAj) return false;
    if(filters.ajustes === "solo_ajustes" && !esAj) return false;
    return true;
  });
}

/* Calcula runway en meses para un KPI con cash_balances.
 *
 * Estrategia:
 *   - Burn = filtrar facts del mes corte por filtros activos y sumar (con FX)
 *   - Burn promedio = promedio de los ultimos N meses (data.burn_avg_meses)
 *   - Cash = data.cash_balances[mes_corte][clave_segun_filtro]
 *   - Runway = cash / burn_promedio si burn > 0; sino Infinity
 *
 * Si la subsidiaria filtrada no existe en cash_balances (ej. GMV-style),
 * caemos al pais inferido.
 */
function calcularRunway(kpiData){
  const f = STATE.filters;
  const elim = f.elim;
  const N = kpiData.burn_avg_meses || 3;

  // Burn promedio ultimos N meses (incluyendo mes corte)
  const meses = kpiData.meses_disponibles || [];
  const idxCorte = meses.indexOf(f.mes);
  if(idxCorte < 0) return null;
  const mesesParaPromedio = meses.slice(Math.max(0, idxCorte - N + 1), idxCorte + 1);

  const filtered = filtrarFacts(kpiData.facts, f);
  let burnSum = 0, n = 0;
  for(const m of mesesParaPromedio){
    const delMes = filtered.filter(r => r.mes === m);
    if(!delMes.length) continue;
    const s = sumarConFX(delMes, elim);
    burnSum += s.actuals;
    n++;
  }
  if(n === 0) return null;
  const burnAvg = burnSum / n;
  if(burnAvg <= 0) return Infinity; // empresa genera cash

  // Cash actual del mes corte
  const bucket = kpiData.cash_balances[f.mes];
  if(!bucket) return null;
  let cash = 0;
  let paisLocalCash = null;
  if(f.subsidiaria !== "All"){
    cash = bucket.por_subsidiaria[f.subsidiaria];
    if(cash == null){
      // fallback al pais de esa subsidiaria
      const p = paisDeSubsidiaria(f.subsidiaria);
      cash = p ? (bucket.por_pais[p] || 0) : 0;
      paisLocalCash = p;
    } else {
      paisLocalCash = paisDeSubsidiaria(f.subsidiaria);
    }
  } else if(f.pais !== "Global"){
    cash = bucket.por_pais[f.pais] || 0;
    paisLocalCash = f.pais;
  } else {
    cash = bucket.Global || 0;
    paisLocalCash = null;
  }
  // Convertir cash a moneda mostrada
  const cashConvertido = convertir(cash, paisLocalCash);
  // burnAvg ya viene en la moneda mostrada (de sumarConFX)
  return cashConvertido / burnAvg;
}

/* Devuelve true si algun filtro activo no se esta aplicando porque el KPI no
 * tiene esa dimension. La UI muestra un aviso en la card cuando esto ocurre. */
function filtrosDegradados(kpiData, filters){
  const avisos = [];
  if(filters.subsidiaria !== "All"){
    if(!kpiData.facts.some(r => r.subsidiaria != null)){
      avisos.push(`No subsidiary granularity — showing ${paisDeSubsidiaria(filters.subsidiaria) || "country"}`);
    }
  }
  if(filters.linea !== "All"){
    if(!kpiData.facts.some(r => r.linea != null)){
      avisos.push(`No business line granularity — showing all`);
    }
  }
  return avisos;
}

/* Orden canonico para keys SIN prefijo numerico. Las que tienen prefijo
 * (ej. "01. Market Maker Sales") se ordenan por ese prefijo numerico. */
const LINEA_ORDER = ["Market Maker", "Brokerage", "HabiCredit", "Other"];
const PAIS_ORDER  = ["Global", "Colombia", "Mexico", "Offshore"];

/* Comparator para drill rows. Prioridad:
 *   1. Si AMBOS keys tienen prefijo "NN.", ordenar por ese numero
 *   2. Si AMBOS son business lines (LINEA_ORDER), seguir ese orden
 *   3. Si AMBOS son paises (PAIS_ORDER), seguir ese orden
 *   4. Sino, ordenar por |actuals| descendente
 */
function compararDrillRows(a, b){
  const ka = String(a.key || "");
  const kb = String(b.key || "");
  // Acepta tanto "01." como "1 " como prefijo numerico
  const ma = /^(\d+)[\.\s]/.exec(ka);
  const mb = /^(\d+)[\.\s]/.exec(kb);
  if(ma && mb) return parseInt(ma[1]) - parseInt(mb[1]);
  if(ma) return -1;
  if(mb) return 1;
  const ila = LINEA_ORDER.indexOf(ka);
  const ilb = LINEA_ORDER.indexOf(kb);
  if(ila >= 0 && ilb >= 0) return ila - ilb;
  if(ila >= 0) return -1;
  if(ilb >= 0) return 1;
  const ipa = PAIS_ORDER.indexOf(ka);
  const ipb = PAIS_ORDER.indexOf(kb);
  if(ipa >= 0 && ipb >= 0) return ipa - ipb;
  if(ipa >= 0) return -1;
  if(ipb >= 0) return 1;
  // (sin asignar) y similares al final
  if(ka.startsWith("(") && !kb.startsWith("(")) return 1;
  if(kb.startsWith("(") && !ka.startsWith("(")) return -1;
  return Math.abs(b.actuals) - Math.abs(a.actuals);
}

/* Agrupa filas por una clave y suma actuals/budget en el elim seleccionado.
 * Tambien acumula revenue_actuals/revenue_budget si presentes (KPIs con ratio).
 * paisLocal se infiere si todas las filas son del mismo pais. */
function agrupar(facts, keyFn, elim){
  const map = new Map();
  for(const r of facts){
    const k = keyFn(r);
    if(k === null || k === undefined) continue;
    const entry = map.get(k) || {key: k, actuals: 0, budget: 0, revenue_actuals: 0, revenue_budget: 0, paises: new Set()};
    entry.actuals += (r.actuals && r.actuals[elim]) || 0;
    entry.budget  += (r.budget && r.budget[elim]) || 0;
    entry.revenue_actuals += (r.revenue_actuals && r.revenue_actuals[elim]) || 0;
    entry.revenue_budget  += (r.revenue_budget  && r.revenue_budget[elim])  || 0;
    if(r.pais) entry.paises.add(r.pais);
    map.set(k, entry);
  }
  return [...map.values()].map(e => ({
    key: e.key,
    actuals: e.actuals,
    budget: e.budget,
    revenue_actuals: e.revenue_actuals,
    revenue_budget: e.revenue_budget,
    paisLocal: e.paises.size === 1 ? [...e.paises][0] : null,
  })).sort(compararDrillRows);
}

/* Suma un fact con FX a la moneda mostrada. Tambien suma revenue_actuals y
 * revenue_budget si estan presentes (KPIs con ratio como Margen bruto). */
function sumarConFX(facts, elim){
  let a = 0, b = 0, ra = 0, rb = 0;
  for(const r of facts){
    const pais = r.pais;
    a += convertir((r.actuals && r.actuals[elim]) || 0, pais) || 0;
    b += convertir((r.budget && r.budget[elim]) || 0, pais) || 0;
    ra += convertir((r.revenue_actuals && r.revenue_actuals[elim]) || 0, pais) || 0;
    rb += convertir((r.revenue_budget  && r.revenue_budget[elim])  || 0, pais) || 0;
  }
  return {actuals: a, budget: b, revenue_actuals: ra, revenue_budget: rb};
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
  // Cache buster: aniadimos un timestamp para forzar fetch fresco cada vez
  // que se recarga el dashboard (evita problemas cuando refrescas datos).
  const cb = "?t=" + Date.now();
  STATE.meta = await fetch("data/meta.json" + cb).then(r => r.json());
  STATE.filters.fxCOP = STATE.meta.fx_default.COP;
  STATE.filters.fxMXN = STATE.meta.fx_default.MXN;

  for(const kpi of [...KPIS_41, ...KPIS_42]){
    if(!kpi.file) continue;
    try{
      STATE.kpis[kpi.id] = await fetch("data/" + kpi.file + cb).then(r => r.json());
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
  if(delMes.length === 0) return {actuals: null, budget: null, paisLocal: null, ratio: null, ratio_budget: null};
  const paises = new Set(delMes.map(r => r.pais).filter(Boolean));
  const paisLocal = paises.size === 1 ? [...paises][0] : null;
  const sums = sumarConFX(delMes, f.elim);
  // Si el KPI tiene revenue (MONEDA_CON_RATIO), calcular el ratio
  const ratio = sums.revenue_actuals !== 0 ? sums.actuals / sums.revenue_actuals : null;
  const ratio_budget = sums.revenue_budget !== 0 ? sums.budget / sums.revenue_budget : null;
  return {actuals: sums.actuals, budget: sums.budget, paisLocal, ratio, ratio_budget};
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
 * unit: "MONEY" (default) o "PCT". En PCT los valores se muestran como %. */
function fmtChartValue(v, unit, moneda){
  if(v == null || isNaN(v)) return "—";
  if(unit === "PCT") return (v*100).toFixed(1) + "%";
  return fmtMoneda(v, moneda, {compact: true});
}

function lineChartSVG(serie, moneda, unit){
  unit = unit || "MONEY";
  if(!serie || serie.length === 0) return "<div class='chart-empty'>No data</div>";
  const W = 1200, H = 460, pad = {l: 78, r: 28, t: 30, b: 58};
  const cw = W - pad.l - pad.r, ch = H - pad.t - pad.b;

  const vals = serie.flatMap(r => [r.actuals, r.budget]).filter(v => v != null && !isNaN(v));
  if(vals.length === 0) return "<div class='chart-empty'>No data</div>";
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
              <text x="${pad.l - 10}" y="${y + 4}" text-anchor="end" font-size="12" fill="#5C5C70" font-family="IBM Plex Mono, monospace">${fmtChartValue(v, unit, moneda)}</text>`;
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
      <title>${serie[p.i].mes} · Actuals: ${fmtChartValue(p.v, unit, moneda)}</title></circle>`;
    labelsA += `<text x="${p.x.toFixed(1)}" y="${yLabel.toFixed(1)}" text-anchor="middle" font-size="12.5" font-weight="700" fill="#3A1980" font-family="IBM Plex Mono, monospace" paint-order="stroke" stroke="#FFFFFF" stroke-width="4">${fmtChartValue(p.v, unit, moneda)}</text>`;
  });
  pointsB.forEach(p => {
    const pA = pointsA.find(pa => pa.i === p.i);
    const bArriba = !pA || p.v > pA.v;
    const yLabel = bArriba ? p.y - labelOffset : p.y + labelOffset + 4;
    dotsB += `<circle cx="${p.x.toFixed(1)}" cy="${p.y.toFixed(1)}" r="4.5" fill="#FFFFFF" stroke="#8B4FE8" stroke-width="2">
      <title>${serie[p.i].mes} · Budget: ${fmtChartValue(p.v, unit, moneda)}</title></circle>`;
    labelsB += `<text x="${p.x.toFixed(1)}" y="${yLabel.toFixed(1)}" text-anchor="middle" font-size="11.5" font-weight="500" fill="#7A3FE0" font-family="IBM Plex Mono, monospace" paint-order="stroke" stroke="#FFFFFF" stroke-width="3">${fmtChartValue(p.v, unit, moneda)}</text>`;
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
const TAG_LABEL = { real:"Real", parcial:"Partial", ejemplo:"Example", pendiente:"Pending" };

/* Color de performance para la card. Mismo umbral que el Health Snapshot:
 *   >= -5%  -> verde
 *   -5% a -15% -> ambar
 *   < -15% -> rojo
 * Si invertir=true (mas es peor: OpEx, Burn), invierte el signo del diff.
 */
function perfColor(diff, invertir){
  if(diff == null || isNaN(diff)) return "perf-gray";
  const d = invertir ? -diff : diff;
  if(d >= -0.05) return "perf-green";
  if(d >= -0.15) return "perf-amber";
  return "perf-red";
}

function renderCard(kpiDef){
  const data = STATE.kpis[kpiDef.id];
  if(!data){
    const msg = kpiDef.pendingMsg || "No source yet";
    const sub = kpiDef.pendingMsg ? "Tile temporarily disabled" : "To be built";
    return `<div class="card pendiente">
      <div class="kpi-name"><span class="nm">${kpiDef.nombre}</span><span class="tag pendiente">Pending</span></div>
      <div class="val">${msg}</div>
      <div class="src">${sub}</div>
    </div>`;
  }
  const {actuals, budget, paisLocal, ratio, ratio_budget} = montoMesActual(data);
  const mon = monedaMostrada(paisLocal);
  const valor = fmtMoneda(actuals, mon);
  const budgetTxt = budget != null && budget !== 0 ? fmtMoneda(budget, mon) : "—";
  const diff = (actuals != null && budget != null && budget !== 0) ? (actuals - budget)/Math.abs(budget) : null;
  const invertir = !!data.invertir_delta;
  // Ratio puede venir embebido (Margen) o cross-KPI (OpEx vs Ingresos)
  let ratioVal = data.unidad === "MONEDA_CON_RATIO" ? ratio : null;
  let ratioBud = data.unidad === "MONEDA_CON_RATIO" ? ratio_budget : null;
  let ratioLabel = data.ratio_label;
  let ratioComoMeses = false;
  if(data.ratio_against && STATE.kpis[data.ratio_against] && actuals != null){
    const ref = montoMesActual(STATE.kpis[data.ratio_against]);
    if(ref.actuals && ref.actuals !== 0){
      ratioVal = Math.abs(actuals) / Math.abs(ref.actuals);
      if(ref.budget && ref.budget !== 0 && budget != null){
        ratioBud = Math.abs(budget) / Math.abs(ref.budget);
      }
    }
  }
  // KPIs con runway (Burn): calcular meses = cash / burn promedio
  if(data.unidad === "MONEDA_CON_RUNWAY" && data.cash_balances){
    const runway = calcularRunway(data);
    if(runway != null){
      ratioVal = runway;
      ratioComoMeses = true;
    }
  }
  const conRatio = ratioVal != null;

  // Sparkline: serie del KPI con los filtros activos
  const filtered = filtrarFacts(data.facts, STATE.filters);
  const serie = serieMensualFiltrada(filtered, STATE.filters.elim);
  const idxCorte = serie.findIndex(r => r.mes === STATE.filters.mes);
  const prev = idxCorte > 0 ? serie[idxCorte-1] : null;
  const last = idxCorte >= 0 ? serie[idxCorte] : null;
  const diffMoM = (last && prev && prev.actuals !== 0) ? (last.actuals - prev.actuals)/Math.abs(prev.actuals) : null;
  const color = SPARK_COLOR[data.estado] || SPARK_COLOR.ejemplo;

  const ratioFmt = ratioComoMeses
    ? (ratioVal === Infinity ? "∞ (generates cash)" : `${ratioVal.toFixed(1)} months`)
    : (ratioVal != null ? `${(ratioVal*100).toFixed(1)}%` : "");
  const ratioBudFmt = (!ratioComoMeses && ratioBud != null)
    ? ` <span class="vs">vs bud ${(ratioBud*100).toFixed(1)}%</span>`
    : "";
  const ratioHTML = conRatio
    ? `<div class="ratio-line">${ratioLabel || "Ratio"}: <b>${ratioFmt}</b>${ratioBudFmt}</div>`
    : "";

  const avisos = filtrosDegradados(data, STATE.filters);
  const avisosHTML = avisos.length
    ? `<div class="card-aviso" title="${avisos.join(' · ')}">ⓘ ${avisos[0]}</div>`
    : "";

  const perfCls = perfColor(diff, invertir);
  return `<div class="card ${perfCls}" onclick="abrirDrill('${kpiDef.id}')">
    <div class="kpi-name"><span class="nm">${kpiDef.nombre}</span><span class="tag ${data.estado}">${TAG_LABEL[data.estado]}</span></div>
    <div class="val">${valor}</div>
    ${ratioHTML}
    <div class="budget-line">Budget: <b>${budgetTxt}</b></div>
    <div class="delta">
      ${diff != null ? fmtDelta(diff, invertir) + ' <span class="vs">vs budget</span>' : ''}
      ${diffMoM != null ? fmtDelta(diffMoM, invertir) + ' <span class="vs">vs prev. month</span>' : ''}
    </div>
    ${sparkSVG(serie, color)}
    ${avisosHTML}
    <div class="src">◷ ${data.fuente || ""}</div>
    <div class="card-cta">Click for drill-down →</div>
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

  let resSem = "gray", resTxt = "No real KPIs yet";
  if(STATE.kpis.ingresos_totales){
    const {actuals, budget} = montoMesActual(STATE.kpis.ingresos_totales);
    const diff = (actuals && budget) ? (actuals-budget)/Math.abs(budget) : null;
    resSem = semaforoDelta(diff);
    resTxt = diff != null ? `Revenue ${(diff*100).toFixed(1)}% vs budget` : "Revenue has no budget for this period";
  }
  const areas = [
    { area: "Performance", sem: resSem, txt: resTxt },
    { area: "Capital",     sem: "gray", txt: "Inventory on books pending" },
    { area: "Growth",      sem: "gray", txt: "GMV and pipeline coverage pending" },
    { area: "Risk",        sem: "gray", txt: "Inventory aging and NPS pending" },
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
  const monedaTxt = f.moneda === "USD" ? "USD" : "local currency";
  const filtrosTxt = [
    f.pais !== "Global" ? f.pais : null,
    f.subsidiaria !== "All" ? f.subsidiaria : null,
    f.linea !== "All" ? f.linea : null,
  ].filter(Boolean).join(" · ") || "Global · all";
  const elimLabel = {sin_elim:"excluded", con_elim:"included", solo_elim:"only eliminations"}[f.elim] || f.elim;
  const ajLabel = {sin_ajustes:"excluded", con_ajustes:"included", solo_ajustes:"only adjustments"}[f.ajustes] || f.ajustes;
  document.getElementById("drillSub").innerHTML =
    `Period: <b>${mesYYYYMM_a_label(f.mes)}</b> · View: <b>${filtrosTxt}</b> · Currency: <b>${monedaTxt}</b> · Eliminations: <b>${elimLabel}</b> · Adjustments: <b>${ajLabel}</b>`;

  // Helper para pintar lista agrupada
  const conRatio = data.unidad === "MONEDA_CON_RATIO";
  const invertirKPI = !!data.invertir_delta;
  function pintarLista(rows){
    if(!rows.length) return `<div class="drill-empty">No data for this view.</div>`;
    // Si el set tiene al menos una fila con ratio, todas las rows del bloque
    // muestran una columna extra (incluso vacia) para que las filas se alineen.
    const blockTieneRatio = conRatio && rows.some(r => r.revenue_actuals && r.revenue_actuals !== 0);
    let html = `<div class="drill-list ${blockTieneRatio ? "with-ratio" : ""}">`;
    for(const r of rows){
      const a = f.moneda === "USD" ? convertir(r.actuals, r.paisLocal) : r.actuals;
      const b = f.moneda === "USD" ? convertir(r.budget, r.paisLocal) : r.budget;
      if((a == null || a === 0) && (b == null || b === 0)) continue;
      const mon = f.moneda === "USD" ? "USD" : monedaDePais(r.paisLocal || "Colombia");
      const diff = (a != null && b != null && b !== 0) ? (a - b) / Math.abs(b) : null;
      let ratioHTML = "";
      if(blockTieneRatio){
        if(r.revenue_actuals && r.revenue_actuals !== 0){
          const ratio = a / (f.moneda === "USD" ? convertir(r.revenue_actuals, r.paisLocal) : r.revenue_actuals);
          ratioHTML = `<span class="v-ratio">${(ratio*100).toFixed(1)}%</span>`;
        } else {
          ratioHTML = `<span class="v-ratio empty"></span>`;
        }
      }
      html += `<div class="drill-row">
        <span class="dr-k">${r.key}</span>
        <span class="dr-v">${fmtMoneda(a, mon)}</span>
        ${blockTieneRatio ? `<span class="dr-ratio">${ratioHTML}</span>` : ""}
        <span class="dr-bud">${b != null ? fmtMoneda(b, mon) : "—"}</span>
        <span class="dr-delta">${diff != null ? fmtDelta(diff, invertirKPI, true) : ""}</span>
      </div>`;
    }
    html += `</div>`;
    return html || `<div class="drill-empty">No data.</div>`;
  }

  // Detectar si el KPI tiene info de subsidiaria / linea / cuenta (no todos
  // la tienen — ej. GMV no trae subsidiaria; OpEx no tiene business line).
  const tieneSubsidiaria = delMes.some(r => r.subsidiaria != null);
  const tieneLinea = delMes.some(r => r.linea != null);
  const tieneCuenta = delMes.some(r => r.cuenta != null);

  let html = `<div class="drill-grid">`;
  // Por pais SOLO si vista=Global (sino seria 1 fila)
  if(f.pais === "Global"){
    const porPais = agrupar(delMes, r => r.pais, elim);
    html += `<div class="drill-block">
      <h3>By country</h3>
      ${pintarLista(porPais)}
    </div>`;
  }
  // Por subsidiaria SOLO si el KPI la tiene Y el filtro esta en Todas
  if(tieneSubsidiaria && f.subsidiaria === "All"){
    const porSub = agrupar(delMes, r => r.subsidiaria || "(unassigned)", elim);
    html += `<div class="drill-block">
      <h3>By subsidiary${f.pais !== "Global" ? " · " + f.pais : ""}</h3>
      ${pintarLista(porSub)}
    </div>`;
  }
  // Por linea SOLO si el KPI la tiene Y linea=Todas
  if(tieneLinea && f.linea === "All"){
    const porLinea = agrupar(delMes, r => r.linea || "(unassigned)", elim);
    html += `<div class="drill-block">
      <h3>By business line${f.subsidiaria !== "All" ? " · " + f.subsidiaria : ""}</h3>
      ${pintarLista(porLinea)}
    </div>`;
  }
  // Si el KPI trae categoria_gasto (OpEx), mostrar un bloque dedicado
  const tieneCategoriaGasto = delMes.some(r => r.categoria_gasto != null);
  if(tieneCategoriaGasto){
    const porCategoria = agrupar(delMes, r => r.categoria_gasto || "(unassigned)", elim);
    html += `<div class="drill-block">
      <h3>By expense category</h3>
      ${pintarLista(porCategoria)}
    </div>`;
  }
  // Si el KPI trae categoria_cf (Burn), mostrar el desglose del cash flow
  const tieneCategoriaCF = delMes.some(r => r.categoria_cf != null);
  if(tieneCategoriaCF){
    const porCF = agrupar(delMes, r => r.categoria_cf || "(unassigned)", elim);
    html += `<div class="drill-block">
      <h3>By cash flow category</h3>
      ${pintarLista(porCF)}
    </div>`;
  }
  // Si el KPI trae bloque_pyl (EBITDA, Contribution), mostrar el desglose
  const tieneBloquePyL = delMes.some(r => r.bloque_pyl != null);
  if(tieneBloquePyL){
    const porBloque = agrupar(delMes, r => r.bloque_pyl || "(unassigned)", elim);
    const tituloBloque = kpiId === "contribution_margin"
      ? "Contribution components"
      : "By P&amp;L block";
    html += `<div class="drill-block">
      <h3>${tituloBloque}</h3>
      ${pintarLista(porBloque)}
    </div>`;
  }
  // Si el KPI trae tipo_transaccion (GMV), mostrar el desglose por tipo
  const tieneTipoTx = delMes.some(r => r.tipo_transaccion != null);
  if(tieneTipoTx){
    const porTipo = agrupar(delMes, r => r.tipo_transaccion || "(unassigned)", elim);
    html += `<div class="drill-block">
      <h3>By transaction type</h3>
      ${pintarLista(porTipo)}
    </div>`;
  }
  html += `</div>`;

  // Grafico mensual: serie de los facts filtrados (sin filtro de mes)
  const serieMensual = serieMensualFiltrada(filtered, elim);
  const monedaSerie = f.moneda === "USD" ? "USD" : (
    f.subsidiaria !== "All" ? monedaDePais(paisDeSubsidiaria(f.subsidiaria)) :
    f.pais !== "Global" ? monedaDePais(f.pais) :
    "COP" // global LOCAL: dominante CO
  );
  // Si el KPI tiene ratio (Margen, Contribution, EBITDA), agregamos toggle $/%
  const hasRatioChart = conRatio;
  if(hasRatioChart){
    // Para el chart en %, computamos GP/Rev por mes. Si data.ratio_against esta
    // definido y el KPI referenciado esta cargado, usamos su revenue (caso EBITDA
    // contra Adjusted Revenue). Sino, usamos los revenue_actuals embedded en el
    // propio fact (caso Margen, Contribution).
    const revPorMes = new Map();
    if(data.ratio_against && STATE.kpis[data.ratio_against]){
      const refFacts = filtrarFacts(STATE.kpis[data.ratio_against].facts, f);
      for(const r of refFacts){
        const ex = revPorMes.get(r.mes) || {revenue_a: 0, revenue_b: 0};
        ex.revenue_a += convertir((r.actuals && r.actuals[elim]) || 0, r.pais) || 0;
        ex.revenue_b += convertir((r.budget && r.budget[elim]) || 0, r.pais) || 0;
        revPorMes.set(r.mes, ex);
      }
    } else {
      for(const r of filtered){
        const ex = revPorMes.get(r.mes) || {revenue_a: 0, revenue_b: 0};
        ex.revenue_a += convertir((r.revenue_actuals && r.revenue_actuals[elim]) || 0, r.pais) || 0;
        ex.revenue_b += convertir((r.revenue_budget && r.revenue_budget[elim]) || 0, r.pais) || 0;
        revPorMes.set(r.mes, ex);
      }
    }
    const seriePct = serieMensual.map(s => {
      const rev = revPorMes.get(s.mes) || {revenue_a:0, revenue_b:0};
      return {
        mes: s.mes,
        actuals: rev.revenue_a !== 0 ? s.actuals / rev.revenue_a : null,
        budget:  rev.revenue_b !== 0 ? s.budget  / rev.revenue_b : null,
      };
    });
    html += `<div class="drill-block chart-block">
      <div class="chart-tab-bar">
        <h3>Monthly execution · Actuals vs Budget</h3>
        <div class="chart-tabs">
          <button class="chart-tab on" onclick="switchChartTab(this,'amount')">$ Amount</button>
          <button class="chart-tab" onclick="switchChartTab(this,'pct')">% ${data.ratio_label || "Ratio"}</button>
        </div>
      </div>
      <div class="chart-pane on" data-pane="amount">
        <div class="chart-unit-label">${monedaSerie}</div>
        ${lineChartSVG(serieMensual, monedaSerie, "MONEY")}
      </div>
      <div class="chart-pane" data-pane="pct">
        <div class="chart-unit-label">% of ${data.ratio_against === "ingresos_ajustados" ? "Adj. Revenue" : "Revenue"}</div>
        ${lineChartSVG(seriePct, "PCT", "PCT")}
      </div>
    </div>`;
  } else {
    html += `<div class="drill-block chart-block">
      <h3>Monthly execution · Actuals vs Budget (${monedaSerie})</h3>
      ${lineChartSVG(serieMensual, monedaSerie, "MONEY")}
    </div>`;
  }

  // Bloque de reconciliacion Books vs Operativo (solo KPI inventario)
  if(kpiId === "inventario" && data.reconciliation){
    const paisesAMostrar = f.pais === "Global"
      ? ["Colombia", "Mexico"]
      : [f.pais];
    let recoRows = "";
    for(const p of paisesAMostrar){
      const rec = data.reconciliation.find(r => r.mes === f.mes && r.pais === p);
      const booksFacts = filtered.filter(r => r.mes === f.mes && r.pais === p);
      const books = booksFacts.reduce((acc, r) => acc + ((r.actuals && r.actuals[elim]) || 0), 0);
      if(!rec && books === 0) continue;
      const op = rec ? rec.valor_compra : 0;
      const delta = books - op;
      const mon = f.moneda === "USD" ? "USD" : monedaDePais(p);
      const booksDisp = f.moneda === "USD" ? convertir(books, p) : books;
      const opDisp    = f.moneda === "USD" ? convertir(op, p)    : op;
      const deltaDisp = f.moneda === "USD" ? convertir(delta, p) : delta;
      const ctargetDisp = f.moneda === "USD" ? convertir(rec ? rec.valor_venta_target : 0, p) : (rec ? rec.valor_venta_target : 0);
      const deltaPct = op !== 0 ? (delta/op) : null;
      const flagCls = Math.abs(deltaPct || 0) > 0.02 ? "perf-amber" : "perf-green";
      recoRows += `<tr class="${flagCls}">
        <td><b>${p}</b></td>
        <td class="num">${fmtMoneda(booksDisp, mon)}</td>
        <td class="num">${fmtMoneda(opDisp, mon)}</td>
        <td class="num">${rec ? rec.nids_vivos.toLocaleString() : "—"}</td>
        <td class="num">${rec ? fmtMoneda(ctargetDisp, mon) : "—"}</td>
        <td class="num">${fmtMoneda(deltaDisp, mon)}</td>
        <td class="num">${deltaPct != null ? (deltaPct*100).toFixed(2) + "%" : "—"}</td>
      </tr>`;
    }
    html += `<div class="drill-block">
      <h3>Books vs Operativo · ${mesYYYYMM_a_label(f.mes)}</h3>
      <table class="drill-table">
        <thead><tr>
          <th>Country</th>
          <th style="text-align:right">Books (BET drivers)</th>
          <th style="text-align:right">Operativo (Σ v_precio)</th>
          <th style="text-align:right"># NIDs alive</th>
          <th style="text-align:right">Σ c_precio target</th>
          <th style="text-align:right">Delta</th>
          <th style="text-align:right">Delta %</th>
        </tr></thead>
        <tbody>${recoRows || `<tr><td colspan="7" class="drill-empty">No data.</td></tr>`}</tbody>
      </table>
    </div>`;
  }

  // Top 20 detalle — respeta TODOS los filtros activos.
  // Si el KPI tiene cuenta contable, se muestra como tabla cuenta+descripcion.
  // Si no (ej. GMV), se muestra como "Detalle" con la submetrica completa.
  const porDetalle = (() => {
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
  const tituloDetalle = tieneCuenta ? "Top 20 accounts" : "Top 20 detail";
  html += `<div class="drill-block">
    <h3>${tituloDetalle}${filtrosTxt && filtrosTxt !== "Global · todas" ? " · " + filtrosTxt : ""}</h3>
    <table class="drill-table">
      <thead><tr>
        ${tieneCuenta ? "<th>Account</th>" : ""}
        <th>${tieneCuenta ? "Description" : "Detail"}</th>
        <th style="text-align:right">Actuals</th>
        <th style="text-align:right">Budget</th>
        <th style="text-align:right">vs Bud</th>
      </tr></thead>
      <tbody>`;
  for(const c of porDetalle){
    const a = f.moneda === "USD" ? convertir(c.actuals, c.pais) : c.actuals;
    const b = c.budget !== 0 ? (f.moneda === "USD" ? convertir(c.budget, c.pais) : c.budget) : null;
    const mon = f.moneda === "USD" ? "USD" : monedaDePais(c.pais || "Colombia");
    const diff = (a != null && b != null && b !== 0) ? (a - b) / Math.abs(b) : null;
    html += `<tr>
      ${tieneCuenta ? `<td><code>${c.cuenta ?? "—"}</code></td>` : ""}
      <td>${c.desc || "(sin descripción)"}</td>
      <td class="num">${fmtMoneda(a, mon)}</td>
      <td class="num">${b != null ? fmtMoneda(b, mon) : "—"}</td>
      <td class="num">${diff != null ? fmtDelta(diff, invertirKPI) : "—"}</td>
    </tr>`;
  }
  html += `</tbody></table>
  </div>`;
  // Solo mostrar la nota especifica de Ingresos cuando el KPI sea ingresos
  if(kpiId === "ingresos_totales"){
    html += `<div class="drill-note">
      <b>Note</b>: If values don't match your reference, the first suspect is the filter <code>m_metrica != '01. Total Revenue'</code>, which excludes the aggregate marker row.
    </div>`;
  }
  if(kpiId === "ingresos_ajustados"){
    html += `<div class="drill-note">
      <b>How the adjustment works</b>: Revenue BET <i>minus</i> MM Sales BET <i>plus</i> Σ <code>c_precio</code> from <code>finance_tapes_global</code> for the NIDs invoiced in BET MM. Pivot month = <code>c_fecha_factura</code>. Intercompany counterparties (MCN, Merbos, MCNEmexico) excluded. The delta is booked to the MM pivot subsidiary by country: <b>Habi</b> for CO, <b>Corporativo</b> for MX. Other subsidiaries keep flat revenue. Budget is <b>not</b> adjusted — comparison vs budget uses plain revenue.
    </div>`;
  }
  if(kpiId === "inventario"){
    html += `<div class="drill-note">
      <b>Books vs Operativo</b>: "Books" comes from <code>bet_data_p2</code> drivers (<code>m_metrica='03. Inventory'</code>). "Operativo" reconstructs live inventory at month close from <code>finance_tapes_global</code>: NIDs with <code>v_fecha_escritura</code> (purchase) and no <code>c_fecha_escritura</code> (sale) at the cut, filtered to <code>desistimientos = 'No desistidos'</code>, valued at <code>v_precio</code> (purchase cost). Significant delta = timing or registry inconsistency to investigate.
    </div>`;
  }

  document.getElementById("drillBody").innerHTML = html;
  document.getElementById("drillModal").hidden = false;
}

function cerrarDrill(){ document.getElementById("drillModal").hidden = true; }

/* ============================================================ RENDER === */

function rebuildSubsidiariaOptions(){
  const sel = document.getElementById("fSubsidiaria");
  const opts = SUBSIDIARIAS_POR_PAIS[STATE.filters.pais];
  sel.innerHTML = opts.map(s => `<option value="${s}">${s}</option>`).join("");
  if(!opts.includes(STATE.filters.subsidiaria)) STATE.filters.subsidiaria = "All";
  sel.value = STATE.filters.subsidiaria;
}
function rebuildLineaOptions(){
  const sel = document.getElementById("fLinea");
  const opts = LINEAS_POR_PAIS[STATE.filters.pais];
  sel.innerHTML = opts.map(s => `<option value="${s}">${s}</option>`).join("");
  if(!opts.includes(STATE.filters.linea)) STATE.filters.linea = "All";
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
  const ctx = `${STATE.filters.pais}${STATE.filters.subsidiaria !== "All" ? " · " + STATE.filters.subsidiaria : ""}${STATE.filters.linea !== "All" ? " · " + STATE.filters.linea : ""} · ${STATE.filters.moneda === "USD" ? "USD" : "Local currency"}`;
  document.getElementById("contextLabel").innerHTML = ctx;
  document.getElementById("ctx41").textContent = ctx;

  renderSnapshot();
  document.getElementById("grid41").innerHTML = KPIS_41.map(renderCard).join("");
  document.getElementById("grid42").innerHTML = KPIS_42.map(renderCard).join("");

  document.getElementById("pageFoot").innerHTML =
    `<b>Manual refresh</b> · run <code>make refresh</code> to regenerate the JSONs from BigQuery.<br>` +
    `KPIs marked as <b>pending</b> are awaiting their data source. Section 4.1 complete; 4.2 in progress (Inventory on books live).`;
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
  document.getElementById("segAjustes").querySelectorAll("button").forEach(b => {
    b.addEventListener("click", () => {
      document.querySelectorAll("#segAjustes button").forEach(x => x.classList.remove("on"));
      b.classList.add("on"); STATE.filters.ajustes = b.dataset.val; render();
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
        <b>Could not load data.</b><br>
        Check that <code>site/data/meta.json</code> exists (run <code>make refresh</code>).<br>
        Error: ${e.message}
      </div>`;
    return;
  }
  poblarFiltros();
  bindFiltros();
  render();
}

function switchChartTab(btn, pane){
  // Toggle tabs within the same chart-block (no global side effects)
  const block = btn.closest(".chart-block");
  if(!block) return;
  block.querySelectorAll(".chart-tab").forEach(t => t.classList.toggle("on", t === btn));
  block.querySelectorAll(".chart-pane").forEach(p => p.classList.toggle("on", p.dataset.pane === pane));
}

window.abrirDrill = abrirDrill;
window.switchChartTab = switchChartTab;
init();
