"""Descarga los animes de romance más populares de AniList y los guarda en data/romance.json.

Reutiliza fetch_dataset() de fetch_anime.py: mismos formatos y campos que anime.json.

Uso (desde la raíz del repo):
    python scripts/fetch_romance.py
"""

from fetch_anime import DATA_DIR, fetch_dataset

GENRES = ["Romance"]
LIMIT = 400  # top 400 por popularidad
MAX_PAGES = 12  # 12 x 50 = 600, margen para los formatos descartados
MIN_RESULTS = 320  # si llegan menos, algo ha fallado: no se sobrescribe el JSON
OUTPUT = DATA_DIR / "romance.json"


def main() -> None:
    fetch_dataset(OUTPUT, genres=GENRES, max_pages=MAX_PAGES, limit=LIMIT, min_results=MIN_RESULTS)


if __name__ == "__main__":
    main()
