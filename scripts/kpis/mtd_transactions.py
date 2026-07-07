"""Tab "MTD · Transactions" — Fase 1 (MM) + PSAs + Gross Margin.

Streams cubiertos (todos Market Maker):
  1. MM Compras escrituras — bet `03. Purchase Deeds` · tape `v_fecha_escritura`
  2. MM Ventas escrituras  — bet `07. Sale Deeds`     · tape `c_fecha_escritura`
  3. MM PSA compra         — bet `01. Gross Purchase PSAs` · tape `v_fecha_promesa`
  4. MM PSA venta          — bet `05. Sale PSAs`     · tape `c_fecha_promesa`
  5. MM Gross Margin       — solo tape · anclado a `c_fecha_factura`
     Revenue = SUM(c_precio); Cost = SUM(v_precio) sobre los mismos NIDs;
     GP = Revenue - Cost; Margen % = GP / Revenue.
     Este es un PROXY del margen contable "oficial" (bet Managerial incluye
     remodel + holding + otros costos). Usamos tape porque el bet no da
     granularidad diaria. Al cerrar el mes, `kpi_margen_bruto` tiene el
     numero oficial mensual.

Por cada stream (excepto Gross Margin), el payload contiene 3 ventanas:
  - mes_actual   = mes en curso (MTD parcial)
  - mes_anterior = mes calendario anterior
  - mes_yoy      = mismo mes calendario hace 12 meses

Por cada ventana y por cada pais se emiten:
  - nids_total / gmv_total   (totales del mes)
  - nids_budget / gmv_budget (solo aplica al mes_actual; viene de bet `budget_1`)
  - curva: [{dia, nids, gmv, nids_cum, gmv_cum}, ...] desde el tape

Gross Margin (stream 5) usa el mismo shape pero con campos extra:
  - revenue_total, cost_total, gp_total, margen_pct   (ratio MTD)
  - curva: [{dia, revenue, cost, gp, revenue_cum, cost_cum, gp_cum, margen_cum}, ...]
  - Sin budget (bet Managerial no tiene budget por dia).

El forecast se calcula en el front a partir de estos numeros:
  estimado_cierre = MTD_actual × (ref_total / ref_acumulado_al_dia_D)
con D = dia del mes hoy. Dos referencias (mes anterior + YoY) → dos estimados.

Cuadre validado 2026-06-30: bet `m_unidad='NIDS'` (suma de submetricas) ≡
tape filtrado a `desistimientos='No desistidos'` (5/6 meses exactos, 1 off
by 1 NID; aceptable).
"""

from __future__ import annotations

import datetime as dt
import logging
from typing import Any

import pandas as pd

from scripts._bq import TABLE_BET, run_query
from scripts._common import MONEDA_POR_PAIS, PAIS_LABEL

log = logging.getLogger(__name__)

TAPE = "clients-domain-data-master.finance_wh_bi.finance_tapes_global"
TAPE_INMO = "papyrus-delivery-data.corp_gov_global.inmobiliaria_tapes_global"

