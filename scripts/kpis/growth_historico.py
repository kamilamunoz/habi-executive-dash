"""Sub-tab Growth (dentro del tab Historical) — 12 meses de NIDs + GMV.

Streams cubiertos (7 — mismos count streams del tab MTD, sin Gross Margin):
  MM · PSA compra          — bet 01. Market Maker · 01. Gross Purchase PSAs
  MM · Compras (escritura) — bet 01. Market Maker · 03. Purchase Deeds
  MM · PSA venta           — bet 01. Market Maker · 05. Sale PSAs
  MM · Ventas (escritura)  — bet 01. Market Maker · 07. Sale Deeds
  BR Used · Subscribed     — bet 02. Brokerage (Used Homes) · 01. Subscribed · 01. Subscribed
  BR Used · Sales          — bet 02. Brokerage (Used Homes) · 03. Sales · 01. Sales
  BR Used · Deeds          — bet 02. Brokerage (Used Homes) · 05. Deeds · 01. Deeds

Fuente: bet_data_p2, m_tipo='2. Transactions', actuals_accounting (mismo
que MTD para que los numeros crucen).

NIDs es la metrica principal de cada card; GMV va como metrica secundaria
en la card y como columna extra en el drill. Gross Margin se excluye —
ese vive en el KPI margen_bruto (bet Managerial oficial, incluye remodel).

Salida: 1 JSON consolidado (`kpi_growth_historico.json`) con
`{streams: [payload por stream, ...]}`. Cada payload sigue el shape
estilo Perf/Cap (series por pais + facts filtrables por sidebar).
"""

from __future__ import annotations

import datetime as dt
import logging
from typing import Any

import pandas as pd

from scripts._bq import TABLE_BET, run_query
from scripts._common import PAIS_LABEL
from scripts.kpis.mtd_transactions import STREAMS_COUNT

log = logging.getLogger(__name__)

HISTORY_MONTHS = 13


# ============================================================ SQL builder ==

def _sql(mes_inicio: dt.date, mes_fin: dt.date) -> str:
    """Trae 13 meses del bet con los filtros de los 7 streams count.

    Emite una fila por (mes, pais, categoria, metrica, submetrica, unidad,
    tipo_precio, dummie_ajustes). dummie_eliminaciones se ignora porque en
    Transactions siempre es NULL (metricas brutas, sin intercompany).
    """
    categorias = sorted({s["bet_categoria"] for s in STREAMS_COUNT})
    metricas = sorted({s["bet_metrica"] for s in STREAMS_COUNT})
    cats_sql = ",".join(f"'{c}'" for c in categorias)
    mets_sql = ",".join(f"'{m}'" for m in metricas)
    return f"""
SELECT
  mes,
  m_pais,
  m_categoria,
  m_metrica,
  m_submetrica,
  m_unidad,
  m_tipo_precio,
  dummie_ajustes,
  SUM(actuals_accounting) AS actuals,
  SUM(budget_1)           AS budget
FROM `{TABLE_BET}`
WHERE m_tipo = '2. Transactions'
  AND m_categoria IN ({cats_sql})
  AND m_metrica IN ({mets_sql})
  AND mes BETWEEN DATE('{mes_inicio.isoformat()}') AND DATE('{mes_fin.isoformat()}')
GROUP BY 1, 2, 3, 4, 5, 6, 7, 8
""".strip()


# ============================================================ helpers per-stream

def _filtrar_stream(df: pd.DataFrame, stream: dict[str, Any]) -> pd.DataFrame:
    """Filas del bet correspondientes a un stream.

    MM tiene bet_submetrica=None → suma todas las submetricas.
    BR Used declara submetrica explicita (01. Subscribed / 01. Sales /
    01. Deeds) para evitar doble contar Inmo 100 + Tradicional + Total.
    """
    mask = (df["m_categoria"] == stream["bet_categoria"]) & (df["m_metrica"] == stream["bet_metrica"])
    submet = stream.get("bet_submetrica")
    if submet is not None:
        mask = mask & (df["m_submetrica"] == submet)
    return df.loc[mask].copy()


def _twin(values: pd.Series) -> dict[str, float]:
    """3 flavors sin_elim/con_elim/solo_elim.

    En Transactions bet, dummie_eliminaciones siempre es NULL. Emitimos
    los 3 flavors iguales para que serieMensualFiltrada + filtrarFacts
    en el front funcionen exactamente igual que con KPIs Managerial.
    """
    total = float(values.fillna(0).astype(float).sum())
    return {"sin_elim": total, "con_elim": total, "solo_elim": 0.0}


def _split_nids_gmv(df: pd.DataFrame, precio: str | None) -> tuple[pd.DataFrame, pd.DataFrame]:
    """Separa las filas NIDs vs GMV segun m_unidad (y m_tipo_precio para MM)."""
    nids = df[df["m_unidad"] == "NIDS"]
    if precio is None:
        gmv = df[df["m_unidad"] == "GMV"]
    else:
        gmv = df[(df["m_unidad"] == "GMV") & (df["m_tipo_precio"] == precio)]
    return nids, gmv


def _serie_global(df: pd.DataFrame, stream: dict[str, Any]) -> list[dict[str, Any]]:
    precio = stream.get("gmv_tipo_precio")
    nids, gmv = _split_nids_gmv(df, precio)
    meses = sorted(pd.unique(df["mes"]))
    out = []
    for mes in meses:
        n = nids[nids["mes"] == mes]
        g = gmv[gmv["mes"] == mes]
        out.append({
            "mes": pd.Timestamp(mes).strftime("%Y-%m"),
            "actuals":     _twin(n["actuals"]),
            "budget":      _twin(n["budget"]),
            "gmv_actuals": _twin(g["actuals"]),
            "gmv_budget":  _twin(g["budget"]),
        })
    return out


