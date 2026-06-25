"""KPI 4.1.8 — Adjusted Revenue.

Aplica el ajuste del owner de `finance_tapes_global` al Revenue plano de BET:

    Adjusted Revenue (mes M)
      = Revenue BET (M)
      − MM Sales BET actuals (M)
      + Sigma tape.c_precio de NIDs facturados en BET MM con c_fecha_factura en M

Lo emitimos como **facts planos** (identicos a ingresos.py) **mas facts
sinteticos del delta** (uno por mes/pais). Asi el frontend agrega normal
y todos los drill funcionan sin logica especial.

Convenciones:
- El delta se asigna a una subsidiaria pivot por pais (la subsidiaria que
  concentra el MM revenue): Habi en CO, Corporativo en MX.
- El delta solo afecta los buckets sin_elim y con_elim; solo_elim queda en 0
  (el tape no modela eliminaciones intercompania).
- El budget NO se ajusta (decision producto): los facts sinteticos tienen
  budget=0 en los 3 buckets. La comparacion vs budget en este KPI se
  computa contra el revenue plano del propio JSON (suma de facts no-synthetic).
- Filtro intercompania (del handoff): excluye c_tercero IN ('MCN INVESTMENTS
  CORP', 'CORPORATIVO MCNEMEXICO', 'MERBOS') del set de NIDs BET MM antes
  de joinear con tape.
"""

from __future__ import annotations

import datetime as dt
import logging
from typing import Any

import pandas as pd

from scripts._bq import TABLE_BET, run_query
from scripts._common import MONEDA_POR_PAIS, PAIS_LABEL, normalize_subsidiaria

log = logging.getLogger(__name__)

HISTORY_MONTHS = 13

TAPE_TABLE = "clients-domain-data-master.finance_wh_bi.finance_tapes_global"

METRICA_A_LINEA = {
    "01. Market Maker Sales (selling price)": "Market Maker",
    "02. Brokerage Sales": "Brokerage",
    "03. HabiCredit": "HabiCredit",
    "04. Other Products": "Other",
}

# Subsidiaria que concentra el MM revenue por pais — destino del delta tape.
SUBSIDIARIA_PIVOT = {
    "Colombia": "Habi",
    "Mexico": "Corporativo",
}

INTERCO_TERCEROS = ("MCN INVESTMENTS CORP", "CORPORATIVO MCNEMEXICO", "MERBOS")


def _sql_revenue_plano(mes_inicio: dt.date, mes_corte: dt.date) -> str:
    return f"""
SELECT
  mes,
  m_pais,
  c_subsidiaria,
  m_metrica,
  c_cuenta,
  c_cuenta_descripcion,
  dummie_eliminaciones,
  dummie_ajustes,
  SUM(actuals_accounting) AS actuals,
  SUM(budget_1)           AS budget
FROM `{TABLE_BET}`
WHERE m_categoria = '01. Total Revenue'
  AND m_tipo      = '1. Financials'
  AND m_metrica  != '01. Total Revenue'
  AND mes BETWEEN DATE('{mes_inicio.isoformat()}') AND DATE('{mes_corte.isoformat()}')
GROUP BY 1, 2, 3, 4, 5, 6, 7, 8
""".strip()


def _sql_tape_delta(mes_inicio: dt.date, mes_corte: dt.date) -> str:
    """Devuelve, por (mes, m_pais), el revenue MM BET y la suma c_precio tape.

    El delta a aplicar es `tape_sum − rev_mm_bet_sin_elim`. Se calcula en Python
    para mantener visibilidad de los componentes.
    """
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
           actuals_accounting, 0)) AS rev_mm_sin_elim,
    SUM(actuals_accounting)        AS rev_mm_con_elim
  FROM `{TABLE_BET}`
  WHERE m_categoria = '01. Total Revenue'
    AND m_tipo = '1. Financials'
    AND m_negocio = '01. Market Maker'
    AND m_metrica != '01. Total Revenue'
    AND mes BETWEEN DATE('{mes_inicio.isoformat()}') AND DATE('{mes_corte.isoformat()}')
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
    AND t.c_fecha_factura BETWEEN DATE('{mes_inicio.isoformat()}') AND LAST_DAY(DATE('{mes_corte.isoformat()}'))
  GROUP BY 1, 2
)
SELECT
  COALESCE(rev_mm_bet.mes, tape_sum.mes)       AS mes,
  COALESCE(rev_mm_bet.m_pais, tape_sum.m_pais) AS m_pais,
  COALESCE(rev_mm_bet.rev_mm_sin_elim, 0)      AS rev_mm_sin_elim,
  COALESCE(rev_mm_bet.rev_mm_con_elim, 0)      AS rev_mm_con_elim,
  COALESCE(tape_sum.tape_sum, 0)               AS tape_sum
FROM rev_mm_bet
FULL OUTER JOIN tape_sum USING (mes, m_pais)
WHERE COALESCE(rev_mm_bet.mes, tape_sum.mes) IS NOT NULL
  AND COALESCE(rev_mm_bet.m_pais, tape_sum.m_pais) IS NOT NULL