# Para Sale Deeds bet expone GMV en Purchase price Y Selling price; el
# tab muestra Selling price (lo que vendimos). Para Purchase Deeds solo
# existe Purchase price.
STREAMS = [
    # ===== MARKET MAKER =====
    {
        "id": "mm_psa_compra",
        "nombre": "MM · PSA compra",
        "linea_negocio": "Market Maker",
        "tipo": "count",
        "tabla_tape": TAPE,
        "bet_categoria": "01. Market Maker",
        "bet_metrica": "01. Gross Purchase PSAs",
        "bet_submetrica": None,   # None = sumar todas las submetricas
        "fecha_field": "v_fecha_promesa",
        "precio_field": "v_precio",
        "gmv_tipo_precio": "Purchase price",
        # Bet cuenta TODAS las PSAs (incluidas desistidas); no filtrar en tape.
        "filtrar_desistidos": False,
    },
    {
        "id": "mm_compras_escritura",
        "nombre": "MM · Compras (escrituras)",
        "linea_negocio": "Market Maker",
        "tipo": "count",
        "tabla_tape": TAPE,
        "bet_categoria": "01. Market Maker",
        "bet_metrica": "03. Purchase Deeds",
        "bet_submetrica": None,
        "fecha_field": "v_fecha_escritura",
        "precio_field": "v_precio",
        "gmv_tipo_precio": "Purchase price",
        "filtrar_desistidos": True,   # Deeds no se desisten; filtro alinea con bet
    },
    {
        "id": "mm_psa_venta",
        "nombre": "MM · PSA venta",
        "linea_negocio": "Market Maker",
        "tipo": "count",
        "tabla_tape": TAPE,
        "bet_categoria": "01. Market Maker",
        "bet_metrica": "05. Sale PSAs",
        "bet_submetrica": None,
        "fecha_field": "c_fecha_promesa",
        "precio_field": "c_precio",
        "gmv_tipo_precio": "Selling price",
        "filtrar_desistidos": False,
    },
    {
        "id": "mm_ventas_escritura",
        "nombre": "MM · Ventas (escrituras)",
        "linea_negocio": "Market Maker",
        "tipo": "count",
        "tabla_tape": TAPE,
        "bet_categoria": "01. Market Maker",
        "bet_metrica": "07. Sale Deeds",
        "bet_submetrica": None,
        "fecha_field": "c_fecha_escritura",
        "precio_field": "c_precio",
        "gmv_tipo_precio": "Selling price",
        "filtrar_desistidos": True,
    },
    {
        "id": "mm_gross_margin",
        "nombre": "MM · Gross Margin (proxy tape)",
        "linea_negocio": "Market Maker",
        "tipo": "ratio",
        "tabla_tape": TAPE,
        # No hay bet_metrica: se calcula del tape.
        # Revenue = SUM(c_precio); Cost = SUM(v_precio) sobre los mismos NIDs.
        "fecha_field": "c_fecha_factura",
    },
    # ===== BROKERAGE USED HOMES =====
    # Cuadre validado 2026-07-06 CO jun-26: bet 348/79/67 vs tape 348/77/67
    # (Sales off-by-2). Tape usa inmobiliaria_tapes_global (papyrus).
    {
        "id": "br_used_subscribed",
        "nombre": "BR Used · Subscribed",
        "linea_negocio": "Brokerage Used",
        "tipo": "count",
        "tabla_tape": TAPE_INMO,
        "bet_categoria": "02. Brokerage (Used Homes)",
        "bet_metrica": "01. Subscribed",
        "bet_submetrica": "01. Subscribed",    # Solo el total, no desglosar Inmo 100/Tradicional
        "fecha_field": "v_fecha_captacion",
        "precio_field": "v_precio",
        "gmv_tipo_precio": None,               # BR Used no usa m_tipo_precio en bet
        "filtrar_desistidos": False,
        "filtro_tipo_captacion": "primera captación",
    },
    {
        "id": "br_used_sales",
        "nombre": "BR Used · Sales",
        "linea_negocio": "Brokerage Used",
        "tipo": "count",
        "tabla_tape": TAPE_INMO,
        "bet_categoria": "02. Brokerage (Used Homes)",
        "bet_metrica": "03. Sales",
        "bet_submetrica": "01. Sales",
        "fecha_field": "c_fecha_promesa",
        "precio_field": "c_precio",
        "gmv_tipo_precio": None,
        "filtrar_desistidos": False,
    },
    {
        "id": "br_used_deeds",
        "nombre": "BR Used · Deeds (escrituras)",
        "linea_negocio": "Brokerage Used",
        "tipo": "count",
        "tabla_tape": TAPE_INMO,
        "bet_categoria": "02. Brokerage (Used Homes)",
        "bet_metrica": "05. Deeds",
        "bet_submetrica": "01. Deeds",
        "fecha_field": "c_fecha_escritura",
        "precio_field": "c_precio",
        "gmv_tipo_precio": None,
        "filtrar_desistidos": False,
    },
]

