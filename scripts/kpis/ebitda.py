"""KPI 4.1.5 — EBITDA y margen EBITDA.

Fuente: bet_data_p2
  - m_tipo = '1. Financials'
  - c_total_reporte IN ('1 Gross Profit', '2 Other Costs', '3 Operating Expenses')

EBITDA = Revenue
       + Cost of Revenue (negativo)
       + Other Costs (Transaction, Inventory, Commercial — negativo)
       + Operating Expenses (Payroll, Tech, Rent, etc. — negativo)

Excluido por definicion: '4 Other (Income) Expense Net' (incluye D&A,
financieros, otros) y '4 Total Income Taxes'.

Linea de negocio:
  EBITDA NO se segmenta por business line en este builder porque OpEx es
  transversal (overhead corporativo) y allocations a MM/Brokerage/HC serian
  subjetivas. linea queda en None y la UI oculta el bloque por linea para
  este KPI. Si en el futuro quieren EBITDA por linea, hay que decidir la
  regla de allocation de OpEx con Finanzas.

Ratio Margen EBITDA = EBITDA / Revenue
  Revenue se computa por separado igual que en Margen (c_subtotal_reporte='1 Revenue').
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


def _sql(mes_inicio: dt.date, mes_corte: dt.date) -> str:
    return f"""
SELECT
  mes,
  m_pais,
  c_subsidiaria,
  c_total_reporte,
  c_subtotal_reporte,
  c_cuenta,
  c_cuenta_descripcion,
  dummie_eliminaciones,
  dummie_ajustes,
  SUM(actuals_accounting) AS actuals,
  SUM(budget_1)           AS budget
FROM `{TABLE_BET}`
WHERE m_tipo = '1. Financials'
  AND c_total_reporte IN ('1 Gross Profit', '2 Other Costs', '3 Operating Expenses')
  AND mes BETWEEN DATE('{mes_inicio.isoformat()}') AND DATE('{mes_corte.isoformat()}')
