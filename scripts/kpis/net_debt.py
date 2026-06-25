"""KPI 4.2.6 — Debt in Homes con leverage sobre Adjusted EBITDA LTM.

Cifra principal del card: Debt in Homes (saldo de la deuda asociada a la
financiacion de inmuebles, de los drivers de BET).

Metrica secundaria: Leverage = Debt in Homes / Adjusted EBITDA LTM
  - EBITDA LTM = suma 12 meses del EBITDA BET (mismo filtro que el KPI EBITDA)
  - Delta tape LTM = ajuste tape (Σ c_precio − MM Sales BET) acumulado 12 meses,
    misma logica que el KPI Adjusted Revenue.
  - Adjusted EBITDA LTM = EBITDA LTM + Delta tape LTM (asumiendo que el delta
    tape representa revenue real no reconocido contablemente, sin costos
    adicionales materiales).

NO incluye deuda corporativa (04. Corporate Debt esta vacio en BET; pendiente
reportar al owner).
"""

from __future__ import annotations

import datetime as dt
import logging
from typing import Any

import pandas as pd

from scripts._bq import TABLE_BET, run_query
from scripts._common import MONEDA_POR_PAIS, PAIS_LABEL

log = logging.getLogger(__name__)

HISTORY_MONTHS = 13
LTM_MONTHS = 12

TAPE_TABLE = "clients-domain-data-master.finance_wh_bi.finance_tapes_global"

INTERCO_TERCEROS = ("MCN INVESTMENTS CORP", "CORPORATIVO MCNEMEXICO", "MERBOS")


def _sql_debt(mes_inicio: dt.date, mes_corte: dt.date) -> str:
    return f"""
SELECT
  mes,
  m_pais,
  dummie_eliminaciones,
  dummie_ajustes,
  SUM(actuals_accounting) AS debt
FROM `{TABLE_BET}`
WHERE m_tipo = '3. Drivers'
  AND m_categoria = '03. Balance General'
  AND m_metrica = '05. Debt in Homes'
  AND mes BETWEEN DATE('{mes_inicio.isoformat()}') AND DATE('{mes_corte.isoformat()}')
GROUP BY 1, 2, 3, 4
""".strip()


def _sql_ebitda(mes_inicio_ltm: dt.date, mes_corte: dt.date) -> str:
    return f"""
SELECT
  mes,
  m_pais,
  SUM(IF(dummie_eliminaciones IS NULL OR dummie_eliminaciones NOT IN (1, -1),
         actuals_accounting, 0)) AS ebitda
FROM `{TABLE_BET}`
WHERE m_tipo = '1. Financials'
  AND c_total_reporte IN ('1 Gross Profit', '2 Other Costs', '3 Operating Expenses')
  AND mes BETWEEN DATE('{mes_inicio_ltm.isoformat()}') AND DATE('{mes_corte.isoformat()}')
  AND (dummie_ajustes IS NULL OR dummie_ajustes != 1)
GROUP BY 1, 2
""".strip()


