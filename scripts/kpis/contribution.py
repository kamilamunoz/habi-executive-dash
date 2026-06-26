"""KPI 4.1.4 — Contribution margin $ y %.

Definicion (acordada con Kamila 2026-06-24):
  Contribution = Revenue - Cost of Revenue - Other Costs (Unit Costs)
               = sum(actuals) sobre c_total_reporte IN ('1 Gross Profit', '2 Other Costs')

Donde:
  - '1 Gross Profit' = Revenue (positivo) + Cost of Revenue (negativo)
  - '2 Other Costs'  = Transaction Costs + Inventory Costs (Holding) + Commercial Costs (todos negativos)

Conceptualmente: lo que queda despues de los costos *por transaccion*, antes de OpEx.
Es la pieza entre Gross Margin y EBITDA — captura todos los unit costs directos
pero excluye el overhead fijo.

Buckets disjuntos verificados: '1 Gross Profit' y '2 Other Costs' no se traslapan
en bet_data_p2 (chequeado 2026-06-24).

Linea de negocio: NO se segmenta. Other Costs (Transaction, Holding, Commercial)
son cross-business — sus m_metricas son genericas, no especificas por linea.
Para Contribution por linea se requiere una regla de allocation que excede el
alcance de v1. linea queda en None y la UI oculta el bloque por linea.

Ratio Margen Contribution = Contribution / Revenue
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

# Labels amigables para el bloque del P&L en el drill
# Prefijo numerico para orden canonico en la UI (la UI ordena por ese prefijo).
BLOQUE_LABELS = {
    ("1 Gross Profit", "1 Revenue"):            "1. Revenue",
    ("1 Gross Profit", "2 Cost of Revenue"):    "2. Cost of Revenue (purchase price)",
    ("2 Other Costs",  "3 Transaction Costs"):  "3. Transaction Costs",
    ("2 Other Costs",  "4 Inventory Costs"):    "4. Holding Costs",
    ("2 Other Costs",  "5 Commercial Costs"):   "5. Commercial Costs",
}


def _sql(mes_inicio: dt.date, mes_corte: dt.date) -> str:
    return f"""
SELECT
  mes,
  m_pais,
  c_subsidiaria,
  c_total_reporte,
  c_subtotal_reporte,
  m_metrica,
  c_cuenta,
  c_cuenta_descripcion,
  dummie_eliminaciones,
  dummie_ajustes,
  SUM(actuals_accounting) AS actuals,
  SUM(budget_1)           AS budget
FROM `{TABLE_BET}`
WHERE m_tipo = '1. Financials'
  AND c_total_reporte IN ('1 Gross Profit', '2 Other Costs')
  AND mes BETWEEN DATE('{mes_inicio.isoformat()}') AND DATE('{mes_corte.isoformat()}')
GROUP BY 1, 2, 3, 4, 5, 6, 7, 8, 9, 10
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
    """Suma solo c_total_reporte='1 Gross Profit' AND c_subtotal_reporte='1 Revenue'."""
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
    rows = []
    keys = ["mes", "m_pais", "c_subsidiaria", "c_total_reporte", "c_subtotal_reporte", "m_metrica", "c_cuenta", "c_cuenta_descripcion", "dummie_ajustes"]
    for vals, g in df.groupby(keys, dropna=False):
        mes, pais, sub, tot_rep, sub_rep, metrica, cuenta, desc, ajuste = vals
        rows.append({
            "mes": mes.strftime("%Y-%m"),
            "pais": pais if pd.notna(pais) else None,
            "subsidiaria": sub if pd.notna(sub) else None,
            "linea": None,  # Contribution no se segmenta por linea en v1
            "cuenta": int(cuenta) if pd.notna(cuenta) else None,
            "cuenta_desc": desc if pd.notna(desc) else None,
            "es_ajuste": bool(pd.notna(ajuste) and ajuste == 1),
            "bloque_pyl": BLOQUE_LABELS.get((str(tot_rep), str(sub_rep)), f"{tot_rep} · {sub_rep}") if pd.notna(tot_rep) else None,
            "metrica": str(metrica) if pd.notna(metrica) else None,
            "actuals": _twin_sum(g),
            "budget": _twin_sum(g, "budget"),
            "revenue_actuals": _twin_sum_revenue(g),
            "revenue_budget":  _twin_sum_revenue(g, "budget"),
        })
    return rows


def build(mes_corte: dt.date, mes_max: dt.date | None = None) -> dict[str, Any]:
    """Construye el payload JSON del KPI Contribution Margin."""
    if mes_max is None:
        mes_max = mes_corte
    mes_inicio = dt.date(mes_corte.year, mes_corte.month, 1)
    for _ in range(HISTORY_MONTHS - 1):
        prev_last = mes_inicio - dt.timedelta(days=1)
        mes_inicio = dt.date(prev_last.year, prev_last.month, 1)

    log.info("Contribution: query rango %s -> %s", mes_inicio, mes_max)
    df = run_query(_sql(mes_inicio, mes_max), label="contribution")

    df["c_subsidiaria"] = df["c_subsidiaria"].map(normalize_subsidiaria)
    df["mes"] = pd.to_datetime(df["mes"])  # type: ignore[assignment]
    df["pais_label"] = df["m_pais"].map(PAIS_LABEL).fillna("(sin pais)")
    df["m_pais"] = df["pais_label"]

    meses_disponibles = sorted(df["mes"].dt.strftime("%Y-%m").unique().tolist())

    payload: dict[str, Any] = {
        "id": "contribution_margin",
        "nombre": "Contribution Margin",
        "seccion": "4.1",
        "unidad": "MONEDA_CON_RATIO",
        "ratio_label": "Contribution Margin",
        "estado": "real",
        "summary_field": "metrica",
        "summary_label": "By metric",
        "fuente": "bet_data_p2 · Gross Profit + Other Costs · Financials",
        "receta": {
            "tabla": TABLE_BET,
            "filtros": [
                "m_tipo = '1. Financials'",
                "c_total_reporte IN ('1 Gross Profit', '2 Other Costs')",
            ],
            "calculo": "Contribution = Revenue - Cost of Revenue - Other Costs (Transaction + Holding + Commercial); Margen = Contribution / Revenue",
            "linea_negocio": "no aplica — Other Costs son cross-business, requiere allocation rule para segmentar por linea",
            "monedas": MONEDA_POR_PAIS,
        },
        "meses_disponibles": meses_disponibles,
        "series": {
            "global": _series_global(df),
            "por_pais": _series_indexada(df, "m_pais"),
            "por_subsidiaria": _series_indexada(df, "c_subsidiaria"),
            "por_linea": {},
        },
        "facts": _facts(df),
    }
    return payload
