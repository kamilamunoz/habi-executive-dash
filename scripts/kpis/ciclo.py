"""KPI 4.2.4 — Cash conversion cycle (deed of purchase to sale collection).

Fuente: finance_tapes_global. Para cada NID con ciclo completo:
  dias = DATE_DIFF(c_fecha_desembolso, v_fecha_escritura, DAY)

Filtro:
  - v_fecha_escritura IS NOT NULL  (Habi firmo la escritura de compra)
  - c_fecha_desembolso IS NOT NULL (cliente final desembolso a Habi)
  - desistimientos = 'No desistidos'

Anclaje: por mes de c_fecha_desembolso (cierre del ciclo).
Card: muestra mediana y promedio del mes corte.
Serie historica 13 meses.
"""

from __future__ import annotations

import datetime as dt
import logging
from typing import Any

import pandas as pd

from scripts._bq import run_query
from scripts._common import MONEDA_POR_PAIS, PAIS_LABEL, REPO_ROOT

log = logging.getLogger(__name__)

HISTORY_MONTHS = 13

TAPE_TABLE = "clients-domain-data-master.finance_wh_bi.finance_tapes_global"

# CSV exportado del Google Sheet de metas (columnas: mes, Colombia, Mexico).
# Kamila lo re-exporta a mano cuando cambian los targets. Formato de mes
# esperado: YYYY-MM. Si el CSV no existe o falta el mes, el target queda
# en None y la card no muestra la barra de cumplimiento.
BUDGET_CSV = REPO_ROOT / "data" / "budgets_ciclo.csv"


def _cargar_targets() -> dict[str, dict[str, float]]:
    """Lee budgets_ciclo.csv y devuelve {mes_YYYY-MM: {pais_label: target_dias}}.

    Los headers del CSV ('Colombia', 'Mexico') se mapean directo a los
    labels de PAIS_LABEL usados por el resto del payload. Si el archivo
    no existe, devuelve dict vacio y sigue (target = None en el payload).
    """
    if not BUDGET_CSV.exists():
        log.warning("Ciclo: no encontre %s — target sin dato", BUDGET_CSV)
        return {}
    df = pd.read_csv(BUDGET_CSV)
    # Normalizar: 'mes' como str YYYY-MM
    df["mes"] = df["mes"].astype(str).str.strip()
    out: dict[str, dict[str, float]] = {}
    for _, r in df.iterrows():
        mes = r["mes"]
        # Aceptar formatos comunes: YYYY-MM o M/D/YYYY (por si Kamila re-exporta directo)
        if "/" in mes:
            try:
                mes = pd.to_datetime(mes, format="%m/%d/%Y").strftime("%Y-%m")
            except ValueError:
                log.warning("Ciclo: mes '%s' con formato desconocido — skip", r["mes"])
                continue
        out[mes] = {
            "Colombia": float(r["Colombia"]) if pd.notna(r.get("Colombia")) else None,
            "Mexico":   float(r["Mexico"])   if pd.notna(r.get("Mexico"))   else None,
        }
    log.info("Ciclo: cargados %d meses de targets desde %s", len(out), BUDGET_CSV.name)
    return out


def _sql_serie(mes_inicio: dt.date, mes_corte: dt.date) -> str:
    """Por mes/pais: count, avg, p50, p90 de dias del ciclo."""
    return f"""
WITH ciclo AS (
  SELECT
    CASE pais
      WHEN 'Colombia' THEN '1. Colombia'
      WHEN 'México'   THEN '2. Mexico'
      ELSE NULL
    END AS m_pais,
    DATE_TRUNC(c_fecha_desembolso, MONTH) AS mes,
    DATE_DIFF(c_fecha_desembolso, v_fecha_escritura, DAY) AS dias
  FROM `{TAPE_TABLE}`
  WHERE v_fecha_escritura IS NOT NULL
    AND c_fecha_desembolso IS NOT NULL
    AND desistimientos = 'No desistidos'
    AND pais IN ('Colombia', 'México')
    AND c_fecha_desembolso BETWEEN DATE('{mes_inicio.isoformat()}') AND LAST_DAY(DATE('{mes_corte.isoformat()}'))
)
SELECT
  mes,
  m_pais,
  COUNT(*) AS nids,
  AVG(dias) AS avg_dias,
  APPROX_QUANTILES(dias, 100)[OFFSET(50)] AS p50_dias,
  APPROX_QUANTILES(dias, 100)[OFFSET(90)] AS p90_dias
FROM ciclo
WHERE m_pais IS NOT NULL
GROUP BY 1, 2
""".strip()


def _sql_detalle(mes_inicio: dt.date, mes_corte: dt.date) -> str:
    """Detalle por NID con ciclo cerrado en cualquier mes del rango."""
    return f"""
SELECT
  DATE_TRUNC(c_fecha_desembolso, MONTH) AS mes_cierre,
  CAST(nid AS STRING) AS nid,
  nombre,
  CASE pais
    WHEN 'Colombia' THEN '1. Colombia'
    WHEN 'México'   THEN '2. Mexico'
    ELSE NULL
  END AS m_pais,
  v_fecha_escritura,
  c_fecha_desembolso,
  v_precio,
  c_precio,
  DATE_DIFF(c_fecha_desembolso, v_fecha_escritura, DAY) AS dias_ciclo
FROM `{TAPE_TABLE}`
WHERE v_fecha_escritura IS NOT NULL
  AND c_fecha_desembolso IS NOT NULL
  AND desistimientos = 'No desistidos'
  AND pais IN ('Colombia', 'México')
  AND c_fecha_desembolso BETWEEN DATE('{mes_inicio.isoformat()}') AND LAST_DAY(DATE('{mes_corte.isoformat()}'))
""".strip()


