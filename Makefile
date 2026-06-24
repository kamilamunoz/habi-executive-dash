# habi-dashboard — comandos comunes
#
# Uso:
#   make install   instala dependencias con uv
#   make refresh   corre todas las queries y regenera site/data/*.json
#   make serve     abre el sitio en http://localhost:8000
#   make lint      revisa el codigo Python con ruff
#   make clean     borra archivos generados de Python (no toca los JSON)

.PHONY: install refresh serve lint clean

install:
	uv sync

refresh:
	uv run python -m scripts.refresh_data

serve:
	@echo "Abre http://localhost:8000/site/ en el navegador"
	python3 -m http.server 8000

lint:
	uv run ruff check scripts/

clean:
	find . -type d -name __pycache__ -exec rm -rf {} + 2>/dev/null || true
	find . -type f -name "*.pyc" -delete 2>/dev/null || true
