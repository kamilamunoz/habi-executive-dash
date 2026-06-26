"""KPI 4.1.1 — Ingresos totales.

Fuente: bet_data_p2
  - m_categoria = '01. Total Revenue'
  - m_tipo      = '1. Financials'          (P&L contable, no managerial)
  - m_metrica  != '01. Total Revenue'      (excluye el marcador agregado)

NOTA si los valores no cuadran con tus referencias:
  Sospechoso #1 es la exclusion del marcador 'm_metrica = 01. Total Revenue'.
  Son 864 filas con suma NULL en la mayoria de meses, pero si en algun mes
  el upstream metiera valores ahi, los estariamos perdiendo. Si pasa,
  cambia el filtro y recomputa.

Linea de negocio: se infiere de m_metrica (no usar m_negocio).
  '01. Market Maker Sales (selling price)' -> Market Maker
  '02. Brokerage Sales'                    -> Brokerage
  '03. HabiCredit'                         -> HabiCredit
  '04. Other Products'                     -> Other

Eliminaciones: se reportan en columnas paralelas (sin/con/solo) por fila.

Estructura del JSON:
  - meses_disponibles: lista YYYY-MM ordenada (para selector de mes)
  - series: serie temporal preagregada por nivel (global, por pais, subsidiaria,
            linea). Solo se usa para sparklines rapidos.
  - facts: lista de filas crudas. Cada fila tiene:
      mes, pais, subsidiaria, linea, cuenta, cuenta_desc,
      actuals: {sin_elim, con_elim, solo_elim}, budget: {...}
    El frontend filtra y agrega sobre esta lista para todos los drill-downs.
    Esto permite respetar la jerarquia completa de filtros (pais > subsidiaria
    > linea > cuenta) sin precomputar cada combinacion.
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
    "01. Market Maker Sales (selling price)": "Market Maker",
    "02. Brokerage Sales": "Brokerage",
    "03. HabiCredit": "HabiCredit",
    "04. Other Products": "Other",
}


def _sql(mes_inicio: dt.date, mes_corte: dt.date) -> str:
    return f"""
SELECT
  mes,
  m_pais,
  c_subsidiaria,
  m_metrica,
  m_submetrica,
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
GROUP BY 1, 2, 3, 4, 5, 6, 7, 8, 9
""".strip()


def _twin_sum(df: pd.DataFrame, value_col: str = "actuals") -> dict[str, float]:
    """Suma de un campo en 3 sabores. NULL en dummie_eliminaciones se trata
    como no-eliminacion (con fillna)."""
    s = df[value_col].fillna(0)
    # dummie_eliminaciones puede ser 1 (ajustes agregados, cuenta NULL) o -1
    # (contrapartidas reales con cuenta, ej. "96. Eliminacion INTERCOMPANIAS").
    # Ambos son eliminaciones intercompania y deben excluirse del sin_elim.
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
    """Agrupa el df a la granularidad (mes, pais, subsidiaria, linea, cuenta)
    y emite cada fila con actuals/budget en sus 3 sabores de eliminacion.
    """
    rows = []
    keys = ["mes", "m_pais", "c_subsidiaria", "linea", "m_submetrica", "c_cuenta", "c_cuenta_descripcion", "dummie_ajustes"]
    for vals, g in df.groupby(keys, dropna=False):
        mes, pais, sub, linea, submetrica, cuenta, desc, ajuste = vals
        rows.append({
            "mes": mes.strftime("%Y-%m"),
            "pais": pais if pd.notna(pais) else None,
            "subsidiaria": sub if pd.notna(sub) else None,
            "linea": linea if pd.notna(linea) else None,
            "submetrica": str(submetrica) if pd.notna(submetrica) else None,
            "cuenta": int(cuenta) if pd.notna(cuenta) else None,
            "cuenta_desc": desc if pd.notna(desc) else None,
            "es_ajuste": bool(pd.notna(ajuste) and ajuste == 1),
            "actuals": _twin_sum(g),
            "budget": _twin_sum(g, "budget"),
        })
    return rows


def build(mes_corte: dt.date) -> dict[str, Any]:
    """Construye el payload JSON del KPI Ingresos."""
    mes_inicio = dt.date(mes_corte.year, mes_corte.month, 1)
    for _ in range(HISTORY_MONTHS - 1):
        prev_last = mes_inicio - dt.timedelta(days=1)
        mes_inicio = dt.date(prev_last.year, prev_last.month, 1)

    log.info("Ingresos: query rango %s -> %s", mes_inicio, mes_corte)
    df = run_query(_sql(mes_inicio, mes_corte), label="ingresos")

    # Normalizar
    df["c_subsidiaria"] = df["c_subsidiaria"].map(normalize_subsidiaria)
    df["linea"] = df["m_metrica"].map(METRICA_A_LINEA).fillna("(sin clasificar)")
    df["mes"] = pd.to_datetime(df["mes"])  # type: ignore[assignment]
    df["pais_label"] = df["m_pais"].map(PAIS_LABEL).fillna("(sin pais)")
    df["m_pais"] = df["pais_label"]

    meses_disponibles = sorted(df["mes"].dt.strftime("%Y-%m").unique().tolist())

    payload: dict[str, Any] = {
        "id": "ingresos_totales",
        "nombre": "Total Revenue",
        "seccion": "4.1",
        "unidad": "MONEDA",
        "estado": "real",
        "summary_field": "submetrica",
        "summary_label": "By revenue detail",
        "fuente": (
            "bet_data_p2 · m_categoria='01. Total Revenue' · m_tipo='1. Financials'"
        ),
        "receta": {
            "tabla": TABLE_BET,
            "filtros": [
                "m_categoria = '01. Total Revenue'",
                "m_tipo = '1. Financials'",
                "m_metrica != '01. Total Revenue' (excluye marcador agregado)",
            ],
            "linea_negocio": "se infiere de m_metrica (no de m_negocio)",
            "eliminaciones": "dummie_eliminaciones=1 → solo_elim; NULL/-1 → sin_elim",
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
