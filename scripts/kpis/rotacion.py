"""KPI 4.2.5 — Sell-through del mes.

Sell-through = NIDs vendidos en M / NIDs en inventario al cierre del mes anterior.

  - "Vendido" = c_fecha_escritura BETWEEN primer_dia(M) AND ultimo_dia(M)
    (sigue la definicion validada con Kamila: escritura de venta como evento de salida).
  - "Inventario al inicio de M" = vivos al cierre del mes anterior:
      v_fecha_escritura <= LAST_DAY(mes_anterior)
      AND (c_fecha_escritura IS NULL OR c_fecha_escritura > LAST_DAY(mes_anterior))
      AND desistimientos = 'No desistidos'

Card: sell-through % del mes corte por pais (o ponderado global).
Drill: tabla por pais, chart historico %, detalle NIDs vendidos del mes corte.
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

TAPE_TABLE = "clients-domain-data-master.finance_wh_bi.finance_tapes_global"


def _sql_serie(mes_inicio: dt.date, mes_corte: dt.date) -> str:
    return f"""
WITH meses AS (
  SELECT mes FROM UNNEST(
    GENERATE_DATE_ARRAY(DATE('{mes_inicio.isoformat()}'), DATE('{mes_corte.isoformat()}'), INTERVAL 1 MONTH)
  ) AS mes
),
inv_inicio AS (
  SELECT
    m.mes,
    CASE t.pais
      WHEN 'Colombia' THEN '1. Colombia'
      WHEN 'México'   THEN '2. Mexico'
      ELSE NULL
    END AS m_pais,
    COUNT(*) AS nids_inv
  FROM meses m
  CROSS JOIN `{TAPE_TABLE}` t
  WHERE t.v_fecha_escritura IS NOT NULL
    AND t.v_fecha_escritura <= DATE_SUB(m.mes, INTERVAL 1 DAY)
    AND (t.c_fecha_escritura IS NULL OR t.c_fecha_escritura > DATE_SUB(m.mes, INTERVAL 1 DAY))
    AND t.desistimientos = 'No desistidos'
    AND t.pais IN ('Colombia', 'México')
  GROUP BY 1, 2
),
ventas AS (
  SELECT
    DATE_TRUNC(t.c_fecha_escritura, MONTH) AS mes,
    CASE t.pais
      WHEN 'Colombia' THEN '1. Colombia'
      WHEN 'México'   THEN '2. Mexico'
      ELSE NULL
    END AS m_pais,
    COUNT(*) AS nids_vendidos
  FROM `{TAPE_TABLE}` t
  WHERE t.c_fecha_escritura BETWEEN DATE('{mes_inicio.isoformat()}') AND LAST_DAY(DATE('{mes_corte.isoformat()}'))
    AND t.v_fecha_escritura IS NOT NULL
    AND t.desistimientos = 'No desistidos'
    AND t.pais IN ('Colombia', 'México')
  GROUP BY 1, 2
)
SELECT
  COALESCE(i.mes, v.mes)     AS mes,
  COALESCE(i.m_pais, v.m_pais) AS m_pais,
  COALESCE(i.nids_inv, 0)     AS nids_inv_inicio,
  COALESCE(v.nids_vendidos, 0) AS nids_vendidos,
  SAFE_DIVIDE(v.nids_vendidos, i.nids_inv) AS sell_through
FROM inv_inicio i
FULL OUTER JOIN ventas v USING (mes, m_pais)
WHERE COALESCE(i.m_pais, v.m_pais) IS NOT NULL
""".strip()


def _sql_detalle(mes_corte: dt.date) -> str:
    """NIDs vendidos en el mes corte (c_fecha_escritura en el mes)."""
    return f"""
SELECT
  CAST(t.nid AS STRING) AS nid,
  t.nombre,
  CASE t.pais
    WHEN 'Colombia' THEN '1. Colombia'
    WHEN 'México'   THEN '2. Mexico'
    ELSE NULL
  END AS m_pais,
  t.v_fecha_escritura,
  t.c_fecha_escritura,
  DATE_DIFF(t.c_fecha_escritura, t.v_fecha_escritura, DAY) AS dias_en_inv,
  t.v_precio,
  t.c_precio