def _sql_delta_tape(mes_inicio_ltm: dt.date, mes_corte: dt.date) -> str:
    """Delta tape mensual: tape_sum − rev_mm_bet_sin_elim por mes y pais."""
    interco_list = ", ".join(f"'{t}'" for t in INTERCO_TERCEROS)
    return f"""
WITH bet_mm_nids AS (
  SELECT DISTINCT CAST(nid AS STRING) AS nid_str
  FROM `{TABLE_BET}`
  WHERE m_categoria = '01. Total Revenue'
    AND m_tipo = '1. Financials'
    AND m_negocio = '01. Market Maker'
    AND m_metrica != '01. Total Revenue'
    AND nid IS NOT NULL
    AND UPPER(COALESCE(c_tercero, '')) NOT IN ({interco_list})
),
rev_mm_bet AS (
  SELECT
    mes,
    m_pais,
    SUM(IF(dummie_eliminaciones IS NULL OR dummie_eliminaciones NOT IN (1, -1),
           actuals_accounting, 0)) AS rev_mm_sin_elim
  FROM `{TABLE_BET}`
  WHERE m_categoria = '01. Total Revenue'
    AND m_tipo = '1. Financials'
    AND m_negocio = '01. Market Maker'
    AND m_metrica != '01. Total Revenue'
    AND mes BETWEEN DATE('{mes_inicio_ltm.isoformat()}') AND DATE('{mes_corte.isoformat()}')
  GROUP BY 1, 2
),
tape_sum AS (
  SELECT
    DATE_TRUNC(t.c_fecha_factura, MONTH) AS mes,
    CASE t.pais
      WHEN 'Colombia' THEN '1. Colombia'
      WHEN 'México'   THEN '2. Mexico'
      ELSE NULL
    END AS m_pais,
    SUM(t.c_precio) AS tape_sum
  FROM `{TAPE_TABLE}` t
  INNER JOIN bet_mm_nids n ON CAST(t.nid AS STRING) = n.nid_str
  WHERE t.c_fecha_factura IS NOT NULL
    AND t.c_fecha_factura BETWEEN DATE('{mes_inicio_ltm.isoformat()}') AND LAST_DAY(DATE('{mes_corte.isoformat()}'))
  GROUP BY 1, 2
)
SELECT
  COALESCE(r.mes, t.mes) AS mes,
  COALESCE(r.m_pais, t.m_pais) AS m_pais,
  COALESCE(t.tape_sum, 0) - COALESCE(r.rev_mm_sin_elim, 0) AS delta_tape
FROM rev_mm_bet r
FULL OUTER JOIN tape_sum t USING (mes, m_pais)
WHERE COALESCE(r.m_pais, t.m_pais) IS NOT NULL
""".strip()


def _twin_sum(df: pd.DataFrame, value_col: str = "debt") -> dict[str, float]:
    s = df[value_col].fillna(0)
    elim_mask = df["dummie_eliminaciones"].fillna(0).isin([1, -1])
    return {
        "sin_elim": float(s[~elim_mask].sum()),
        "solo_elim": float(s[elim_mask].sum()),
        "con_elim": float(s.sum()),
    }


