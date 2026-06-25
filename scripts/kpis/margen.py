"""KPI 4.1.3 — Gross Margin $ and %.

Fuente: bet_data_p2
  - m_tipo      = '4. Managerial'    (anchored a fecha de factura, vista operativa)
  - m_categoria IN ('01. Total Revenue', '02. Total Costs')

Por que Managerial y no Financials:
  - Financials usa c_total_reporte/c_subtotal_reporte (jerarquia contable),
    anchored a fecha de booking en NetSuite (devengado).
  - Managerial usa m_categoria, anchored a FECHA DE FACTURA (vista operativa).
  - Cambio decidido con Kamila el 2026-06-24 para alinear con la lectura
    operativa del management team.

Estructura de Managerial:
  - c_total_reporte / c_subtotal_reporte vienen NULL (no aplica la jerarquia contable)
  - m_categoria reemplaza: '01. Total Revenue' = revenue, '02. Total Costs' = COGS
  - Medida: actuals_managerial (no actuals_accounting)

Logica:
  - Gross Profit = sum(actuals_managerial) sobre Revenue + Total Costs
    (Revenue positivo, Total Costs negativo, suma da GP)
  - Revenue separado = sum solo sobre m_categoria='01. Total Revenue'
  - Margen % = GP / Revenue (recomputado en cada nivel)

Linea de negocio: se infiere de m_metrica (igual que en Ingresos).
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

# Labels amigables para el bloque del P&L en el drill (mismo patron que contribution)
BLOQUE_LABELS = {
    "01. Total Revenue": "1. Revenue",
    "02. Total Costs":   "2. Cost of Revenue",
}

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
  m_categoria,
  c_cuenta,
  c_cuenta_descripcion,
  dummie_eliminaciones,
  dummie_ajustes,
  SUM(actuals_managerial) AS actuals,
  SUM(budget_1)           AS budget
FROM `{TABLE_BET}`
WHERE m_tipo      = '4. Managerial'
  AND m_categoria IN ('01. Total Revenue', '02. Total Costs')
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
    """Suma solo las filas con m_categoria = '01. Total Revenue' (denominador del %)."""
    rev = df[df["m_categoria"] == "01. Total Revenue"]
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
    keys = ["mes", "m_pais", "c_subsidiaria", "linea", "m_categoria", "c_cuenta", "c_cuenta_descripcion", "dummie_ajustes"]
    for vals, g in df.groupby(keys, dropna=False):
        mes, pais, sub, linea, categoria, cuenta, desc, ajuste = vals
        rows.append({
            "mes": mes.strftime("%Y-%m"),
            "pais": pais if pd.notna(pais) else None,
            "subsidiaria": sub if pd.notna(sub) else None,
            "linea": linea if pd.notna(linea) else None,
            "cuenta": int(cuenta) if pd.notna(cuenta) else None,
            "cuenta_desc": desc if pd.notna(desc) else None,
            "es_ajuste": bool(pd.notna(ajuste) and ajuste == 1),
            "bloque_pyl": BLOQUE_LABELS.get(str(categoria), str(categoria)) if pd.notna(categoria) else None,
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
        "nombre": "Gross Margin",
        "seccion": "4.1",
        "unidad": "MONEDA_CON_RATIO",  # UI muestra $ + ratio %
        "ratio_label": "Margin",
        "estado": "real",
        "fuente": "bet_data_p2 · Managerial · Total Revenue + Total Costs (anchored a fecha factura)",
        "receta": {
            "tabla": TABLE_BET,
            "filtros": [
                "m_tipo = '4. Managerial'",
                "m_categoria IN ('01. Total Revenue', '02. Total Costs')",
            ],
            "calculo": "GP = sum(actuals_managerial); Revenue = sum solo donde m_categoria='01. Total Revenue'; Margen% = GP/Revenue",
            "anchored": "fecha de factura (NO fecha de booking contable)",
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
