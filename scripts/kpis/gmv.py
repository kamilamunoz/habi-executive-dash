"""KPI 4.1.2 — GMV / Valor transado.

Fuente: bet_data_p2 · m_tipo='2. Transactions'.

Receta (Opcion A + HC Loans Disbursed, segun acuerdo con Kamila 2026-06-24):
  - dummie_gmv = 1                          (ventas MM a Purchase price)
  - OR m_categoria='04. Habicredit'
       AND m_metrica='03. Loans Disbursed' (creditos desembolsados)

Linea de negocio se infiere de m_categoria:
  '01. Market Maker' -> Market Maker
  '04. Habicredit'   -> HabiCredit

Medida: actuals_managerial (lo que reporta operacion, alineado con el caracter
operativo del GMV vs el contable de Ingresos).

OJO con la estructura de bet_data_p2 para Transactions:
  - c_subsidiaria es NULL en estas filas (no hay info contable de subsidiaria)
  - c_cuenta es NULL (no aplica plan de cuentas a transactions operativas)
  - dummie_eliminaciones tambien NULL (no hay eliminaciones intercompania
    de transactions; estas son metricas brutas)
  En la fact table se emiten como None y el frontend los maneja como
  '(sin asignar)' o oculta el bloque cuando no hay info.
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

CATEGORIA_A_LINEA = {
    "01. Market Maker": "Market Maker",
    "04. Habicredit": "HabiCredit",
}


def _sql(mes_inicio: dt.date, mes_corte: dt.date) -> str:
    return f"""
SELECT
  mes,
  m_pais,
  c_subsidiaria,
  m_categoria,
  m_metrica,
  m_submetrica,
  c_cuenta,
  c_cuenta_descripcion,
  dummie_eliminaciones,
  SUM(actuals_managerial) AS actuals,
  SUM(budget_1)           AS budget
FROM `{TABLE_BET}`
WHERE m_tipo = '2. Transactions'
  AND (
    dummie_gmv = 1
    OR (m_categoria = '04. Habicredit' AND m_metrica = '03. Loans Disbursed')
  )
  AND mes BETWEEN DATE('{mes_inicio.isoformat()}') AND DATE('{mes_corte.isoformat()}')
GROUP BY 1, 2, 3, 4, 5, 6, 7, 8, 9
""".strip()


def _twin_sum(df: pd.DataFrame, value_col: str = "actuals") -> dict[str, float]:
    """Misma logica que ingresos.py — 3 sabores de eliminacion.

    Para GMV en la practica dummie_eliminaciones es siempre NULL (transactions
    brutas no tienen intercompany), pero mantenemos la misma estructura por
    consistencia con la UI.
    """
    s = df[value_col].fillna(0)
    elim_mask = df["dummie_eliminaciones"].fillna(0).eq(1)
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
    """Para GMV el detalle granular es la submetrica (ej. 'Sale Deeds Alianzas').
    cuenta y subsidiaria quedan en None porque bet_data_p2 no los trae para
    Transactions.
    """
    rows = []
    keys = ["mes", "m_pais", "c_subsidiaria", "linea", "m_categoria", "m_metrica", "m_submetrica"]
    for vals, g in df.groupby(keys, dropna=False):
        mes, pais, sub, linea, categoria, metrica, submetrica = vals
        # Combinamos categoria + metrica + submetrica como la descripcion del detalle
        detalle_partes = [str(metrica), str(submetrica)] if pd.notna(submetrica) else [str(metrica)]
        detalle = " · ".join(p for p in detalle_partes if p and p != "nan")
        rows.append({
            "mes": mes.strftime("%Y-%m"),
            "pais": pais if pd.notna(pais) else None,
            "subsidiaria": sub if pd.notna(sub) else None,
            "linea": linea if pd.notna(linea) else None,
            "cuenta": None,
            "cuenta_desc": detalle,
            "actuals": _twin_sum(g),
            "budget": _twin_sum(g, "budget"),
        })
    return rows


def build(mes_corte: dt.date) -> dict[str, Any]:
    """Construye el payload JSON del KPI GMV."""
    mes_inicio = dt.date(mes_corte.year, mes_corte.month, 1)
    for _ in range(HISTORY_MONTHS - 1):
        prev_last = mes_inicio - dt.timedelta(days=1)
        mes_inicio = dt.date(prev_last.year, prev_last.month, 1)

    log.info("GMV: query rango %s -> %s", mes_inicio, mes_corte)
    df = run_query(_sql(mes_inicio, mes_corte), label="gmv")

    df["c_subsidiaria"] = df["c_subsidiaria"].map(normalize_subsidiaria)
    df["linea"] = df["m_categoria"].map(CATEGORIA_A_LINEA).fillna("(sin clasificar)")
    df["mes"] = pd.to_datetime(df["mes"])  # type: ignore[assignment]
    df["pais_label"] = df["m_pais"].map(PAIS_LABEL).fillna("(sin pais)")
    df["m_pais"] = df["pais_label"]

    meses_disponibles = sorted(df["mes"].dt.strftime("%Y-%m").unique().tolist())

    payload: dict[str, Any] = {
        "id": "gmv",
        "nombre": "GMV / Valor transado",
        "seccion": "4.1",
        "unidad": "MONEDA",
        "estado": "real",
        "fuente": "bet_data_p2 · Transactions · dummie_gmv=1 + HC Loans Disbursed",
        "receta": {
            "tabla": TABLE_BET,
            "opcion": "A (solo dummie_gmv=1) + HC Loans Disbursed",
            "filtros": [
                "m_tipo = '2. Transactions'",
                "dummie_gmv = 1  -- ventas MM valuadas a Purchase price",
                "OR m_categoria='04. Habicredit' AND m_metrica='03. Loans Disbursed'",
            ],
            "medida": "actuals_managerial (operativo, no accounting)",
            "notas": [
                "GMV es operativo: no tiene c_subsidiaria ni c_cuenta en bet_data_p2.",
                "Drill-down granular usa la submetrica (Tradicional / Alianzas / HC100 / etc.)",
                "Opcion A excluye compras MM y Brokerage por convencion de Habi.",
            ],
            "monedas": MONEDA_POR_PAIS,
        },
        "meses_disponibles": meses_disponibles,
        "series": {
            "global": _series_global(df),
            "por_pais": _series_indexada(df, "m_pais"),
            "por_subsidiaria": _series_indexada(df, "c_subsidiaria"),  # quedara vacio
            "por_linea": _series_indexada(df, "linea"),
        },
        "facts": _facts(df),
    }
    return payload
