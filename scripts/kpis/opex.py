"""KPI 4.1.6 — OpEx / Ingreso.

Fuente: bet_data_p2
  - c_total_reporte = '3 Operating Expenses'
  - m_tipo          = '1. Financials'

Valores: en bet_data_p2 los OpEx vienen NEGATIVOS (convencion contable de gasto).
Aqui los convertimos a POSITIVOS (abs) para lectura natural en el dashboard
("OpEx = $5.7B" en vez de "-$5.7B"). El campo invertir_delta=True en el payload
le dice a la UI que ▲ vs budget es MALO (gastar mas), no bueno.

Linea de negocio: OpEx no se segmenta por business line (es overhead transversal:
Payroll, Tech, Rent, Marketing, etc.). En cada fact emitimos linea=None y la
UI oculta el bloque "Por linea" en el drill cuando aplica.

Ratio: OpEx / Ingresos. Se computa en el frontend usando el KPI de Ingresos
(ratio_against='ingresos_totales') — asi el OpEx no necesita cargar revenue
en su propio JSON.
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
  m_metrica,
  c_cuenta,
  c_cuenta_descripcion,
  dummie_eliminaciones,
  dummie_ajustes,
  -- Convertir gasto a positivo para lectura natural
  -SUM(actuals_accounting) AS actuals,
  -SUM(budget_1)           AS budget
FROM `{TABLE_BET}`
WHERE c_total_reporte = '3 Operating Expenses'
  AND m_tipo          = '1. Financials'
  AND mes BETWEEN DATE('{mes_inicio.isoformat()}') AND DATE('{mes_corte.isoformat()}')
GROUP BY 1, 2, 3, 4, 5, 6, 7, 8
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


def _series_global(df: pd.DataFrame) -> list[dict[str, Any]]:
    out = []
    for mes, sub in df.groupby("mes", dropna=False):
        out.append({
            "mes": mes.strftime("%Y-%m"),
            "actuals": _twin_sum(sub),
            "budget": _twin_sum(sub, "budget"),
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
        })
    for key in out:
        out[key].sort(key=lambda r: r["mes"])
    return out


def _facts(df: pd.DataFrame) -> list[dict[str, Any]]:
    rows = []
    # No incluimos 'linea' como key porque para OpEx no aplica (overhead transversal)
    keys = ["mes", "m_pais", "c_subsidiaria", "m_metrica", "c_cuenta", "c_cuenta_descripcion", "dummie_ajustes"]
    for vals, g in df.groupby(keys, dropna=False):
        mes, pais, sub, metrica, cuenta, desc, ajuste = vals
        rows.append({
            "mes": mes.strftime("%Y-%m"),
            "pais": pais if pd.notna(pais) else None,
            "subsidiaria": sub if pd.notna(sub) else None,
            "linea": None,  # OpEx no tiene business line natural
            "cuenta": int(cuenta) if pd.notna(cuenta) else None,
            "cuenta_desc": desc if pd.notna(desc) else None,
            "categoria_gasto": str(metrica) if pd.notna(metrica) else None,
            "es_ajuste": bool(pd.notna(ajuste) and ajuste == 1),
            "actuals": _twin_sum(g),
            "budget": _twin_sum(g, "budget"),
        })
    return rows


def build(mes_corte: dt.date) -> dict[str, Any]:
    """Construye el payload JSON del KPI OpEx."""
    mes_inicio = dt.date(mes_corte.year, mes_corte.month, 1)
    for _ in range(HISTORY_MONTHS - 1):
        prev_last = mes_inicio - dt.timedelta(days=1)
        mes_inicio = dt.date(prev_last.year, prev_last.month, 1)

    log.info("OpEx: query rango %s -> %s", mes_inicio, mes_corte)
    df = run_query(_sql(mes_inicio, mes_corte), label="opex")

    df["c_subsidiaria"] = df["c_subsidiaria"].map(normalize_subsidiaria)
    df["mes"] = pd.to_datetime(df["mes"])  # type: ignore[assignment]
    df["pais_label"] = df["m_pais"].map(PAIS_LABEL).fillna("(sin pais)")
    df["m_pais"] = df["pais_label"]

    meses_disponibles = sorted(df["mes"].dt.strftime("%Y-%m").unique().tolist())

    payload: dict[str, Any] = {
        "id": "opex_ingreso",
        "nombre": "OpEx",
        "seccion": "4.1",
        "unidad": "MONEDA",
        "estado": "real",
        "fuente": "bet_data_p2 · c_total_reporte='3 Operating Expenses' · Financials",
        "ratio_against": "ingresos_ajustados",
        "ratio_label": "OpEx/Adj. Rev.",
        "invertir_delta": True,  # mas OpEx = peor (rojo)
        "receta": {
            "tabla": TABLE_BET,
            "filtros": [
                "c_total_reporte = '3 Operating Expenses'",
                "m_tipo = '1. Financials'",
            ],
            "transformacion": "Valores convertidos a positivos (abs) para lectura natural",
            "categorias": "11 categorias en m_metrica (Payroll, Tech, Rent, Marketing, etc.)",
            "monedas": MONEDA_POR_PAIS,
        },
        "meses_disponibles": meses_disponibles,
        "series": {
            "global": _series_global(df),
            "por_pais": _series_indexada(df, "m_pais"),
            "por_subsidiaria": _series_indexada(df, "c_subsidiaria"),
            "por_linea": {},  # OpEx no tiene business line
        },
        "facts": _facts(df),
    }
    return payload