def _serie_indexada(df: pd.DataFrame, stream: dict[str, Any], col: str) -> dict[str, list[dict[str, Any]]]:
    out: dict[str, list[dict[str, Any]]] = {}
    for key, sub in df.groupby(col, dropna=False):
        label = key if pd.notna(key) else "(sin asignar)"
        out[label] = _serie_global(sub, stream)
    return out


def _facts_stream(df: pd.DataFrame, stream: dict[str, Any]) -> list[dict[str, Any]]:
    """Detalle por (mes, pais, submetrica, ajuste) para el drill.

    Trae NIDs (metrica principal) + GMV (metrica secundaria) en la misma
    fila. subsidiaria/cuenta son None porque bet Transactions no los expone.
    """
    precio = stream.get("gmv_tipo_precio")
    linea = stream["linea_negocio"]
    metrica = stream["bet_metrica"]
    keys = ["mes", "m_pais", "m_submetrica", "dummie_ajustes"]
    rows: list[dict[str, Any]] = []
    for vals, g in df.groupby(keys, dropna=False):
        mes, pais, submet, ajuste = vals
        n, gmv = _split_nids_gmv(g, precio)
        detalle = f"{metrica} · {submet}" if pd.notna(submet) else metrica
        rows.append({
            "mes": pd.Timestamp(mes).strftime("%Y-%m"),
            "pais": pais if pd.notna(pais) else None,
            "subsidiaria": None,
            "linea": linea,
            "cuenta": None,
            "cuenta_desc": detalle,
            "tipo_transaccion": metrica,
            "es_ajuste": bool(pd.notna(ajuste) and ajuste == 1),
            "actuals":     _twin(n["actuals"]),
            "budget":      _twin(n["budget"]),
            "gmv_actuals": _twin(gmv["actuals"]),
            "gmv_budget":  _twin(gmv["budget"]),
        })
    return rows


def _payload_stream(df_all: pd.DataFrame, stream: dict[str, Any]) -> dict[str, Any]:
    df = _filtrar_stream(df_all, stream)
    df["m_pais"] = df["m_pais"].map(PAIS_LABEL).fillna("(sin pais)")
    meses = sorted(df["mes"].dt.strftime("%Y-%m").unique().tolist())

    filtros_desc = [
        "m_tipo = '2. Transactions'",
        f"m_categoria = '{stream['bet_categoria']}'",
        f"m_metrica = '{stream['bet_metrica']}'",
    ]
    if stream.get("bet_submetrica"):
        filtros_desc.append(f"m_submetrica = '{stream['bet_submetrica']}'")
    if stream.get("gmv_tipo_precio"):
        filtros_desc.append(f"GMV pivot: m_tipo_precio = '{stream['gmv_tipo_precio']}'")

    return {
        "id": f"growth_{stream['id']}",
        "nombre": stream["nombre"],
        "seccion": "growth",
        "linea_negocio": stream["linea_negocio"],
        "unidad": "COUNT_NIDS",
        "estado": "real",
        "fuente": (
            f"bet_data_p2 · {stream['bet_categoria']} · "
            f"{stream['bet_metrica']}"
        ),
        "receta": {
            "tabla": TABLE_BET,
            "filtros": filtros_desc,
            "medida_principal": "SUM(actuals_accounting) WHERE m_unidad='NIDS'",
            "medida_secundaria": (
                "SUM(actuals_accounting) WHERE m_unidad='GMV'"
                + (f" AND m_tipo_precio='{stream['gmv_tipo_precio']}'"
                   if stream.get("gmv_tipo_precio") else "")
            ),
            "notas": [
                "NIDs = numero de transacciones (count).",
                "GMV  = valor monetario (moneda local del pais).",
                "Transactions no tiene intercompany ni subsidiaria — "
                "elim_flavors emitidos iguales por consistencia con Perf/Cap.",
            ],
        },
        "meses_disponibles": meses,
        "series": {
            "global": _serie_global(df, stream),
            "por_pais": _serie_indexada(df, stream, "m_pais"),
            "por_linea": {stream["linea_negocio"]: _serie_global(df, stream)},
        },
        "facts": _facts_stream(df, stream),
    }


def build(mes_corte: dt.date, mes_max: dt.date | None = None) -> dict[str, Any]:
    """Payload consolidado: 7 streams count, 13 meses de historia."""
    if mes_max is None:
        mes_max = mes_corte
    mes_fin = dt.date(mes_max.year, mes_max.month, 1)
    mes_inicio = mes_fin
    for _ in range(HISTORY_MONTHS - 1):
        prev = mes_inicio - dt.timedelta(days=1)
        mes_inicio = dt.date(prev.year, prev.month, 1)
    log.info(
        "Growth historico: rango %s → %s (%d meses)",
        mes_inicio, mes_fin, HISTORY_MONTHS,
    )

    df = run_query(_sql(mes_inicio, mes_fin), label="growth_historico")
    df["mes"] = pd.to_datetime(df["mes"])

    streams_payload = [_payload_stream(df, s) for s in STREAMS_COUNT]

    meses_union = sorted({m for s in streams_payload for m in s["meses_disponibles"]})

    return {
        "id": "growth_historico",
        "nombre": "Growth · Historical monthly evolution",
        "meses_disponibles": meses_union,
        "fuente": (
            "bet_data_p2 · m_tipo='2. Transactions' · actuals_accounting · "
            f"{len(streams_payload)} streams (MM 4 + BR Used 3) · {HISTORY_MONTHS} meses"
        ),
        "streams": streams_payload,
    }
