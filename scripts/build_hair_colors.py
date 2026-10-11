"""Genera los datos del modo Hair Color: máscara del pelo y color objetivo de cada personaje.

Se ejecuta en local (no en la Action): necesita torch y transformers, ver
scripts/requirements-hair.txt. Funciona en CPU.

Proceso por personaje (los ~150 con más favoritos de data/characters.json):
  1. Segmentación por texto con CLIPSeg: el prompt "hair" compite contra
     "face", "skin", "clothes", "background"... (softmax por píxel), así la piel
     y el fondo no cuentan como pelo. Se promedia con la imagen volteada.
  2. Refinado por color: dentro de esa zona se agrupan los colores en CIELAB
     (k-means) y solo se conservan los píxeles parecidos a los colores dominantes
     del pelo. La máscara sigue los mechones y deja fuera piel y lineart.
  3. Color objetivo: mediana en CIELAB de los píxeles seguros de la máscara,
     descartando el 15 % más oscuro y el 15 % más claro (sombras y brillos).

Datos de trabajo (no se publican: scripts/ queda fuera del despliegue):
  scripts/hair/candidates.json   todos los candidatos con su estado de revisión:
                                 "pending", "approved" o "rejected"
  scripts/hair/masks/<id>.png    máscara en escala de grises, a la resolución de la imagen

Datos del juego (se regeneran al final de cada ejecución, solo con los aprobados):
  data/hair.json                 id, nombre, anime, imagen, máscara y color (hex y Lab)
  assets/hair/<id>.png           máscaras de los aprobados

Uso (desde la raíz del repo, con el entorno de requirements-hair.txt):
    python scripts/build_hair_colors.py                 # procesa los 150 primeros que falten
    python scripts/build_hair_colors.py --limit 300     # amplía hasta el puesto 300
    python scripts/build_hair_colors.py --force         # recalcula los no rechazados
    python scripts/build_hair_colors.py --approve review.json

Revisión: python -m http.server y abrir http://localhost:8000/scripts/review.html.
Exporta review.json con lo aprobado y lo rechazado; --approve lo aplica sin tocar los
que no aparecen (los pendientes siguen pendientes y los aprobados de antes se conservan).
Las máscaras de los rechazados se borran y esos personajes ya no se recalculan.
"""

import argparse
import io
import json
import shutil
import time
import urllib.request
from pathlib import Path

import numpy as np
import torch
from PIL import Image, ImageFilter

ROOT = Path(__file__).resolve().parent.parent
CHARACTERS = ROOT / "data" / "characters.json"
WORK_DIR = ROOT / "scripts" / "hair"
CANDIDATES = WORK_DIR / "candidates.json"
WORK_MASKS = WORK_DIR / "masks"
GAME_DATA = ROOT / "data" / "hair.json"
GAME_MASKS = ROOT / "assets" / "hair"
GAME_FIELDS = ("id", "name", "anime", "image", "hex", "lab")  # más "mask": lo que lee game.js
STATUSES = ("pending", "approved", "rejected")

LIMIT = 150  # por defecto, hasta qué puesto del ranking de favoritos se procesa
MODEL = "CIDAS/clipseg-rd64-refined"
HAIR_PROMPTS = ["hair", "hairstyle", "bangs"]  # se promedian en un único "pelo"
NEG_PROMPTS = ["face", "skin", "eyes", "clothes", "background", "hand", "hat"]
MIN_COVERAGE = 0.01  # con menos de un 1 % de la imagen como pelo, se descarta (calvos, etc.)
TRIM = (15, 85)  # percentiles de claridad que se conservan para el color objetivo
HEADERS = {"User-Agent": "anime-higher-or-lower/0.1"}


# ---------- Color ----------
SRGB_TO_XYZ = np.array([
    [0.4124564, 0.3575761, 0.1804375],
    [0.2126729, 0.7151522, 0.0721750],
    [0.0193339, 0.1191920, 0.9503041],
])
WHITE_D65 = np.array([0.95047, 1.0, 1.08883])


def rgb_to_lab(rgb: np.ndarray) -> np.ndarray:
    """sRGB (0-255, ...x3) a CIELAB D65."""
    c = rgb / 255.0
    c = np.where(c > 0.04045, ((c + 0.055) / 1.055) ** 2.4, c / 12.92)
    xyz = (c @ SRGB_TO_XYZ.T) / WHITE_D65
    f = np.where(xyz > 216 / 24389, np.cbrt(xyz), (24389 / 27 * xyz + 16) / 116)
    return np.stack([116 * f[..., 1] - 16, 500 * (f[..., 0] - f[..., 1]), 200 * (f[..., 1] - f[..., 2])], -1)


