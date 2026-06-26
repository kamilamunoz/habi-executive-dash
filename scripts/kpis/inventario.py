"""KPI 4.2.1 — Inventory on books.

Fuente principal (books):
  bet_data_p2
    m_tipo      = '3. Drivers'
    m_categoria = '03. Balance General'
    m_metrica   = '03. Inventory'

Reconciliacion (operativo): finance_tapes_global
  NIDs vivos al cierre de cada mes (`v_fecha_escritura <= cierre AND
  (c_fecha_escritura IS NULL OR c_fecha_escritura > cierre) AND
  desistimientos = 'No desistidos'`), valuados a `v_precio` (precio compra).

Para mayo 2026 CO los dos coinciden ($218B) — BET drivers viene alimentado
del tape v_precio. Cualquier delta significativo es un hallazgo de control:
un NID que figura en libros pero no en operativo (o viceversa) sugiere un
timing/registry issue.

Granularidad:
- BET drivers no tiene `c_subsidiaria` ni `nid` poblado para esta metrica
  (es un agregado pais/mes). Por eso no segmentamos por subsidiaria/linea
  en el card.
- El detalle de NIDs vivos se incluye como `reconciliation` por (mes, pais)
  para alimentar el drill comparativo.
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

TAPE_TABLE = "clients-domain-data-master.finance_wh_bi.finance_tapes_global"


def _sql_books(mes_inicio: dt.date, mes_corte: dt.date) -> str:
    return f"""
SELECT
  mes,
  m_pais,
  dummie_eliminaciones,
  dummie_ajustes,
  SUM(actuals_accounting) AS actuals,
  SUM(budget_1)           AS budget
FROM `{TABLE_BET}`
WHERE m_tipo = '3. Drivers'
  AND m_categoria = '03. Balance General'
  AND m_metrica = '03. Inventory'
  AND mes BETWEEN DATE('{mes_inicio.isoformat()}') AND DATE('{mes_corte.isoformat()}')
GROUP BY 1, 2, 3, 4
""".strip()


def _sql_detalle_mes(mes_inicio: dt.date, mes_corte: dt.date) -> str:
    """Detalle por NID al cierre de cada mes en el rango."""
    return f"""
WITH meses AS (
  SELECT mes FROM UNNEST(
    GENERATE_DATE_ARRAY(DATE('{mes_inicio.isoformat()}'), DATE('{mes_corte.isoformat()}'), INTERVAL 1 MONTH)
  ) AS mes
)
SELECT
  m.mes AS mes_cierre,
  CAST(t.nid AS STRING) AS nid,
  t.nombre,
  CASE t.pais
    WHEN 'Colombia' THEN '1. Colombia'
    WHEN 'México'   THEN '2. Mexico'
    ELSE NULL
  END AS m_pais,
  t.v_fecha_escritura,
  t.v_precio,
  t.c_precio,
  t.estatus
FROM meses m
CROSS JOIN `{TAPE_TABLE}` t
WHERE t.v_fecha_escritura IS NOT NULL
  AND t.v_fecha_escritura <= LAST_DAY(m.mes)
  AND (t.c_fecha_escritura IS NULL OR t.c_fecha_escritura > LAST_DAY(m.mes))
  AND t.desistimientos = 'No desistidos'
  AND t.pais IN ('Colombia', 'México')
""".strip()


def _sql_operativo(mes_inicio: dt.date, mes_corte: dt.date) -> str:
    """Snapshot operativo por mes: NIDs vivos al cierre de cada mes.

    Genera meses con GENERATE_DATE_ARRAY y para cada uno cuenta NIDs cuyo
    v_fecha_escritura ya ocurrio y cuya venta (c_fecha_escritura) o sigue
    sin pasar o ocurre despues del cierre del mes.
    """
    return f"""
WITH meses AS (
  SELECT mes FROM UNNEST(
    GENERATE_DATE_ARRAY(DATE('{mes_inicio.isoformat()}'), DATE('{mes_corte.isoformat()}'), INTERVAL 1 MONTH)
  ) AS mes
)
SELECT
  m.mes,
  CASE t.pais
    WHEN 'Colombia' THEN '1. Colombia'
    WHEN 'México'   THEN '2. Mexico'
    ELSE NULL
  END AS m_pais,
  COUNT(DISTINCT t.nid) AS nids_vivos,
  SUM(t.v_precio)       AS valor_compra,
  SUM(t.c_precio)       AS valor_venta_target
FROM meses m
CROSS JOIN `{TAPE_TABLE}` t
WHERE t.v_fecha_escritura IS NOT NULL
  AND t.v_fecha_escritura <= LAST_DAY(m.mes)
  AND (t.c_fecha_escritura IS NULL OR t.c_fecha_escritura > LAST_DAY(m.mes))
  AND t.desistimientos = 'No desistidos'
  AND t.pais IN ('Colombia', 'México')