# Solo los streams con `tipo='count'` van al bet (para budget + total mensual).
STREAMS_COUNT = [s for s in STREAMS if s["tipo"] == "count"]
STREAMS_RATIO = [s for s in STREAMS if s["tipo"] == "ratio"]


def _ventanas(mes_max: dt.date) -> dict[str, tuple[dt.date, dt.date]]:
    """Calcula los 3 rangos calendario completos (primer dia, ultimo dia).

    mes_actual usa mes_max (el mes en curso). mes_anterior = mes calendario
    inmediato anterior. mes_yoy = mes_actual menos 12 meses.
    """
    def primer_dia(y: int, m: int) -> dt.date:
        return dt.date(y, m, 1)

    def ultimo_dia(y: int, m: int) -> dt.date:
        if m == 12:
            return dt.date(y, 12, 31)
        return dt.date(y, m + 1, 1) - dt.timedelta(days=1)

    actual_inicio = primer_dia(mes_max.year, mes_max.month)
    actual_fin    = ultimo_dia(mes_max.year, mes_max.month)

    # Mes anterior
    prev_first = actual_inicio - dt.timedelta(days=1)
    ant_inicio = primer_dia(prev_first.year, prev_first.month)
    ant_fin    = ultimo_dia(prev_first.year, prev_first.month)

    # YoY (mismo mes anyo anterior)
    yoy_inicio = primer_dia(actual_inicio.year - 1, actual_inicio.month)
    yoy_fin    = ultimo_dia(actual_inicio.year - 1, actual_inicio.month)

    return {
        "mes_actual":   (actual_inicio, actual_fin),
        "mes_anterior": (ant_inicio, ant_fin),
        "mes_yoy":      (yoy_inicio, yoy_fin),
    }


def _sql_bet(meses: list[dt.date]) -> str:
    """Totales mensuales y budget_1 por (mes, pais, categoria, metrica, submetrica, unidad, precio).

    Trae todas las categorias que aparezcan en STREAMS_COUNT. Luego cada stream
    filtra por su (categoria, metrica, submetrica) en _ventana_payload.
    """
    fechas = ",".join(f"'{m.isoformat()}'" for m in meses)
    categorias = sorted(set(s["bet_categoria"] for s in STREAMS_COUNT))
    metricas = sorted(set(s["bet_metrica"] for s in STREAMS_COUNT))
    cats_sql = ",".join(f"'{c}'" for c in categorias)
    mets_sql = ",".join(f"'{m}'" for m in metricas)
    return f"""
SELECT
  mes, m_pais, m_categoria, m_metrica, m_submetrica, m_unidad, m_tipo_precio,
  SUM(actuals_accounting) AS actuals,
  SUM(budget_1)           AS budget
FROM `{TABLE_BET}`
WHERE m_tipo = '2. Transactions'
  AND m_categoria IN ({cats_sql})
  AND m_metrica IN ({mets_sql})
  AND mes IN ({fechas})
GROUP BY 1, 2, 3, 4, 5, 6, 7
""".strip()


