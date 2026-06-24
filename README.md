# Habi · Dashboard Ejecutivo de KPIs

Tablero estatico hosteado en GitHub Pages que muestra los KPIs del marco ejecutivo (4.1 Resultado y rentabilidad · 4.2 Capital, balance y liquidez) con datos refrescados manualmente desde BigQuery.

## Como funciona

```
BigQuery (bet_data_p2)
      │
      │  make refresh   (corre queries, escribe JSON)
      ▼
site/data/*.json
      │
      │  GitHub Pages sirve los archivos estaticos
      ▼
HTML + JS (site/index.html)  →  navegador
```

- **Sin backend**, sin Streamlit, sin servidor.
- Refresh manual: corres `make refresh` cuando quieras actualizar.
- Drill-down precomputado a **Nivel B**: pais + subsidiaria + linea de negocio + cuenta top 20.

## Setup la primera vez

Requisitos: Python 3.12, [`uv`](https://docs.astral.sh/uv/), credenciales de BigQuery (Application Default Credentials).

```bash
# 1. Autenticate con tu cuenta Habi para BQ
gcloud auth application-default login

# 2. Instala dependencias
make install
```

## Uso diario

```bash
# Refrescar los datos desde BigQuery
make refresh

# Ver el dashboard en local
make serve
# → abre http://localhost:8000/site/

# Publicar (cuando esten todos los KPIs listos)
git add site/data/
git commit -m "Refresh datos <mes>"
git push   # GitHub Pages publica solo
```

## Estructura

```
habi-dashboard/
├── site/                       ← GitHub Pages sirve esto
│   ├── index.html
│   ├── css/styles.css
│   ├── js/app.js
│   └── data/                   ← JSONs generados por make refresh
├── scripts/
│   ├── refresh_data.py         ← orquesta todo
│   ├── _bq.py                  ← cliente BigQuery
│   ├── _common.py              ← helpers (normalizacion, FX, meses)
│   └── kpis/
│       └── ingresos.py         ← 1 archivo por KPI (receta SQL + builder JSON)
├── Makefile
├── pyproject.toml
└── README.md
```

## Estados por KPI

Cada KPI vive en uno de cuatro estados:

- 🟢 **real** — dato verificado contra BQ.
- 🟡 **parcial** — parte real, parte pendiente.
- 🟣 **ejemplo** — placeholder, no es dato de negocio.
- ⚪ **pendiente** — sin fuente todavia.

## Estado actual

| KPI | Estado |
|---|---|
| 4.1.1 Ingresos totales | 🚧 en construccion |
| 4.1.2 GMV | ⚪ pendiente |
| 4.1.3 Margen bruto | ⚪ pendiente |
| 4.1.4 Contribution margin | ⚪ pendiente |
| 4.1.5 EBITDA | ⚪ pendiente |
| 4.1.6 OpEx / Ingreso | ⚪ pendiente |
| 4.1.7 Burn / Runway | ⚪ pendiente |
| 4.2 (todos) | ⚪ pendiente |
