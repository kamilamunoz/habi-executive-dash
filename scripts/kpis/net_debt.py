"""KPI 4.2.6 — Net debt, leverage & cost of capital.

Cifra principal del card: **Total Debt = Debt in Homes + Corporate Debt**
(saldos de deuda de los drivers de BET).

Cada fact expone las 3 vistas:
  - Homes  (m_metrica = '05. Debt in Homes')
  - Corporate (m_metrica = '04. Corporate Debt')
  - Total  (Homes + Corporate)

y los ratios calculados por vista:

  Leverage[view] = Debt[view] / Adjusted EBITDA LTM
    - EBITDA LTM = suma 12 meses del EBITDA BET.
    - Capitalized Payroll LTM = suma 12 meses del payroll capitalizado
      (m_categoria='05. Capitalized Payroll'). En BET viene negativo (sale del
      P&L); aqui lo invertimos para sumarlo al EBITDA.
    - Adjusted EBITDA LTM = EBITDA LTM + Capitalized Payroll LTM.

  Cost of capital[view] = |Net Interest LTM| / Average Debt[view] LTM
    - Net Interest LTM = suma 12 meses de m_categoria='06. Net financing costs'
      (Interest Expense + Interest Income). NO hay split de intereses por
      Homes vs Corporate en el bet; usamos el mismo Net Interest para las 3
      vistas — es un proxy. Cost of Capital "Homes only" queda inflado, y
      "Corporate only" queda muy alto. La vista Total es la financieramente
      correcta.
    - Average Debt[view] LTM = promedio de los saldos del bucket en 12 meses.
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
LTM_MONTHS = 12


def _sql_debt(mes_inicio: dt.date, mes_corte: dt.date) -> str:
    """Trae ambos saldos de deuda (Homes + Corporate) desde el bet, en
    formato pivoteado por m_metrica: una columna `bucket` con {homes,
    corporate}. Suma en Python."""
    return f"""
SELECT
  mes,
  m_pais,
  dummie_eliminaciones,
  dummie_ajustes,
  CASE m_metrica
    WHEN '05. Debt in Homes'  THEN 'homes'
    WHEN '04. Corporate Debt' THEN 'corporate'
  END AS bucket,
  SUM(actuals_accounting) AS debt
FROM `{TABLE_BET}`
WHERE m_tipo = '3. Drivers'
  AND m_categoria = '03. Balance General'
  AND m_metrica IN ('05. Debt in Homes', '04. Corporate Debt')
  AND mes BETWEEN DATE('{mes_inicio.isoformat()}') AND DATE('{mes_corte.isoformat()}')
GROUP BY 1, 2, 3, 4, 5
""".strip()


def _sql_ebitda(mes_inicio_ltm: dt.date, mes_corte: dt.date) -> str:
    return f"""
SELECT
  mes,
  m_pais,
  SUM(IF(dummie_eliminaciones IS NULL OR dummie_eliminaciones NOT IN (1, -1),
         actuals_accounting, 0)) AS ebitda
FROM `{TABLE_BET}`
WHERE m_tipo = '1. Financials'
  AND c_total_reporte IN ('1 Gross Profit', '2 Other Costs', '3 Operating Expenses')
  AND mes BETWEEN DATE('{mes_inicio_ltm.isoformat()}') AND DATE('{mes_corte.isoformat()}')
  AND (dummie_ajustes IS NULL OR dummie_ajustes != 1)
GROUP BY 1, 2
""".strip()


def _sql_net_interest(mes_inicio_ltm: dt.date, mes_corte: dt.date) -> str:
    """Net Interest Expense mensual por pais. En BET viene negativo neto
    (gasto > ingreso); aqui lo invertimos para mostrar como costo positivo."""
    return f"""
SELECT
  mes,
  m_pais,
  -- Invertimos signo: en BET es negativo neto, lo emitimos positivo como costo
  -SUM(IF(dummie_eliminaciones IS NULL OR dummie_eliminaciones NOT IN (1, -1),
          actuals_accounting, 0)) AS net_interest
FROM `{TABLE_BET}`
WHERE m_tipo = '1. Financials'
  AND m_categoria = '06. Net financing costs'
  AND mes BETWEEN DATE('{mes_inicio_ltm.isoformat()}') AND DATE('{mes_corte.isoformat()}')
  AND (dummie_ajustes IS NULL OR dummie_ajustes != 1)
