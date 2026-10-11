"""Descarga los animes más populares de AniList y los guarda en data/anime.json.

fetch_dataset() también la usan otros scripts (p. ej. fetch_romance.py) para
generar listas filtradas por género con el mismo formato.

Uso (desde la raíz del repo):
    python scripts/fetch_anime.py
"""

import json
import time
import urllib.error
import urllib.request
from pathlib import Path

API_URL = "https://graphql.anilist.co"
PER_PAGE = 50
MAX_PAGES = 20  # 20 x 50 = top 1000 por popularidad
REQUEST_DELAY = 2.0  # segundos entre peticiones, margen sobre el rate limit
DATA_DIR = Path(__file__).resolve().parent.parent / "data"
OUTPUT = DATA_DIR / "anime.json"
MIN_RESULTS = 800  # si llegan menos, algo ha fallado: no se sobrescribe el JSON
ALLOWED_FORMATS = {"TV", "TV_SHORT", "MOVIE", "ONA", "OVA"}

# AniList ignora los argumentos a null: sin géneros ($genres = null) no se filtra.
QUERY = """
query ($page: Int, $perPage: Int, $genres: [String]) {
  Page(page: $page, perPage: $perPage) {
    pageInfo { hasNextPage }
    media(type: ANIME, sort: POPULARITY_DESC, isAdult: false, genre_in: $genres) {
      id
      title { romaji english }
      coverImage { extraLarge medium color }
      format
      seasonYear
      popularity
      favourites
      averageScore
    }
  }
}
"""

HEADERS = {
    "Content-Type": "application/json",
    "Accept": "application/json",
    "User-Agent": "anime-higher-or-lower/0.1",
}


def fetch_page(page: int, genres: list[str] | None = None) -> dict:
    """Pide una página a AniList, reintentando si salta el rate limit."""
    variables = {"page": page, "perPage": PER_PAGE, "genres": genres}
    payload = json.dumps({"query": QUERY, "variables": variables}).encode("utf-8")
    request = urllib.request.Request(API_URL, data=payload, headers=HEADERS)

    while True:
        try:
            with urllib.request.urlopen(request, timeout=30) as response:
                return json.load(response)["data"]["Page"]
        except urllib.error.HTTPError as err:
            if err.code != 429:
                raise
            wait = int(err.headers.get("Retry-After", 60))
            print(f"  Rate limit alcanzado, esperando {wait}s...")
            time.sleep(wait)


def normalize(media: dict) -> dict:
    """Se queda solo con los campos que usa el juego."""
    title = media["title"]
    return {
        "id": media["id"],
        "title": title["english"] or title["romaji"],
        "romaji": title["romaji"],
        "image": media["coverImage"]["extraLarge"],
        "thumb": media["coverImage"]["medium"],  # miniatura ligera para el mosaico de la portada
        "color": media["coverImage"]["color"],
        "year": media["seasonYear"],
        "members": media["popularity"],      # usuarios que lo tienen en su lista
        "favourites": media["favourites"],
        "score": media["averageScore"],      # 0-100, puede ser None
    }


def fetch_dataset(
    output: Path,
    *,
    genres: list[str] | None = None,
    max_pages: int = MAX_PAGES,
    limit: int | None = None,
    min_results: int = MIN_RESULTS,
) -> None:
    """Descarga los animes más populares (opcionalmente de ciertos géneros) y los guarda en `output`.

    Con `limit`, deja de pedir páginas en cuanto hay suficientes y guarda solo los `limit` primeros.
    """
    animes: dict[int, dict] = {}  # por id, evita duplicados entre páginas

    for page in range(1, max_pages + 1):
        print(f"Página {page}/{max_pages}...")
        data = fetch_page(page, genres)
        for media in data["media"]:
            if media["format"] in ALLOWED_FORMATS:
                animes[media["id"]] = normalize(media)
        if not data["pageInfo"]["hasNextPage"] or (limit and len(animes) >= limit):
            break
        time.sleep(REQUEST_DELAY)

    result = sorted(animes.values(), key=lambda a: a["members"], reverse=True)[:limit]
    if len(result) < min_results:
        raise SystemExit(f"Solo se obtuvieron {len(result)} animes; no se sobrescribe {output}")
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text(
        json.dumps(result, ensure_ascii=False, separators=(",", ":")),
        encoding="utf-8",
    )
    print(f"\nGuardados {len(result)} animes en {output}")
    print(f"Más popular: {result[0]['title']} ({result[0]['members']:,} miembros)")


def main() -> None:
    fetch_dataset(OUTPUT)


if __name__ == "__main__":
    main()
