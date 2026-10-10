"""Descarga los animes más populares de AniList y los guarda en data/anime.json.

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
OUTPUT = Path(__file__).resolve().parent.parent / "data" / "anime.json"
MIN_RESULTS = 800  # si llegan menos, algo ha fallado: no se sobrescribe el JSON
ALLOWED_FORMATS = {"TV", "TV_SHORT", "MOVIE", "ONA", "OVA"}

QUERY = """
query ($page: Int, $perPage: Int) {
  Page(page: $page, perPage: $perPage) {
    pageInfo { hasNextPage }
    media(type: ANIME, sort: POPULARITY_DESC, isAdult: false) {
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


def fetch_page(page: int) -> dict:
    """Pide una página a AniList, reintentando si salta el rate limit."""
    payload = json.dumps(
        {"query": QUERY, "variables": {"page": page, "perPage": PER_PAGE}}
    ).encode("utf-8")
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


def main() -> None:
    animes: dict[int, dict] = {}  # por id, evita duplicados entre páginas

    for page in range(1, MAX_PAGES + 1):
        print(f"Página {page}/{MAX_PAGES}...")
        data = fetch_page(page)
        for media in data["media"]:
            if media["format"] in ALLOWED_FORMATS:
                animes[media["id"]] = normalize(media)
        if not data["pageInfo"]["hasNextPage"]:
            break
        time.sleep(REQUEST_DELAY)

    result = sorted(animes.values(), key=lambda a: a["members"], reverse=True)
    if len(result) < MIN_RESULTS:
        raise SystemExit(f"Solo se obtuvieron {len(result)} animes; no se sobrescribe {OUTPUT}")
    OUTPUT.parent.mkdir(parents=True, exist_ok=True)
    OUTPUT.write_text(
        json.dumps(result, ensure_ascii=False, separators=(",", ":")),
        encoding="utf-8",
    )
    print(f"\nGuardados {len(result)} animes en {OUTPUT}")
    print(f"Más popular: {result[0]['title']} ({result[0]['members']:,} miembros)")


if __name__ == "__main__":
    main()