def lab_to_hex(lab: np.ndarray) -> str:
    fy = (lab[0] + 16) / 116
    f = np.array([fy + lab[1] / 500, fy, fy - lab[2] / 200])
    xyz = np.where(f**3 > 216 / 24389, f**3, (116 * f - 16) / (24389 / 27)) * WHITE_D65
    rgb = np.linalg.solve(SRGB_TO_XYZ, xyz)
    rgb = np.where(rgb > 0.0031308, 1.055 * np.clip(rgb, 0, None) ** (1 / 2.4) - 0.055, 12.92 * rgb)
    return "#" + "".join(f"{int(round(v)):02x}" for v in np.clip(rgb * 255, 0, 255))


# ---------- Segmentación ----------
class HairSegmenter:
    def __init__(self) -> None:
        from transformers import CLIPSegForImageSegmentation, CLIPSegProcessor

        self.processor = CLIPSegProcessor.from_pretrained(MODEL)
        self.model = CLIPSegForImageSegmentation.from_pretrained(MODEL).eval()
        prompts = HAIR_PROMPTS + NEG_PROMPTS
        text = self.processor.tokenizer(prompts, padding=True, return_tensors="pt")
        with torch.no_grad():
            self.text_emb = self.model.clip.get_text_features(**text).pooler_output  # (P, D)

    def hair_probability(self, img: Image.Image) -> np.ndarray:
        """Probabilidad de pelo por píxel (0-1), a la resolución de la imagen.

        El codificador de imagen se ejecuta una vez (imagen y su reflejo) y el decodificador,
        que es ligero, una vez por prompt.
        """
        pixels = self.processor.image_processor(
            [img, img.transpose(Image.FLIP_LEFT_RIGHT)], return_tensors="pt"
        ).pixel_values
        n_prompts = len(self.text_emb)
        with torch.no_grad():
            vision = self.model.clip.get_image_features(pixel_values=pixels, output_hidden_states=True)
            activations = [vision.hidden_states[i + 1] for i in self.model.extract_layers]
            # cada imagen (original y reflejo) se combina con todos los prompts
            activations = [a.repeat_interleave(n_prompts, 0) for a in activations]
            logits = self.model.decoder(activations, self.text_emb.repeat(2, 1)).logits
        logits = logits.view(2, n_prompts, *logits.shape[-2:])
        n_hair = len(HAIR_PROMPTS)
        logits = torch.cat([logits[:, :n_hair].mean(1, keepdim=True), logits[:, n_hair:]], 1)
        prob = torch.softmax(logits, 1)[:, 0].numpy()
        prob = (prob[0] + prob[1][:, ::-1]) / 2
        # el suavizado borra la cuadrícula de parches del ViT antes de escalar
        im = Image.fromarray((prob * 255).astype(np.uint8)).filter(ImageFilter.GaussianBlur(6))
        return np.asarray(im.resize(img.size, Image.BICUBIC)) / 255.0


def kmeans(x: np.ndarray, w: np.ndarray, k: int = 4, iters: int = 15) -> tuple[np.ndarray, np.ndarray]:
    """k-means ponderado; devuelve centros y la proporción de peso de cada uno."""
    rng = np.random.default_rng(0)
    centers = x[rng.choice(len(x), k, p=w / w.sum())]
    for _ in range(iters):
        labels = ((x[:, None] - centers[None]) ** 2).sum(-1).argmin(1)
        for j in range(k):
            sel = labels == j
            if sel.any():
                centers[j] = np.average(x[sel], 0, w[sel])
    labels = ((x[:, None] - centers[None]) ** 2).sum(-1).argmin(1)
    share = np.array([w[labels == j].sum() for j in range(k)]) / w.sum()
    return centers, share


