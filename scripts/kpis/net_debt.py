"""KPI 4.2.6 — Net debt, leverage & cost of capital.

Cifra principal del card: Debt in Homes (saldo de la deuda asociada a la
financiacion de inmuebles, de los drivers de BET).

Metricas secundarias:

  Leverage = Debt in Homes / Adjusted EBITDA LTM
    - EBITDA LTM = suma 12 meses del EBITDA BET.
    - Capitalized Payroll LTM = suma 12 meses del payroll capitalizado
      (m_categoria='05. Capitalized Payroll'). En BET viene negativo (sale del
      P&L); aqui lo invertimos para sumarlo al EBITDA.
    - Adjusted EBITDA LTM = EBITDA LTM + Capitalized Payroll LTM.

  Cost of capital = |Net Interest LTM| / Average Debt LTM
    - Net Interest LTM = suma 12 meses de m_categoria='06. Net financing costs'
      (Interest Expense + Interest Income, ambos con signo de BET). En BET viene
      negativo neto; aqui lo invertimos para mostrar como costo positivo.
    - Average Debt LTM = promedio de los saldos de Debt in Homes en los 12 meses.
    - Resultado anualizado naturalmente (LTM / LTM).

NO incluye deuda corporativa (04. Corporate Debt esta vacio en BET; pendiente
reportar al owner).
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
    return f"""
SELECT
  mes,
  m_pais,
  dummie_eliminaciones,
  dummie_ajustes,
  SUM(actuals_accounting) AS debt
FROM `{TABLE_BET}`
WHERE m_tipo = '3. Drivers'
  AND m_categoria = '03. Balance General'
  AND m_metrica = '05. Debt in Homes'
  AND mes BETWEEN DATE('{mes_inicio.isoformat()}') AND DATE('{mes_corte.isoformat()}')
GROUP BY 1, 2, 3, 4
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

    # Debt saldo mensual (snapshot) y promedio LTM
    debt_snapshot = df_debt.pivot_table(
        index="mes", columns="pais_label", values="debt", aggfunc="sum"
    ).reindex(ebitda_pivot.index).fillna(0)
    for col in ebitda_pivot.columns:
        if col not in debt_snapshot.columns:
            debt_snapshot[col] = 0.0
    debt_snapshot = debt_snapshot[ebitda_pivot.columns]
    debt_avg_ltm = debt_snapshot.rolling(window=LTM_MONTHS, min_periods=1).mean()

    # Emitir facts solo del rango [mes_inicio, mes_corte] (no del rango LTM extendido)
    df_debt_emit = df_debt[df_debt["mes"] >= pd.Timestamp(mes_inicio)].copy()
    meses_disponibles = sorted({m.strftime("%Y-%m") for m in df_debt_emit["mes"].unique()})

    facts = []
    keys = ["mes", "m_pais", "dummie_ajustes"]
    for vals, g in df_debt_emit.groupby(keys, dropna=False):
        mes, pais, ajuste = vals
        debt_buckets = _twin_sum(g, "debt")
        mes_ts = pd.Timestamp(mes) if not isinstance(mes, pd.Timestamp) else mes
        ebitda_ltm_v = float(ebitda_ltm.loc[mes_ts, pais]) if pais in ebitda_ltm.columns and mes_ts in ebitda_ltm.index else None
        cap_ltm_v    = float(cap_ltm.loc[mes_ts, pais])    if pais in cap_ltm.columns    and mes_ts in cap_ltm.index    else None
        adj_ltm_v    = float(adj_ltm.loc[mes_ts, pais])    if pais in adj_ltm.columns    and mes_ts in adj_ltm.index    else None
        interest_ltm_v = float(interest_ltm.loc[mes_ts, pais]) if pais in interest_ltm.columns and mes_ts in interest_ltm.index else None
        debt_avg_v     = float(debt_avg_ltm.loc[mes_ts, pais]) if pais in debt_avg_ltm.columns and mes_ts in debt_avg_ltm.index else None
        leverage     = (debt_buckets["sin_elim"] / adj_ltm_v) if (adj_ltm_v and adj_ltm_v != 0) else None
        cost_of_capital = (interest_ltm_v / debt_avg_v) if (interest_ltm_v is not None and debt_avg_v and debt_avg_v != 0) else None
        facts.append({
            "mes": mes_ts.strftime("%Y-%m"),
            "pais": pais if pd.notna(pais) else None,
            "subsidiaria": None,
            "linea": None,
            "cuenta": None,
            "cuenta_desc": None,
            "es_ajuste": bool(pd.notna(ajuste) and ajuste == 1),
            "actuals": debt_buckets,
            "budget":  {"sin_elim": 0.0, "con_elim": 0.0, "solo_elim": 0.0},
            "ebitda_ltm": ebitda_ltm_v,
            "capitalized_payroll_ltm": cap_ltm_v,
            "adj_ebitda_ltm": adj_ltm_v,
            "leverage": leverage,
            "net_interest_ltm": interest_ltm_v,
            "debt_avg_ltm": debt_avg_v,
            "cost_of_capital": cost_of_capital,
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
            "bet_data_p2 · drivers Debt in Homes · "
            "leverage = Debt / Adj EBITDA LTM · "
            "cost of capital = |Net Interest LTM| / Avg Debt LTM"
        ),
        "receta": {
            "tabla": TABLE_BET,
            "filtros_debt": [
                "m_tipo = '3. Drivers'",
                "m_categoria = '03. Balance General'",
                "m_metrica = '05. Debt in Homes'",
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
            "cost_of_capital_formula": "|Net Interest LTM| / promedio(Debt LTM 12 meses)",
            "ltm_meses": LTM_MONTHS,
            "nota": "Corporate Debt vacio en BET; pendiente reportar al owner.",
            "monedas": MONEDA_POR_PAIS,
        },
        "meses_disponibles": meses_disponibles,
        "facts": facts,
    }
    return payload
