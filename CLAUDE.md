# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Qué es

Juego web Higher or Lower de anime (higherloweranime.com) más el modo Hair Color. Web estática **sin frameworks ni build**: `index.html`, `game.js`, `style.css` se sirven tal cual. Desplegada en GitHub Pages con GitHub Actions; datos de AniList; analítica con Umami (solo cuenta en el dominio de producción, `data-domains`).

Convenciones: comentarios y textos de desarrollo en **español**; textos de la interfaz en **inglés**. Finales de línea LF (`.gitattributes`). Mensajes de commit en inglés.

## Comandos

No hay tests, linter ni paso de build.

```bash
python -m http.server 8000            # servir en local (fetch de data/*.json no funciona con file://)
node --check game.js                  # comprobación de sintaxis tras editar

python scripts/fetch_anime.py         # data/anime.json (top 1000 por popularidad)
python scripts/fetch_characters.py    # data/characters.json (top 1000 por favoritos)
python scripts/fetch_romance.py       # data/romance.json (top 400 romance)
```

Color Guess (antes Hair Color): herramienta local de anotación, necesita `.venv` con torch/torchvision CPU + `scripts/requirements-color.txt` (ver README):

```bash
.venv/Scripts/python scripts/color/server.py                 # http://localhost:8001 (--model edgetam|none)
```

Para verificar UI se ha usado Edge headless por CDP (`msedge --headless=new --remote-debugging-port=...` + script de Node). Requisito de diseño: **sin scroll en 375×667** (y se comprueba también 320×568 y 1280×800, claro y oscuro).

## Arquitectura

### game.js (una IIFE, secciones con `/* ---------- X ---------- */`)

- **Configuración declarativa al principio**:
  - `DATASETS` (url, accesores nombre/subtítulo/imagen/color, `rankKey` y curva `difficulty` propia: el pool de candidatos son los N más populares y crece con la racha).
  - `MODES` (Higher or Lower: dataset + campo comparado; `label` completo para HUD/compartir, `name` corto dentro de su categoría).
  - `CATEGORIES` (tarjetas de la portada; una categoría con un solo modo arranca directamente, con varios despliega sus modos en la misma celda de rejilla para que el título no salte; `hidden: true` la quita de la portada sin borrar el modo).
  - `DAILY_MODE` y `HAIR_MODES` (otro juego; `mode.game === 'hair'` hace que `startGame` delegue en `startHair`; `mode.menu()` da descripción y dato lateral del botón).
- **Los `id` de modo son claves persistentes**: récords en `localStorage` (`hol:best:<id>`) y eventos Umami. No renombrarlos; cambiar `label` sí es seguro.
- **Cancelación por token**: `state.token` / `hair.token` se incrementan al empezar o salir; cada `await` comprueba el token antes de seguir. Mantener este patrón en cualquier flujo asíncrono nuevo.
- **Diarios deterministas por fecha UTC**: Higher or Lower usa `mulberry32(hashString(fecha))`; Hair Color recorre una permutación fija de los aprobados indexada por `día - HAIR_FIRST_DAY`. `DAILY_FIRST_DAY` y `HAIR_FIRST_DAY` definen el #1: no cambiarlos tras publicar. Cambiar la lista de aprobados de Hair Color cambia el orden del diario (publicar ampliaciones tras las 00:00 UTC).
- `localStorage` se envuelve siempre en `store` (try/catch). Analítica solo vía `track()`, pocos eventos por partida (`game_start`, `game_over`, `share_click`).

### Hair Color → Color Guess (en rehacer)

Oculto en la portada (`hidden` en `CATEGORIES`); su código sigue en `game.js` y todavía lee `data/hair.json`, que se ha retirado (las imágenes de AniList eran casi todas de manga, con colores distintos del anime). Se rehace como Color Guess ("What color is Luffy's straw hat?") con datos anotados a mano. Ids `hair`, `hair-daily`, `hair-practice` y `HAIR_FIRST_DAY` se mantienen.