def _sql_tape_daily(tabla: str, fecha_field: str, precio_field: str,
                    rangos: list[tuple[dt.date, dt.date]],
                    filtrar_desistidos: bool = True,
                    filtro_tipo_captacion: str | None = None) -> str:
    """Curva diaria de NIDs + GMV en el tape (finance o inmobiliaria).

    - `tabla`: TAPE (Market Maker) o TAPE_INMO (Brokerage Used).
    - `filtrar_desistidos=True` aplica `desistimientos='No desistidos'` (solo
      existe en finance_tapes_global; correcto para Deeds MM).
    - `filtro_tipo_captacion`: si se pasa, agrega `tipo_captacion='...'`
      (solo aplica al tape de inmobiliaria; usado para Subscribed BR Used).
    - `rangos` = 3 ventanas (actual / anterior / yoy) en un solo query.

    `pais` en inmobiliaria_tapes_global es 'Colombia' / 'México' igual que en
    finance_tapes_global — el CASE de normalizacion aplica a ambas.
    """
    or_clauses = " OR ".join(
        f"({fecha_field} BETWEEN '{a.isoformat()}' AND '{b.isoformat()}')"
        for a, b in rangos
    )
    desist_clause = "  AND desistimientos = 'No desistidos'\n" if filtrar_desistidos else ""
    tipo_cap_clause = f"  AND tipo_captacion = '{filtro_tipo_captacion}'\n" if filtro_tipo_captacion else ""
    return f"""
SELECT
  {fecha_field}                              AS fecha,
  CASE pais
    WHEN 'Colombia' THEN '1. Colombia'
    WHEN 'México'   THEN '2. Mexico'
  END                                        AS m_pais,
  COUNT(*)                                   AS nids,
  SUM({precio_field})                        AS gmv
FROM `{tabla}`
WHERE pais IN ('Colombia','México')
{desist_clause}{tipo_cap_clause}  AND {fecha_field} IS NOT NULL
  AND ({or_clauses})
GROUP BY 1, 2
""".strip()


def _curva_dia_a_dia(df_dia: pd.DataFrame, pais: str,
                     ventana_inicio: dt.date, ventana_fin: dt.date) -> list[dict[str, Any]]:
    """Toma rows diarias del tape filtradas a un pais y construye curva
    acumulada desde dia 1 hasta el ultimo dia con dato dentro de la ventana.

    Si el ultimo dia con dato es < ventana_fin (caso mes_actual MTD), corta
    ahi. Si no hay datos en absoluto, devuelve [].
    """
    sub = df_dia[
        (df_dia["m_pais"] == pais)
        & (df_dia["fecha"] >= pd.Timestamp(ventana_inicio))
        & (df_dia["fecha"] <= pd.Timestamp(ventana_fin))
    ].copy()
    if sub.empty:
        return []
    sub = sub.sort_values("fecha")
    nids_acc = 0.0
    gmv_acc  = 0.0
    out = []
    for _, r in sub.iterrows():
        dia = int(r["fecha"].day)
        n = float(r["nids"] or 0)
        g = float(r["gmv"]  or 0)
        nids_acc += n
        gmv_acc  += g
        out.append({
            "dia": dia,
            "nids": n,
            "gmv":  g,
            "nids_cum": nids_acc,
            "gmv_cum":  gmv_acc,
        })
    return out


def _sql_tape_daily_margin(rangos: list[tuple[dt.date, dt.date]]) -> str:
    """Curva diaria para Gross Margin: revenue (c_precio) + cost (v_precio)
    por c_fecha_factura, sobre NIDs con ambos precios (MM propios).

    Filtramos v_precio IS NOT NULL para excluir NIDs que Habi nunca compro
    directo (Brokerage / Marketplace sin inventario propio). GP se calcula
    en Python al construir la curva acumulada.
    """
    or_clauses = " OR ".join(
        f"(c_fecha_factura BETWEEN '{a.isoformat()}' AND '{b.isoformat()}')"
        for a, b in rangos
    )
    return f"""
SELECT
  c_fecha_factura                            AS fecha,
  CASE pais
    WHEN 'Colombia' THEN '1. Colombia'
    WHEN 'México'   THEN '2. Mexico'
  END                                        AS m_pais,
  COUNT(*)                                   AS nids,
  SUM(c_precio)                              AS revenue,
  SUM(v_precio)                              AS cost
FROM `{TAPE}`
WHERE pais IN ('Colombia','México')
  AND desistimientos = 'No desistidos'
  AND c_fecha_factura IS NOT NULL
  AND v_precio IS NOT NULL
  AND ({or_clauses})
GROUP BY 1, 2
""".strip()