def refine(lab: np.ndarray, prob: np.ndarray) -> np.ndarray:
    """Recorta la zona de CLIPSeg a los píxeles con el color del pelo. Máscara 0-1."""
    core = prob > 0.5
    if core.sum() < 200:
        return np.zeros_like(prob)
    centers, share = kmeans(lab[core], prob[core])
    hair_colors = centers[share > 0.2]
    # distancia sobre todo en croma (a, b): la claridad pesa poco para tolerar luces y sombras
    dist = np.min([
        np.sqrt(((lab[..., 1:] - c[1:]) ** 2).sum(-1) + (0.35 * (lab[..., 0] - c[0])) ** 2)
        for c in hair_colors
    ], 0)
    similarity = np.exp(-((dist / 18.0) ** 2))
    region = Image.fromarray((prob * 255).astype(np.uint8)).filter(ImageFilter.MaxFilter(5))
    region = np.clip((np.asarray(region) / 255.0 - 0.25) / 0.35, 0, 1)
    mask = similarity * region
    # rampa suave: el interior del pelo queda a 1 y los bordes conservan algo de transición
    t = np.clip((mask - 0.25) / 0.35, 0, 1)
    return t * t * (3 - 2 * t)


def target_color(lab: np.ndarray, mask: np.ndarray, prob: np.ndarray) -> np.ndarray | None:
    """Mediana en Lab de los píxeles seguros, sin las sombras ni los brillos extremos."""
    pixels = lab[(mask > 0.5) & (prob > 0.5)]
    if len(pixels) < 100:
        return None
    lo, hi = np.percentile(pixels[:, 0], TRIM)
    pixels = pixels[(pixels[:, 0] >= lo) & (pixels[:, 0] <= hi)]
    return np.median(pixels, 0)


# ---------- Pipeline ----------
def download(url: str) -> Image.Image:
    request = urllib.request.Request(url, headers=HEADERS)
    with urllib.request.urlopen(request, timeout=30) as response:
        return Image.open(io.BytesIO(response.read())).convert("RGB")


def rel(path: Path) -> str:
    return path.relative_to(ROOT).as_posix()


def by_ranking(entries) -> list[dict]:
    """Ordena por el ranking actual de favoritos (los que ya no están en él, al final)."""
    rank = {c["id"]: i for i, c in enumerate(json.loads(CHARACTERS.read_text(encoding="utf-8")))}
    return sorted(entries, key=lambda e: rank.get(e["id"], len(rank)))


def load_candidates() -> dict[int, dict]:
    if not CANDIDATES.exists():
        return {}
    return {entry["id"]: entry for entry in json.loads(CANDIDATES.read_text(encoding="utf-8"))}


def save_candidates(entries: dict[int, dict]) -> None:
    WORK_DIR.mkdir(parents=True, exist_ok=True)
    text = json.dumps(by_ranking(entries.values()), ensure_ascii=False, indent=1)
    CANDIDATES.write_text(text + "\n", encoding="utf-8")


def summary(entries: dict[int, dict]) -> str:
    counts = {s: sum(e["status"] == s for e in entries.values()) for s in STATUSES}
    return f"{counts['approved']} aprobados, {counts['pending']} pendientes y {counts['rejected']} rechazados"


