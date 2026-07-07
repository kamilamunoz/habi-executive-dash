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
  currentDrillKpi: null,
  filters: {
    mes: null,
    pais: "Global",
    subsidiaria: "All",
    linea: "All",
    moneda: "USD",
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
  { id: "inventory_aging",     nombre: "Inventory aging",            file: "kpi_aging.json" },
  { id: "capital_roic",        nombre: "Capital deployed / ROIC",    file: null },
  { id: "ciclo_caja",          nombre: "Cash conversion cycle",      file: "kpi_ciclo.json" },
  { id: "rotacion",            nombre: "Sell-through",               file: "kpi_rotacion.json" },
  { id: "net_debt",            nombre: "Net debt, leverage & cost of capital", file: "kpi_net_debt.json" },
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

/* Capitalized Payroll filtrado por (mes, pais, subsidiaria, ajustes, elim) con
 * FX aplicado. Devuelve {actuals, budget} en la moneda mostrada.
 *
 * Cap. payroll en BET ya viene con signo invertido (positivo) desde el builder,
 * de modo que el front lo SUMA directo al EBITDA para obtener Adj EBITDA. Solo
 * lo usa el KPI EBITDA por ahora (data.cap_payroll_serie). */
function montoCapPayroll(capSerie, filters, mes){
  if(!capSerie) return {actuals: 0, budget: 0};
  let a = 0, b = 0;
  for(const r of capSerie){
    if(r.mes !== mes) continue;
    if(filters.pais !== "Global" && r.pais !== filters.pais) continue;
    if(filters.subsidiaria !== "All" && r.subsidiaria !== filters.subsidiaria) continue;
    const esAj = !!r.es_ajuste;
    if(filters.ajustes === "sin_ajustes" && esAj) continue;
    if(filters.ajustes === "solo_ajustes" && !esAj) continue;
    const aVal = (r.actuals && r.actuals[filters.elim]) || 0;
    const bVal = (r.budget  && r.budget[filters.elim])  || 0;
    a += convertir(aVal, r.pais) || 0;
    b += convertir(bVal, r.pais) || 0;
  }
  return {actuals: a, budget: b};
}

/* Serie mensual de cap. payroll para el chart (mismo filtro que arriba pero por
 * cada mes en lugar de un mes especifico). */
function serieCapPayroll(capSerie, filters){
  if(!capSerie) return new Map();
  const map = new Map();
  for(const r of capSerie){
    if(filters.pais !== "Global" && r.pais !== filters.pais) continue;
    if(filters.subsidiaria !== "All" && r.subsidiaria !== filters.subsidiaria) continue;
    const esAj = !!r.es_ajuste;
    if(filters.ajustes === "sin_ajustes" && esAj) continue;
    if(filters.ajustes === "solo_ajustes" && !esAj) continue;
    const ex = map.get(r.mes) || {actuals: 0, budget: 0};
    ex.actuals += convertir((r.actuals && r.actuals[filters.elim]) || 0, r.pais) || 0;
    ex.budget  += convertir((r.budget  && r.budget[filters.elim])  || 0, r.pais) || 0;
    map.set(r.mes, ex);
  }
  return map;
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

/* Ventana movil de N meses terminando en mesFinal (inclusive). Si mesFinal no
 * esta en la serie, recorta a los meses <= mesFinal. Centralizado para que
 * todas las graficas (sparkline, line chart, stacked bars) usen el mismo corte
 * dictado por STATE.filters.mes. */
const VENTANA_MESES_CHART = 13;
function recortarVentana(serie, mesFinal, N){
  N = N || VENTANA_MESES_CHART;
  if(!mesFinal || !serie || !serie.length) return serie || [];
  // Guarda contra series que no usan formato YYYY-MM (ej. eje de "dia del
  // mes" del tab MTD). Si el primer mes no parece YYYY-MM, no recortar.
  if(!/^\d{4}-\d{2}$/.test(String(serie[0].mes))) return serie;
  // serie ya viene ordenada por mes asc en todos los callers
  let cutEnd = serie.findIndex(r => r.mes === mesFinal);
  if(cutEnd < 0){
    // mes no esta en la serie: cortar al ultimo mes <= mesFinal
    let i = serie.length - 1;
    while(i >= 0 && serie[i].mes > mesFinal) i--;
    cutEnd = i;
  }
  if(cutEnd < 0) return [];
  return serie.slice(Math.max(0, cutEnd - N + 1), cutEnd + 1);
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
  // MTD · Transactions (Fase 1) — payload con shape distinto a los KPIs
  // (multi-stream agrupado por pais con ventanas mes_actual/anterior/yoy).
  try{
    STATE.mtd = await fetch("data/kpi_mtd_transactions.json" + cb).then(r => r.json());
  } catch(e){
    console.warn("No se pudo cargar kpi_mtd_transactions.json", e);
  }
  const primero = Object.values(STATE.kpis)[0];
  if(primero && primero.meses_disponibles && primero.meses_disponibles.length){
    // Default = ultimo mes CERRADO (meta.mes_corte). Si no esta en meta, cae
    // al ultimo mes disponible (back-compat con meta.json viejos).
    const defaultMes = (STATE.meta.mes_corte || "").slice(0, 7);
    const disponibles = primero.meses_disponibles;
    STATE.filters.mes = disponibles.includes(defaultMes)
      ? defaultMes
      : disponibles[disponibles.length - 1];
  }
}

/* True si el mes YYYY-MM es el mes parcial (MTD) reportado por meta.json. */
function esMesParcial(mesYYYYMM){
  if(!STATE.meta || !STATE.meta.es_mes_parcial || !STATE.meta.mes_max) return false;
  return STATE.meta.mes_max.slice(0, 7) === mesYYYYMM;
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
  // Recorte a ventana movil de 13m terminando en el mes seleccionado.
  serie = recortarVentana(serie, STATE.filters && STATE.filters.mes);
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
  if(unit === "DAYS") return Math.round(v) + "d";
  if(unit === "COUNT") return Math.round(v).toLocaleString();
  return fmtMoneda(v, moneda, {compact: true});
}

function lineChartSVG(serie, moneda, unit, labels, extra){
  unit = unit || "MONEY";
  labels = labels || {actuals: "Actuals", budget: "Budget"};
  // extra: opcional, {serie:[{mes, actuals}], label, color}. Pinta una tercera
  // linea (ej. Adj EBITDA en azul) alineada por indice de mes con serie.
  // Recorte a ventana movil de 13m terminando en el mes seleccionado.
  const mesFinal = STATE.filters && STATE.filters.mes;
  serie = recortarVentana(serie, mesFinal);
  if(extra && extra.serie){ extra = Object.assign({}, extra, {serie: recortarVentana(extra.serie, mesFinal)}); }
  if(!serie || serie.length === 0) return "<div class='chart-empty'>No data</div>";
  const W = 1200, H = 460, pad = {l: 78, r: 28, t: 30, b: 58};
  const cw = W - pad.l - pad.r, ch = H - pad.t - pad.b;

  const extraVals = (extra && extra.serie)
    ? extra.serie.flatMap(r => [r.actuals]).filter(v => v != null && !isNaN(v))
    : [];
  const vals = serie.flatMap(r => [r.actuals, r.budget]).concat(extraVals).filter(v => v != null && !isNaN(v));
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
  const pointsE = (extra && extra.serie)
    ? extra.serie.map((r,i) => (r.actuals == null || isNaN(r.actuals))
        ? null
        : {x: xAt(i), y: yAt(r.actuals), v: r.actuals, i}).filter(Boolean)
    : [];

  // Paths
  const dA = pointsA.map((p,i) => (i?"L":"M") + p.x.toFixed(1) + " " + p.y.toFixed(1)).join(" ");
  const dB = pointsB.map((p,i) => (i?"L":"M") + p.x.toFixed(1) + " " + p.y.toFixed(1)).join(" ");
  const dE = pointsE.map((p,i) => (i?"L":"M") + p.x.toFixed(1) + " " + p.y.toFixed(1)).join(" ");

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
      <title>${serie[p.i].mes} · ${labels.actuals}: ${fmtChartValue(p.v, unit, moneda)}</title></circle>`;
    labelsA += `<text x="${p.x.toFixed(1)}" y="${yLabel.toFixed(1)}" text-anchor="middle" font-size="12.5" font-weight="700" fill="#3A1980" font-family="IBM Plex Mono, monospace" paint-order="stroke" stroke="#FFFFFF" stroke-width="4">${fmtChartValue(p.v, unit, moneda)}</text>`;
  });
  pointsB.forEach(p => {
    const pA = pointsA.find(pa => pa.i === p.i);
    const bArriba = !pA || p.v > pA.v;
    const yLabel = bArriba ? p.y - labelOffset : p.y + labelOffset + 4;
    dotsB += `<circle cx="${p.x.toFixed(1)}" cy="${p.y.toFixed(1)}" r="4.5" fill="#FFFFFF" stroke="#8B4FE8" stroke-width="2">
      <title>${serie[p.i].mes} · ${labels.budget}: ${fmtChartValue(p.v, unit, moneda)}</title></circle>`;
    labelsB += `<text x="${p.x.toFixed(1)}" y="${yLabel.toFixed(1)}" text-anchor="middle" font-size="11.5" font-weight="500" fill="#7A3FE0" font-family="IBM Plex Mono, monospace" paint-order="stroke" stroke="#FFFFFF" stroke-width="3">${fmtChartValue(p.v, unit, moneda)}</text>`;
  });

  // Extra series (Adj EBITDA en azul). Sin label encima del punto para no
  // saturar; el valor sale en el tooltip al hacer hover.
  let dotsE = "";
  const extraColor = (extra && extra.color) || "#2D6FD4";
  const extraLabel = (extra && extra.label) || "Adj EBITDA";
  pointsE.forEach(p => {
    const mes = (extra.serie[p.i] || {}).mes || "";
    dotsE += `<circle cx="${p.x.toFixed(1)}" cy="${p.y.toFixed(1)}" r="4.5" fill="${extraColor}">
      <title>${mes} · ${extraLabel}: ${fmtChartValue(p.v, unit, moneda)}</title></circle>`;
  });

  // Eje X — formato YYYY-MM (mes/anyo) o numerico (dia del mes en MTD)
  const esYYYYMM = /^\d{4}-\d{2}$/.test(String(serie[0].mes));
  let xLabels = "";
  serie.forEach((r,i) => {
    const x = xAt(i);
    if(esYYYYMM){
      const [y, m] = r.mes.split("-");
      xLabels += `<text x="${x.toFixed(1)}" y="${H - 30}" text-anchor="middle" font-size="13" font-weight="600" fill="#1A1A2E" font-family="IBM Plex Mono, monospace">${FMT_MES[m]}</text>
                  <text x="${x.toFixed(1)}" y="${H - 14}" text-anchor="middle" font-size="11" fill="#5C5C70" font-family="IBM Plex Mono, monospace">${y}</text>`;
    } else {
      // Dia del mes: pintar solo cada 3 dias + 1 y ultimo para no saturar
      const dia = parseInt(r.mes, 10);
      const mostrar = (dia === 1) || (dia === serie.length) || (dia % 3 === 0);
      if(mostrar){
        xLabels += `<text x="${x.toFixed(1)}" y="${H - 22}" text-anchor="middle" font-size="12" font-weight="600" fill="#1A1A2E" font-family="IBM Plex Mono, monospace">${dia}</text>`;
      }
    }
  });

  const legendExtra = (extra && extra.serie && extra.serie.length)
    ? `<span><span class="lg-line lg-adj" style="background:${extraColor}"></span>${extraLabel}</span>`
    : "";
  return `<div class="chart-wrap">
    <svg viewBox="0 0 ${W} ${H}" class="chart" preserveAspectRatio="xMidYMid meet">
      ${yAxis}
      ${dB ? `<path d="${dB}" fill="none" stroke="#8B4FE8" stroke-width="2.4" stroke-dasharray="6 4" stroke-linejoin="round" stroke-linecap="round" opacity="0.85"/>` : ""}
      ${dE ? `<path d="${dE}" fill="none" stroke="${extraColor}" stroke-width="2.6" stroke-linejoin="round" stroke-linecap="round" opacity="0.95"/>` : ""}
      ${dA ? `<path d="${dA}" fill="none" stroke="#6B2FD4" stroke-width="3" stroke-linejoin="round" stroke-linecap="round"/>` : ""}
      ${dotsB}
      ${dotsE}
      ${dotsA}
      ${labelsB}
      ${labelsA}
      ${xLabels}
    </svg>
  </div>
  <div class="chart-legend">
    <span><span class="lg-line lg-actuals"></span>${labels.actuals}</span>
    ${legendExtra}
    <span><span class="lg-line lg-budget"></span>${labels.budget}</span>
  </div>`;
}

/* Stacked bar chart SVG. seriePorMes = [{mes, segmentos: [{key, value, color}, ...]}].
 * Renderiza barras apiladas con leyenda inferior. value = entero (count). */
function stackedBarChartSVG(seriePorMes, legendOrder, colorMap){
  // Recorte a ventana movil de 13m terminando en el mes seleccionado.
  seriePorMes = recortarVentana(seriePorMes, STATE.filters && STATE.filters.mes);
  if(!seriePorMes || !seriePorMes.length) return "<div class='chart-empty'>No data</div>";
  const W = 1200, H = 460, pad = {l: 78, r: 28, t: 30, b: 58};
  const cw = W - pad.l - pad.r, ch = H - pad.t - pad.b;

  const totales = seriePorMes.map(r => r.segmentos.reduce((acc, s) => acc + (s.value || 0), 0));
  const max = Math.max(...totales, 1);
  const yMax = max * 1.12;

  const n = seriePorMes.length;
  const barW = Math.min(60, (cw / n) * 0.6);
  const xAt = i => pad.l + (n === 1 ? cw/2 : i * cw / (n-1));
  const yAt = v => pad.t + ch - (v / yMax) * ch;

  // Y axis
  const ticks = 5;
  let yAxis = "";
  for(let i=0; i<=ticks; i++){
    const v = yMax * i / ticks;
    const y = pad.t + ch - (ch * i / ticks);
    yAxis += `<line x1="${pad.l}" x2="${pad.l + cw}" y1="${y}" y2="${y}" stroke="#EFEFF4" stroke-width="1"/>
              <text x="${pad.l - 10}" y="${y + 4}" text-anchor="end" font-size="12" fill="#5C5C70" font-family="IBM Plex Mono, monospace">${Math.round(v).toLocaleString()}</text>`;
  }

  // Bars
  let bars = "", topLabels = "";
  seriePorMes.forEach((r, i) => {
    let acumulado = 0;
    const x = xAt(i) - barW/2;
    for(const seg of r.segmentos){
      const v = seg.value || 0;
      if(v <= 0) continue;
      const yTop = yAt(acumulado + v);
      const yBot = yAt(acumulado);
      const h = Math.max(0.5, yBot - yTop);
      const color = colorMap[seg.key] || "#999";
      bars += `<rect x="${x.toFixed(1)}" y="${yTop.toFixed(1)}" width="${barW.toFixed(1)}" height="${h.toFixed(1)}" fill="${color}">
        <title>${r.mes} · ${seg.key}: ${v.toLocaleString()}</title>
      </rect>`;
      acumulado += v;
    }
    const total = totales[i];
    if(total > 0){
      const yTotal = yAt(total) - 6;
      topLabels += `<text x="${xAt(i).toFixed(1)}" y="${yTotal.toFixed(1)}" text-anchor="middle" font-size="11.5" font-weight="700" fill="#1A1A2E" font-family="IBM Plex Mono, monospace">${total.toLocaleString()}</text>`;
    }
  });

  // X labels
  let xLabels = "";
  seriePorMes.forEach((r, i) => {
    const x = xAt(i);
    const [y, m] = r.mes.split("-");
    xLabels += `<text x="${x.toFixed(1)}" y="${H - 30}" text-anchor="middle" font-size="13" font-weight="600" fill="#1A1A2E" font-family="IBM Plex Mono, monospace">${FMT_MES[m]}</text>
                <text x="${x.toFixed(1)}" y="${H - 14}" text-anchor="middle" font-size="11" fill="#5C5C70" font-family="IBM Plex Mono, monospace">${y}</text>`;
  });

  const legend = legendOrder.map(k =>
    `<span><span class="lg-swatch" style="background:${colorMap[k]}"></span>${k}d</span>`
  ).join("");

  return `<div class="chart-wrap">
    <svg viewBox="0 0 ${W} ${H}" class="chart" preserveAspectRatio="xMidYMid meet">
      ${yAxis}
      ${bars}
      ${topLabels}
      ${xLabels}
    </svg>
  </div>
  <div class="chart-legend">${legend}</div>`;
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
  // Caso especial: KPI aging muestra % NIDs sobre umbral (no moneda)
  if(data.unidad === "PORCENTAJE_AGING"){
    return renderCardAging(kpiDef, data);
  }
  // Caso especial: KPI ciclo muestra dias (mediana y promedio)
  if(data.unidad === "DIAS_CICLO"){
    return renderCardCiclo(kpiDef, data);
  }
  // Caso especial: KPI sell-through muestra % NIDs vendidos / inventario inicio
  if(data.unidad === "PORCENTAJE_SELLTHROUGH"){
    return renderCardSellThrough(kpiDef, data);
  }
  // Caso especial: Debt in Homes con leverage sobre Adj EBITDA LTM
  if(data.unidad === "MONEDA_DEBT_HOMES"){
    return renderCardDebtHomes(kpiDef, data);
  }
  const {actuals, budget, paisLocal, ratio, ratio_budget} = montoMesActual(data);
  const mon = monedaMostrada(paisLocal);
  const valor = fmtMoneda(actuals, mon);
  const budgetTxt = budget != null && budget !== 0 ? fmtMoneda(budget, mon) : "—";
  const diff = (actuals != null && budget != null && budget !== 0) ? (actuals - budget)/Math.abs(budget) : null;
  const invertir = !!data.invertir_delta;
  // Cap. payroll adjustment (solo KPI EBITDA hoy). Adj EBITDA = EBITDA + Cap. Payroll
  // (en el payload viene con signo invertido, asi que se suma directo).
  let capPayroll = null, adjActuals = null, adjBudget = null;
  if(data.cap_payroll_serie){
    capPayroll = montoCapPayroll(data.cap_payroll_serie, STATE.filters, STATE.filters.mes);
    adjActuals = actuals != null ? actuals + capPayroll.actuals : null;
    adjBudget  = budget  != null ? budget  + capPayroll.budget  : null;
  }
  // Ratio puede venir embebido (Margen) o cross-KPI (OpEx vs Ingresos)
  let ratioVal = data.unidad === "MONEDA_CON_RATIO" ? ratio : null;
  let ratioBud = data.unidad === "MONEDA_CON_RATIO" ? ratio_budget : null;
  let ratioLabel = data.ratio_label;
  let ratioComoMeses = false;
  if(data.ratio_against && STATE.kpis[data.ratio_against] && actuals != null){
    const ref = montoMesActual(STATE.kpis[data.ratio_against]);
    // Si el KPI usa Adj EBITDA como numerador (EBITDA), reemplazar actuals/budget
    // por sus versiones ajustadas para el calculo del ratio.
    const numA = (data.ratio_numerator === "adj_ebitda" && adjActuals != null) ? adjActuals : actuals;
    const numB = (data.ratio_numerator === "adj_ebitda" && adjBudget  != null) ? adjBudget  : budget;
    if(ref.actuals && ref.actuals !== 0){
      ratioVal = Math.abs(numA) / Math.abs(ref.actuals);
      if(ref.budget && ref.budget !== 0 && numB != null){
        ratioBud = Math.abs(numB) / Math.abs(ref.budget);
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

  // Barra de cumplimiento vs budget. Capped a 100% visualmente; color refleja performance real.
  let progressHTML = "";
  if(actuals != null && budget != null && budget !== 0){
    const pct = actuals / budget;
    const cappedPct = Math.min(Math.max(pct, 0), 1) * 100;
    const fillCls = perfCls;  // mismo color que la card
    progressHTML = `<div class="progress-wrap">
      <div class="progress-bar"><div class="progress-fill ${fillCls}" style="width:${cappedPct.toFixed(1)}%"></div></div>
      <div class="progress-label">${(pct*100).toFixed(0)}% of budget</div>
    </div>`;
  }

  // Linea secundaria con Adj EBITDA (solo si el KPI usa cap_payroll_serie).
  const adjHTML = (adjActuals != null)
    ? `<div class="adj-line">Adj. EBITDA: <b>${fmtMoneda(adjActuals, mon)}</b></div>`
    : "";

  return `<div class="card ${perfCls}" onclick="abrirDrill('${kpiDef.id}')">
    <div class="kpi-name"><span class="nm">${kpiDef.nombre}</span><span class="tag ${data.estado}">${TAG_LABEL[data.estado]}</span></div>
    <div class="val">${valor}</div>
    ${adjHTML}
    ${ratioHTML}
    <div class="budget-line">Budget: <b>${budgetTxt}</b></div>
    ${progressHTML}
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

/* Card render para KPIs tipo aging: muestra % NIDs sobre umbral.
 * No usa moneda; el budget no aplica (snapshot derivado del tape).
 * Sparkline es serie del % mes a mes. */
function renderCardAging(kpiDef, data){
  const f = STATE.filters;
  const bucketsOver = (data.buckets_meta || []).filter(b => b.over).map(b => b.name);
  const filtered = filtrarFacts(data.facts, f);

  // Serie mensual del % over para sparkline
  const porMes = new Map();
  for(const r of filtered){
    const ex = porMes.get(r.mes) || {mes: r.mes, total: 0, over: 0};
    const n = (r.actuals && r.actuals[f.elim]) || 0;
    ex.total += n;
    if(bucketsOver.includes(r.bucket)) ex.over += n;
    porMes.set(r.mes, ex);
  }
  const serie = [...porMes.values()]
    .sort((a,b) => a.mes.localeCompare(b.mes))
    .map(r => ({mes: r.mes, actuals: r.total > 0 ? r.over/r.total : null}));

  const idxCorte = serie.findIndex(r => r.mes === f.mes);
  const last = idxCorte >= 0 ? serie[idxCorte] : null;
  const prev = idxCorte > 0  ? serie[idxCorte-1] : null;
  const pct = last ? last.actuals : null;
  const delta = (last && prev && prev.actuals != null) ? (last.actuals - prev.actuals) : null;

  // Detalle del mes para mostrar absolutos
  const delMes = filtered.filter(r => r.mes === f.mes);
  const totalNids = delMes.reduce((acc, r) => acc + ((r.actuals && r.actuals[f.elim]) || 0), 0);
  const overNids  = delMes.filter(r => bucketsOver.includes(r.bucket))
                          .reduce((acc, r) => acc + ((r.actuals && r.actuals[f.elim]) || 0), 0);

  const color = SPARK_COLOR[data.estado] || SPARK_COLOR.ejemplo;
  const valorTxt = pct != null
    ? `${(pct*100).toFixed(1)}%`
    : "—";
  const subTxt = pct != null
    ? `<span class="vs">${Math.round(overNids).toLocaleString()} of ${Math.round(totalNids).toLocaleString()} NIDs over ${data.umbral_dias}d</span>`
    : "";

  // Color de card: ▲ % over = peor (rojo)
  // Umbral arbitrario: <2pp = verde, 2-5pp = ámbar, >5pp = rojo (en cambio MoM)
  let perfCls = "perf-gray";
  if(delta != null){
    if(delta <= 0.02) perfCls = "perf-green";
    else if(delta <= 0.05) perfCls = "perf-amber";
    else perfCls = "perf-red";
  }

  // Delta MoM en puntos porcentuales
  const deltaTxt = delta != null
    ? `<span class="${delta > 0 ? 'down' : 'up'}">${delta > 0 ? '▲' : '▼'} ${Math.abs(delta*100).toFixed(1)}pp</span> <span class="vs">vs prev. month</span>`
    : "";

  return `<div class="card ${perfCls}" onclick="abrirDrill('${kpiDef.id}')">
    <div class="kpi-name"><span class="nm">${kpiDef.nombre}</span><span class="tag ${data.estado}">${TAG_LABEL[data.estado]}</span></div>
    <div class="val">${valorTxt}</div>
    <div class="ratio-line">${subTxt}</div>
    <div class="delta">${deltaTxt}</div>
    ${sparkSVG(serie, color)}
    <div class="src">◷ ${data.fuente || ""}</div>
    <div class="card-cta">Click for drill-down →</div>
  </div>`;
}

/* Card render para KPI ciclo de caja: muestra mediana (valor principal) y promedio (ratio-line).
 * Sparkline = p50 mes a mes. */
function renderCardCiclo(kpiDef, data){
  const f = STATE.filters;
  const filtered = filtrarFacts(data.facts, f);
  // Cuando filter pais especifico, los facts del pais; cuando Global, ponderamos por NIDs
  function agregarMes(facts){
    // Devuelve {avg, p50, nids} promediados ponderados por nids
    if(!facts.length) return {avg: null, p50: null, nids: 0};
    let wAvg = 0, wP50 = 0, w = 0;
    for(const r of facts){
      const n = r.nids || 0;
      if(r.avg_dias != null) wAvg += r.avg_dias * n;
      if(r.p50_dias != null) wP50 += r.p50_dias * n;
      w += n;
    }
    return {avg: w > 0 ? wAvg/w : null, p50: w > 0 ? wP50/w : null, nids: w};
  }
  const delMes = filtered.filter(r => r.mes === f.mes);
  const cur = agregarMes(delMes);

  // Serie mensual de p50 para sparkline
  const porMes = {};
  for(const r of filtered){
    porMes[r.mes] = porMes[r.mes] || [];
    porMes[r.mes].push(r);
  }
  const serie = Object.keys(porMes).sort().map(m => ({mes: m, actuals: agregarMes(porMes[m]).p50}));

  const idxCorte = serie.findIndex(r => r.mes === f.mes);
  const prev = idxCorte > 0 ? serie[idxCorte-1] : null;
  const last = idxCorte >= 0 ? serie[idxCorte] : null;
  const delta = (last && prev && prev.actuals != null && last.actuals != null) ? (last.actuals - prev.actuals) : null;

  const color = SPARK_COLOR[data.estado] || SPARK_COLOR.ejemplo;
  const valorTxt = cur.p50 != null ? `${Math.round(cur.p50)} days` : "—";
  const avgTxt = cur.avg != null ? `Avg <b>${Math.round(cur.avg)}d</b>` : "";
  const nidsTxt = cur.nids ? `<span class="vs">${cur.nids.toLocaleString()} cycles closed in month</span>` : "";

  // Color de card: ▲ días = peor (rojo)
  let perfCls = "perf-gray";
  if(delta != null){
    if(delta <= 7) perfCls = "perf-green";       // <= +7 días
    else if(delta <= 30) perfCls = "perf-amber"; // +7 a +30
    else perfCls = "perf-red";                   // > +30
  }
  const deltaTxt = delta != null
    ? `<span class="${delta > 0 ? 'down' : 'up'}">${delta > 0 ? '▲' : '▼'} ${Math.abs(delta).toFixed(0)}d</span> <span class="vs">vs prev. month (median)</span>`
    : "";

  return `<div class="card ${perfCls}" onclick="abrirDrill('${kpiDef.id}')">
    <div class="kpi-name"><span class="nm">${kpiDef.nombre}</span><span class="tag ${data.estado}">${TAG_LABEL[data.estado]}</span></div>
    <div class="val">${valorTxt}</div>
    <div class="ratio-line">${avgTxt} ${nidsTxt}</div>
    <div class="delta">${deltaTxt}</div>
    ${sparkSVG(serie, color)}
    <div class="src">◷ ${data.fuente || ""}</div>
    <div class="card-cta">Click for drill-down →</div>
  </div>`;
}

/* Card render para sell-through: muestra % y "X sold / Y in inventory". */
function renderCardSellThrough(kpiDef, data){
  const f = STATE.filters;
  const filtered = filtrarFacts(data.facts, f);

  // Ponderacion: cuando filter=Global, sumamos vendidos / sumamos inventario
  function ratioMes(facts){
    let sold = 0, inv = 0;
    for(const r of facts){
      sold += r.nids_vendidos || 0;
      inv  += r.nids_inv_inicio || 0;
    }
    return {sold, inv, st: inv > 0 ? sold/inv : null};
  }
  const delMes = filtered.filter(r => r.mes === f.mes);
  const cur = ratioMes(delMes);

  // Serie mensual del sell-through ponderado
  const porMes = {};
  for(const r of filtered){
    porMes[r.mes] = porMes[r.mes] || [];
    porMes[r.mes].push(r);
  }
  const serie = Object.keys(porMes).sort().map(m => ({mes: m, actuals: ratioMes(porMes[m]).st}));

  const idxCorte = serie.findIndex(r => r.mes === f.mes);
  const last = idxCorte >= 0 ? serie[idxCorte] : null;
  const prev = idxCorte > 0 ? serie[idxCorte-1] : null;
  const delta = (last && prev && prev.actuals != null && last.actuals != null) ? (last.actuals - prev.actuals) : null;

  const color = SPARK_COLOR[data.estado] || SPARK_COLOR.ejemplo;
  const valorTxt = cur.st != null ? `${(cur.st*100).toFixed(1)}%` : "—";
  const subTxt = cur.inv > 0
    ? `<span class="vs">${cur.sold.toLocaleString()} sold / ${cur.inv.toLocaleString()} in inventory at start of month</span>`
    : "";

  // Color: ▲ sell-through = bueno (verde). Umbral en pp.
  let perfCls = "perf-gray";
  if(delta != null){
    if(delta >= -0.01) perfCls = "perf-green";
    else if(delta >= -0.03) perfCls = "perf-amber";
    else perfCls = "perf-red";
  }
  const deltaTxt = delta != null
    ? `<span class="${delta >= 0 ? 'up' : 'down'}">${delta >= 0 ? '▲' : '▼'} ${Math.abs(delta*100).toFixed(1)}pp</span> <span class="vs">vs prev. month</span>`
    : "";

  return `<div class="card ${perfCls}" onclick="abrirDrill('${kpiDef.id}')">
    <div class="kpi-name"><span class="nm">${kpiDef.nombre}</span><span class="tag ${data.estado}">${TAG_LABEL[data.estado]}</span></div>
    <div class="val">${valorTxt}</div>
    <div class="ratio-line">${subTxt}</div>
    <div class="delta">${deltaTxt}</div>
    ${sparkSVG(serie, color)}
    <div class="src">◷ ${data.fuente || ""}</div>
    <div class="card-cta">Click for drill-down →</div>
  </div>`;
}

/* Card render para Net debt + Leverage + Cost of capital. */
function renderCardDebtHomes(kpiDef, data){
  const f = STATE.filters;
  const filtered = filtrarFacts(data.facts, f);

  function agregarMes(facts){
    let debt = 0, adjLtm = 0, ebLtm = 0, capLtm = 0, intLtm = 0, avgDebtLtm = 0, paisLocal = null;
    const paises = new Set();
    for(const r of facts){
      const p = r.pais;
      debt   += convertir((r.actuals && r.actuals[f.elim]) || 0, p) || 0;
      adjLtm += convertir(r.adj_ebitda_ltm || 0, p) || 0;
      ebLtm  += convertir(r.ebitda_ltm || 0, p) || 0;
      capLtm += convertir(r.capitalized_payroll_ltm || 0, p) || 0;
      intLtm += convertir(r.net_interest_ltm || 0, p) || 0;
      avgDebtLtm += convertir(r.debt_avg_ltm || 0, p) || 0;
      paises.add(p);
    }
    if(paises.size === 1) paisLocal = [...paises][0];
    const lev = adjLtm > 0 ? debt/adjLtm : null;
    const coc = avgDebtLtm > 0 ? intLtm/avgDebtLtm : null;
    return {debt, adjLtm, ebLtm, capLtm, intLtm, avgDebtLtm, lev, coc, paisLocal};
  }
  const delMes = filtered.filter(r => r.mes === f.mes);
  const cur = agregarMes(delMes);

  // Serie mensual del debt para sparkline
  const porMes = {};
  for(const r of filtered){
    porMes[r.mes] = porMes[r.mes] || [];
    porMes[r.mes].push(r);
  }
  const serie = Object.keys(porMes).sort().map(m => ({mes: m, actuals: agregarMes(porMes[m]).debt}));
  const idxCorte = serie.findIndex(r => r.mes === f.mes);
  const last = idxCorte >= 0 ? serie[idxCorte] : null;
  const prev = idxCorte > 0 ? serie[idxCorte-1] : null;
  const delta = (last && prev && prev.actuals !== 0) ? (last.actuals - prev.actuals)/Math.abs(prev.actuals) : null;

  const mon = monedaMostrada(cur.paisLocal);
  const valorTxt = fmtMoneda(cur.debt, mon);
  const leverageTxt = (cur.lev != null && isFinite(cur.lev))
    ? `<b>${cur.lev.toFixed(2)}x</b> Adj EBITDA`
    : `<span class="vs">Leverage n/a</span>`;
  const cocTxt = (cur.coc != null && isFinite(cur.coc))
    ? `<b>${(cur.coc*100).toFixed(1)}%</b> cost of capital`
    : `<span class="vs">Cost of capital n/a</span>`;

  // Color: ▲ debt = peor (invertido)
  let perfCls = "perf-gray";
  if(delta != null){
    if(delta <= 0.05) perfCls = "perf-green";
    else if(delta <= 0.20) perfCls = "perf-amber";
    else perfCls = "perf-red";
  }
  const deltaTxt = delta != null
    ? `<span class="${delta > 0 ? 'down' : 'up'}">${delta > 0 ? '▲' : '▼'} ${Math.abs(delta*100).toFixed(1)}%</span> <span class="vs">vs prev. month</span>`
    : "";
  const color = SPARK_COLOR[data.estado] || SPARK_COLOR.ejemplo;

  return `<div class="card ${perfCls}" onclick="abrirDrill('${kpiDef.id}')">
    <div class="kpi-name"><span class="nm">${kpiDef.nombre}</span><span class="tag ${data.estado}">${TAG_LABEL[data.estado]}</span></div>
    <div class="val">${valorTxt}</div>
    <div class="ratio-line">${leverageTxt}</div>
    <div class="ratio-line">${cocTxt}</div>
    <div class="delta">${deltaTxt}</div>
    ${sparkSVG(serie, color)}
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

  // Capital = Inventory on books vs Budget. Para inventario, sobre-budget es
  // PEOR (capital inmovilizado en exceso); negamos diff antes del semaforo.
  let capSem = "gray", capTxt = "Inventory on books pending";
  if(STATE.kpis.inventario){
    const {actuals, budget} = montoMesActual(STATE.kpis.inventario);
    const diff = (actuals && budget) ? (actuals-budget)/Math.abs(budget) : null;
    capSem = semaforoDelta(diff != null ? -diff : null);
    capTxt = diff != null ? `Inventory ${(diff*100).toFixed(1)}% vs budget` : "Inventory has no budget for this period";
  }

  // Growth = GMV vs Budget. Mismo patron que Performance: arriba de budget es
  // bueno (mas volumen transado).
  let grSem = "gray", grTxt = "GMV pending";
  if(STATE.kpis.gmv){
    const {actuals, budget} = montoMesActual(STATE.kpis.gmv);
    const diff = (actuals && budget) ? (actuals-budget)/Math.abs(budget) : null;
    grSem = semaforoDelta(diff);
    grTxt = diff != null ? `GMV ${(diff*100).toFixed(1)}% vs budget` : "GMV has no budget for this period";
  }

  const areas = [
    { area: "Performance", sem: resSem, txt: resTxt },
    { area: "Capital",     sem: capSem, txt: capTxt },
    { area: "Growth",      sem: grSem,  txt: grTxt  },
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
  STATE.currentDrillKpi = kpiId;
  const f = STATE.filters;
  const elim = f.elim;

  // Filtrar facts segun filtros activos
  const filtered = filtrarFacts(data.facts, f);
  const delMes = filtered.filter(r => r.mes === f.mes);

  document.getElementById("drillEyebrow").textContent = "DRILL-DOWN";
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

  // Drill especial para Debt in Homes con Adj EBITDA leverage
  if(data.unidad === "MONEDA_DEBT_HOMES"){
    let html = "";
    const paises = f.pais === "Global" ? ["Colombia", "Mexico", "Offshore"] : [f.pais];
    let totRows = "";
    for(const p of paises){
      const row = delMes.find(r => r.pais === p);
      if(!row) continue;
      const mon = f.moneda === "USD" ? "USD" : monedaDePais(p);
      const debt = f.moneda === "USD" ? convertir(row.actuals[elim], p) : row.actuals[elim];
      const eb   = row.ebitda_ltm    != null ? (f.moneda === "USD" ? convertir(row.ebitda_ltm,    p) : row.ebitda_ltm)    : null;
      const cap  = row.capitalized_payroll_ltm!= null ? (f.moneda === "USD" ? convertir(row.capitalized_payroll_ltm,p) : row.capitalized_payroll_ltm): null;
      const adj  = row.adj_ebitda_ltm!= null ? (f.moneda === "USD" ? convertir(row.adj_ebitda_ltm,p) : row.adj_ebitda_ltm): null;
      const lev  = row.leverage;
      const intLtm  = row.net_interest_ltm != null ? (f.moneda === "USD" ? convertir(row.net_interest_ltm, p) : row.net_interest_ltm) : null;
      const avgDebt = row.debt_avg_ltm != null ? (f.moneda === "USD" ? convertir(row.debt_avg_ltm, p) : row.debt_avg_ltm) : null;
      const coc = row.cost_of_capital;
      totRows += `<tr>
        <td><b>${p}</b></td>
        <td class="num">${fmtMoneda(debt, mon)}</td>
        <td class="num">${eb  != null ? fmtMoneda(eb, mon)  : "—"}</td>
        <td class="num">${cap != null ? fmtMoneda(cap, mon) : "—"}</td>
        <td class="num"><b>${adj != null ? fmtMoneda(adj, mon) : "—"}</b></td>
        <td class="num">${(lev != null && isFinite(lev)) ? lev.toFixed(2)+"x" : "—"}</td>
        <td class="num">${intLtm  != null ? fmtMoneda(intLtm, mon)  : "—"}</td>
        <td class="num">${avgDebt != null ? fmtMoneda(avgDebt, mon) : "—"}</td>
        <td class="num"><b>${(coc != null && isFinite(coc)) ? (coc*100).toFixed(1)+"%" : "—"}</b></td>
      </tr>`;
    }
    html += `<div class="drill-block">
      <h3>Debt, leverage &amp; cost of capital · ${mesYYYYMM_a_label(f.mes)}</h3>
      <div class="drill-table-scroll">
      <table class="drill-table drill-table-compact">
        <thead><tr>
          <th>Country</th>
          <th style="text-align:right">Debt in Homes</th>
          <th style="text-align:right">EBITDA LTM</th>
          <th style="text-align:right">Cap. Payroll LTM</th>
          <th style="text-align:right">Adj EBITDA LTM</th>
          <th style="text-align:right">Leverage</th>
          <th style="text-align:right">Net Interest LTM</th>
          <th style="text-align:right">Avg Debt LTM</th>
          <th style="text-align:right">Cost of Capital</th>
        </tr></thead>
        <tbody>${totRows || `<tr><td colspan="9" class="drill-empty">No data.</td></tr>`}</tbody>
      </table>
      </div>
    </div>`;

    // Chart historico debt
    function agrDebt(facts){
      let d = 0;
      for(const r of facts){ d += convertir((r.actuals && r.actuals[elim]) || 0, r.pais) || 0; }
      return d;
    }
    const porMesSerie = {};
    for(const r of filtered){
      porMesSerie[r.mes] = porMesSerie[r.mes] || [];
      porMesSerie[r.mes].push(r);
    }
    const serieDebt = Object.keys(porMesSerie).sort().map(m => ({
      mes: m, actuals: agrDebt(porMesSerie[m]), budget: null,
    }));
    const monedaSerie = f.moneda === "USD" ? "USD" : (
      f.pais !== "Global" ? monedaDePais(f.pais) : "COP"
    );
    html += `<div class="drill-block chart-block">
      <h3>Monthly Debt in Homes</h3>
      ${lineChartSVG(serieDebt, monedaSerie, "MONEY", {actuals: "Debt", budget: ""})}
    </div>`;

    html += `<div class="drill-note">
      <b>How metrics are built</b>: Debt = BET drivers <code>m_metrica='05. Debt in Homes'</code>.<br>
      EBITDA LTM = sum of last 12 months EBITDA (BET Financials: Gross Profit + Other Costs + OpEx).<br>
      Cap. Payroll LTM = sum of last 12 months payroll capitalized as non-current asset (BET <code>m_categoria='05. Capitalized Payroll'</code>, sign inverted).<br>
      Adj EBITDA LTM = EBITDA LTM + Cap. Payroll LTM. <b>Leverage</b> = Debt ÷ Adj EBITDA LTM.<br>
      Net Interest LTM = sum of last 12 months of <code>m_categoria='06. Net financing costs'</code> (Interest Expense + Interest Income, sign inverted to positive cost). Avg Debt LTM = average of monthly debt balances over 12 months. <b>Cost of Capital</b> = |Net Interest LTM| ÷ Avg Debt LTM (annualized).<br>
      <b>Note</b>: Corporate Debt is empty in BET — this only covers home financing debt. Reported to the data owner as pending.
    </div>`;
    document.getElementById("drillBody").innerHTML = html;
    document.getElementById("drillModal").hidden = false;
    return;
  }

  // Drill especial para sell-through (PORCENTAJE_SELLTHROUGH)
  if(data.unidad === "PORCENTAJE_SELLTHROUGH"){
    let html = "";
    // Tabla por pais del mes corte
    let recoRows = "";
    const paises = f.pais === "Global" ? ["Colombia", "Mexico"] : [f.pais];
    for(const p of paises){
      const row = delMes.find(r => r.pais === p);
      if(!row) continue;
      const st = row.sell_through;
      recoRows += `<tr>
        <td><b>${p}</b></td>
        <td class="num">${row.nids_inv_inicio.toLocaleString()}</td>
        <td class="num">${row.nids_vendidos.toLocaleString()}</td>
        <td class="num">${st != null ? (st*100).toFixed(1)+"%" : "—"}</td>
      </tr>`;
    }
    html += `<div class="drill-block">
      <h3>Sell-through stats · ${mesYYYYMM_a_label(f.mes)}</h3>
      <table class="drill-table">
        <thead><tr>
          <th>Country</th>
          <th style="text-align:right">Inventory at start of month</th>
          <th style="text-align:right">Sold during month</th>
          <th style="text-align:right">Sell-through</th>
        </tr></thead>
        <tbody>${recoRows || `<tr><td colspan="4" class="drill-empty">No data.</td></tr>`}</tbody>
      </table>
    </div>`;

    // Chart historico mensual del sell-through ponderado
    function ratioMesSerie(facts){
      let sold = 0, inv = 0;
      for(const r of facts){ sold += r.nids_vendidos || 0; inv += r.nids_inv_inicio || 0; }
      return inv > 0 ? sold/inv : null;
    }
    const porMesSerie = {};
    for(const r of filtered){
      porMesSerie[r.mes] = porMesSerie[r.mes] || [];
      porMesSerie[r.mes].push(r);
    }
    const serieSt = Object.keys(porMesSerie).sort().map(m => ({
      mes: m, actuals: ratioMesSerie(porMesSerie[m]), budget: null,
    }));
    html += `<div class="drill-block chart-block">
      <h3>Monthly sell-through</h3>
      ${lineChartSVG(serieSt, "PCT", "PCT", {actuals: "Sell-through", budget: ""})}
    </div>`;

    // Detalle NIDs vendidos en mes corte
    if(data.detalle_nids && data.detalle_nids.por_mes && (data.detalle_nids.por_mes[f.mes] || []).length){
      let nids = data.detalle_nids.por_mes[f.mes].slice();
      if(f.pais !== "Global") nids = nids.filter(n => n.pais === f.pais);
      nids.sort((a,b) => b.dias_en_inv - a.dias_en_inv);
      let detRows = "";
      for(const n of nids){
        const mon = f.moneda === "USD" ? "USD" : monedaDePais(n.pais);
        const vp = f.moneda === "USD" ? convertir(n.v_precio, n.pais) : n.v_precio;
        const cp = n.c_precio != null ? (f.moneda === "USD" ? convertir(n.c_precio, n.pais) : n.c_precio) : null;
        const margen = (n.v_precio && n.c_precio) ? ((n.c_precio - n.v_precio) / n.c_precio) : null;
        detRows += `<tr>
          <td><code>${n.nid}</code></td>
          <td>${(n.nombre || "(sin nombre)").substring(0, 50)}</td>
          <td>${n.pais}</td>
          <td class="num">${n.v_fecha_escritura || "—"}</td>
          <td class="num">${n.c_fecha_escritura || "—"}</td>
          <td class="num">${n.dias_en_inv}d</td>
          <td class="num">${fmtMoneda(vp, mon)}</td>
          <td class="num">${cp != null ? fmtMoneda(cp, mon) : "—"}</td>
          <td class="num">${margen != null ? (margen*100).toFixed(1)+"%" : "—"}</td>
        </tr>`;
      }
      html += `<div class="drill-block">
        <h3>NIDs sold in ${mesYYYYMM_a_label(f.mes)}${f.pais !== "Global" ? " · " + f.pais : ""} <span class="vs">(${nids.length.toLocaleString()} NIDs, sorted by days in inventory desc)</span></h3>
        <div class="drill-table-scroll">
          <table class="drill-table drill-table-compact">
            <thead><tr>
              <th>NID</th>
              <th>Property</th>
              <th>Country</th>
              <th>v_fecha_escritura</th>
              <th>c_fecha_escritura</th>
              <th style="text-align:right">Days in inv.</th>
              <th style="text-align:right">v_precio (buy)</th>
              <th style="text-align:right">c_precio (sell)</th>
              <th style="text-align:right">Margin</th>
            </tr></thead>
            <tbody>${detRows || '<tr><td colspan="9" class="drill-empty">No NIDs for this filter.</td></tr>'}</tbody>
          </table>
        </div>
      </div>`;
    }

    html += `<div class="drill-note">
      <b>How sell-through is built</b>: For each month M, sell-through = NIDs with <code>c_fecha_escritura</code> in M ÷ NIDs alive at close of (M−1). Alive means <code>v_fecha_escritura</code> populated, no <code>c_fecha_escritura</code> yet, not desisted. NIDs in the detail table are those sold during the month, sorted by days they spent in inventory before selling.
    </div>`;
    document.getElementById("drillBody").innerHTML = html;
    document.getElementById("drillModal").hidden = false;
    return;
  }

  // Drill especial para ciclo de caja (DIAS_CICLO): salimos temprano para
  // evitar bloques genericos (By country en moneda, chart Actuals/Budget en MONEY)
  // que no aplican cuando la metrica son dias.
  if(data.unidad === "DIAS_CICLO"){
    let html = "";
    // Tabla por pais del mes corte (avg, p50, p90)
    let recoRows = "";
    const paises = f.pais === "Global" ? ["Colombia", "Mexico"] : [f.pais];
    for(const p of paises){
      const row = delMes.find(r => r.pais === p);
      if(!row) continue;
      recoRows += `<tr>
        <td><b>${p}</b></td>
        <td class="num">${row.nids.toLocaleString()}</td>
        <td class="num">${row.avg_dias != null ? Math.round(row.avg_dias) + "d" : "—"}</td>
        <td class="num">${row.p50_dias != null ? Math.round(row.p50_dias) + "d" : "—"}</td>
        <td class="num">${row.p90_dias != null ? Math.round(row.p90_dias) + "d" : "—"}</td>
      </tr>`;
    }
    html += `<div class="drill-block">
      <h3>Cycle stats · ${mesYYYYMM_a_label(f.mes)}</h3>
      <table class="drill-table">
        <thead><tr>
          <th>Country</th>
          <th style="text-align:right"># Cycles closed</th>
          <th style="text-align:right">Avg days</th>
          <th style="text-align:right">Median (p50)</th>
          <th style="text-align:right">p90 (tail)</th>
        </tr></thead>
        <tbody>${recoRows || `<tr><td colspan="5" class="drill-empty">No data.</td></tr>`}</tbody>
      </table>
    </div>`;

    // Chart historico mensual: dos lineas (avg y p50), ponderadas por nids cuando Global
    function agregarMesParaSerie(facts){
      let wAvg = 0, wP50 = 0, w = 0;
      for(const r of facts){
        const n = r.nids || 0;
        if(r.avg_dias != null) wAvg += r.avg_dias * n;
        if(r.p50_dias != null) wP50 += r.p50_dias * n;
        w += n;
      }
      return {avg: w > 0 ? wAvg/w : null, p50: w > 0 ? wP50/w : null};
    }
    const porMesSerie = {};
    for(const r of filtered){
      porMesSerie[r.mes] = porMesSerie[r.mes] || [];
      porMesSerie[r.mes].push(r);
    }
    const serieDias = Object.keys(porMesSerie).sort().map(m => {
      const a = agregarMesParaSerie(porMesSerie[m]);
      return {mes: m, actuals: a.p50, budget: a.avg};
    });
    html += `<div class="drill-block chart-block">
      <h3>Monthly cycle · Median vs Average</h3>
      <div class="chart-unit-label">days</div>
      ${lineChartSVG(serieDias, "DAYS", "DAYS", {actuals: "Median", budget: "Average"})}
    </div>`;

    // Detalle por NID
    if(data.detalle_nids && data.detalle_nids.por_mes && (data.detalle_nids.por_mes[f.mes] || []).length){
      let nids = data.detalle_nids.por_mes[f.mes].slice();
      if(f.pais !== "Global") nids = nids.filter(n => n.pais === f.pais);
      nids.sort((a,b) => b.dias_ciclo - a.dias_ciclo);
      let detRows = "";
      for(const n of nids){
        const mon = f.moneda === "USD" ? "USD" : monedaDePais(n.pais);
        const vp = f.moneda === "USD" ? convertir(n.v_precio, n.pais) : n.v_precio;
        const cp = n.c_precio != null ? (f.moneda === "USD" ? convertir(n.c_precio, n.pais) : n.c_precio) : null;
        const margen = (n.v_precio && n.c_precio) ? ((n.c_precio - n.v_precio) / n.c_precio) : null;
        detRows += `<tr>
          <td><code>${n.nid}</code></td>
          <td>${(n.nombre || "(sin nombre)").substring(0, 50)}</td>
          <td>${n.pais}</td>
          <td class="num">${n.v_fecha_escritura || "—"}</td>
          <td class="num">${n.c_fecha_desembolso || "—"}</td>
          <td class="num">${n.dias_ciclo}d</td>
          <td class="num">${fmtMoneda(vp, mon)}</td>
          <td class="num">${cp != null ? fmtMoneda(cp, mon) : "—"}</td>
          <td class="num">${margen != null ? (margen*100).toFixed(1)+"%" : "—"}</td>
        </tr>`;
      }
      html += `<div class="drill-block">
        <h3>NID detail · ${mesYYYYMM_a_label(f.mes)}${f.pais !== "Global" ? " · " + f.pais : ""} <span class="vs">(${nids.length.toLocaleString()} cycles closed, sorted by days desc)</span></h3>
        <div class="drill-table-scroll">
          <table class="drill-table drill-table-compact">
            <thead><tr>
              <th>NID</th>
              <th>Property</th>
              <th>Country</th>
              <th>v_fecha_escritura</th>
              <th>c_fecha_desembolso</th>
              <th style="text-align:right">Days</th>
              <th style="text-align:right">v_precio (buy)</th>
              <th style="text-align:right">c_precio (sell)</th>
              <th style="text-align:right">Margin</th>
            </tr></thead>
            <tbody>${detRows || '<tr><td colspan="9" class="drill-empty">No NIDs for this filter.</td></tr>'}</tbody>
          </table>
        </div>
      </div>`;
    }

    html += `<div class="drill-note">
      <b>How cycle is built</b>: For each NID with a complete cycle (both <code>v_fecha_escritura</code> and <code>c_fecha_desembolso</code> populated, not desisted), days = <code>c_fecha_desembolso</code> − <code>v_fecha_escritura</code>. Each NID is bucketed in the month of <code>c_fecha_desembolso</code> (cycle close). The card shows the median for the period and avg below; sparkline tracks median over time.
    </div>`;
    document.getElementById("drillBody").innerHTML = html;
    document.getElementById("drillModal").hidden = false;
    return;
  }

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
      // Barra de cumplimiento por fila: % actuals/budget, capped a 100% visualmente.
      // Color: mismo umbral que la card (perf-green/amber/red), respeta invertir_delta.
      let progressHTML = `<span class="dr-progress empty"></span>`;
      if(a != null && b != null && b !== 0){
        const pct = a / b;
        const cappedPct = Math.min(Math.max(pct, 0), 1) * 100;
        const cls = perfColor(diff, invertirKPI);
        progressHTML = `<span class="dr-progress">
          <span class="dr-progress-bar"><span class="dr-progress-fill ${cls}" style="width:${cappedPct.toFixed(1)}%"></span></span>
          <span class="dr-progress-lbl">${(pct*100).toFixed(0)}%</span>
        </span>`;
      }
      html += `<div class="drill-row">
        <span class="dr-k">${r.key}</span>
        <span class="dr-v">${fmtMoneda(a, mon)}</span>
        ${blockTieneRatio ? `<span class="dr-ratio">${ratioHTML}</span>` : ""}
        <span class="dr-bud">${b != null ? fmtMoneda(b, mon) : "—"}</span>
        ${progressHTML}
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
  // Si el KPI trae bucket (aging), tabla por bucket con # NIDs, %, valor compra y avg dias
  const tieneBucket = delMes.some(r => r.bucket != null);
  if(tieneBucket){
    const bucketsMeta = data.buckets_meta || [];
    const ordenBuckets = bucketsMeta.map(b => b.name);
    const totalNids = delMes.reduce((acc, r) => acc + ((r.actuals && r.actuals[elim]) || 0), 0);
    // Agrupa por bucket sumando NIDs y valor_compra y promediando avg_dias
    const porBucket = {};
    for(const r of delMes){
      const k = r.bucket;
      if(!porBucket[k]) porBucket[k] = {bucket: k, nids: 0, valor: 0, avg_dias_acc: 0, avg_dias_w: 0, pais: r.pais};
      const n = (r.actuals && r.actuals[elim]) || 0;
      porBucket[k].nids += n;
      porBucket[k].valor += r.valor_compra || 0;
      if(r.avg_dias != null){
        porBucket[k].avg_dias_acc += r.avg_dias * n;
        porBucket[k].avg_dias_w   += n;
      }
    }
    const rowsBucket = ordenBuckets
      .map(b => porBucket[b])
      .filter(Boolean);
    let bRows = "";
    for(const r of rowsBucket){
      const pct = totalNids > 0 ? r.nids/totalNids : 0;
      const avg = r.avg_dias_w > 0 ? r.avg_dias_acc/r.avg_dias_w : null;
      const meta = bucketsMeta.find(m => m.name === r.bucket);
      const over = meta && meta.over;
      const cls = over ? "perf-amber" : "";
      const mon = f.moneda === "USD" ? "USD" : monedaDePais(r.pais || (f.pais !== "Global" ? f.pais : "Colombia"));
      const valorDisp = f.moneda === "USD" ? convertir(r.valor, r.pais) : r.valor;
      bRows += `<tr class="${cls}">
        <td><b>${r.bucket}d</b>${over ? ' <span class="vs">over threshold</span>' : ''}</td>
        <td class="num">${Math.round(r.nids).toLocaleString()}</td>
        <td class="num">${(pct*100).toFixed(1)}%</td>
        <td class="num">${fmtMoneda(valorDisp, mon)}</td>
        <td class="num">${avg != null ? Math.round(avg) + "d" : "—"}</td>
      </tr>`;
    }
    html += `<div class="drill-block">
      <h3>By aging bucket${f.pais !== "Global" ? " · " + f.pais : ""}</h3>
      <table class="drill-table">
        <thead><tr>
          <th>Bucket</th>
          <th style="text-align:right"># NIDs</th>
          <th style="text-align:right">% of total</th>
          <th style="text-align:right">Σ v_precio</th>
          <th style="text-align:right">Avg days</th>
        </tr></thead>
        <tbody>${bRows || `<tr><td colspan="5" class="drill-empty">No data.</td></tr>`}</tbody>
      </table>
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
    // Serie de Adj EBITDA por mes (solo KPI con cap_payroll_serie). El numerador
    // del ratio % cambia a Adj EBITDA cuando ratio_numerator==='adj_ebitda'.
    const capMap = data.cap_payroll_serie ? serieCapPayroll(data.cap_payroll_serie, f) : null;
    const usaAdj = data.ratio_numerator === "adj_ebitda" && capMap;
    const serieAdj = capMap ? serieMensual.map(s => {
      const c = capMap.get(s.mes) || {actuals: 0, budget: 0};
      return {mes: s.mes, actuals: s.actuals + c.actuals, budget: s.budget + c.budget};
    }) : null;
    const seriePct = serieMensual.map((s, i) => {
      const rev = revPorMes.get(s.mes) || {revenue_a:0, revenue_b:0};
      const sA = (usaAdj && serieAdj) ? serieAdj[i] : s;
      return {
        mes: s.mes,
        actuals: rev.revenue_a !== 0 ? sA.actuals / rev.revenue_a : null,
        budget:  rev.revenue_b !== 0 ? sA.budget  / rev.revenue_b : null,
      };
    });
    const chartExtra = serieAdj ? {serie: serieAdj, label: "Adj EBITDA", color: "#2D6FD4"} : undefined;
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
        ${lineChartSVG(serieMensual, monedaSerie, "MONEY", undefined, chartExtra)}
      </div>
      <div class="chart-pane" data-pane="pct">
        <div class="chart-unit-label">% of ${data.ratio_against === "ingresos_ajustados" ? "Adj. Revenue" : "Revenue"}</div>
        ${lineChartSVG(seriePct, "PCT", "PCT")}
      </div>
    </div>`;
  } else if(data.unidad === "PORCENTAJE_AGING"){
    // Chart mensual: barras apiladas por bucket. NIDs por bucket.
    const ordenBuckets = (data.buckets_meta || []).map(b => b.name);
    const colorBucket = Object.fromEntries(
      (data.buckets_meta || []).map(b => [b.name, b.color || "#9CA3AF"])
    );
    const porMes = new Map();
    for(const r of filtered){
      const ex = porMes.get(r.mes) || {mes: r.mes, segs: {}};
      const n = (r.actuals && r.actuals[elim]) || 0;
      ex.segs[r.bucket] = (ex.segs[r.bucket] || 0) + n;
      porMes.set(r.mes, ex);
    }
    const seriePorMes = [...porMes.values()]
      .sort((a,b) => a.mes.localeCompare(b.mes))
      .map(r => ({
        mes: r.mes,
        segmentos: ordenBuckets.map(b => ({key: b, value: r.segs[b] || 0, color: colorBucket[b]})),
      }));
    html += `<div class="drill-block chart-block">
      <h3>Monthly NIDs by aging bucket${f.pais !== "Global" ? " · " + f.pais : ""}</h3>
      ${stackedBarChartSVG(seriePorMes, ordenBuckets, colorBucket)}
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

    // Tabla detalle por NID (mismo set que aging, sin dias/bucket)
    if(data.detalle_nids && data.detalle_nids.por_mes && (data.detalle_nids.por_mes[f.mes] || []).length){
      let nids = data.detalle_nids.por_mes[f.mes].slice();
      if(f.pais !== "Global") nids = nids.filter(n => n.pais === f.pais);
      // Sort por v_precio desc (mas grande primero)
      nids.sort((a,b) => (b.v_precio || 0) - (a.v_precio || 0));
      let detRows = "";
      for(const n of nids){
        const mon = f.moneda === "USD" ? "USD" : monedaDePais(n.pais);
        const vp = f.moneda === "USD" ? convertir(n.v_precio, n.pais) : n.v_precio;
        const cp = n.c_precio != null ? (f.moneda === "USD" ? convertir(n.c_precio, n.pais) : n.c_precio) : null;
        const margen = (n.v_precio && n.c_precio) ? ((n.c_precio - n.v_precio) / n.c_precio) : null;
        detRows += `<tr>
          <td><code>${n.nid}</code></td>
          <td>${(n.nombre || "(sin nombre)").substring(0, 50)}</td>
          <td>${n.pais}</td>
          <td class="num">${n.v_fecha_escritura || "—"}</td>
          <td class="num">${fmtMoneda(vp, mon)}</td>
          <td class="num">${cp != null ? fmtMoneda(cp, mon) : "—"}</td>
          <td class="num">${margen != null ? (margen*100).toFixed(1)+"%" : "—"}</td>
          <td>${n.estatus || "—"}</td>
        </tr>`;
      }
      html += `<div class="drill-block">
        <h3>NID detail · ${mesYYYYMM_a_label(f.mes)}${f.pais !== "Global" ? " · " + f.pais : ""} <span class="vs">(${nids.length.toLocaleString()} NIDs, sorted by v_precio desc)</span></h3>
        <div class="drill-table-scroll">
          <table class="drill-table drill-table-compact">
            <thead><tr>
              <th>NID</th>
              <th>Property</th>
              <th>Country</th>
              <th>v_fecha_escritura</th>
              <th style="text-align:right">v_precio (buy)</th>
              <th style="text-align:right">c_precio (sell target)</th>
              <th style="text-align:right">Est. margin</th>
              <th>Status</th>
            </tr></thead>
            <tbody>${detRows || '<tr><td colspan="8" class="drill-empty">No NIDs for this filter.</td></tr>'}</tbody>
          </table>
        </div>
      </div>`;
    }
  }

  // Top 20 detalle no aplica para aging (sin cuenta contable)
  if(data.unidad === "PORCENTAJE_AGING"){
    // Tabla de detalle por NID al cierre del mes_corte. Solo si el mes filtrado
    // coincide con el mes del snapshot (el detalle es solo del ultimo cierre).
    if(data.detalle_nids && data.detalle_nids.por_mes && (data.detalle_nids.por_mes[f.mes] || []).length){
      const ordenBuckets = (data.buckets_meta || []).map(b => b.name);
      const colorBucket = Object.fromEntries(
        (data.buckets_meta || []).map(b => [b.name, b.color || "#9CA3AF"])
      );
      let nids = data.detalle_nids.por_mes[f.mes].slice();
      // Filtros activos: pais
      if(f.pais !== "Global") nids = nids.filter(n => n.pais === f.pais);
      // Sort por dias desc
      nids.sort((a,b) => b.dias_en_inv - a.dias_en_inv);

      let detRows = "";
      for(const n of nids){
        const mon = f.moneda === "USD" ? "USD" : monedaDePais(n.pais);
        const vp = f.moneda === "USD" ? convertir(n.v_precio, n.pais) : n.v_precio;
        const cp = n.c_precio != null ? (f.moneda === "USD" ? convertir(n.c_precio, n.pais) : n.c_precio) : null;
        const margen = (n.v_precio && n.c_precio) ? ((n.c_precio - n.v_precio) / n.c_precio) : null;
        detRows += `<tr data-bucket="${n.bucket}">
          <td><code>${n.nid}</code></td>
          <td>${(n.nombre || "(sin nombre)").substring(0, 50)}</td>
          <td>${n.pais}</td>
          <td class="num">${n.v_fecha_escritura || "—"}</td>
          <td class="num">${n.dias_en_inv}d</td>
          <td><span class="bucket-chip" style="background:${colorBucket[n.bucket]}">${n.bucket}d</span></td>
          <td class="num">${fmtMoneda(vp, mon)}</td>
          <td class="num">${cp != null ? fmtMoneda(cp, mon) : "—"}</td>
          <td class="num">${margen != null ? (margen*100).toFixed(1)+"%" : "—"}</td>
          <td>${n.estatus || "—"}</td>
        </tr>`;
      }
      // Conteo por bucket para los chips del filtro
      const conteoPorBucket = {};
      for(const n of nids){ conteoPorBucket[n.bucket] = (conteoPorBucket[n.bucket] || 0) + 1; }
      const filterBtns = ordenBuckets.map(b => {
        const cnt = conteoPorBucket[b] || 0;
        return `<button class="bucket-filter-btn" data-bucket="${b}" onclick="filterAgingBucket(this,'${b}')" style="border-color:${colorBucket[b]}">${b}d <span class="vs">(${cnt})</span></button>`;
      }).join("");
      html += `<div class="drill-block">
        <h3>NID detail · ${mesYYYYMM_a_label(f.mes)}${f.pais !== "Global" ? " · " + f.pais : ""} <span class="vs">(${nids.length.toLocaleString()} NIDs, sorted oldest first)</span></h3>
        <div class="bucket-filter">
          <span class="bucket-filter-label">Show only:</span>
          <button class="bucket-filter-btn on" data-bucket="all" onclick="filterAgingBucket(this,'all')">All</button>
          ${filterBtns}
          <span class="bucket-filter-count" id="agingDetailCount">${nids.length.toLocaleString()} of ${nids.length.toLocaleString()}</span>
        </div>
        <div class="drill-table-scroll" id="agingDetailScroll">
          <table class="drill-table drill-table-compact" id="agingDetailTable">
            <thead><tr>
              <th>NID</th>
              <th>Property</th>
              <th>Country</th>
              <th>v_fecha_escritura</th>
              <th style="text-align:right">Days</th>
              <th>Bucket</th>
              <th style="text-align:right">v_precio (buy)</th>
              <th style="text-align:right">c_precio (sell target)</th>
              <th style="text-align:right">Est. margin</th>
              <th>Status</th>
            </tr></thead>
            <tbody>${detRows || '<tr><td colspan="10" class="drill-empty">No NIDs for this filter.</td></tr>'}</tbody>
          </table>
        </div>
      </div>`;
    }

    html += `<div class="drill-note">
      <b>How aging is built</b>: For each month M, NIDs alive at close of M (same filter as Inventory on books) and days = LAST_DAY(M) − <code>v_fecha_escritura</code>. The card shows the percentage of NIDs above the <b>${data.umbral_dias}-day</b> threshold. Stacked bars show count per bucket month over month.
    </div>`;
    document.getElementById("drillBody").innerHTML = html;
    document.getElementById("drillModal").hidden = false;
    return;
  }

  // Bloque resumido por metrica/submetrica si el KPI define summary_field.
  // Si no, fallback al Top 20 cuentas tradicional.
  if(data.summary_field){
    const porSummary = agrupar(delMes, r => r[data.summary_field] || "(unassigned)", elim);
    html += `<div class="drill-block">
      <h3>${data.summary_label || "Summary"}${filtrosTxt && filtrosTxt !== "Global · todas" ? " · " + filtrosTxt : ""}</h3>
      ${pintarLista(porSummary)}
    </div>`;
  } else {
    // Top 20 detalle tradicional — respeta TODOS los filtros activos.
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
  }
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

function cerrarDrill(){
  document.getElementById("drillModal").hidden = true;
  STATE.currentDrillKpi = null;
}

/* ===================================================== MTD · TRANSACTIONS = */
/* Fase 1: tab MTD con cards de transacciones del mes en curso (MTD) y
 * forecast de cierre comparando contra (a) curva del mes anterior y (b)
 * curva del mismo mes anyo anterior.
 *
 * Data shape (kpi_mtd_transactions.json):
 *   streams: [{
 *     id, nombre, granularidad, gmv_tipo_precio,
 *     por_pais: { Colombia: {moneda, mes_actual, mes_anterior, mes_yoy} }
 *   }]
 * Cada ventana (mes_actual/anterior/yoy):
 *   {mes, dias_en_mes, nids_total, gmv_total, [nids_budget, gmv_budget], curva}
 * curva: [{dia, nids, gmv, nids_cum, gmv_cum}, ...]   (solo dias con dato)
 *
 * Forecast: MTD × (ref_total / ref_cum_al_dia_D), con D = hoy_dia_del_mes.
 */

/* Convierte una curva sparse (solo dias con dato) a un array denso de
 * dias_en_mes elementos con nids_cum/gmv_cum interpolando por carry-forward.
 * Dia sin dato → mismos cum que el dia anterior. */
function densificarCurva(curva, dias_en_mes){
  const out = [];
  let lastN = 0, lastG = 0;
  let idx = 0;
  for(let d = 1; d <= dias_en_mes; d++){
    while(idx < curva.length && curva[idx].dia < d) idx++;
    if(idx < curva.length && curva[idx].dia === d){
      lastN = curva[idx].nids_cum;
      lastG = curva[idx].gmv_cum;
      idx++;
    }
    out.push({dia: d, nids_cum: lastN, gmv_cum: lastG});
  }
  return out;
}

/* Lookup del valor acumulado en el dia D usando la curva. Si D > ultimo dia
 * con dato, devuelve el ultimo valor acumulado (= total del mes asumido). */
function acumuladoAlDia(curva, dia, field){
  let last = 0;
  for(const p of curva){
    if(p.dia <= dia) last = p[field];
    else break;
  }
  return last;
}

/* Agrega los datos de un stream segun el filtro de pais activo. Si el
 * filtro es Global, suma Colombia + Mexico (NIDs validos; GMV se convierte
 * a la moneda mostrada). Si es un pais especifico, retorna ese. */
function agregarStream(stream){
  const f = STATE.filters;
  const paisesAUsar = f.pais === "Global" ? ["Colombia", "Mexico"] : [f.pais];
  // Acumuladores por ventana
  function ventanaVacia(){ return {nids_total: 0, gmv_total: 0, nids_budget: 0, gmv_budget: 0, curva: [], dias_en_mes: 0, mes: ""}; }
  const out = {
    mes_actual: ventanaVacia(),
    mes_anterior: ventanaVacia(),
    mes_yoy: ventanaVacia(),
    moneda: f.moneda === "USD" ? "USD" : (f.pais === "Global" ? "COP" : monedaDePais(f.pais)),
    paisLocal: paisesAUsar.length === 1 ? paisesAUsar[0] : null,
  };
  for(const ventana of ["mes_actual", "mes_anterior", "mes_yoy"]){
    let curvasParaSumar = [];  // [{moneda, curva_densa}]
    let dias_en_mes = 0;
    let mes_str = "";
    for(const pais of paisesAUsar){
      const d = stream.por_pais[pais];
      if(!d) continue;
      const w = d[ventana];
      if(!w) continue;
      dias_en_mes = Math.max(dias_en_mes, w.dias_en_mes);
      mes_str = w.mes;
      out[ventana].nids_total  += w.nids_total || 0;
      out[ventana].gmv_total   += convertir(w.gmv_total || 0, pais) || 0;
      if(ventana === "mes_actual"){
        out[ventana].nids_budget += w.nids_budget || 0;
        out[ventana].gmv_budget  += convertir(w.gmv_budget || 0, pais) || 0;
      }
      curvasParaSumar.push({pais, curva: densificarCurva(w.curva, w.dias_en_mes)});
    }
    // Suma las curvas (NIDs directo; GMV con FX por pais)
    const curvaSumada = [];
    for(let i = 0; i < dias_en_mes; i++){
      let n = 0, g = 0;
      for(const c of curvasParaSumar){
        if(c.curva[i]){
          n += c.curva[i].nids_cum || 0;
          g += convertir(c.curva[i].gmv_cum || 0, c.pais) || 0;
        }
      }
      curvaSumada.push({dia: i + 1, nids_cum: n, gmv_cum: g});
    }
    out[ventana].curva = curvaSumada;
    out[ventana].dias_en_mes = dias_en_mes;
    out[ventana].mes = mes_str;
  }
  return out;
}

/* Calcula forecast {nids, gmv} usando una ventana de referencia. */
function forecastDesde(agregado, refKey){
  const ma = agregado.mes_actual;
  const ref = agregado[refKey];
  if(!ref || !ref.curva.length) return null;
  const D = STATE.mtd.hoy_dia_del_mes;
  const refNidsAlD = acumuladoAlDia(ref.curva, D, "nids_cum");
  const refGmvAlD  = acumuladoAlDia(ref.curva, D, "gmv_cum");
  if(refNidsAlD <= 0 || ma.nids_total <= 0) return null;
  const factorN = ref.nids_total / refNidsAlD;
  const factorG = refGmvAlD > 0 ? ref.gmv_total / refGmvAlD : factorN;
  return {
    nids: ma.nids_total * factorN,
    gmv:  ma.gmv_total  * factorG,
    factor_nids: factorN,
    ref_mes: ref.mes,
  };
}

/* Color de performance del card MTD: forecast_nids vs budget_nids.
 * Para Sale/Purchase Deeds asumimos "mas = mejor" (sobre-cumplir budget). */
function perfMTD(fcast_nids, budget_nids){
  if(!fcast_nids || !budget_nids) return "perf-gray";
  const pct = fcast_nids / budget_nids;
  if(pct >= 0.95) return "perf-green";
  if(pct >= 0.80) return "perf-amber";
  return "perf-red";
}

function renderMTDCard(stream){
  // Bifurcar por tipo: 'ratio' (Gross Margin) tiene shape distinto.
  if(stream.tipo === "ratio") return renderMTDCardRatio(stream);
  return renderMTDCardCount(stream);
}

function renderMTDCardCount(stream){
  const agg = agregarStream(stream);
  const ma = agg.mes_actual;
  const fcPrev = forecastDesde(agg, "mes_anterior");
  const fcYoy  = forecastDesde(agg, "mes_yoy");

  // Promedio de los 2 estimados (si ambos existen) para el color/progress
  const fcastNidsAvg = (fcPrev && fcYoy) ? (fcPrev.nids + fcYoy.nids) / 2
                     : (fcPrev ? fcPrev.nids : (fcYoy ? fcYoy.nids : null));
  const cls = perfMTD(fcastNidsAvg, ma.nids_budget);

  const mon = agg.moneda;
  const dia = STATE.mtd.hoy_dia_del_mes;
  const diasMes = STATE.mtd.days_in_month_actual;

  function pctOfBudget(v){
    if(!ma.nids_budget) return "";
    return `<span class="vs">${Math.round((v/ma.nids_budget)*100)}% of budget</span>`;
  }

  const fcPrevHTML = fcPrev
    ? `<div class="mtd-forecast"><span class="lbl">Forecast (vs ${fcPrev.ref_mes}):</span> <b>${Math.round(fcPrev.nids).toLocaleString()} NIDs</b> · ${fmtMoneda(fcPrev.gmv, mon, {compact: true})} ${pctOfBudget(fcPrev.nids)}</div>`
    : "";
  const fcYoyHTML = fcYoy
    ? `<div class="mtd-forecast"><span class="lbl">Forecast (vs ${fcYoy.ref_mes} · YoY):</span> <b>${Math.round(fcYoy.nids).toLocaleString()} NIDs</b> · ${fmtMoneda(fcYoy.gmv, mon, {compact: true})} ${pctOfBudget(fcYoy.nids)}</div>`
    : "";

  // Progress bar: avg forecast vs budget (capped a 100% visualmente)
  let progressHTML = "";
  if(fcastNidsAvg && ma.nids_budget){
    const pct = fcastNidsAvg / ma.nids_budget;
    const capped = Math.min(Math.max(pct, 0), 1) * 100;
    progressHTML = `<div class="progress-wrap">
      <div class="progress-bar"><div class="progress-fill ${cls}" style="width:${capped.toFixed(1)}%"></div></div>
      <div class="progress-label">${(pct*100).toFixed(0)}% of budget (forecast avg)</div>
    </div>`;
  }

  // Sparkline: curva acumulada de NIDs del mes actual
  const sparkSerie = ma.curva.slice(0, dia).map(p => ({mes: String(p.dia), actuals: p.nids_cum}));
  const color = "#6B2FD4";
  // sparkSVG es generico — recorta por STATE.filters.mes que aqui no aplica.
  // Para evitar el recorte, llamamos directo a una mini-version inline.
  const spark = miniSparkSVG(sparkSerie, color);

  const budgetTxt = ma.nids_budget
    ? `Budget: <b>${Math.round(ma.nids_budget).toLocaleString()} NIDs</b> · ${fmtMoneda(ma.gmv_budget, mon, {compact: true})}`
    : "Budget: —";

  const gmvSub = stream.gmv_tipo_precio ? ` <span class="vs">${stream.gmv_tipo_precio}</span>` : "";
  return `<div class="card mtd-card ${cls}" onclick="abrirDrillMTD('${stream.id}')">
    <div class="kpi-name"><span class="nm">${stream.nombre}</span><span class="tag real">MTD</span></div>
    <div class="val">${Math.round(ma.nids_total).toLocaleString()} <span class="mtd-unit">NIDs</span></div>
    <div class="adj-line">${fmtMoneda(ma.gmv_total, mon, {compact: true})}${gmvSub}</div>
    ${fcPrevHTML}
    ${fcYoyHTML}
    <div class="budget-line">${budgetTxt}</div>
    ${progressHTML}
    <div class="delta"><span class="vs">Day ${dia} of ${diasMes}</span></div>
    ${spark}
    <div class="src">◷ ${STATE.mtd.fuente || ""}</div>
    <div class="card-cta">Click for drill-down →</div>
  </div>`;
}

/* Agrega un stream ratio (Gross Margin) sobre paises seleccionados.
 * Revenue y Cost se convierten a la moneda display; el margen se recalcula
 * sobre los totales sumados (NO promedio de porcentajes por pais). */
function agregarStreamRatio(stream){
  const f = STATE.filters;
  const paisesAUsar = f.pais === "Global" ? ["Colombia", "Mexico"] : [f.pais];
  function ventanaVacia(){
    return {revenue_total:0, cost_total:0, gp_total:0, nids_total:0, margen_pct:null, curva:[], dias_en_mes:0, mes:""};
  }
  const out = {
    mes_actual: ventanaVacia(), mes_anterior: ventanaVacia(), mes_yoy: ventanaVacia(),
    moneda: f.moneda === "USD" ? "USD" : (f.pais === "Global" ? "COP" : monedaDePais(f.pais)),
    paisLocal: paisesAUsar.length === 1 ? paisesAUsar[0] : null,
  };
  for(const ventana of ["mes_actual","mes_anterior","mes_yoy"]){
    let dias_en_mes = 0, mes_str = "";
    // Sumar totales convertidos por pais
    for(const pais of paisesAUsar){
      const d = stream.por_pais[pais];
      if(!d) continue;
      const w = d[ventana];
      if(!w) continue;
      dias_en_mes = Math.max(dias_en_mes, w.dias_en_mes);
      mes_str = w.mes;
      out[ventana].revenue_total += convertir(w.revenue_total || 0, pais) || 0;
      out[ventana].cost_total    += convertir(w.cost_total    || 0, pais) || 0;
      out[ventana].nids_total    += w.nids_total || 0;
    }
    // Recalcular GP y margen sobre totales sumados
    out[ventana].gp_total   = out[ventana].revenue_total - out[ventana].cost_total;
    out[ventana].margen_pct = out[ventana].revenue_total > 0
      ? (out[ventana].gp_total / out[ventana].revenue_total * 100) : null;
    out[ventana].dias_en_mes = dias_en_mes;
    out[ventana].mes = mes_str;
    // Curva sumada dia a dia: acumular revenue+cost por dia, luego derivar margen
    const curvaSumada = [];
    for(let i = 0; i < dias_en_mes; i++){
      let rev_cum = 0, cost_cum = 0, nids_cum = 0;
      for(const pais of paisesAUsar){
        const d = stream.por_pais[pais];
        if(!d || !d[ventana]) continue;
        const curvaDensa = densificarCurvaMargen(d[ventana].curva, d[ventana].dias_en_mes);
        if(curvaDensa[i]){
          rev_cum  += convertir(curvaDensa[i].revenue_cum || 0, pais) || 0;
          cost_cum += convertir(curvaDensa[i].cost_cum    || 0, pais) || 0;
          nids_cum += curvaDensa[i].nids_cum || 0;
        }
      }
      const gp_cum = rev_cum - cost_cum;
      curvaSumada.push({
        dia: i + 1,
        revenue_cum: rev_cum,
        cost_cum: cost_cum,
        gp_cum: gp_cum,
        nids_cum: nids_cum,
        margen_cum_pct: rev_cum > 0 ? (gp_cum / rev_cum * 100) : null,
      });
    }
    out[ventana].curva = curvaSumada;
  }
  return out;
}

/* Densifica una curva de margen (rellena dias sin dato con el ultimo cum). */
function densificarCurvaMargen(curva, diasEnMes){
  const dense = [];
  let last = {revenue_cum:0, cost_cum:0, nids_cum:0};
  const pormap = {};
  for(const p of curva) pormap[p.dia] = p;
  for(let d = 1; d <= diasEnMes; d++){
    if(pormap[d]){
      last = {revenue_cum: pormap[d].revenue_cum, cost_cum: pormap[d].cost_cum, nids_cum: pormap[d].nids_cum};
    }
    dense.push({dia: d, ...last});
  }
  return dense;
}

/* Color de performance para Gross Margin: margen actual vs referencia mes anterior.
 * Simple: verde si iguala o supera, ambar si -2pp, rojo si peor. */
function perfMTDMargin(margenActual, margenRef){
  if(margenActual == null || margenRef == null) return "perf-gray";
  const delta = margenActual - margenRef;
  if(delta >= 0) return "perf-green";
  if(delta >= -2) return "perf-amber";
  return "perf-red";
}

function renderMTDCardRatio(stream){
  const agg = agregarStreamRatio(stream);
  const ma = agg.mes_actual, mp = agg.mes_anterior, my = agg.mes_yoy;
  const dia = STATE.mtd.hoy_dia_del_mes;
  const diasMes = STATE.mtd.days_in_month_actual;
  const mon = agg.moneda;
  const cls = perfMTDMargin(ma.margen_pct, mp.margen_pct);
  const margenTxt = ma.margen_pct != null ? `${ma.margen_pct.toFixed(1)}%` : "—";
  const gpTxt = fmtMoneda(ma.gp_total, mon, {compact: true});
  const revTxt = fmtMoneda(ma.revenue_total, mon, {compact: true});

  function pp(v){ return v == null ? "—" : `${v.toFixed(1)}%`; }
  function deltaPP(a, b){
    if(a == null || b == null) return "";
    const d = a - b;
    const sign = d >= 0 ? "+" : "";
    const cls = d >= 0 ? "up" : "down";
    return ` <span class="${cls}">(${sign}${d.toFixed(1)}pp)</span>`;
  }

  // Sparkline con la curva del margen acumulado (%)
  const sparkSerie = ma.curva.slice(0, dia)
    .map(p => ({mes: String(p.dia), actuals: p.margen_cum_pct}))
    .filter(p => p.actuals != null);
  const spark = miniSparkSVG(sparkSerie, "#6B2FD4");

  return `<div class="card mtd-card ${cls}" onclick="abrirDrillMTD('${stream.id}')">
    <div class="kpi-name"><span class="nm">${stream.nombre}</span><span class="tag real">MTD %</span></div>
    <div class="val">${margenTxt}</div>
    <div class="adj-line">GP <b>${gpTxt}</b> / Rev ${revTxt} · ${Math.round(ma.nids_total).toLocaleString()} NIDs</div>
    <div class="mtd-forecast"><span class="lbl">Prev month (${mp.mes}):</span> <b>${pp(mp.margen_pct)}</b>${deltaPP(ma.margen_pct, mp.margen_pct)}</div>
    <div class="mtd-forecast"><span class="lbl">YoY (${my.mes}):</span> <b>${pp(my.margen_pct)}</b>${deltaPP(ma.margen_pct, my.margen_pct)}</div>
    <div class="delta"><span class="vs">Day ${dia} of ${diasMes} · proxy tape (revenue = c_precio, cost = v_precio)</span></div>
    ${spark}
    <div class="src">◷ ${STATE.mtd.fuente || ""}</div>
    <div class="card-cta">Click for drill-down →</div>
  </div>`;
}

/* Sparkline minimo sin el recorte de ventana (la curva MTD es por dia, no
 * por mes; no le aplica STATE.filters.mes). */
function miniSparkSVG(serie, color){
  const pts = serie.filter(p => p.actuals != null && !isNaN(p.actuals)).map(p => p.actuals);
  if(pts.length < 2) return "";
  const w=260, h=36, pad=3;
  const mn = Math.min(...pts), mx = Math.max(...pts), rng = (mx-mn) || 1;
  const xy = pts.map((v,i) => [
    pad + i*(w-2*pad)/(pts.length-1),
    h - pad - ((v-mn)/rng)*(h-2*pad),
  ]);
  const d = xy.map((p,i) => (i?"L":"M") + p[0].toFixed(1) + " " + p[1].toFixed(1)).join(" ");
  const last = xy[xy.length-1];
  const gid = "g" + Math.random().toString(36).slice(2,8);
  return `<svg class="spark" viewBox="0 0 ${w} ${h}" preserveAspectRatio="none">
    <defs><linearGradient id="${gid}" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0%" stop-color="${color}" stop-opacity=".18"/>
      <stop offset="100%" stop-color="${color}" stop-opacity="0"/></linearGradient></defs>
    <path d="${d} L ${last[0].toFixed(1)} ${h} L ${xy[0][0].toFixed(1)} ${h} Z" fill="url(#${gid})"/>
    <path d="${d}" fill="none" stroke="${color}" stroke-width="1.8" stroke-linejoin="round" stroke-linecap="round"/>
    <circle cx="${last[0].toFixed(1)}" cy="${last[1].toFixed(1)}" r="2.6" fill="${color}"/>
  </svg>`;
}

function renderMTD(){
  const grid = document.getElementById("gridMTD");
  if(!grid) return;
  if(!STATE.mtd || !STATE.mtd.streams){
    grid.innerHTML = `<div class="card pendiente"><div class="kpi-name"><span class="nm">MTD data unavailable</span></div></div>`;
    return;
  }
  // Filtrar por sub-tab activo (linea_negocio). Default: Market Maker.
  const subtab = STATE.mtdSubtab || "Market Maker";
  const streams = STATE.mtd.streams.filter(s => s.linea_negocio === subtab);
  if(streams.length === 0){
    // Placeholder para lineas sin data aun (BR Used, BR New, HC — Fase 2)
    grid.innerHTML = `<div class="card pendiente"><div class="kpi-name"><span class="nm">${subtab} · Fase 2 pendiente</span></div><div class="val">—</div><div class="adj-line">Data streams a incluir cuando lleguen del builder.</div></div>`;
  } else {
    grid.innerHTML = streams.map(renderMTDCard).join("");
  }
  const ctx = `${STATE.filters.pais}${STATE.filters.moneda === "USD" ? " · USD" : " · Local"} · ${STATE.mtd.mes_actual} · day ${STATE.mtd.hoy_dia_del_mes} of ${STATE.mtd.days_in_month_actual}`;
  document.getElementById("ctxMTD").textContent = ctx;
}

/* Drill: chart con 3 curvas acumuladas (NIDs o GMV toggle) y tabla
 * comparativa. */
function abrirDrillMTD(streamId){
  const stream = STATE.mtd.streams.find(s => s.id === streamId);
  if(!stream) return;
  STATE.currentDrillKpi = "__mtd__" + streamId;  // marker para no chocar con KPIs
  const agg = agregarStream(stream);
  const ma = agg.mes_actual;
  const fcPrev = forecastDesde(agg, "mes_anterior");
  const fcYoy  = forecastDesde(agg, "mes_yoy");
  const mon = agg.moneda;
  const dia = STATE.mtd.hoy_dia_del_mes;
  const diasMes = STATE.mtd.days_in_month_actual;

  document.getElementById("drillEyebrow").textContent = "MTD · FORECAST";
  document.getElementById("drillTitle").textContent = stream.nombre;
  const monedaTxt = STATE.filters.moneda === "USD" ? "USD" : "local currency";
  const filtroPais = STATE.filters.pais === "Global" ? "Colombia + Mexico" : STATE.filters.pais;
  document.getElementById("drillSub").innerHTML =
    `Period: <b>${ma.mes}</b> · Day <b>${dia}/${diasMes}</b> · View: <b>${filtroPais}</b> · Currency: <b>${monedaTxt}</b>`;

  // Tabla resumen
  function row(label, nids, gmv, pctNids){
    const nidsTxt = nids != null ? Math.round(nids).toLocaleString() : "—";
    const gmvTxt  = gmv  != null ? fmtMoneda(gmv, mon, {compact: true}) : "—";
    const pctTxt  = pctNids != null ? `${(pctNids*100).toFixed(0)}%` : "—";
    return `<tr><td><b>${label}</b></td><td class="num">${nidsTxt}</td><td class="num">${gmvTxt}</td><td class="num">${pctTxt}</td></tr>`;
  }
  const budN = ma.nids_budget || 0;
  let tabla = `<table class="drill-table">
    <thead><tr><th></th><th style="text-align:right">NIDs</th><th style="text-align:right">${stream.gmv_tipo_precio || "GMV"}</th><th style="text-align:right">% of budget</th></tr></thead>
    <tbody>
      ${row(`MTD (day ${dia}/${diasMes})`, ma.nids_total, ma.gmv_total, budN ? ma.nids_total/budN : null)}
      ${fcPrev ? row(`Forecast vs ${fcPrev.ref_mes}`, fcPrev.nids, fcPrev.gmv, budN ? fcPrev.nids/budN : null) : ""}
      ${fcYoy  ? row(`Forecast vs ${fcYoy.ref_mes} · YoY`, fcYoy.nids, fcYoy.gmv, budN ? fcYoy.nids/budN : null) : ""}
      ${row("Budget (mes completo)", budN, ma.gmv_budget, budN ? 1 : null)}
      ${row(`Mes anterior (${agg.mes_anterior.mes})`, agg.mes_anterior.nids_total, agg.mes_anterior.gmv_total, budN ? agg.mes_anterior.nids_total/budN : null)}
      ${row(`YoY (${agg.mes_yoy.mes})`, agg.mes_yoy.nids_total, agg.mes_yoy.gmv_total, budN ? agg.mes_yoy.nids_total/budN : null)}
    </tbody>
  </table>`;

  // Chart de curvas acumuladas — 3 series (actual, mes anterior, YoY)
  // Construimos un eje X de "dia del mes" 1..max_dias.
  const maxDias = Math.max(agg.mes_actual.dias_en_mes, agg.mes_anterior.dias_en_mes, agg.mes_yoy.dias_en_mes);
  function serieDe(ventana, hastaDia){
    const out = [];
    for(let d = 1; d <= maxDias; d++){
      if(hastaDia != null && d > hastaDia){ out.push({mes: String(d), actuals: null}); continue; }
      out.push({mes: String(d), actuals: acumuladoAlDia(ventana.curva, d, "nids_cum")});
    }
    return out;
  }
  // serieActual solo hasta el dia_corte
  const serieActual = serieDe(agg.mes_actual, dia);
  const seriePrev   = serieDe(agg.mes_anterior, null);
  const serieYoy    = serieDe(agg.mes_yoy, null);
  // serie principal (actuals=actual, budget=prev) + extra (YoY)
  const serieChart = serieActual.map((p, i) => ({mes: p.mes, actuals: p.actuals, budget: seriePrev[i].actuals}));
  const chartExtra = {serie: serieYoy.map(p => ({mes: p.mes, actuals: p.actuals})), label: `YoY (${agg.mes_yoy.mes})`, color: "#EA580C"};

  // lineChartSVG recorta por STATE.filters.mes (formato YYYY-MM). Como aqui
  // el "mes" es el dia (string "1".."31"), el recorte no aplica (no match).
  // Pero por seguridad, sobrescribimos temporalmente el filtro... no, mejor:
  // pasamos un labels custom y dejamos que recortarVentana no haga nada
  // (porque ningun item tiene mes igual a STATE.filters.mes).
  const labels = {actuals: `MTD (${ma.mes})`, budget: `Mes anterior (${agg.mes_anterior.mes})`};
  let html = `<div class="drill-grid">
    <div class="drill-block">
      <h3>Summary · ${stream.nombre}</h3>
      ${tabla}
    </div>
  </div>
  <div class="drill-block chart-block">
    <h3>Cumulative curve by day of month · ${STATE.filters.pais === "Global" ? "Colombia + Mexico" : STATE.filters.pais}</h3>
    <div class="chart-unit-label">Cumulative NIDs</div>
    ${lineChartSVG(serieChart, "NIDS", "COUNT", labels, chartExtra)}
  </div>
  <div class="drill-note">
    <b>How forecast is built</b>: For day D (today = day ${dia} of ${diasMes}), we take the reference month's cumulative NIDs at day D and its full-month total. Forecast = <code>MTD × (ref_total / ref_at_day_D)</code>. Two references shown: previous calendar month and same month one year ago. NIDs come from <code>finance_tapes_global</code> (filtered to <code>desistimientos='No desistidos'</code>); budget from <code>bet_data_p2 budget_1</code>.
  </div>`;

  document.getElementById("drillBody").innerHTML = html;
  document.getElementById("drillModal").hidden = false;
}

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
    .map(m => {
      const label = mesYYYYMM_a_label(m) + (esMesParcial(m) ? " · MTD" : "");
      return `<option value="${m}">${label}</option>`;
    }).join("");
  sel.value = STATE.filters.mes;
}

function render(){
  const mesActual = STATE.filters.mes;
  const parcial = esMesParcial(mesActual);
  const labelMes = mesYYYYMM_a_label(mesActual) + (parcial ? ' <span class="mtd-badge">MTD · partial</span>' : "");
  document.getElementById("mesCorte").innerHTML = labelMes;
  document.getElementById("refreshAt").textContent = STATE.meta.generado_en.replace("T", " ").slice(0,16);
  const ctx = `${STATE.filters.pais}${STATE.filters.subsidiaria !== "All" ? " · " + STATE.filters.subsidiaria : ""}${STATE.filters.linea !== "All" ? " · " + STATE.filters.linea : ""} · ${STATE.filters.moneda === "USD" ? "USD" : "Local currency"}`;
  document.getElementById("contextLabel").innerHTML = ctx;
  document.getElementById("ctx41").textContent = ctx;

  renderSnapshot();
  document.getElementById("grid41").innerHTML = KPIS_41.map(renderCard).join("");
  document.getElementById("grid42").innerHTML = KPIS_42.map(renderCard).join("");
  renderMTD();

  // Si el drill esta abierto, re-renderizar con los filtros nuevos
  if(STATE.currentDrillKpi && !document.getElementById("drillModal").hidden){
    if(STATE.currentDrillKpi.startsWith("__mtd__")){
      abrirDrillMTD(STATE.currentDrillKpi.slice("__mtd__".length));
    } else {
      abrirDrill(STATE.currentDrillKpi);
    }
  }

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

/* Filtro local de la tabla de detalle de aging. Solo afecta la tabla — no toca
 * chart ni card. Single-select: "all" muestra todo, un bucket filtra a ese. */
function filterAgingBucket(btn, bucket){
  const bar = btn.closest(".bucket-filter");
  if(!bar) return;
  bar.querySelectorAll(".bucket-filter-btn").forEach(b => b.classList.toggle("on", b === btn));
  const table = document.getElementById("agingDetailTable");
  if(!table) return;
  let visible = 0, total = 0;
  table.querySelectorAll("tbody tr").forEach(tr => {
    const b = tr.getAttribute("data-bucket");
    if(!b) return;
    total++;
    const show = (bucket === "all" || b === bucket);
    tr.style.display = show ? "" : "none";
    if(show) visible++;
  });
  const cnt = document.getElementById("agingDetailCount");
  if(cnt) cnt.textContent = `${visible.toLocaleString()} of ${total.toLocaleString()}`;
  // Reset scroll al top cuando filtra
  const scroll = document.getElementById("agingDetailScroll");
  if(scroll) scroll.scrollTop = 0;
}

window.abrirDrill = abrirDrill;
window.switchChartTab = switchChartTab;
window.filterAgingBucket = filterAgingBucket;

/* ============================================================ TAB BAR =====
 * Bajo el snapshot hay 3 tabs (Performance / Capital / MTD).
 * Solo el .tab-pane con clase .on esta visible. El tab activo se guarda en
 * sessionStorage para persistir entre refreshes de la misma sesion.
 * NOTA: renderMTD/render41/render42 escriben en sus grids por id, no
 * dependen de visibilidad, asi que se puede ocultar el pane sin romper
 * nada. Los renders siguen corriendo aunque el tab no este visible. */
(function initTabBar(){
  const bar = document.getElementById("tabBar");
  if(!bar) return;
  const KEY = "habi_dash_tab";
  const saved = sessionStorage.getItem(KEY);
  if(saved && document.querySelector(`.tab-pane[data-tab="${saved}"]`)){
    activateTab(saved);
  }
  bar.addEventListener("click", (e) => {
    const btn = e.target.closest(".tab-btn");
    if(!btn) return;
    const tab = btn.dataset.tab;
    activateTab(tab);
    sessionStorage.setItem(KEY, tab);
  });
  function activateTab(tab){
    document.querySelectorAll(".tab-btn").forEach(b => {
      const on = b.dataset.tab === tab;
      b.classList.toggle("on", on);
      b.setAttribute("aria-selected", on ? "true" : "false");
    });
    document.querySelectorAll(".tab-pane").forEach(p => {
      p.classList.toggle("on", p.dataset.tab === tab);
    });
  }
})();

/* ========================================================= SUBTAB BAR =====
 * Dentro del pane MTD hay 4 sub-tabs por linea de negocio (MM/BR Used/BR
 * New/HC). Al cambiar, re-renderiza el grid MTD filtrado por linea_negocio.
 * El sub-tab activo tambien se persiste en sessionStorage. */
(function initSubtabBar(){
  const bar = document.getElementById("subtabBar");
  if(!bar) return;
  const KEY = "habi_dash_mtd_subtab";
  const saved = sessionStorage.getItem(KEY);
  if(saved && document.querySelector(`.subtab-btn[data-subtab="${saved}"]`)){
    activateSubtab(saved);
  }
  bar.addEventListener("click", (e) => {
    const btn = e.target.closest(".subtab-btn");
    if(!btn) return;
    const sub = btn.dataset.subtab;
    activateSubtab(sub);
    sessionStorage.setItem(KEY, sub);
    // Re-render solo el grid MTD (los otros paneles no cambian)
    if(typeof renderMTD === "function") renderMTD();
  });
  function activateSubtab(sub){
    if(typeof STATE !== "undefined") STATE.mtdSubtab = sub;
    document.querySelectorAll(".subtab-btn").forEach(b => {
      const on = b.dataset.subtab === sub;
      b.classList.toggle("on", on);
      b.setAttribute("aria-selected", on ? "true" : "false");
    });
  }
})();

init();