def _curva_margin_dia_a_dia(df_dia: pd.DataFrame, pais: str,
                            ventana_inicio: dt.date, ventana_fin: dt.date) -> list[dict[str, Any]]:
    """Curva acumulada del Gross Margin dia a dia dentro de la ventana."""
    sub = df_dia[
        (df_dia["m_pais"] == pais)
        & (df_dia["fecha"] >= pd.Timestamp(ventana_inicio))
        & (df_dia["fecha"] <= pd.Timestamp(ventana_fin))
    ].copy()
    if sub.empty:
        return []
    sub = sub.sort_values("fecha")
    rev_acc = 0.0
    cost_acc = 0.0
    nids_acc = 0.0
    out = []
    for _, r in sub.iterrows():
        dia = int(r["fecha"].day)
        rev = float(r["revenue"] or 0)
        cost = float(r["cost"] or 0)
        n = float(r["nids"] or 0)
        rev_acc += rev
        cost_acc += cost
        nids_acc += n
        gp_acc = rev_acc - cost_acc
        margen_pct = (gp_acc / rev_acc * 100.0) if rev_acc > 0 else None
        out.append({
            "dia": dia,
            "revenue": rev,
            "cost": cost,
            "gp": rev - cost,
            "nids": n,
            "revenue_cum": rev_acc,
            "cost_cum": cost_acc,
            "gp_cum": gp_acc,
            "nids_cum": nids_acc,
            "margen_cum_pct": margen_pct,
        })
    return out


def _ventana_payload_margin(df_dia: pd.DataFrame, pais: str,
                            ventana_nombre: str,
                            ventana_inicio: dt.date, ventana_fin: dt.date) -> dict[str, Any]:
    """Bloque de payload para Gross Margin en una (pais, ventana). Sin budget."""
    sub = df_dia[
        (df_dia["m_pais"] == pais)
        & (df_dia["fecha"] >= pd.Timestamp(ventana_inicio))
        & (df_dia["fecha"] <= pd.Timestamp(ventana_fin))
    ]
    revenue_total = float(sub["revenue"].sum()) if not sub.empty else 0.0
    cost_total    = float(sub["cost"].sum())    if not sub.empty else 0.0
    nids_total    = float(sub["nids"].sum())    if not sub.empty else 0.0
    gp_total = revenue_total - cost_total
    margen_pct = (gp_total / revenue_total * 100.0) if revenue_total > 0 else None
    return {
        "ventana": ventana_nombre,
        "mes": ventana_inicio.strftime("%Y-%m"),
        "dias_en_mes": (ventana_fin - ventana_inicio).days + 1,
        "revenue_total": revenue_total,
        "cost_total": cost_total,
        "gp_total": gp_total,
        "nids_total": nids_total,
        "margen_pct": margen_pct,
        "curva": _curva_margin_dia_a_dia(df_dia, pais, ventana_inicio, ventana_fin),
    }