""".strip()


def _twin_sum(df: pd.DataFrame, value_col: str = "actuals") -> dict[str, float]:
    s = df[value_col].fillna(0)
    elim_mask = df["dummie_eliminaciones"].fillna(0).isin([1, -1])
    return {
        "sin_elim": float(s[~elim_mask].sum()),
        "solo_elim": float(s[elim_mask].sum()),
        "con_elim": float(s.sum()),
    }


def _facts_plano(df: pd.DataFrame) -> list[dict[str, Any]]:
    rows = []
    keys = ["mes", "m_pais", "c_subsidiaria", "linea", "c_cuenta", "c_cuenta_descripcion", "dummie_ajustes"]
    for vals, g in df.groupby(keys, dropna=False):
        mes, pais, sub, linea, cuenta, desc, ajuste = vals
        rows.append({
            "mes": mes.strftime("%Y-%m"),
            "pais": pais if pd.notna(pais) else None,
            "subsidiaria": sub if pd.notna(sub) else None,
            "linea": linea if pd.notna(linea) else None,
            "cuenta": int(cuenta) if pd.notna(cuenta) else None,
            "cuenta_desc": desc if pd.notna(desc) else None,
            "es_ajuste": bool(pd.notna(ajuste) and ajuste == 1),
            "es_tape_adjustment": False,
            "actuals": _twin_sum(g),
            "budget": _twin_sum(g, "budget"),
        })
    return rows


def _facts_tape_delta(df_delta: pd.DataFrame) -> list[dict[str, Any]]:
    """Una fila sintetica por (mes, pais) con el delta tape − rev_mm_bet.

    Asignamos el delta a la subsidiaria pivot de cada pais. Otras subsidiarias
    quedan con su revenue plano sin ajuste.
    """
    rows = []
    for _, r in df_delta.iterrows():
        pais_label = r["pais_label"]  # 'Colombia' o 'Mexico'
        pivot = SUBSIDIARIA_PIVOT.get(pais_label)
        if pivot is None:
            log.warning("Sin subsidiaria pivot para %s, salto delta tape", pais_label)
            continue
        delta_sin_elim = float(r["tape_sum"] - r["rev_mm_sin_elim"])
        delta_con_elim = float(r["tape_sum"] - r["rev_mm_con_elim"])
        rows.append({
            "mes": r["mes"].strftime("%Y-%m"),
            "pais": pais_label,
            "subsidiaria": pivot,
            "linea": "Market Maker",
            "cuenta": None,
            "cuenta_desc": "Tape Adjustment (c_precio − BET MM)",
            "es_ajuste": False,
            "es_tape_adjustment": True,
            "actuals": {
                "sin_elim": delta_sin_elim,
                "con_elim": delta_con_elim,
                "solo_elim": 0.0,
            },
            "budget": {"sin_elim": 0.0, "con_elim": 0.0, "solo_elim": 0.0},
        })
    return rows


def build(mes_corte: dt.date) -> dict[str, Any]:
    """Construye el payload JSON de Adjusted Revenue."""
    mes_inicio = dt.date(mes_corte.year, mes_corte.month, 1)
    for _ in range(HISTORY_MONTHS - 1):
        prev_last = mes_inicio - dt.timedelta(days=1)
        mes_inicio = dt.date(prev_last.year, prev_last.month, 1)

    log.info("Adj Revenue: query rango %s -> %s", mes_inicio, mes_corte)
    df_plano = run_query(_sql_revenue_plano(mes_inicio, mes_corte), label="adj_ingresos_plano")
    df_delta = run_query(_sql_tape_delta(mes_inicio, mes_corte), label="adj_ingresos_delta")

    # Normalizacion plano
    df_plano["c_subsidiaria"] = df_plano["c_subsidiaria"].map(normalize_subsidiaria)
    df_plano["linea"] = df_plano["m_metrica"].map(METRICA_A_LINEA).fillna("(sin clasificar)")
    df_plano["mes"] = pd.to_datetime(df_plano["mes"])
    df_plano["pais_label"] = df_plano["m_pais"].map(PAIS_LABEL).fillna("(sin pais)")
    df_plano["m_pais"] = df_plano["pais_label"]

    # Normalizacion delta
    df_delta["mes"] = pd.to_datetime(df_delta["mes"])
    df_delta["pais_label"] = df_delta["m_pais"].map(PAIS_LABEL).fillna("(sin pais)")

    meses_disponibles = sorted(df_plano["mes"].dt.strftime("%Y-%m").unique().tolist())

    facts_plano = _facts_plano(df_plano)
    facts_delta = _facts_tape_delta(df_delta)

    log.info(
        "Adj Revenue: %d facts planos + %d facts delta tape (mes mas reciente delta=%s)",
        len(facts_plano),
        len(facts_delta),
        df_delta["mes"].max().strftime("%Y-%m") if not df_delta.empty else "n/a",
    )

    payload: dict[str, Any] = {
        "id": "ingresos_ajustados",
        "nombre": "Adjusted Revenue",
        "seccion": "4.1",
        "unidad": "MONEDA",
        "estado": "real",
        "fuente": (
            "bet_data_p2 (revenue plano) + finance_tapes_global (delta MM via c_precio); "
            "pivot c_fecha_factura. Delta asignado a subsidiaria pivot (Habi CO / Corporativo MX)."
        ),
        "receta": {
            "tabla_revenue": TABLE_BET,
            "tabla_tape": TAPE_TABLE,
            "formula": "Revenue BET − MM Sales BET + Σ tape.c_precio (NIDs BET MM, pivot c_fecha_factura)",
            "interco_excluidos": list(INTERCO_TERCEROS),
            "subsidiaria_pivot": SUBSIDIARIA_PIVOT,
            "budget_ajustado": False,
            "monedas": MONEDA_POR_PAIS,
        },
        "meses_disponibles": meses_disponibles,
        "facts": facts_plano + facts_delta,
    }
    return payload
