"""KPI 4.2.2 — Inventory aging.

Fuente: finance_tapes_global. Para cada mes M:
  - NIDs vivos al cierre = mismo filtro que inventario (v_fecha_escritura sin
    c_fecha_escritura, no desistidos)
  - dias_en_inv = LAST_DAY(M) − v_fecha_escritura
  - bucket por dias: 0-90, 90-180, 180-365, 365+

Card: % NIDs con dias_en_inv > 180.
Drill: distribucion por bucket (nids y valor_compra) y serie mensual del %.
"""

from __future__ import annotations

import datetime as dt
import logging
from typing import Any

import pandas as pd

from scripts._bq import run_query
from scripts._common import MONEDA_POR_PAIS, PAIS_LABEL

log = logging.getLogger(__name__)

HISTORY_MONTHS = 13
UMBRAL_DIAS = 180

TAPE_TABLE = "clients-domain-data-master.finance_wh_bi.finance_tapes_global"

BUCKETS_META = [
    {"name": "0-90",    "min": 0,   "max": 89,   "over": False},
    {"name": "90-180",  "min": 90,  "max": 179,  "over": False},
    {"name": "180-365", "min": 180, "max": 364,  "over": True},
    {"name": "365+",    "min": 365, "max": None, "over": True},
]


def _sql_detalle_mes(mes_inicio: dt.date, mes_corte: dt.date) -> str:
    """Detalle por NID al cierre de cada mes en el rango (con dias_en_inv recalculado por mes)."""
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
  t.estatus,
  DATE_DIFF(LAST_DAY(m.mes), t.v_fecha_escritura, DAY) AS dias_en_inv
FROM meses m
CROSS JOIN `{TAPE_TABLE}` t
WHERE t.v_fecha_escritura IS NOT NULL
  AND t.v_fecha_escritura <= LAST_DAY(m.mes)
  AND (t.c_fecha_escritura IS NULL OR t.c_fecha_escritura > LAST_DAY(m.mes))
  AND t.desistimientos = 'No desistidos'
  AND t.pais IN ('Colombia', 'México')
""".strip()


def _bucket_for(dias: int) -> str:
    if dias < 90:  return "0-90"
    if dias < 180: return "90-180"
    if dias < 365: return "180-365"
    return "365+"


def _sql(mes_inicio: dt.date, mes_corte: dt.date) -> str:
    return f"""
WITH meses AS (
  SELECT mes FROM UNNEST(
    GENERATE_DATE_ARRAY(DATE('{mes_inicio.isoformat()}'), DATE('{mes_corte.isoformat()}'), INTERVAL 1 MONTH)
  ) AS mes
),
nids_vivos AS (
  SELECT
    m.mes,
    CASE t.pais
      WHEN 'Colombia' THEN '1. Colombia'
      WHEN 'México'   THEN '2. Mexico'
      ELSE NULL
    END AS m_pais,
    t.nid,
    t.v_precio,
    DATE_DIFF(LAST_DAY(m.mes), t.v_fecha_escritura, DAY) AS dias
  FROM meses m
  CROSS JOIN `{TAPE_TABLE}` t
  WHERE t.v_fecha_escritura IS NOT NULL
    AND t.v_fecha_escritura <= LAST_DAY(m.mes)
    AND (t.c_fecha_escritura IS NULL OR t.c_fecha_escritura > LAST_DAY(m.mes))
    AND t.desistimientos = 'No desistidos'
    AND t.pais IN ('Colombia', 'México')
)
SELECT
  mes,
  m_pais,
  CASE
    WHEN dias < 90  THEN '0-90'
    WHEN dias < 180 THEN '90-180'
    WHEN dias < 365 THEN '180-365'
    ELSE                 '365+'
  END AS bucket,
  COUNT(*)      AS nids,
  SUM(v_precio) AS valor_compra,
  AVG(dias)     AS avg_dias
