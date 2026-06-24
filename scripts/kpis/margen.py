"""KPI 4.1.3 — Margen bruto $ y %.

Fuente: bet_data_p2
  - c_total_reporte = '1 Gross Profit'  (incluye Revenue + Cost of Revenue)
  - m_tipo          = '1. Financials'   (P&L contable)

Logica:
  - Gross Profit = sum(actuals_accounting) sobre todas las filas del scope
    (porque Revenue es positivo y Cost of Revenue es negativo, la suma da GP)
  - Revenue separado = sum(actuals_accounting) solo sobre c_subtotal_reporte='1 Revenue'
  - Margen % = GP / Revenue   (calculado en cada nivel de agregacion)

Por eso emitimos DOS medidas paralelas en cada fact:
  - actuals         -> Gross Profit ($)
  - revenue_actuals -> Revenue ($)
La UI suma ambas independientemente y divide al final para obtener el % correcto
a cualquier nivel de agregacion (no se puede promediar %, hay que recomputar).

Linea de negocio: igual que Ingresos, se infiere de m_metrica.
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

METRICA_A_LINEA = {
    # Revenue side
    "01. Market Maker Sales (selling price)": "Market Maker",
    "02. Brokerage Sales": "Brokerage",
    "03. HabiCredit": "HabiCredit",
    "04. Other Products": "Other",
    # Cost of Revenue side — explorado 2026-06-24 contra bet_data_p2
    "01. Market Maker Cost of sales (Purchase price)": "Market Maker",
    "01. Remodeling Costs": "Market Maker",  # las remodelaciones son MM
    "02. Brokerage Costs": "Brokerage",
    "03. HabiCredit Costs": "HabiCredit",
}


def _sql(mes_inicio: dt.date, mes_corte: dt.date) -> str:
    return f"""
SELECT
  mes,
  m_pais,
  c_subsidiaria,
  m_metrica,
  c_subtotal_reporte,
  c_cuenta,
  c_cuenta_descripcion,
  dummie_eliminaciones,
  SUM(actuals_accounting) AS actuals,
  SUM(budget_1)           AS budget
FROM `{TABLE_BET}`
WHERE c_total_reporte = '1 Gross Profit'
  AND m_tipo          = '1. Financials'
  AND mes BETWEEN DATE('{mes_inicio.isoformat()}') AND DATE('{mes_corte.isoformat()}')
GROUP BY 1, 2, 3, 4, 5, 6, 7, 8
""".strip()


def _twin_sum(df: pd.DataFrame, value_col: str = "actuals") -> dict[str, float]:
    s = df[value_col].fillna(0)
    elim_mask = df["dummie_eliminaciones"].fillna(0).eq(1)
    return {
        "sin_elim": float(s[~elim_mask].sum()),
        "solo_elim": float(s[elim_mask].sum()),
        "con_elim": float(s.sum()),
    }


def _twin_sum_revenue(df: pd.DataFrame, value_col: str = "actuals") -> dict[str, float]:
    """Suma solo las filas con c_subtotal_reporte = '1 Revenue' (denominador del %)."""
    rev = df[df["c_subtotal_reporte"] == "1 Revenue"]
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
    """Cada fila lleva actuals (GP), revenue_actuals (denominador), budget y revenue_budget."""
    rows = []
    keys = ["mes", "m_pais", "c_subsidiaria", "linea", "c_cuenta", "c_cuenta_descripcion"]
    for vals, g in df.groupby(keys, dropna=False):
        mes, pais, sub, linea, cuenta, desc = vals
        rows.append({
            "mes": mes.strftime("%Y-%m"),
            "pais": pais if pd.notna(pais) else None,
            "subsidiaria": sub if pd.notna(sub) else None,
            "linea": linea if pd.notna(linea) else None,
            "cuenta": int(cuenta) if pd.notna(cuenta) else None,
            "cuenta_desc": desc if pd.notna(desc) else None,
            "actuals": _twin_sum(g),
            "budget": _twin_sum(g, "budget"),
            "revenue_actuals": _twin_sum_revenue(g),
            "revenue_budget":  _twin_sum_revenue(g, "budget"),
        })
    return rows


def build(mes_corte: dt.date) -> dict[str, Any]:
    """Construye el payload JSON del KPI Margen bruto."""
    mes_inicio = dt.date(mes_corte.year, mes_corte.month, 1)
    for _ in range(HISTORY_MONTHS - 1):
        prev_last = mes_inicio - dt.timedelta(days=1)
        mes_inicio = dt.date(prev_last.year, prev_last.month, 1)

    log.info("Margen: query rango %s -> %s", mes_inicio, mes_corte)
    df = run_query(_sql(mes_inicio, mes_corte), label="margen")

    df["c_subsidiaria"] = df["c_subsidiaria"].map(normalize_subsidiaria)
    df["linea"] = df["m_metrica"].map(METRICA_A_LINEA).fillna("(sin clasificar)")
    df["mes"] = pd.to_datetime(df["mes"])  # type: ignore[assignment]
    df["pais_label"] = df["m_pais"].map(PAIS_LABEL).fillna("(sin pais)")
    df["m_pais"] = df["pais_label"]

    meses_disponibles = sorted(df["mes"].dt.strftime("%Y-%m").unique().tolist())

    payload: dict[str, Any] = {
        "id": "margen_bruto",
        "nombre": "Margen bruto",
        "seccion": "4.1",
        "unidad": "MONEDA_CON_RATIO",  # UI muestra $ + ratio %
        "ratio_label": "Margen",
        "estado": "real",
        "fuente": "bet_data_p2 · c_total_reporte='1 Gross Profit' · m_tipo='1. Financials'",
        "receta": {
            "tabla": TABLE_BET,
            "filtros": [
                "c_total_reporte = '1 Gross Profit'",
                "m_tipo = '1. Financials'",
            ],
            "calculo": "GP = sum(actuals_accounting); Revenue = sum solo donde c_subtotal_reporte='1 Revenue'; Margen% = GP/Revenue",
            "linea_negocio": "se infiere de m_metrica (no de m_negocio)",
            "monedas": MONEDA_POR_PAIS,
        },
        "meses_disponibles": meses_disponibles,
        "series": {
            "global": _series_global(df),
            "por_pais": _series_indexada(df, "m_pais"),
            "por_subsidiaria": _series_indexada(df, "c_subsidiaria"),
            "por_linea": _series_indexada(df, "linea"),
        },
        "facts": _facts(df),
    }
    return payload