def publish(entries: dict[int, dict]) -> None:
    """Regenera los datos del juego solo con los aprobados: data/hair.json y assets/hair/."""
    GAME_MASKS.mkdir(parents=True, exist_ok=True)
    approved = [e for e in entries.values()
                if e["status"] == "approved" and e["mask"] and (ROOT / e["mask"]).exists()]
    game, keep = [], set()
    for entry in by_ranking(approved):
        target = GAME_MASKS / f"{entry['id']}.png"
        shutil.copyfile(ROOT / entry["mask"], target)
        keep.add(target.name)
        game.append({key: entry[key] for key in GAME_FIELDS} | {"mask": rel(target)})
    for stale in GAME_MASKS.glob("*.png"):  # aprobados que dejaron de estarlo
        if stale.name not in keep:
            stale.unlink()
    GAME_DATA.write_text(json.dumps(game, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    print(f"Juego: {len(game)} personajes en {rel(GAME_DATA)} y {rel(GAME_MASKS)}/")


def process(seg: HairSegmenter, character: dict) -> dict | None:
    img = download(character["image"])
    lab = rgb_to_lab(np.asarray(img).astype(np.float64))
    prob = seg.hair_probability(img)
    mask = refine(lab, prob)
    coverage = float((mask > 0.5).mean())
    color = target_color(lab, mask, prob)
    if coverage < MIN_COVERAGE or color is None:
        return None

    mask_path = WORK_MASKS / f"{character['id']}.png"
    Image.fromarray((mask * 255).round().astype(np.uint8), "L").save(mask_path, optimize=True)
    return {
        "id": character["id"],
        "name": character["name"],
        "anime": character["anime"],
        "image": character["image"],
        "mask": rel(mask_path),
        "width": img.width,
        "height": img.height,
        "hex": lab_to_hex(color),
        "lab": [round(float(v), 1) for v in color],
        "coverage": round(coverage, 3),
        "status": "pending",
    }


def build(limit: int, force: bool) -> None:
    characters = json.loads(CHARACTERS.read_text(encoding="utf-8"))[:limit]
    entries = load_candidates()
    WORK_MASKS.mkdir(parents=True, exist_ok=True)

    print("Cargando CLIPSeg...")
    seg = HairSegmenter()

    skipped = []
    for i, character in enumerate(characters, 1):
        cid = character["id"]
        old = entries.get(cid)
        if old and old["status"] == "rejected":
            continue  # rechazado en la revisión: no se recalcula
        if old and not force and old["mask"] and (ROOT / old["mask"]).exists():
            continue
        start = time.time()
        try:
            entry = process(seg, character)
        except Exception as err:  # una imagen rota no debe parar el lote
            print(f"[{i}/{len(characters)}] {character['name']}: error ({err})")
            continue
        if entry is None:
            skipped.append(character["name"])
            print(f"[{i}/{len(characters)}] {character['name']}: sin pelo detectado, se descarta")
            continue
        if old:  # al recalcular se conserva la decisión de revisión
            entry["status"] = old["status"]
        entries[cid] = entry
        save_candidates(entries)  # se guarda tras cada personaje: se puede interrumpir y seguir
        print(f"[{i}/{len(characters)}] {character['name']}: {entry['hex']} "
              f"({entry['coverage']:.0%} de la imagen, {time.time() - start:.1f}s)")

    save_candidates(entries)
    print(f"\n{len(entries)} candidatos en {rel(CANDIDATES)}: {summary(entries)}")
    if skipped:
        print("Descartados sin pelo:", ", ".join(skipped))
    publish(entries)


def apply_review(path: Path) -> None:
    """Aplica las decisiones exportadas desde review.html y regenera los datos del juego.

    review.json es {"approved": [ids], "rejected": [ids]} y solo cambia los ids que aparecen:
    los pendientes no revisados siguen pendientes y los aprobados de antes se conservan.
    También acepta una lista de ids aprobados (formato antiguo): entonces los pendientes que
    no están en ella se rechazan, pero un aprobado nunca pasa a rechazado.
    Las máscaras de los rechazados se borran; un rechazado que se apruebe más adelante
    recupera la suya en la siguiente ejecución normal del script.
    """
    decisions = json.loads(path.read_text(encoding="utf-8"))
    entries = load_candidates()
    if isinstance(decisions, list):
        approved = set(decisions)
        rejected = {cid for cid, e in entries.items() if e["status"] == "pending"} - approved
    else:
        approved = set(decisions.get("approved", []))
        rejected = set(decisions.get("rejected", [])) - approved

    removed = 0
    for cid, entry in entries.items():
        if cid in approved:
            entry["status"] = "approved"
            entry["mask"] = entry["mask"] or rel(WORK_MASKS / f"{cid}.png")
        elif cid in rejected:
            entry["status"] = "rejected"
            if entry["mask"] and (ROOT / entry["mask"]).exists():
                (ROOT / entry["mask"]).unlink()
                removed += 1
            entry["mask"] = None
    save_candidates(entries)

    print(f"{rel(CANDIDATES)}: {summary(entries)}; {removed} máscaras de rechazados borradas")
    missing = [e["name"] for e in entries.values()
               if e["status"] == "approved" and not (ROOT / e["mask"]).exists()]
    if missing:
        print(f"Aprobados sin máscara (ejecuta el script sin --approve para generarlas): {', '.join(missing)}")
    unknown = (approved | rejected) - entries.keys()
    if unknown:
        print(f"Aviso: {len(unknown)} ids de {path.name} no están entre los candidatos: {sorted(unknown)}")
    publish(entries)


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    parser.add_argument("--limit", type=int, default=LIMIT, help="hasta qué puesto del ranking procesar")
    parser.add_argument("--force", action="store_true", help="recalcula también los ya procesados")
    parser.add_argument("--approve", type=Path, help="review.json exportado desde review.html")
    args = parser.parse_args()
    if args.approve:
        apply_review(args.approve)
    else:
        build(args.limit, args.force)


if __name__ == "__main__":
    main()