def build(mes_corte: dt.date) -> dict[str, Any]:
    mes_inicio = dt.date(mes_corte.year, mes_corte.month, 1)
    for _ in range(HISTORY_MONTHS - 1):
        prev_last = mes_inicio - dt.timedelta(days=1)
        mes_inicio = dt.date(prev_last.year, prev_last.month, 1)

    # Rango LTM (12 meses adicionales hacia atras para calcular LTM del primer mes)
    mes_inicio_ltm = mes_inicio
    for _ in range(LTM_MONTHS - 1):
        prev_last = mes_inicio_ltm - dt.timedelta(days=1)
        mes_inicio_ltm = dt.date(prev_last.year, prev_last.month, 1)

    log.info("Debt in Homes: rango %s -> %s (LTM desde %s)", mes_inicio, mes_corte, mes_inicio_ltm)
    df_debt   = run_query(_sql_debt(mes_inicio, mes_corte), label="debt_homes")
    df_ebitda = run_query(_sql_ebitda(mes_inicio_ltm, mes_corte), label="debt_ebitda")
    df_delta  = run_query(_sql_delta_tape(mes_inicio_ltm, mes_corte), label="debt_delta_tape")

    df_debt["mes"] = pd.to_datetime(df_debt["mes"])
    df_debt["pais_label"] = df_debt["m_pais"].map(PAIS_LABEL).fillna("(sin pais)")
    df_debt["m_pais"] = df_debt["pais_label"]

    df_ebitda["mes"] = pd.to_datetime(df_ebitda["mes"])
    df_ebitda["pais_label"] = df_ebitda["m_pais"].map(PAIS_LABEL).fillna("(sin pais)")

    df_delta["mes"] = pd.to_datetime(df_delta["mes"])
    df_delta["pais_label"] = df_delta["m_pais"].map(PAIS_LABEL).fillna("(sin pais)")

    # Adj EBITDA mensual por pais
    ebitda_pivot = df_ebitda.pivot_table(
        index="mes", columns="pais_label", values="ebitda", aggfunc="sum"
    ).fillna(0)
    delta_pivot = df_delta.pivot_table(
        index="mes", columns="pais_label", values="delta_tape", aggfunc="sum"
    ).reindex(ebitda_pivot.index).fillna(0)
    # Alinear columnas: el delta solo tiene CO y MX
    for col in ebitda_pivot.columns:
        if col not in delta_pivot.columns:
            delta_pivot[col] = 0.0
    delta_pivot = delta_pivot[ebitda_pivot.columns]
    adj_ebitda_pivot = ebitda_pivot + delta_pivot

    # LTM rolling
    ebitda_ltm = ebitda_pivot.rolling(window=LTM_MONTHS, min_periods=1).sum()
    delta_ltm  = delta_pivot.rolling(window=LTM_MONTHS, min_periods=1).sum()
    adj_ltm    = adj_ebitda_pivot.rolling(window=LTM_MONTHS, min_periods=1).sum()

    meses_disponibles = sorted({m.strftime("%Y-%m") for m in df_debt["mes"].unique()})

    facts = []
    keys = ["mes", "m_pais", "dummie_ajustes"]
    for vals, g in df_debt.groupby(keys, dropna=False):
        mes, pais, ajuste = vals
        debt_buckets = _twin_sum(g, "debt")
        mes_ts = pd.Timestamp(mes) if not isinstance(mes, pd.Timestamp) else mes
        ebitda_ltm_v = float(ebitda_ltm.loc[mes_ts, pais]) if pais in ebitda_ltm.columns and mes_ts in ebitda_ltm.index else None
        delta_ltm_v  = float(delta_ltm.loc[mes_ts, pais])  if pais in delta_ltm.columns  and mes_ts in delta_ltm.index  else None
        adj_ltm_v    = float(adj_ltm.loc[mes_ts, pais])    if pais in adj_ltm.columns    and mes_ts in adj_ltm.index    else None
        leverage     = (debt_buckets["sin_elim"] / adj_ltm_v) if (adj_ltm_v and adj_ltm_v != 0) else None
        facts.append({
            "mes": mes_ts.strftime("%Y-%m"),
            "pais": pais if pd.notna(pais) else None,
            "subsidiaria": None,
            "linea": None,
            "cuenta": None,
            "cuenta_desc": None,
            "es_ajuste": bool(pd.notna(ajuste) and ajuste == 1),
            "actuals": debt_buckets,
            "budget":  {"sin_elim": 0.0, "con_elim": 0.0, "solo_elim": 0.0},
            "ebitda_ltm": ebitda_ltm_v,
            "delta_tape_ltm": delta_ltm_v,
            "adj_ebitda_ltm": adj_ltm_v,
            "leverage": leverage,
        })

    log.info("Debt in Homes: %d facts", len(facts))

    payload: dict[str, Any] = {
        "id": "net_debt",
        "nombre": "Debt in Homes",
        "seccion": "4.2",
        "unidad": "MONEDA_DEBT_HOMES",
        "estado": "real",
        "invertir_delta": True,  # mas deuda = peor
        "fuente": (
            "bet_data_p2 · drivers Debt in Homes · leverage = Debt / Adj EBITDA LTM"
        ),
        "receta": {
            "tabla": TABLE_BET,
            "tabla_tape": TAPE_TABLE,
            "filtros_debt": [
                "m_tipo = '3. Drivers'",
                "m_categoria = '03. Balance General'",
                "m_metrica = '05. Debt in Homes'",
            ],
            "filtros_ebitda": [
                "m_tipo = '1. Financials'",
                "c_total_reporte IN ('1 Gross Profit', '2 Other Costs', '3 Operating Expenses')",
            ],
            "adj_ebitda_formula": "EBITDA BET + Delta tape (mismo ajuste que Adjusted Revenue)",
            "ltm_meses": LTM_MONTHS,
            "nota": "Corporate Debt vacio en BET; pendiente reportar al owner.",
            "monedas": MONEDA_POR_PAIS,
        },
        "meses_disponibles": meses_disponibles,
        "facts": facts,
    }
    return payload
