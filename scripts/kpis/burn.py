"""KPI 4.1.7 — Burn neto y runway.

Fuente: bet_data_p2
  - m_tipo = '7. Cash Flow'
  - m_categoria IN (
       '01. Net Income (excl.)',
       '02. Changes in WK',
       '03. Investing Cash Flow',
    )
    (excluye '04. Financing Cash Flow' y '05. Cash BoP')

Cash actual: tomado del Balance Sheet
  - c_total_reporte = '5 Current Assets'
  - c_subtotal_reporte = '1 Cash and Cash Equivalents'

Definiciones (acordadas con Kamila 2026-06-24):
  - Burn neto = -(Net Income + Changes WK + Investing CF)
    (negamos signo para que valor positivo = consume cash, lectura natural)
  - Runway = cash actual / promedio de burn ultimos 3 meses
    (si burn promedio <= 0, empresa genera cash → runway = infinito)

Estructura del JSON:
  Aparte de los campos estandar (series, facts, etc.) agregamos:
  - cash_balances: dict {mes: {pais|subsidiaria: monto}}
    para que el frontend pueda calcular runway respetando los filtros.
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

CATEGORIAS_BURN = (
    "01. Net Income (excl.)",
    "02. Changes in WK",
    "03. Investing Cash Flow",
)


def _sql_burn(mes_inicio: dt.date, mes_corte: dt.date) -> str:
    cats = ", ".join(f"'{c}'" for c in CATEGORIAS_BURN)
    return f"""
SELECT
  mes,
  m_pais,
  c_subsidiaria,
  m_categoria,
  m_metrica,
  c_cuenta,
  c_cuenta_descripcion,
  dummie_eliminaciones,
  dummie_ajustes,
  -- Negamos para que burn positivo = consume cash
  -SUM(actuals_accounting) AS actuals,
  -SUM(budget_1)           AS budget
FROM `{TABLE_BET}`
WHERE m_tipo = '7. Cash Flow'
  AND m_categoria IN ({cats})
  AND mes BETWEEN DATE('{mes_inicio.isoformat()}') AND DATE('{mes_corte.isoformat()}')
GROUP BY 1, 2, 3, 4, 5, 6, 7, 8, 9
""".strip()


def _sql_cash(mes_inicio: dt.date, mes_corte: dt.date) -> str:
    return f"""
SELECT
  mes,
  m_pais,
  c_subsidiaria,
  -- Cash es positivo (es un activo). En bet_data_p2 viene con signo correcto.
  SUM(actuals_accounting) AS cash
FROM `{TABLE_BET}`
WHERE m_tipo = '6. Balance Sheet'
  AND c_total_reporte = '5 Current Assets'
  AND c_subtotal_reporte = '1 Cash and Cash Equivalents'
  AND mes BETWEEN DATE('{mes_inicio.isoformat()}') AND DATE('{mes_corte.isoformat()}')
GROUP BY 1, 2, 3
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
    keys = ["mes", "m_pais", "c_subsidiaria", "m_categoria", "m_metrica", "c_cuenta", "c_cuenta_descripcion", "dummie_ajustes"]
    for vals, g in df.groupby(keys, dropna=False):
        mes, pais, sub, categoria, metrica, cuenta, desc, ajuste = vals
        # En Cash Flow no siempre hay c_cuenta. Usamos m_metrica como descripcion
        # del detalle (ej. "01. Net Income", "02. Inventory") para que el Top 20
        # muestre las lineas reales del flujo.
        detalle = desc if pd.notna(desc) else (str(metrica) if pd.notna(metrica) else None)
        rows.append({
            "mes": mes.strftime("%Y-%m"),
            "pais": pais if pd.notna(pais) else None,
            "subsidiaria": sub if pd.notna(sub) else None,
            "linea": None,
            "cuenta": int(cuenta) if pd.notna(cuenta) else None,
            "cuenta_desc": detalle,
            "categoria_cf": str(categoria) if pd.notna(categoria) else None,
            "es_ajuste": bool(pd.notna(ajuste) and ajuste == 1),
            "actuals": _twin_sum(g),
            "budget": _twin_sum(g, "budget"),
        })
    return rows


