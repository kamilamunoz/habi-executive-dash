"""Helpers compartidos por todos los KPIs: normalizacion, FX defaults, formato de meses."""

from __future__ import annotations

import datetime as dt
from pathlib import Path

# ---------------------------------------------------------------------------
# Rutas
# ---------------------------------------------------------------------------

REPO_ROOT = Path(__file__).resolve().parent.parent
DATA_DIR = REPO_ROOT / "site" / "data"


# ---------------------------------------------------------------------------
# Catalogos canonicos
# ---------------------------------------------------------------------------

# Subsidiarias con naming duplicado en bet_data_p2 → normalizar al canonico.
# Las que no esten en el dict se dejan como vienen.
SUBSIDIARIA_CANONICA = {
    "Habicapital": "HabiCapital",  # 288 filas mal escritas
    "TuHabiPres": "Tu HabiPres",  # 5,184 filas mal escritas
}

# Mapeo pais → moneda local
MONEDA_POR_PAIS = {
    "1. Colombia": "COP",
    "2. Mexico": "MXN",
    "3. Offshore": "USD",
}

# Etiquetas cortas para la UI
PAIS_LABEL = {
    "1. Colombia": "Colombia",
    "2. Mexico": "Mexico",
    "3. Offshore": "Offshore",
}

# FX defaults (editable por el usuario en el sidebar del dashboard)
FX_DEFAULT = {
    "COP": 3700.0,  # COP por 1 USD
    "MXN": 18.5,
    "USD": 1.0,
}


def normalize_subsidiaria(name: str | None) -> str | None:
    if name is None:
        return None
    return SUBSIDIARIA_CANONICA.get(name, name)


# ---------------------------------------------------------------------------
# Meses
# ---------------------------------------------------------------------------

MESES_ABREV = {
    1: "Ene", 2: "Feb", 3: "Mar", 4: "Abr", 5: "May", 6: "Jun",
    7: "Jul", 8: "Ago", 9: "Sep", 10: "Oct", 11: "Nov", 12: "Dic",
}


def mes_label(d: dt.date) -> str:
    """Devuelve 'May 2026' para una fecha."""
    return f"{MESES_ABREV[d.month]} {d.year}"


def mes_corte_default() -> dt.date:
    """Mes anterior al actual (ultimo mes con cierre razonable)."""
    hoy = dt.date.today()
    primer_dia_mes_actual = dt.date(hoy.year, hoy.month, 1)
    ultimo_dia_mes_anterior = primer_dia_mes_actual - dt.timedelta(days=1)
    return dt.date(ultimo_dia_mes_anterior.year, ultimo_dia_mes_anterior.month, 1)


def mes_max_disponible() -> dt.date:
    """Mes en curso (parcial). Upper bound de las queries para traer MTD."""
    hoy = dt.date.today()
    return dt.date(hoy.year, hoy.month, 1)
