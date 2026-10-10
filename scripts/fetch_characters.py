"""Descarga los personajes con más favoritos de AniList y los guarda en data/characters.json.

Uso (desde la raíz del repo):
    python scripts/fetch_characters.py
"""

import json
import time
import urllib.error
import urllib.request
from pathlib import Path

API_URL = "https://graphql.anilist.co"
PER_PAGE = 50
MAX_PAGES = 20  # 20 x 50 = top 1000 por favoritos
REQUEST_DELAY = 2.0  # segundos entre peticiones, margen sobre el rate limit
MIN_RESULTS = 800  # si llegan menos, algo ha fallado: no se sobrescribe el JSON
OUTPUT = Path(__file__).resolve().parent.parent / "data" / "characters.json"

QUERY = """
query ($page: Int, $perPage: Int) {
  Page(page: $page, perPage: $perPage) {
    pageInfo { hasNextPage }
    characters(sort: FAVOURITES_DESC) {
      id
      name { full }
      image { large }
      favourites
      media(sort: POPULARITY_DESC, type: ANIME, perPage: 1) {
        nodes { title { romaji english } }
      }
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


def normalize(character: dict) -> dict:
    """Se queda solo con los campos que usa el juego."""
    nodes = character["media"]["nodes"]
    anime = None
    if nodes:  # anime más popular en el que aparece; None si solo sale en manga
        title = nodes[0]["title"]
        anime = title["english"] or title["romaji"]
    return {
        "id": character["id"],
        "name": character["name"]["full"],
        "image": character["image"]["large"],
        "favourites": character["favourites"],
        "anime": anime,
    }


def main() -> None:
    characters: dict[int, dict] = {}  # por id, evita duplicados entre páginas

    for page in range(1, MAX_PAGES + 1):
        print(f"Página {page}/{MAX_PAGES}...")
        data = fetch_page(page)
        for character in data["characters"]:
            characters[character["id"]] = normalize(character)
        if not data["pageInfo"]["hasNextPage"]:
            break
        time.sleep(REQUEST_DELAY)

    result = sorted(characters.values(), key=lambda c: c["favourites"], reverse=True)
    if len(result) < MIN_RESULTS:
        raise SystemExit(f"Solo se obtuvieron {len(result)} personajes; no se sobrescribe {OUTPUT}")
    OUTPUT.parent.mkdir(parents=True, exist_ok=True)
    OUTPUT.write_text(
        json.dumps(result, ensure_ascii=False, separators=(",", ":")),
        encoding="utf-8",
    )
    print(f"\nGuardados {len(result)} personajes en {OUTPUT}")
    print(f"Más popular: {result[0]['name']} ({result[0]['favourites']:,} favoritos)")


if __name__ == "__main__":
    main()
