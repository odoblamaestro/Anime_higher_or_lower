# Anime_higher_or_lower

Juego web Higher or Lower de anime ([higherloweranime.com](https://higherloweranime.com)): web estática sin frameworks, desplegada en GitHub Pages con GitHub Actions y datos de AniList que se actualizan cada semana. La carpeta `scripts/` y los archivos de desarrollo no se publican (ver `.github/workflows/deploy.yml`).

## Color Guess: anotar objetivos (en preparación)

El modo Hair Color está oculto en la portada mientras se rehace como **Color Guess** ("What color is Luffy's straw hat?"). Los datos se anotan a mano con una herramienta local que no se publica (`scripts/color/`).

### Preparación (una sola vez)

```powershell
python -m venv .venv
.venv\Scripts\python -m pip install torch torchvision --index-url https://download.pytorch.org/whl/cpu
.venv\Scripts\python -m pip install -r scripts\requirements-color.txt
```

Sin torch la herramienta funciona igual, pero sin SAM (solo varita, pincel y goma). La primera vez que se usa SAM se descarga el modelo (`facebook/sam2.1-hiera-tiny`, unos 150 MB).

### Arrancar

```powershell
.venv\Scripts\python scripts\color\server.py
```

Abre <http://localhost:8001>. Con `--model edgetam` SAM va unas 3 veces más rápido, pero las máscaras salen algo más ruidosas; con `--model none` se desactiva.

### Objetivos: `scripts/color/targets.csv`

| Columna | Qué es |
|---|---|
| `character` | Id de personaje de AniList o su nombre (se busca en `data/characters.json` y, si no está, en AniList) |
| `target` | Lo que se colorea: `Hair`, `Straw hat`, `Scarf`, `Eyes`… |
| `image` | Opcional: ruta local (relativa a `scripts/color/` o a la raíz) o URL. Si se deja vacía, se usa la de AniList |
| `short_name` | Opcional: nombre corto para la pregunta (`Luffy`, `Gojo`); también se puede escribir en la herramienta |

### Uso

- **Imagen:** arrastra una captura del anime al lienzo, pégala con Ctrl+V o pega una URL arriba. Las imágenes que no son de AniList se guardan reducidas (400 px de alto, WebP) en `assets/color/img/`. **AniList** vuelve a la imagen original.
- **Varita** (`W`): clic selecciona la zona conectada de color parecido (distancia en Lab, tolerancia con el slider o `[` `]`); `Shift`+clic añade, `Alt`/`Ctrl`+clic resta.
- **SAM** (`A`): clic izquierdo incluye, derecho excluye. Con un solo punto, `M` alterna entre los 3 niveles de SAM (trozo, objeto, todo); `N` empieza otro objeto; `Esc` lo cancela. El cálculo pesado (~7 s por imagen en CPU) se hace en segundo plano al abrir cada objetivo y se precarga el siguiente; luego cada clic tarda menos de 1 s.
- **Pincel** (`B`) y **goma** (`E`) para retocar; **Crecer/Encoger** añaden o quitan 1 px de borde (útil junto a las líneas negras).
- **Color objetivo:** se calcula solo (mediana en Lab sin el 15 % más oscuro ni el 15 % más claro); el **cuentagotas** (`I`) lo fija a mano.
- **Vista previa:** "Real" recolorea la máscara con el color objetivo como lo hará el juego (debería parecerse al original); "Prueba" con otro tono; "Gris" es como empieza la partida.
- `Ctrl+Z` / `Ctrl+Y`, rueda para zoom, `Espacio`+arrastrar o botón central para moverse, `0` para encajar, `H` oculta la capa.
- **Guardar** (`Enter`) pasa al siguiente pendiente; **Saltar** (`Shift+Enter`). Todo se guarda en `scripts/color/annotations.json`: se puede cerrar y seguir otro día.

### Qué se genera

| | Qué contiene | ¿Se publica? |
|---|---|---|
| `scripts/color/targets.csv` y `annotations.json` | Lista de objetivos y estado del trabajo (pendiente, guardado, saltado) | No |
| `scripts/color/cache/` | Imágenes de AniList y embeddings de SAM (ignorado por git) | No |
| `data/color.json`, `assets/color/masks/` y `assets/color/img/` | Objetivos guardados con su máscara y color, en el orden de `targets.csv` | Sí |

`data/color.json` se regenera en cada guardado; no hay que editarlo a mano. El juego todavía no lo usa.

### Pipeline anterior

`scripts/build_hair_colors.py`, `scripts/review.html` y `scripts/hair/` son el pipeline automático anterior (CLIPSeg sobre las imágenes de AniList, que en su mayoría son de manga y no tienen los colores del anime). Se conservan como referencia, pero **no lo ejecutes**: regeneraría `data/hair.json` y `assets/hair/`, que ya no se publican.