FROM nids_vivos
WHERE m_pais IS NOT NULL
GROUP BY 1, 2, 3
""".strip()


def _facts(df: pd.DataFrame) -> list[dict[str, Any]]:
    rows = []
    for _, r in df.iterrows():
        rows.append({
            "mes": r["mes"].strftime("%Y-%m"),
            "pais": r["pais_label"],
            "subsidiaria": None,
            "linea": None,
            "cuenta": None,
            "cuenta_desc": None,
            "bucket": r["bucket"],
            "es_ajuste": False,
            "actuals": {
                "sin_elim": float(r["nids"]),
                "con_elim": float(r["nids"]),
                "solo_elim": 0.0,
            },
            "budget": {"sin_elim": 0.0, "con_elim": 0.0, "solo_elim": 0.0},
            "valor_compra": float(r["valor_compra"]) if pd.notna(r["valor_compra"]) else 0.0,
            "avg_dias": float(r["avg_dias"]) if pd.notna(r["avg_dias"]) else None,
        })
    return rows


def build(mes_corte: dt.date) -> dict[str, Any]:
    mes_inicio = dt.date(mes_corte.year, mes_corte.month, 1)
    for _ in range(HISTORY_MONTHS - 1):
        prev_last = mes_inicio - dt.timedelta(days=1)
        mes_inicio = dt.date(prev_last.year, prev_last.month, 1)

    log.info("Aging: query rango %s -> %s", mes_inicio, mes_corte)
    df = run_query(_sql(mes_inicio, mes_corte), label="aging")
    df_det = run_query(_sql_detalle_mes(mes_inicio, mes_corte), label="aging_detalle")

    df["mes"] = pd.to_datetime(df["mes"])
    df["pais_label"] = df["m_pais"].map(PAIS_LABEL).fillna("(sin pais)")
    df_det["mes_cierre"] = pd.to_datetime(df_det["mes_cierre"])
    df_det["pais_label"] = df_det["m_pais"].map(PAIS_LABEL).fillna("(sin pais)")

    meses_disponibles = sorted(df["mes"].dt.strftime("%Y-%m").unique().tolist())

    facts = _facts(df)

    # Detalle por NID por cada mes en el rango
    detalle_por_mes: dict[str, list[dict[str, Any]]] = {}
    for _, r in df_det.iterrows():
        mes_key = r["mes_cierre"].strftime("%Y-%m")
        dias = int(r["dias_en_inv"]) if pd.notna(r["dias_en_inv"]) else 0
        detalle_por_mes.setdefault(mes_key, []).append({
            "nid": str(r["nid"]),
            "nombre": str(r["nombre"]) if pd.notna(r["nombre"]) else None,
            "pais": r["pais_label"],
            "v_fecha_escritura": r["v_fecha_escritura"].isoformat() if pd.notna(r["v_fecha_escritura"]) else None,
            "dias_en_inv": dias,
            "bucket": _bucket_for(dias),
            "v_precio": float(r["v_precio"]) if pd.notna(r["v_precio"]) else None,
            "c_precio": float(r["c_precio"]) if pd.notna(r["c_precio"]) else None,
            "estatus": str(r["estatus"]) if pd.notna(r["estatus"]) else None,
        })
    total_det = sum(len(v) for v in detalle_por_mes.values())
    log.info("Aging: %d facts (mes, pais, bucket) + %d NIDs detalle en %d meses",
             len(facts), total_det, len(detalle_por_mes))

    payload: dict[str, Any] = {
        "id": "inventory_aging",
        "nombre": "Inventory aging",
        "seccion": "4.2",
        "unidad": "PORCENTAJE_AGING",
        "estado": "real",
        "umbral_dias": UMBRAL_DIAS,
        "buckets_meta": BUCKETS_META,
        "fuente": (
            f"finance_tapes_global · dias = LAST_DAY(mes) − v_fecha_escritura · "
            f"% sobre umbral {UMBRAL_DIAS} dias"
        ),
        "receta": {
            "tabla": TAPE_TABLE,
            "filtros": [
                "v_fecha_escritura IS NOT NULL AND v_fecha_escritura <= cierre_mes",
                "c_fecha_escritura IS NULL OR c_fecha_escritura > cierre_mes",
                "desistimientos = 'No desistidos'",
            ],
            "umbral_dias": UMBRAL_DIAS,
            "buckets": [b["name"] for b in BUCKETS_META],
            "monedas": MONEDA_POR_PAIS,
        },
        "meses_disponibles": meses_disponibles,
        "facts": facts,
        "detalle_nids": {
            "por_mes": detalle_por_mes,
        },
    }
    return payload
