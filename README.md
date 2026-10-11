# Anime_higher_or_lower

Juego web Higher or Lower de anime ([higherloweranime.com](https://higherloweranime.com)): web estática sin frameworks, desplegada en GitHub Pages con GitHub Actions y datos de AniList que se actualizan cada semana. La carpeta `scripts/` y los archivos de desarrollo no se publican (ver `.github/workflows/deploy.yml`).

## Hair Color: ampliar el pool de personajes

Los personajes de Hair Color salen de un pipeline local (`scripts/build_hair_colors.py`) y de una revisión manual. Hay dos juegos de datos:

| | Qué contiene | ¿Se publica? |
|---|---|---|
| `scripts/hair/candidates.json` y `scripts/hair/masks/` | Todos los candidatos procesados, con su estado: `pending`, `approved` o `rejected` | No |
| `data/hair.json` y `assets/hair/` | Solo los aprobados, con lo que necesita el juego | Sí |

El script regenera los datos del juego al terminar cada ejecución, así que no hay que tocarlos a mano.

### Preparación (una sola vez)

```powershell
python -m venv .venv
.venv\Scripts\python -m pip install torch --index-url https://download.pytorch.org/whl/cpu
.venv\Scripts\python -m pip install -r scripts\requirements-hair.txt
```

### 1. Procesar los siguientes personajes del ranking

```powershell
.venv\Scripts\python scripts\build_hair_colors.py --limit 300
```

`--limit` indica hasta qué puesto del ranking de favoritos (`data/characters.json`) llegar. Los personajes ya procesados y los rechazados se saltan, así que con 150 hechos este comando solo procesa del 151 al 300. Los nuevos quedan como `pending` y todavía no entran en el juego.

Tarda unos 4 s por personaje en CPU (unos 10 minutos por cada 150). Se puede interrumpir con Ctrl+C y relanzar: continúa donde se quedó. Los personajes sin pelo detectado (calvos, sombreros…) se descartan automáticamente.

El ranking cambia cada semana con la actualización de datos, así que "del 151 al 300" es aproximado: algún personaje puede haber subido o bajado de puesto.

### 2. Revisar en review.html

```powershell
python -m http.server 8000
```

Abre <http://localhost:8000/scripts/review.html> y pulsa el filtro **Pendientes**. Cada tarjeta muestra la imagen original, la máscara del pelo en magenta y una vista previa del recoloreado con el color calculado. Acepta los que tengan bien la máscara y el color, y rechaza el resto. Las decisiones se guardan en el navegador, así que puedes cerrar la página y seguir más tarde.

Al terminar, pulsa **Exportar review.json**.

### 3. Aplicar las decisiones

```powershell
.venv\Scripts\python scripts\build_hair_colors.py --approve "$env:USERPROFILE\Downloads\review.json"
```

Solo cambian los personajes que aparecen en `review.json`:

- **Aprobados anteriores:** se conservan aunque el archivo no los incluya, por ejemplo si revisas desde otro navegador.
- **Pendientes que no hayas revisado:** siguen pendientes.
- **Rechazados:** pierden la máscara y ya no se vuelven a procesar.

Luego se regeneran `data/hair.json` y `assets/hair/` con todos los aprobados.

**Recuperar un rechazado:** acéptalo en review.html, exporta, aplica y ejecuta el script sin `--approve` para regenerar su máscara.

### 4. Probar y publicar

Prueba el modo en local (`python -m http.server 8000` → <http://localhost:8000>) y sube los cambios:

```powershell
git add scripts/hair data/hair.json assets/hair
git commit -m "Hair Color: add characters 151-300"
git push
```

El push despliega la web automáticamente.

El personaje del día recorre la lista de aprobados en un orden fijo, así que al cambiar la lista cambia el orden. Para que nadie vea cambiar el personaje del día a mitad de jornada, publica las ampliaciones justo después de las 00:00 UTC. Quien ya haya jugado ese día seguirá viendo su resultado.