GROUP BY 1, 2, 3, 4, 5, 6, 7, 8, 9
""".strip()


def _twin_sum(df: pd.DataFrame, value_col: str = "actuals") -> dict[str, float]:
    s = df[value_col].fillna(0)
    # Trata 1 y -1 como eliminacion (ambos son intercompania).
    elim_mask = df["dummie_eliminaciones"].fillna(0).isin([1, -1])
    return {
        "sin_elim": float(s[~elim_mask].sum()),
        "solo_elim": float(s[elim_mask].sum()),
        "con_elim": float(s.sum()),
    }


def _twin_sum_revenue(df: pd.DataFrame, value_col: str = "actuals") -> dict[str, float]:
    """Suma solo c_total_reporte='1 Gross Profit' Y c_subtotal_reporte='1 Revenue'."""
    rev = df[
        (df["c_total_reporte"] == "1 Gross Profit")
        & (df["c_subtotal_reporte"] == "1 Revenue")
    ]
    return _twin_sum(rev, value_col)


def _series_global(df: pd.DataFrame) -> list[dict[str, Any]]:
    out = []
    for mes, sub in df.groupby("mes", dropna=False):
        out.append({
            "mes": mes.strftime("%Y-%m"),
            "actuals": _twin_sum(sub),
            "budget": _twin_sum(sub, "budget"),
            "revenue_actuals": _twin_sum_revenue(sub),
            "revenue_budget":  _twin_sum_revenue(sub, "budget"),
        })
    out.sort(key=lambda r: r["mes"])
    return out


def _series_indexada(df: pd.DataFrame, group_col: str) -> dict[str, list[dict[str, Any]]]:
    out: dict[str, list[dict[str, Any]]] = {}
    for (grupo, mes), sub in df.groupby([group_col, "mes"], dropna=False):
        key = grupo if pd.notna(grupo) else "(sin asignar)"
        out.setdefault(key, []).append({
            "mes": mes.strftime("%Y-%m"),
            "actuals": _twin_sum(sub),
            "budget": _twin_sum(sub, "budget"),
            "revenue_actuals": _twin_sum_revenue(sub),
            "revenue_budget":  _twin_sum_revenue(sub, "budget"),
        })
    for key in out:
        out[key].sort(key=lambda r: r["mes"])
    return out


def _facts(df: pd.DataFrame) -> list[dict[str, Any]]:
    """Granularidad: mes, pais, subsidiaria, c_total_reporte, cuenta.

    linea queda en None (EBITDA no se segmenta por business line).
    Conservamos c_total_reporte como dimension extra para el detalle: el drill
    de EBITDA puede mostrar el desglose entre Gross Profit / Other Costs / OpEx.
    """
    rows = []
    keys = ["mes", "m_pais", "c_subsidiaria", "c_total_reporte", "c_cuenta", "c_cuenta_descripcion", "dummie_ajustes"]
    for vals, g in df.groupby(keys, dropna=False):
        mes, pais, sub, tot_rep, cuenta, desc, ajuste = vals
        rows.append({
            "mes": mes.strftime("%Y-%m"),
            "pais": pais if pd.notna(pais) else None,
            "subsidiaria": sub if pd.notna(sub) else None,
            "linea": None,  # EBITDA no se segmenta por business line
            "cuenta": int(cuenta) if pd.notna(cuenta) else None,
            "cuenta_desc": desc if pd.notna(desc) else None,
            "es_ajuste": bool(pd.notna(ajuste) and ajuste == 1),
            "bloque_pyl": str(tot_rep) if pd.notna(tot_rep) else None,  # GP / OC / OpEx
            "actuals": _twin_sum(g),
            "budget": _twin_sum(g, "budget"),
            "revenue_actuals": _twin_sum_revenue(g),
            "revenue_budget":  _twin_sum_revenue(g, "budget"),
        })
    return rows


def build(mes_corte: dt.date) -> dict[str, Any]:
    """Construye el payload JSON del KPI EBITDA."""
    mes_inicio = dt.date(mes_corte.year, mes_corte.month, 1)
    for _ in range(HISTORY_MONTHS - 1):
        prev_last = mes_inicio - dt.timedelta(days=1)
        mes_inicio = dt.date(prev_last.year, prev_last.month, 1)

    log.info("EBITDA: query rango %s -> %s", mes_inicio, mes_corte)
    df = run_query(_sql(mes_inicio, mes_corte), label="ebitda")

    df["c_subsidiaria"] = df["c_subsidiaria"].map(normalize_subsidiaria)
    df["mes"] = pd.to_datetime(df["mes"])  # type: ignore[assignment]
    df["pais_label"] = df["m_pais"].map(PAIS_LABEL).fillna("(sin pais)")
    df["m_pais"] = df["pais_label"]

    meses_disponibles = sorted(df["mes"].dt.strftime("%Y-%m").unique().tolist())

    payload: dict[str, Any] = {
        "id": "ebitda",
        "nombre": "EBITDA",
        "seccion": "4.1",
        "unidad": "MONEDA_CON_RATIO",
        "ratio_label": "EBITDA / Adj. Rev.",
        "ratio_against": "ingresos_ajustados",
        "estado": "real",
        "fuente": "bet_data_p2 · Gross Profit + Other Costs + Operating Expenses",
        "receta": {
            "tabla": TABLE_BET,
            "filtros": [
                "m_tipo = '1. Financials'",
                "c_total_reporte IN ('1 Gross Profit', '2 Other Costs', '3 Operating Expenses')",
            ],
            "calculo": "EBITDA = sum(actuals); Revenue = sum donde c_total_reporte='1 Gross Profit' AND c_subtotal_reporte='1 Revenue'; Margen% = EBITDA/Revenue",
            "linea_negocio": "no aplica — EBITDA agrupable por pais/subsidiaria pero no por linea (allocations de OpEx subjetivas)",
            "excluido": "D&A, financieros, taxes — quedan en c_total_reporte = '4 Other (Income) Expense Net' y '4 Total Income Taxes'",
            "monedas": MONEDA_POR_PAIS,
        },
        "meses_disponibles": meses_disponibles,
        "series": {
            "global": _series_global(df),
            "por_pais": _series_indexada(df, "m_pais"),
            "por_subsidiaria": _series_indexada(df, "c_subsidiaria"),
            "por_linea": {},  # EBITDA no se segmenta por linea
        },
        "facts": _facts(df),
    }
    return payload