def _facts(df: pd.DataFrame, targets: dict[str, dict[str, float]]) -> list[dict[str, Any]]:
    rows = []
    for _, r in df.iterrows():
        p50 = float(r["p50_dias"]) if pd.notna(r["p50_dias"]) else None
        avg = float(r["avg_dias"]) if pd.notna(r["avg_dias"]) else None
        mes_key = r["mes"].strftime("%Y-%m")
        pais_lbl = r["pais_label"]
        # Target del mes/pais desde el CSV. Si no hay dato, budget queda en 0
        # (el front sabe que 0/None -> no muestra barra de cumplimiento).
        target = None
        if mes_key in targets:
            target = targets[mes_key].get(pais_lbl)
        bud = float(target) if target is not None else 0.0
        rows.append({
            "mes": mes_key,
            "pais": pais_lbl,
            "subsidiaria": None,
            "linea": None,
            "cuenta": None,
            "cuenta_desc": None,
            "es_ajuste": False,
            # actuals = p50 (metrica principal) para que el sparkline funcione
            "actuals": {"sin_elim": p50 or 0, "con_elim": p50 or 0, "solo_elim": 0.0},
            "budget":  {"sin_elim": bud, "con_elim": bud, "solo_elim": 0.0},
            "nids": int(r["nids"]) if pd.notna(r["nids"]) else 0,
            "avg_dias": avg,
            "p50_dias": p50,
            "p90_dias": float(r["p90_dias"]) if pd.notna(r["p90_dias"]) else None,
            "target_dias": target,   # duplicado explicito para claridad del front
        })
    return rows


def build(mes_corte: dt.date, mes_max: dt.date | None = None) -> dict[str, Any]:
    if mes_max is None:
        mes_max = mes_corte
    mes_inicio = dt.date(mes_corte.year, mes_corte.month, 1)
    for _ in range(HISTORY_MONTHS - 1):
        prev_last = mes_inicio - dt.timedelta(days=1)
        mes_inicio = dt.date(prev_last.year, prev_last.month, 1)

    log.info("Cycle: query rango %s -> %s", mes_inicio, mes_max)
    df = run_query(_sql_serie(mes_inicio, mes_max), label="ciclo")
    df_det = run_query(_sql_detalle(mes_inicio, mes_max), label="ciclo_detalle")

    df["mes"] = pd.to_datetime(df["mes"])
    df["pais_label"] = df["m_pais"].map(PAIS_LABEL).fillna("(sin pais)")
    df_det["mes_cierre"] = pd.to_datetime(df_det["mes_cierre"])
    df_det["pais_label"] = df_det["m_pais"].map(PAIS_LABEL).fillna("(sin pais)")

    meses_disponibles = sorted(df["mes"].dt.strftime("%Y-%m").unique().tolist())
    targets = _cargar_targets()
    facts = _facts(df, targets)

    detalle_por_mes: dict[str, list[dict[str, Any]]] = {}
    for _, r in df_det.iterrows():
        mes_key = r["mes_cierre"].strftime("%Y-%m")
        detalle_por_mes.setdefault(mes_key, []).append({
            "nid": str(r["nid"]),
            "nombre": str(r["nombre"]) if pd.notna(r["nombre"]) else None,
            "pais": r["pais_label"],
            "v_fecha_escritura": r["v_fecha_escritura"].isoformat() if pd.notna(r["v_fecha_escritura"]) else None,
            "c_fecha_desembolso": r["c_fecha_desembolso"].isoformat() if pd.notna(r["c_fecha_desembolso"]) else None,
            "dias_ciclo": int(r["dias_ciclo"]) if pd.notna(r["dias_ciclo"]) else 0,
            "v_precio": float(r["v_precio"]) if pd.notna(r["v_precio"]) else None,
            "c_precio": float(r["c_precio"]) if pd.notna(r["c_precio"]) else None,
        })
    total_det = sum(len(v) for v in detalle_por_mes.values())
    log.info("Cycle: %d facts (mes, pais) + %d NIDs detalle en %d meses",
             len(facts), total_det, len(detalle_por_mes))

    payload: dict[str, Any] = {
        "id": "ciclo_caja",
        "nombre": "Cash conversion cycle",
        "seccion": "4.2",
        "unidad": "DIAS_CICLO",
        "estado": "real",
        "fuente": (
            "finance_tapes_global · dias = c_fecha_desembolso − v_fecha_escritura · "
            "anclaje por mes de c_fecha_desembolso · solo NIDs con ciclo completo, no desistidos"
        ),
        "receta": {
            "tabla": TAPE_TABLE,
            "fecha_inicio_ciclo": "v_fecha_escritura (escritura de compra de Habi)",
            "fecha_fin_ciclo": "c_fecha_desembolso (desembolso del cliente final a Habi)",
            "filtros": [
                "v_fecha_escritura IS NOT NULL",
                "c_fecha_desembolso IS NOT NULL",
                "desistimientos = 'No desistidos'",
            ],
            "anclaje_serie": "mes de c_fecha_desembolso (cierre del ciclo)",
            "monedas": MONEDA_POR_PAIS,
        },
        "meses_disponibles": meses_disponibles,
        "facts": facts,
        "detalle_nids": {
            "por_mes": detalle_por_mes,
        },
        # Metas por (mes, pais) para lookup directo en el front — el CSV
        # data/budgets_ciclo.csv es la fuente editable por Kamila.
        "targets_por_mes": targets,
        "budget_source": f"data/{BUDGET_CSV.name}",
    }
    return payload