GROUP BY 1, 2
HAVING m_pais IS NOT NULL
""".strip()


def _twin_sum(df: pd.DataFrame, value_col: str = "actuals") -> dict[str, float]:
    s = df[value_col].fillna(0)
    elim_mask = df["dummie_eliminaciones"].fillna(0).isin([1, -1])
    return {
        "sin_elim": float(s[~elim_mask].sum()),
        "solo_elim": float(s[elim_mask].sum()),
        "con_elim": float(s.sum()),
    }


def _facts_books(df: pd.DataFrame) -> list[dict[str, Any]]:
    """Facts a partir del agregado de BET drivers. No tiene subsidiaria/linea/cuenta."""
    rows = []
    keys = ["mes", "m_pais", "dummie_ajustes"]
    for vals, g in df.groupby(keys, dropna=False):
        mes, pais, ajuste = vals
        rows.append({
            "mes": mes.strftime("%Y-%m"),
            "pais": pais if pd.notna(pais) else None,
            "subsidiaria": None,
            "linea": None,
            "cuenta": None,
            "cuenta_desc": None,
            "es_ajuste": bool(pd.notna(ajuste) and ajuste == 1),
            "actuals": _twin_sum(g),
            "budget": _twin_sum(g, "budget"),
        })
    return rows


def _reconciliation(df_op: pd.DataFrame) -> list[dict[str, Any]]:
    """Una fila por (mes, pais) con el snapshot operativo desde tape."""
    rows = []
    for _, r in df_op.iterrows():
        rows.append({
            "mes": r["mes"].strftime("%Y-%m"),
            "pais": r["pais_label"],
            "nids_vivos": int(r["nids_vivos"]) if pd.notna(r["nids_vivos"]) else 0,
            "valor_compra": float(r["valor_compra"]) if pd.notna(r["valor_compra"]) else 0.0,
            "valor_venta_target": float(r["valor_venta_target"]) if pd.notna(r["valor_venta_target"]) else 0.0,
        })
    return rows


def build(mes_corte: dt.date, mes_max: dt.date | None = None) -> dict[str, Any]:
    """Construye el payload JSON de Inventory on books."""
    if mes_max is None:
        mes_max = mes_corte
    mes_inicio = dt.date(mes_corte.year, mes_corte.month, 1)
    for _ in range(HISTORY_MONTHS - 1):
        prev_last = mes_inicio - dt.timedelta(days=1)
        mes_inicio = dt.date(prev_last.year, prev_last.month, 1)

    log.info("Inventory: query rango %s -> %s", mes_inicio, mes_max)
    df_books = run_query(_sql_books(mes_inicio, mes_max), label="inventario_books")
    df_op    = run_query(_sql_operativo(mes_inicio, mes_max), label="inventario_op")
    df_det   = run_query(_sql_detalle_mes(mes_inicio, mes_max), label="inventario_detalle")

    df_books["mes"] = pd.to_datetime(df_books["mes"])
    df_books["pais_label"] = df_books["m_pais"].map(PAIS_LABEL).fillna("(sin pais)")
    df_books["m_pais"] = df_books["pais_label"]

    df_op["mes"] = pd.to_datetime(df_op["mes"])
    df_op["pais_label"] = df_op["m_pais"].map(PAIS_LABEL).fillna("(sin pais)")

    df_det["mes_cierre"] = pd.to_datetime(df_det["mes_cierre"])
    df_det["pais_label"] = df_det["m_pais"].map(PAIS_LABEL).fillna("(sin pais)")

    meses_disponibles = sorted(df_books["mes"].dt.strftime("%Y-%m").unique().tolist())

    facts = _facts_books(df_books)
    reconciliation = _reconciliation(df_op)

    detalle_por_mes: dict[str, list[dict[str, Any]]] = {}
    for _, r in df_det.iterrows():
        mes_key = r["mes_cierre"].strftime("%Y-%m")
        detalle_por_mes.setdefault(mes_key, []).append({
            "nid": str(r["nid"]),
            "nombre": str(r["nombre"]) if pd.notna(r["nombre"]) else None,
            "pais": r["pais_label"],
            "v_fecha_escritura": r["v_fecha_escritura"].isoformat() if pd.notna(r["v_fecha_escritura"]) else None,
            "v_precio": float(r["v_precio"]) if pd.notna(r["v_precio"]) else None,
            "c_precio": float(r["c_precio"]) if pd.notna(r["c_precio"]) else None,
            "estatus": str(r["estatus"]) if pd.notna(r["estatus"]) else None,
        })

    total_det = sum(len(v) for v in detalle_por_mes.values())
    log.info(
        "Inventory: %d facts books, %d puntos reconciliation, %d NIDs detalle en %d meses",
        len(facts), len(reconciliation), total_det, len(detalle_por_mes),
    )

    payload: dict[str, Any] = {
        "id": "inventario",
        "nombre": "Inventory on books",
        "seccion": "4.2",
        "unidad": "MONEDA",
        "estado": "real",
        "fuente": (
            "bet_data_p2 drivers Inventory; reconciled vs finance_tapes_global "
            "(NIDs con v_fecha_escritura sin c_fecha_escritura, no desistidos)."
        ),
        "receta": {
            "tabla_books": TABLE_BET,
            "tabla_operativo": TAPE_TABLE,
            "filtros_books": [
                "m_tipo = '3. Drivers'",
                "m_categoria = '03. Balance General'",
                "m_metrica = '03. Inventory'",
            ],
            "filtros_operativo": [
                "v_fecha_escritura IS NOT NULL AND v_fecha_escritura <= cierre_mes",
                "c_fecha_escritura IS NULL OR c_fecha_escritura > cierre_mes",
                "desistimientos = 'No desistidos'",
            ],
            "valuacion_operativo": "v_precio (precio compra Habi)",
            "monedas": MONEDA_POR_PAIS,
        },
        "meses_disponibles": meses_disponibles,
        "facts": facts,
        "reconciliation": reconciliation,
        "detalle_nids": {
            "por_mes": detalle_por_mes,
        },
    }
    return payload