GROUP BY 1, 2
""".strip()


def _sql_capitalized_payroll(mes_inicio_ltm: dt.date, mes_corte: dt.date) -> str:
    """Capitalized Payroll mensual por pais. En BET viene negativo (porque se
    capitaliza como activo no corriente, sale del P&L); aqui lo invertimos
    para sumarlo al EBITDA en la formula Adj EBITDA = EBITDA + Cap. Payroll."""
    return f"""
SELECT
  mes,
  m_pais,
  -- Invertimos signo: en BET es negativo, lo emitimos positivo para sumar
  -SUM(IF(dummie_eliminaciones IS NULL OR dummie_eliminaciones NOT IN (1, -1),
          actuals_accounting, 0)) AS capitalized_payroll
FROM `{TABLE_BET}`
WHERE m_tipo = '1. Financials'
  AND m_categoria = '05. Capitalized Payroll'
  AND mes BETWEEN DATE('{mes_inicio_ltm.isoformat()}') AND DATE('{mes_corte.isoformat()}')
  AND (dummie_ajustes IS NULL OR dummie_ajustes != 1)
GROUP BY 1, 2
""".strip()


def _twin_sum(df: pd.DataFrame, value_col: str = "debt") -> dict[str, float]:
    s = df[value_col].fillna(0)
    elim_mask = df["dummie_eliminaciones"].fillna(0).isin([1, -1])
    return {
        "sin_elim": float(s[~elim_mask].sum()),
        "solo_elim": float(s[elim_mask].sum()),
        "con_elim": float(s.sum()),
    }


def build(mes_corte: dt.date, mes_max: dt.date | None = None) -> dict[str, Any]:
    if mes_max is None:
        mes_max = mes_corte
    mes_inicio = dt.date(mes_corte.year, mes_corte.month, 1)
    for _ in range(HISTORY_MONTHS - 1):
        prev_last = mes_inicio - dt.timedelta(days=1)
        mes_inicio = dt.date(prev_last.year, prev_last.month, 1)

    # Rango LTM (12 meses adicionales hacia atras para calcular LTM del primer mes)
    mes_inicio_ltm = mes_inicio
    for _ in range(LTM_MONTHS - 1):
        prev_last = mes_inicio_ltm - dt.timedelta(days=1)
        mes_inicio_ltm = dt.date(prev_last.year, prev_last.month, 1)

    log.info("Debt in Homes: rango %s -> %s (LTM desde %s)", mes_inicio, mes_max, mes_inicio_ltm)
    # Debt LTM tambien: necesitamos 12 meses para calcular Average Debt LTM
    df_debt   = run_query(_sql_debt(mes_inicio_ltm, mes_max), label="debt_homes")
    df_ebitda = run_query(_sql_ebitda(mes_inicio_ltm, mes_max), label="debt_ebitda")
    df_cap    = run_query(_sql_capitalized_payroll(mes_inicio_ltm, mes_max), label="debt_cap_payroll")
    df_int    = run_query(_sql_net_interest(mes_inicio_ltm, mes_max), label="debt_net_interest")

    df_debt["mes"] = pd.to_datetime(df_debt["mes"])
    df_debt["pais_label"] = df_debt["m_pais"].map(PAIS_LABEL).fillna("(sin pais)")
    df_debt["m_pais"] = df_debt["pais_label"]

    df_ebitda["mes"] = pd.to_datetime(df_ebitda["mes"])
    df_ebitda["pais_label"] = df_ebitda["m_pais"].map(PAIS_LABEL).fillna("(sin pais)")

    df_cap["mes"] = pd.to_datetime(df_cap["mes"])
    df_cap["pais_label"] = df_cap["m_pais"].map(PAIS_LABEL).fillna("(sin pais)")

    df_int["mes"] = pd.to_datetime(df_int["mes"])
    df_int["pais_label"] = df_int["m_pais"].map(PAIS_LABEL).fillna("(sin pais)")

    # Adj EBITDA mensual por pais
    ebitda_pivot = df_ebitda.pivot_table(
        index="mes", columns="pais_label", values="ebitda", aggfunc="sum"
    ).fillna(0)
    cap_pivot = df_cap.pivot_table(
        index="mes", columns="pais_label", values="capitalized_payroll", aggfunc="sum"
    ).reindex(ebitda_pivot.index).fillna(0)
    # Alinear columnas
    for col in ebitda_pivot.columns:
        if col not in cap_pivot.columns:
            cap_pivot[col] = 0.0
    cap_pivot = cap_pivot[ebitda_pivot.columns]
    adj_ebitda_pivot = ebitda_pivot + cap_pivot

    # LTM rolling
    ebitda_ltm = ebitda_pivot.rolling(window=LTM_MONTHS, min_periods=1).sum()
    cap_ltm    = cap_pivot.rolling(window=LTM_MONTHS, min_periods=1).sum()
    adj_ltm    = adj_ebitda_pivot.rolling(window=LTM_MONTHS, min_periods=1).sum()

    # Net interest LTM (suma 12 meses)
    int_pivot = df_int.pivot_table(
        index="mes", columns="pais_label", values="net_interest", aggfunc="sum"
    ).reindex(ebitda_pivot.index).fillna(0)
    for col in ebitda_pivot.columns:
        if col not in int_pivot.columns:
            int_pivot[col] = 0.0
    int_pivot = int_pivot[ebitda_pivot.columns]
    interest_ltm = int_pivot.rolling(window=LTM_MONTHS, min_periods=1).sum()

    # Debt saldo mensual por bucket + total, y promedio LTM por bucket + total
    def _pivot_debt(bucket_val: str | None) -> pd.DataFrame:
        """Pivot saldo mensual por (mes, pais) filtrado a un bucket. Si
        bucket_val is None, suma todos los buckets (= Total)."""
        d = df_debt if bucket_val is None else df_debt[df_debt["bucket"] == bucket_val]
        p = d.pivot_table(
            index="mes", columns="pais_label", values="debt", aggfunc="sum"
        ).reindex(ebitda_pivot.index).fillna(0)
        for col in ebitda_pivot.columns:
            if col not in p.columns:
                p[col] = 0.0
        return p[ebitda_pivot.columns]

    debt_homes_snap     = _pivot_debt("homes")
    debt_corporate_snap = _pivot_debt("corporate")
    debt_total_snap     = debt_homes_snap + debt_corporate_snap
    debt_homes_avg_ltm     = debt_homes_snap.rolling(window=LTM_MONTHS, min_periods=1).mean()
    debt_corporate_avg_ltm = debt_corporate_snap.rolling(window=LTM_MONTHS, min_periods=1).mean()
    debt_total_avg_ltm     = debt_total_snap.rolling(window=LTM_MONTHS, min_periods=1).mean()

    # Emitir facts solo del rango [mes_inicio, mes_corte] (no del rango LTM extendido)
    df_debt_emit = df_debt[df_debt["mes"] >= pd.Timestamp(mes_inicio)].copy()
    meses_disponibles = sorted({m.strftime("%Y-%m") for m in df_debt_emit["mes"].unique()})

    def _lev(debt_val: float, adj: float | None) -> float | None:
        return (debt_val / adj) if (adj is not None and adj != 0) else None

    def _coc(interest: float | None, avg: float | None) -> float | None:
        return (interest / avg) if (interest is not None and avg is not None and avg != 0) else None

    def _snap(pivot: pd.DataFrame, mes_ts: pd.Timestamp, pais: str) -> float | None:
        return float(pivot.loc[mes_ts, pais]) if pais in pivot.columns and mes_ts in pivot.index else None

    facts = []
    keys = ["mes", "m_pais", "dummie_ajustes"]
    for vals, g in df_debt_emit.groupby(keys, dropna=False):
        mes, pais, ajuste = vals
        # Twin (sin_elim / con_elim / solo_elim) sobre el TOTAL (homes+corporate)
        actuals_total = _twin_sum(g, "debt")
        # Buckets por m_metrica
        actuals_homes     = _twin_sum(g[g["bucket"] == "homes"],     "debt")
        actuals_corporate = _twin_sum(g[g["bucket"] == "corporate"], "debt")

        mes_ts = pd.Timestamp(mes) if not isinstance(mes, pd.Timestamp) else mes
        ebitda_ltm_v   = _snap(ebitda_ltm,   mes_ts, pais)
        cap_ltm_v      = _snap(cap_ltm,      mes_ts, pais)
        adj_ltm_v      = _snap(adj_ltm,      mes_ts, pais)
        interest_ltm_v = _snap(interest_ltm, mes_ts, pais)
        avg_homes     = _snap(debt_homes_avg_ltm,     mes_ts, pais)
        avg_corporate = _snap(debt_corporate_avg_ltm, mes_ts, pais)
        avg_total     = _snap(debt_total_avg_ltm,     mes_ts, pais)

        facts.append({
            "mes": mes_ts.strftime("%Y-%m"),
            "pais": pais if pd.notna(pais) else None,
            "subsidiaria": None,
            "linea": None,
            "cuenta": None,
            "cuenta_desc": None,
            "es_ajuste": bool(pd.notna(ajuste) and ajuste == 1),
            # `actuals` = TOTAL (homes + corporate) — cifra principal de la card.
            "actuals": actuals_total,
            "actuals_homes": actuals_homes,
            "actuals_corporate": actuals_corporate,
            "budget":  {"sin_elim": 0.0, "con_elim": 0.0, "solo_elim": 0.0},
            "ebitda_ltm": ebitda_ltm_v,
            "capitalized_payroll_ltm": cap_ltm_v,
            "adj_ebitda_ltm": adj_ltm_v,
            "net_interest_ltm": interest_ltm_v,
            # 3 vistas Homes / Corporate / Total. La card muestra Total; el
            # drill tiene toggle para las otras 2.
            "leverage":           _lev(actuals_total["sin_elim"],     adj_ltm_v),
            "leverage_homes":     _lev(actuals_homes["sin_elim"],     adj_ltm_v),
            "leverage_corporate": _lev(actuals_corporate["sin_elim"], adj_ltm_v),
            "debt_avg_ltm":           avg_total,
            "debt_homes_avg_ltm":     avg_homes,
            "debt_corporate_avg_ltm": avg_corporate,
            "cost_of_capital":           _coc(interest_ltm_v, avg_total),
            "cost_of_capital_homes":     _coc(interest_ltm_v, avg_homes),
            "cost_of_capital_corporate": _coc(interest_ltm_v, avg_corporate),
        })

    log.info("Debt in Homes: %d facts", len(facts))

    payload: dict[str, Any] = {
        "id": "net_debt",
        "nombre": "Net debt, leverage & cost of capital",
        "seccion": "4.2",
        "unidad": "MONEDA_DEBT_HOMES",
        "estado": "real",
        "invertir_delta": True,  # mas deuda = peor
        "fuente": (
            "bet_data_p2 · drivers Homes + Corporate Debt · "
            "leverage = Debt / Adj EBITDA LTM · "
            "cost of capital = |Net Interest LTM| / Avg Debt LTM"
        ),
        "receta": {
            "tabla": TABLE_BET,
            "filtros_debt": [
                "m_tipo = '3. Drivers'",
                "m_categoria = '03. Balance General'",
                "m_metrica IN ('05. Debt in Homes', '04. Corporate Debt')",
                "total = homes + corporate",
            ],
            "filtros_ebitda": [
                "m_tipo = '1. Financials'",
                "c_total_reporte IN ('1 Gross Profit', '2 Other Costs', '3 Operating Expenses')",
            ],
            "filtros_capitalized_payroll": [
                "m_tipo = '1. Financials'",
                "m_categoria = '05. Capitalized Payroll'",
            ],
            "filtros_net_interest": [
                "m_tipo = '1. Financials'",
                "m_categoria = '06. Net financing costs'",
                "incluye Interest Expense + Interest Income",
            ],
            "adj_ebitda_formula": "EBITDA BET + Capitalized Payroll (formula contable estandar)",
            "cost_of_capital_formula": "|Net Interest LTM| / promedio(Debt LTM 12 meses) por bucket",
            "ltm_meses": LTM_MONTHS,
            "nota": (
                "Net Interest LTM no esta separado por bucket (el bet no lo splitea). "
                "Cost of Capital 'Homes only' y 'Corporate only' usan el mismo numerador "
                "= son proxys. La vista Total es la financieramente correcta."
            ),
            "monedas": MONEDA_POR_PAIS,
        },
        "meses_disponibles": meses_disponibles,
        "facts": facts,
    }
    return payload
