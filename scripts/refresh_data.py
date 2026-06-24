"""Orquesta el refresh completo de datos del dashboard.

Uso:
    python -m scripts.refresh_data
    # o
    make refresh

Cada KPI vive en scripts/kpis/<nombre>.py y expone una funcion build()
que devuelve un dict serializable a JSON. Este orquestador los corre
todos en secuencia y escribe los archivos en site/data/.
"""

from __future__ import annotations

import datetime as dt
import json
import logging
import time

from scripts._common import DATA_DIR, FX_DEFAULT, mes_corte_default, mes_label
from scripts.kpis import gmv, ingresos, margen

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s %(levelname)s %(name)s · %(message)s",
    datefmt="%H:%M:%S",
)
log = logging.getLogger("refresh")


KPIS = [
    ("kpi_ingresos.json", ingresos),
    ("kpi_gmv.json", gmv),
    ("kpi_margen_bruto.json", margen),
    # ... etc
]


def main() -> None:
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    mes_corte = mes_corte_default()
    log.info("Mes corte: %s", mes_label(mes_corte))

    # Meta global del refresh — la UI la lee para mostrar "Datos al ..."
    meta = {
        "generado_en": dt.datetime.now().isoformat(timespec="seconds"),
        "mes_corte": mes_corte.isoformat(),
        "mes_corte_label": mes_label(mes_corte),
        "fx_default": FX_DEFAULT,
    }
    (DATA_DIR / "meta.json").write_text(json.dumps(meta, indent=2, ensure_ascii=False))
    log.info("meta.json escrito")

    # Cada KPI
    for filename, module in KPIS:
        t0 = time.time()
        log.info("Construyendo %s ...", filename)
        payload = module.build(mes_corte=mes_corte)
        (DATA_DIR / filename).write_text(json.dumps(payload, indent=2, ensure_ascii=False))
        log.info("%s escrito en %.1fs", filename, time.time() - t0)


if __name__ == "__main__":
    main()