def _ventana_payload(df_bet: pd.DataFrame, df_dia: pd.DataFrame,
                     stream: dict[str, str], pais: str,
                     ventana_nombre: str,
                     ventana_inicio: dt.date, ventana_fin: dt.date,
                     incluir_budget: bool) -> dict[str, Any]:
    """Arma el bloque {nids_total, gmv_total, [budget...], curva} para una
    (stream, pais, ventana). Budget solo se incluye en mes_actual.

    Filtra bet por (categoria, metrica, submetrica). Si stream tiene
    `bet_submetrica=None`, suma TODAS las submetricas (patron MM). Si tiene
    submetrica explicita, solo esa (patron BR Used, para no doble-contar).
    """
    categoria = stream["bet_categoria"]
    metrica   = stream["bet_metrica"]
    submet    = stream.get("bet_submetrica")
    precio    = stream.get("gmv_tipo_precio")

    # bet: totales y budget de esta ventana
    bet_mes = df_bet[
        (df_bet["m_pais"] == pais)
        & (df_bet["m_categoria"] == categoria)
        & (df_bet["m_metrica"] == metrica)
        & (df_bet["mes"] == pd.Timestamp(ventana_inicio))
    ]
    if submet is not None:
        bet_mes = bet_mes[bet_mes["m_submetrica"] == submet]

    nids_row = bet_mes[bet_mes["m_unidad"] == "NIDS"]
    if precio is None:
        # BR Used no usa m_tipo_precio (todos con NULL) — solo filtrar por unidad
        gmv_row = bet_mes[bet_mes["m_unidad"] == "GMV"]
    else:
        gmv_row = bet_mes[(bet_mes["m_unidad"] == "GMV") & (bet_mes["m_tipo_precio"] == precio)]

    nids_total = float(nids_row["actuals"].sum()) if not nids_row.empty else 0.0
    gmv_total  = float(gmv_row["actuals"].sum())  if not gmv_row.empty  else 0.0

    bloque: dict[str, Any] = {
        "ventana": ventana_nombre,
        "mes": ventana_inicio.strftime("%Y-%m"),
        "dias_en_mes": (ventana_fin - ventana_inicio).days + 1,
        "nids_total": nids_total,
        "gmv_total":  gmv_total,
        "curva": _curva_dia_a_dia(df_dia, pais, ventana_inicio, ventana_fin),
    }
    if incluir_budget:
        bloque["nids_budget"] = float(nids_row["budget"].sum()) if not nids_row.empty else 0.0
        bloque["gmv_budget"]  = float(gmv_row["budget"].sum())  if not gmv_row.empty  else 0.0
    return bloque