def _cash_balances(df_cash: pd.DataFrame) -> dict[str, Any]:
    """Devuelve {mes: {clave: cash}} con claves Global, por_pais, por_sub.

    El frontend usa este dict para calcular runway respetando los filtros del
    usuario.
    """
    out: dict[str, dict[str, Any]] = {}
    for mes_str, dfm in df_cash.groupby(df_cash["mes"].dt.strftime("%Y-%m")):
        global_cash = float(dfm["cash"].fillna(0).sum())
        por_pais = {p: float(g["cash"].fillna(0).sum())
                    for p, g in dfm.groupby("m_pais", dropna=False)
                    if pd.notna(p)}
        por_sub = {s: float(g["cash"].fillna(0).sum())
                   for s, g in dfm.groupby("c_subsidiaria", dropna=False)
                   if pd.notna(s)}
        out[mes_str] = {
            "Global": global_cash,
            "por_pais": por_pais,
            "por_subsidiaria": por_sub,
        }
    return out


def build(mes_corte: dt.date) -> dict[str, Any]:
    """Construye el payload JSON del KPI Burn / Runway."""
    mes_inicio = dt.date(mes_corte.year, mes_corte.month, 1)
    for _ in range(HISTORY_MONTHS - 1):
        prev_last = mes_inicio - dt.timedelta(days=1)
        mes_inicio = dt.date(prev_last.year, prev_last.month, 1)

    log.info("Burn: query rango %s -> %s", mes_inicio, mes_corte)
    df_burn = run_query(_sql_burn(mes_inicio, mes_corte), label="burn")
    log.info("Burn: query cash balance")
    df_cash = run_query(_sql_cash(mes_inicio, mes_corte), label="burn_cash")

    # Normalizar burn
    df_burn["c_subsidiaria"] = df_burn["c_subsidiaria"].map(normalize_subsidiaria)
    df_burn["mes"] = pd.to_datetime(df_burn["mes"])  # type: ignore[assignment]
    df_burn["pais_label"] = df_burn["m_pais"].map(PAIS_LABEL).fillna("(sin pais)")
    df_burn["m_pais"] = df_burn["pais_label"]

    # Normalizar cash
    df_cash["c_subsidiaria"] = df_cash["c_subsidiaria"].map(normalize_subsidiaria)
    df_cash["mes"] = pd.to_datetime(df_cash["mes"])  # type: ignore[assignment]
    df_cash["pais_label"] = df_cash["m_pais"].map(PAIS_LABEL).fillna("(sin pais)")
    df_cash["m_pais"] = df_cash["pais_label"]

    meses_disponibles = sorted(df_burn["mes"].dt.strftime("%Y-%m").unique().tolist())

    payload: dict[str, Any] = {
        "id": "burn_runway",
        "nombre": "Net Burn",
        "seccion": "4.1",
        "unidad": "MONEDA_CON_RUNWAY",  # UI especial: calcular runway con cash_balances
        "ratio_label": "Runway",
        "estado": "real",
        "fuente": "bet_data_p2 · Cash Flow (excl. Financing) + Balance Sheet Cash",
        "invertir_delta": True,  # mas burn = peor
        "burn_avg_meses": 3,    # promedio de N meses para runway
        "receta": {
            "tabla": TABLE_BET,
            "burn_filtros": [
                "m_tipo = '7. Cash Flow'",
                "m_categoria IN (Net Income, Changes in WK, Investing CF)",
                "Excluye Financing CF y Cash BoP",
            ],
            "cash_filtros": [
                "m_tipo = '6. Balance Sheet'",
                "c_subtotal_reporte = '1 Cash and Cash Equivalents'",
            ],
            "burn_formula": "burn = -(Net Income + Changes WK + Investing CF). Positivo = consume cash.",
            "runway_formula": "runway = cash actual / promedio de burn ultimos 3 meses",
            "monedas": MONEDA_POR_PAIS,
        },
        "meses_disponibles": meses_disponibles,
        "series": {
            "global": _series_global(df_burn),
            "por_pais": _series_indexada(df_burn, "m_pais"),
            "por_subsidiaria": _series_indexada(df_burn, "c_subsidiaria"),
            "por_linea": {},  # Burn no se segmenta por linea
        },
        "facts": _facts(df_burn),
        "cash_balances": _cash_balances(df_cash),
    }
    return payload