- **Recoloreado** (canvas): por cada píxel de pelo se conserva su claridad L original desplazada en bloque hasta la elegida, y se sustituye el croma/tono (limitado a la gama sRGB en cada L). Se precalcula una LUT de 101 entradas por L original, así cada fotograma solo indexa. Tres sliders (tono, saturación como fracción de la croma máxima, claridad): con solo dos, los pelos grises/negros/blancos y los castaños apagados eran inalcanzables.
- **Puntuación**: CIEDE2000 (`ciede2000`, validada contra los pares de Sharma et al.), `100·(1−ΔE/50)^1.6`.
- **Imágenes**: se leen del CDN de AniList con `crossOrigin` (devuelve `Access-Control-Allow-Origin` reflejado). `readPixels` reintenta con `?cors` por si la caché tiene una copia sin CORS (la del modo Characters).
- **Anotación** `scripts/color/` (no se publica): `server.py` (stdlib + Pillow; SAM 2.1 tiny vía transformers, opcional) sirve `annotate.html`/`annotate.js`. Objetivos en `targets.csv` (personaje por id o nombre, target, imagen opcional, nombre corto); trabajo en `annotations.json`. Cada guardado regenera con `publish()` `data/color.json` + `assets/color/masks/` (solo terminados, orden del CSV; no editarlos a mano); las imágenes propias van reducidas a `assets/color/img/` (400 px de alto, WebP). Formato de entrada igual que el antiguo `hair.json` (`id, name, anime, image, mask, hex, lab`) más `key`, `short` y `target`. `annotate.js` copia las fórmulas de color y la LUT de `game.js`: si cambian allí, actualizarlas también.
- **SAM en CPU** (medido en este equipo): SAM ViT-B ~20 s de embedding, SAM 2.1 tiny ~7 s, EdgeTAM ~2 s (más ruidoso); cada clic ~0,25 s con el embedding hecho. Por eso el embedding se calcula en segundo plano al abrir cada objetivo, se precarga el siguiente y se cachea en `scripts/color/cache/` (ignorado). Con un solo punto SAM devuelve 3 niveles y el de una sola máscara suele ser el personaje entero.
- **Pipeline anterior** (`build_hair_colors.py`, `review.html`, `scripts/hair/`): CLIPSeg + refinado en Lab, solo como referencia; no ejecutarlo (regeneraría `data/hair.json` y `assets/hair/`).

### Datos y despliegue

- `scripts/fetch_*.py` usan solo la biblioteca estándar; no sobrescriben el JSON si llegan menos resultados del mínimo. `fetch_romance.py` reutiliza `fetch_dataset()` de `fetch_anime.py` (filtro `genre_in`; AniList ignora argumentos a null).
- `.github/workflows/update-data.yml`: lunes 00:07 UTC ejecuta los fetch, commitea si hay cambios y **llama a `deploy.yml` vía `workflow_call`** (los push con `GITHUB_TOKEN` no disparan otros workflows). Hair Color no está en la Action.
- `.github/workflows/deploy.yml`: push a `main` despliega. Copia el repo a `_site/` con rsync **excluyendo `scripts/`, `.github`, README, CLAUDE.md y archivos de desarrollo**; si se añade un archivo solo de desarrollo fuera de `scripts/`, añadirlo a esa lista. Después añade `?v=<commit>` (cache busting) a `style.css`/`game.js` en los HTML y a las `url: 'data/*.json'` de `DATASETS`; el paso falla si no encuentra alguna referencia, así que al cambiar esas líneas hay que mantener el formato o actualizar el `sed`.

## Entorno (Windows)

- Shell Git Bash + PowerShell. Los heredocs largos o con acentos/comillas en Bash fallan a menudo: escribir archivos con la herramienta Write/Edit.
- En Python, `Path.write_text` en Windows escribe CRLF; usar `newline="\n"` al reescribir archivos del repo.