def build(mes_corte: dt.date, mes_max: dt.date | None = None) -> dict[str, Any]:
    """Construye el payload del tab MTD · Transactions (Fase 1)."""
    if mes_max is None:
        mes_max = mes_corte
    ventanas = _ventanas(mes_max)

    log.info("MTD: ventanas %s",
             {k: (a.isoformat(), b.isoformat()) for k, (a, b) in ventanas.items()})

    # 1) bet: totales y budget para los 3 meses
    meses_consulta = [a for (a, _) in ventanas.values()]
    df_bet = run_query(_sql_bet(meses_consulta), label="mtd_bet")
    df_bet["mes"] = pd.to_datetime(df_bet["mes"])

    # 2) tape: una query daily por fecha-field (v / c) cubriendo los 3 rangos.
    #    Solo para streams COUNT (los ratio usan query aparte).
    df_dia_por_stream: dict[str, pd.DataFrame] = {}
    rangos = list(ventanas.values())
    for s in STREAMS_COUNT:
        log.info("MTD: tape daily %s (%s, tabla=%s, filtrar_desistidos=%s, tipo_captacion=%s)",
                 s["id"], s["fecha_field"],
                 s.get("tabla_tape", TAPE).split(".")[-1],
                 s.get("filtrar_desistidos", True),
                 s.get("filtro_tipo_captacion") or "-")
        df = run_query(
            _sql_tape_daily(
                s.get("tabla_tape", TAPE),
                s["fecha_field"], s["precio_field"], rangos,
                filtrar_desistidos=s.get("filtrar_desistidos", True),
                filtro_tipo_captacion=s.get("filtro_tipo_captacion"),
            ),
            label=f"mtd_tape_{s['id']}",
        )
        df["fecha"] = pd.to_datetime(df["fecha"])
        df_dia_por_stream[s["id"]] = df

    # 3) tape especial para Gross Margin: revenue + cost por c_fecha_factura
    df_margin_por_stream: dict[str, pd.DataFrame] = {}
    for s in STREAMS_RATIO:
        log.info("MTD: tape margin %s (%s)", s["id"], s["fecha_field"])
        df = run_query(_sql_tape_daily_margin(rangos), label=f"mtd_tape_{s['id']}")
        df["fecha"] = pd.to_datetime(df["fecha"])
        df_margin_por_stream[s["id"]] = df

    # day_corte = dia del mes actual del ultimo dato observado en cualquier tape.
    #    Considera count streams + ratio streams.
    actual_a, actual_b = ventanas["mes_actual"]
    last_days = []
    for s in STREAMS_COUNT:
        df = df_dia_por_stream[s["id"]]
        df_actual = df[(df["fecha"] >= pd.Timestamp(actual_a)) & (df["fecha"] <= pd.Timestamp(actual_b))]
        if not df_actual.empty:
            last_days.append(int(df_actual["fecha"].max().day))
    for s in STREAMS_RATIO:
        df = df_margin_por_stream[s["id"]]
        df_actual = df[(df["fecha"] >= pd.Timestamp(actual_a)) & (df["fecha"] <= pd.Timestamp(actual_b))]
        if not df_actual.empty:
            last_days.append(int(df_actual["fecha"].max().day))
    day_corte = max(last_days) if last_days else 0
    days_in_month_actual = (actual_b - actual_a).days + 1

    # Construir streams
    paises = ["1. Colombia", "2. Mexico"]
    streams_payload = []
    for s in STREAMS_COUNT:
        df_dia = df_dia_por_stream[s["id"]]
        por_pais = {}
        for pais in paises:
            por_pais[PAIS_LABEL[pais]] = {
                "moneda": MONEDA_POR_PAIS.get(pais, "USD"),
                "mes_actual":   _ventana_payload(df_bet, df_dia, s, pais, "mes_actual",
                                                 *ventanas["mes_actual"], incluir_budget=True),
                "mes_anterior": _ventana_payload(df_bet, df_dia, s, pais, "mes_anterior",
                                                 *ventanas["mes_anterior"], incluir_budget=False),
                "mes_yoy":      _ventana_payload(df_bet, df_dia, s, pais, "mes_yoy",
                                                 *ventanas["mes_yoy"], incluir_budget=False),
            }
        streams_payload.append({
            "id": s["id"],
            "nombre": s["nombre"],
            "linea_negocio": s["linea_negocio"],
            "tipo": s["tipo"],
            "bet_metrica": s["bet_metrica"],
            "fecha_field": s["fecha_field"],
            "gmv_tipo_precio": s["gmv_tipo_precio"],
            "granularidad": "diaria",
            "por_pais": por_pais,
        })

    # Streams ratio (Gross Margin) — shape distinto, sin bet ni budget
    for s in STREAMS_RATIO:
        df_dia = df_margin_por_stream[s["id"]]
        por_pais = {}
        for pais in paises:
            por_pais[PAIS_LABEL[pais]] = {
                "moneda": MONEDA_POR_PAIS.get(pais, "USD"),
                "mes_actual":   _ventana_payload_margin(df_dia, pais, "mes_actual",   *ventanas["mes_actual"]),
                "mes_anterior": _ventana_payload_margin(df_dia, pais, "mes_anterior", *ventanas["mes_anterior"]),
                "mes_yoy":      _ventana_payload_margin(df_dia, pais, "mes_yoy",      *ventanas["mes_yoy"]),
            }
        streams_payload.append({
            "id": s["id"],
            "nombre": s["nombre"],
            "linea_negocio": s["linea_negocio"],
            "tipo": s["tipo"],
            "fecha_field": s["fecha_field"],
            "granularidad": "diaria",
            "por_pais": por_pais,
        })

    payload: dict[str, Any] = {
        "id": "mtd_transactions",
        "nombre": "MTD · Transactions",
        "fase": 1,
        "fuente": (
            f"bet_data_p2 m_tipo='2. Transactions' (totales+budget) · "
            f"{TAPE} (curva diaria, desistimientos='No desistidos')"
        ),
        "hoy_dia_del_mes": day_corte,
        "mes_actual": actual_a.strftime("%Y-%m"),
        "mes_anterior": ventanas["mes_anterior"][0].strftime("%Y-%m"),
        "mes_yoy": ventanas["mes_yoy"][0].strftime("%Y-%m"),
        "days_in_month_actual": days_in_month_actual,
        "streams": streams_payload,
    }
    return payload