FROM `{TAPE_TABLE}` t
WHERE DATE_TRUNC(t.c_fecha_escritura, MONTH) = DATE('{mes_corte.isoformat()}')
  AND t.v_fecha_escritura IS NOT NULL
  AND t.desistimientos = 'No desistidos'
  AND t.pais IN ('Colombia', 'México')
""".strip()


def _facts(df: pd.DataFrame) -> list[dict[str, Any]]:
    rows = []
    for _, r in df.iterrows():
        st = float(r["sell_through"]) if pd.notna(r["sell_through"]) else None
        rows.append({
            "mes": r["mes"].strftime("%Y-%m"),
            "pais": r["pais_label"],
            "subsidiaria": None,
            "linea": None,
            "cuenta": None,
            "cuenta_desc": None,
            "es_ajuste": False,
            "actuals": {"sin_elim": st or 0, "con_elim": st or 0, "solo_elim": 0.0},
            "budget":  {"sin_elim": 0.0, "con_elim": 0.0, "solo_elim": 0.0},
            "nids_vendidos": int(r["nids_vendidos"]) if pd.notna(r["nids_vendidos"]) else 0,
            "nids_inv_inicio": int(r["nids_inv_inicio"]) if pd.notna(r["nids_inv_inicio"]) else 0,
            "sell_through": st,
        })
    return rows


def build(mes_corte: dt.date) -> dict[str, Any]:
    mes_inicio = dt.date(mes_corte.year, mes_corte.month, 1)
    for _ in range(HISTORY_MONTHS - 1):
        prev_last = mes_inicio - dt.timedelta(days=1)
        mes_inicio = dt.date(prev_last.year, prev_last.month, 1)

    log.info("Sell-through: query rango %s -> %s", mes_inicio, mes_corte)
    df = run_query(_sql_serie(mes_inicio, mes_corte), label="rotacion")
    df_det = run_query(_sql_detalle(mes_corte), label="rotacion_detalle")

    df["mes"] = pd.to_datetime(df["mes"])
    df["pais_label"] = df["m_pais"].map(PAIS_LABEL).fillna("(sin pais)")
    df_det["pais_label"] = df_det["m_pais"].map(PAIS_LABEL).fillna("(sin pais)")

    meses_disponibles = sorted(df["mes"].dt.strftime("%Y-%m").unique().tolist())
    facts = _facts(df)

    detalle_nids = []
    for _, r in df_det.iterrows():
        detalle_nids.append({
            "nid": str(r["nid"]),
            "nombre": str(r["nombre"]) if pd.notna(r["nombre"]) else None,
            "pais": r["pais_label"],
            "v_fecha_escritura": r["v_fecha_escritura"].isoformat() if pd.notna(r["v_fecha_escritura"]) else None,
            "c_fecha_escritura": r["c_fecha_escritura"].isoformat() if pd.notna(r["c_fecha_escritura"]) else None,
            "dias_en_inv": int(r["dias_en_inv"]) if pd.notna(r["dias_en_inv"]) else 0,
            "v_precio": float(r["v_precio"]) if pd.notna(r["v_precio"]) else None,
            "c_precio": float(r["c_precio"]) if pd.notna(r["c_precio"]) else None,
        })

    log.info("Sell-through: %d facts + %d NIDs detalle mes corte", len(facts), len(detalle_nids))

    payload: dict[str, Any] = {
        "id": "rotacion",
        "nombre": "Sell-through",
        "seccion": "4.2",
        "unidad": "PORCENTAJE_SELLTHROUGH",
        "estado": "real",
        "fuente": (
            "finance_tapes_global · NIDs c_fecha_escritura en M ÷ NIDs vivos al cierre del mes anterior"
        ),
        "receta": {
            "tabla": TAPE_TABLE,
            "numerador": "c_fecha_escritura BETWEEN primer_dia(M) AND ultimo_dia(M)",
            "denominador": "Inventario vivo al cierre del mes anterior (v_fecha_escritura sin c_fecha_escritura)",
            "filtros": ["desistimientos = 'No desistidos'", "v_fecha_escritura IS NOT NULL"],
            "monedas": MONEDA_POR_PAIS,
        },
        "meses_disponibles": meses_disponibles,
        "facts": facts,
        "detalle_nids": {
            "mes": mes_corte.strftime("%Y-%m"),
            "nids": detalle_nids,
        },
    }
    return payload
