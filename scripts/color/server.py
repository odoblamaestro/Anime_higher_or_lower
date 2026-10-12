"""Servidor local de la herramienta de anotación de Color Guess (scripts/color/annotate.html).

Uso (desde la raíz del repo):
    .venv/Scripts/python scripts/color/server.py            # http://localhost:8001
    .venv/Scripts/python scripts/color/server.py --model edgetam   # SAM más rápido, algo menos fino
    .venv/Scripts/python scripts/color/server.py --model none      # sin SAM (solo varita y pincel)

Lee los objetivos de scripts/color/targets.csv y guarda el trabajo en scripts/color/annotations.json
(se puede dejar a medias). Cada vez que se guarda un objetivo regenera lo que publica la web:
data/color.json y assets/color/masks/; las imágenes que no son de AniList se guardan reducidas
en assets/color/img/. La caché (imágenes de AniList y embeddings de SAM) va a scripts/color/cache/.

Solo necesita Pillow; SAM necesita además torch, torchvision, timm y transformers
(ver scripts/requirements-color.txt). Si faltan, la herramienta funciona sin SAM.
"""
import argparse
import base64
import collections
import csv
import hashlib
import io
import json
import os
import re
import sys
import threading
import time
import urllib.parse
import urllib.request
from http import HTTPStatus
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

from PIL import Image

ROOT = Path(__file__).resolve().parents[2]
COLOR = ROOT / "scripts" / "color"
TARGETS = COLOR / "targets.csv"
ANNOTATIONS = COLOR / "annotations.json"
CACHE = COLOR / "cache"
CHARACTERS = ROOT / "data" / "characters.json"
IMG_DIR = ROOT / "assets" / "color" / "img"
MASK_DIR = ROOT / "assets" / "color" / "masks"
GAME_DATA = ROOT / "data" / "color.json"

IMAGE_HEIGHT = 400  # alto de las imágenes propias que se publican (solo se reduce, nunca se amplía)
WEBP_QUALITY = 88
ANILIST_HOSTS = ("anilist.co",)  # imágenes que se enlazan tal cual (el juego las lee del CDN con CORS)
HEADERS = {"User-Agent": "anime-higher-or-lower/0.1 (color annotation tool)"}
MODELS = {
    "sam2": "facebook/sam2.1-hiera-tiny",  # mejor calidad; ~7 s de embedding por imagen en CPU
    "edgetam": "yonigozlan/EdgeTAM-hf",  # ~2 s, máscaras algo más ruidosas
}

state_lock = threading.Lock()


# ---------- Utilidades ----------
def rel(path: Path) -> str:
    return path.relative_to(ROOT).as_posix()


def slug(text: str) -> str:
    return re.sub(r"[^a-z0-9]+", "-", text.lower()).strip("-") or "x"


def is_anilist(url: str) -> bool:
    host = urllib.parse.urlparse(url).hostname or ""
    return any(host == h or host.endswith("." + h) for h in ANILIST_HOSTS)


def write_json(path: Path, data, compact=False) -> None:
    """Escritura atómica con LF (en Windows, write_text pondría CRLF)."""
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(path.suffix + ".tmp")
    with open(tmp, "w", encoding="utf-8", newline="\n") as f:
        if compact:
            json.dump(data, f, ensure_ascii=False, separators=(",", ":"))
        else:
            json.dump(data, f, ensure_ascii=False, indent=1, sort_keys=True)
            f.write("\n")
    os.replace(tmp, path)


def read_json(path: Path, default):
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except FileNotFoundError:
        return default


def download(url: str) -> bytes:
    request = urllib.request.Request(url, headers=HEADERS)
    with urllib.request.urlopen(request, timeout=30) as response:
        return response.read()


def cached_download(url: str) -> Path:
    """Imágenes remotas (AniList) en caché local: para el proxy y para SAM."""
    path = CACHE / "img" / (hashlib.sha1(url.encode()).hexdigest() + Path(urllib.parse.urlparse(url).path).suffix)
    if not path.exists():
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(download(url))
    return path


def import_image(data: bytes, key: str) -> Path:
    """Guarda una imagen propia reducida a IMAGE_HEIGHT de alto, en WebP, para publicarla."""
    img = Image.open(io.BytesIO(data))
    img = img.convert("RGBA") if img.mode in ("RGBA", "LA", "P") else img.convert("RGB")
    if img.mode == "RGBA":  # sin transparencias: el juego recolorea sobre el fondo real
        bg = Image.new("RGB", img.size, (255, 255, 255))
        bg.paste(img, mask=img.split()[3])
        img = bg
    if img.height > IMAGE_HEIGHT:
        img = img.resize((round(img.width * IMAGE_HEIGHT / img.height), IMAGE_HEIGHT), Image.LANCZOS)
    IMG_DIR.mkdir(parents=True, exist_ok=True)
    path = IMG_DIR / f"{key}.webp"
    img.save(path, "WEBP", quality=WEBP_QUALITY, method=6)
    return path


# ---------- Personajes ----------
class Characters:
    """Resuelve un personaje por id de AniList o por nombre: primero data/characters.json
    (top 1000 por favoritos) y, si no está, la API de AniList (con caché en disco)."""

    QUERY = """query ($id: Int, $search: String) {
      Character(id: $id, search: $search) {
        id name { full } image { large }
        media(sort: POPULARITY_DESC, type: ANIME, perPage: 1) { nodes { title { english romaji } } }
      }
    }"""

    def __init__(self):
        self.local = read_json(CHARACTERS, [])
        self.by_id = {c["id"]: c for c in self.local}
        self.cache_path = CACHE / "characters.json"
        self.cache = read_json(self.cache_path, {})

    @staticmethod
    def _tokens(name: str) -> set:
        return set(re.findall(r"[a-z0-9]+", name.lower()))

    def find_local(self, name: str):
        tokens = self._tokens(name)
        exact = [c for c in self.local if self._tokens(c["name"]) == tokens]
        if exact:
            return exact[0]
        # "Luffy" o "Monkey D. Luffy" frente a "Luffy Monkey": todas las palabras buscadas están en el nombre
        partial = [c for c in self.local if tokens and tokens <= self._tokens(c["name"])]
        return partial[0] if partial else None  # characters.json va por favoritos: el más popular

    def anilist(self, ident: str):
        if ident in self.cache:
            return self.cache[ident]
        variables = {"id": int(ident)} if ident.isdigit() else {"search": ident}
        body = json.dumps({"query": self.QUERY, "variables": variables}).encode()
        request = urllib.request.Request("https://graphql.anilist.co", data=body, headers={
            **HEADERS, "Content-Type": "application/json", "Accept": "application/json"})
        try:
            with urllib.request.urlopen(request, timeout=30) as response:
                ch = json.loads(response.read())["data"]["Character"]
        except Exception as err:  # noqa: BLE001 — sin red o no encontrado: se muestra en la lista
            print(f"AniList: no se pudo resolver {ident!r}: {err}")
            return None
        nodes = ch["media"]["nodes"]
        title = (nodes[0]["title"]["english"] or nodes[0]["title"]["romaji"]) if nodes else ""
        result = {"id": ch["id"], "name": ch["name"]["full"], "anime": title, "image": ch["image"]["large"]}
        self.cache[ident] = result
        write_json(self.cache_path, self.cache)
        return result

    def resolve(self, ident: str):
        ident = ident.strip()
        if ident.isdigit() and int(ident) in self.by_id:
            c = self.by_id[int(ident)]
        elif not ident.isdigit():
            c = self.find_local(ident)
        else:
            c = None
        if c:
            return {"id": c["id"], "name": c["name"], "anime": c.get("anime", ""), "image": c["image"]}
        return self.anilist(ident)


# ---------- Objetivos y anotaciones ----------
def load_targets(chars: Characters) -> list:
    """targets.csv: character (id o nombre), target, image (opcional: ruta local o URL),
    short_name (opcional: nombre corto para la pregunta del juego)."""
    rows = []
    with open(TARGETS, encoding="utf-8-sig", newline="") as f:
        for n, row in enumerate(csv.DictReader(f), start=2):
            ident = (row.get("character") or "").strip()
            target = (row.get("target") or "").strip()
            if not ident or not target or ident.startswith("#"):
                continue
            ch = chars.resolve(ident)
            base = str(ch["id"]) if ch else slug(ident)
            rows.append({
                "key": f"{base}-{slug(target)}",
                "line": n,
                "ident": ident,
                "character": ch,
                "target": target,
                "csv_image": (row.get("image") or "").strip(),
                "short": (row.get("short_name") or "").strip(),
            })
    seen = set()
    for r in rows:  # filas repetidas (mismo personaje y objetivo): se distinguen por la línea
        if r["key"] in seen:
            r["key"] = f"{r['key']}-{r['line']}"
        seen.add(r["key"])
    return rows


def image_source(row: dict, ann: dict) -> dict:
    """Imagen de trabajo: la elegida en la herramienta > la de targets.csv > la de AniList."""
    if ann.get("image"):
        return {"kind": "local" if not ann["image"].startswith("http") else "url", "ref": ann["image"]}
    if row["csv_image"]:
        return {"kind": "csv", "ref": row["csv_image"]}
    if row["character"] and row["character"].get("image"):
        return {"kind": "url", "ref": row["character"]["image"]}
    return {"kind": "none", "ref": ""}


def resolve_csv_image(ref: str, key: str) -> str:
    """Una imagen de targets.csv se importa la primera vez que se abre (las de AniList se enlazan)."""
    if ref.startswith("http"):
        return ref if is_anilist(ref) else rel(import_image(download(ref), key))
    path = Path(ref)
    for base in (COLOR, ROOT):
        if not path.is_absolute() and (base / path).exists():
            path = base / path
            break
    return rel(import_image(path.read_bytes(), key))


def image_path_for(ref: str) -> Path:
    """Archivo local con los píxeles de la imagen de trabajo (para SAM)."""
    return cached_download(ref) if ref.startswith("http") else ROOT / ref


def client_url(ref: str) -> str:
    if ref.startswith("http"):
        return "/api/proxy?url=" + urllib.parse.quote(ref, safe="")
    path = ROOT / ref
    return "/" + ref + f"?t={int(path.stat().st_mtime)}" if path.exists() else ""


def publish(rows: list, annotations: dict) -> int:
    """Regenera data/color.json y assets/color/masks/ con los objetivos terminados, en el orden de
    targets.csv. Es lo que leerá el juego (mismos campos que el antiguo hair.json, más key y target)."""
    MASK_DIR.mkdir(parents=True, exist_ok=True)
    game, keep = [], set()
    for row in rows:
        ann = annotations.get(row["key"], {})
        mask = MASK_DIR / f"{row['key']}.png"
        if ann.get("status") != "done" or not mask.exists() or not row["character"]:
            continue
        keep.add(mask.name)
        ch = row["character"]
        game.append({
            "key": row["key"],
            "id": ch["id"],
            "name": ch["name"],
            "short": ann.get("short") or row["short"] or ch["name"],
            "anime": ch.get("anime", ""),
            "target": row["target"],
            "image": ann["image"],
            "mask": rel(mask),
            "hex": ann["hex"],
            "lab": ann["lab"],
        })
    for stale in MASK_DIR.glob("*.png"):  # terminados que se han saltado después o quitado del CSV
        if stale.name not in keep:
            stale.unlink()
    write_json(GAME_DATA, game, compact=True)
    return len(game)


# ---------- SAM ----------
class Segmenter:
    """SAM 2 (o EdgeTAM) en CPU. El embedding de cada imagen (lo lento) se calcula en segundo
    plano en cuanto se abre un objetivo y se guarda en disco; luego cada clic tarda ~0,25 s."""

    def __init__(self, model_name: str):
        self.name = model_name
        self.repo = MODELS.get(model_name)
        self.error = None if self.repo else "disabled (--model none)"
        self.model = self.proc = None
        self.load_lock = threading.Lock()
        self.cond = threading.Condition()
        self.queue = collections.deque()
        self.embeddings = collections.OrderedDict()  # ruta de imagen -> (PIL.Image, embeddings), LRU
        self.pending = set()
        if self.repo:
            threading.Thread(target=self._worker, daemon=True).start()

    @property
    def available(self) -> bool:
        return self.error is None

    def _load(self):
        with self.load_lock:
            if self.model is not None or self.error:
                return
            try:
                import torch  # noqa: F401
                from transformers import EdgeTamModel, Sam2Model, Sam2Processor
            except ImportError as err:
                self.error = f"missing dependency ({err.name}); see scripts/requirements-color.txt"
                print("SAM desactivado:", self.error)
                return
            import torch
            torch.set_num_threads(max(4, (os.cpu_count() or 8) // 2))
            cls = EdgeTamModel if self.name == "edgetam" else Sam2Model
            t = time.time()
            self.model = cls.from_pretrained(self.repo).eval()
            self.proc = Sam2Processor.from_pretrained(self.repo)
            print(f"SAM: {self.repo} cargado en {time.time() - t:.1f}s")

    def _cache_file(self, path: Path) -> Path:
        digest = hashlib.sha1(path.read_bytes()).hexdigest()
        return CACHE / "emb" / f"{self.name}-{digest}.pt"

    def _embed(self, path: Path):
        import torch
        self._load()
        if self.error:
            return
        img = Image.open(path).convert("RGB")
        cache = self._cache_file(path)
        if cache.exists():
            emb = torch.load(cache)
        else:
            t = time.time()
            with torch.inference_mode():
                emb = self.model.get_image_embeddings(self.proc(images=img, return_tensors="pt")["pixel_values"])
            cache.parent.mkdir(parents=True, exist_ok=True)
            torch.save(emb, cache)
            print(f"SAM: embedding de {path.name} en {time.time() - t:.1f}s")
        with self.cond:
            self.embeddings[str(path)] = (img, emb)
            while len(self.embeddings) > 8:
                self.embeddings.popitem(last=False)

    def _worker(self):
        while True:
            with self.cond:
                while not self.queue:
                    self.cond.wait()
                path = self.queue.popleft()
            try:
                self._embed(path)
            except Exception as err:  # noqa: BLE001
                print(f"SAM: error con {path}: {err}")
            with self.cond:
                self.pending.discard(str(path))
                self.cond.notify_all()

    def request(self, path: Path, urgent: bool) -> str:
        """Encola el embedding (urgente = el objetivo abierto, delante de las precargas)."""
        if not self.available:
            return "unavailable"
        key = str(path)
        with self.cond:
            if key in self.embeddings:
                self.embeddings.move_to_end(key)
                return "ready"
            if key in self.pending:
                if urgent and path in self.queue:
                    self.queue.remove(path)
                    self.queue.appendleft(path)
                return "pending"
            self.pending.add(key)
            (self.queue.appendleft if urgent else self.queue.append)(path)
            self.cond.notify_all()
        return "pending"

    def predict(self, path: Path, points: list, labels: list) -> list:
        """Máscaras (bytes PNG en escala de grises) para los puntos dados. Con un solo punto
        devuelve los 3 niveles de SAM (parte, objeto, todo) de menor a mayor área."""
        import numpy as np
        import torch
        self.request(path, urgent=True)
        key = str(path)
        with self.cond:
            if not self.cond.wait_for(lambda: key in self.embeddings or key not in self.pending, timeout=120):
                raise TimeoutError("embedding timeout")
            if key not in self.embeddings:
                raise RuntimeError(self.error or "embedding failed")
            img, emb = self.embeddings[key]
        multi = len(points) == 1
        with torch.inference_mode():
            p = self.proc(images=img, input_points=[[points]], input_labels=[[labels]], return_tensors="pt")
            out = self.model(input_points=p["input_points"], input_labels=p["input_labels"],
                             image_embeddings=emb, multimask_output=multi)
            masks = np.asarray(self.proc.post_process_masks(out.pred_masks, p["original_sizes"])[0])
        masks = masks.reshape(-1, *masks.shape[-2:]) > 0
        masks = sorted(masks, key=lambda m: m.mean())
        result = []
        for m in masks:
            buf = io.BytesIO()
            Image.fromarray((m * 255).astype(np.uint8), "L").save(buf, "PNG")
            result.append(buf.getvalue())
        return result


# ---------- HTTP ----------
class App:
    def __init__(self, model: str):
        self.chars = Characters()
        self.sam = Segmenter(model)
        self.reload()

    def reload(self):
        with state_lock:
            self.rows = load_targets(self.chars)
            self.by_key = {r["key"]: r for r in self.rows}
            self.annotations = read_json(ANNOTATIONS, {})

    def summary(self, row: dict) -> dict:
        ann = self.annotations.get(row["key"], {})
        return {
            "key": row["key"],
            "line": row["line"],
            "ident": row["ident"],
            "character": row["character"],
            "target": row["target"],
            "short": ann.get("short") or row["short"],
            "status": ann.get("status", "pending"),
            "source": image_source(row, ann)["kind"],
        }

    def working_image(self, key: str) -> str:
        """Ruta relativa o URL de la imagen de trabajo; importa la de targets.csv si hace falta."""
        row = self.by_key[key]
        with state_lock:
            src = image_source(row, self.annotations.get(key, {}))
            if src["kind"] == "csv":
                ann = self.annotations.setdefault(key, {})
                ann["image"] = resolve_csv_image(src["ref"], key)
                write_json(ANNOTATIONS, self.annotations)
                return ann["image"]
            return src["ref"]

    def set_image(self, key: str, payload: dict) -> str:
        if payload.get("reset"):  # volver a la de targets.csv o a la de AniList
            ref = None
        elif payload.get("data_url"):
            data = base64.b64decode(payload["data_url"].split(",", 1)[1])
            ref = rel(import_image(data, key))
        elif payload.get("url"):
            url = payload["url"].strip()
            ref = url if is_anilist(url) else rel(import_image(download(url), key))
        else:
            raise ValueError("no image")
        with state_lock:
            ann = self.annotations.setdefault(key, {})
            if ref is None:
                ann.pop("image", None)
            else:
                ann["image"] = ref
            # Otra imagen invalida la máscara: el objetivo vuelve a pendiente.
            if ann.get("status") == "done":
                ann["status"] = "pending"
            write_json(ANNOTATIONS, self.annotations)
            publish(self.rows, self.annotations)
        return self.working_image(key)

    def save(self, key: str, payload: dict) -> int:
        row = self.by_key[key]
        with state_lock:
            ann = self.annotations.setdefault(key, {})
            ann["status"] = payload["status"]
            ann["updated"] = time.strftime("%Y-%m-%d %H:%M:%S")
            ann["short"] = (payload.get("short") or "").strip() or row["short"]
            if payload["status"] == "done":
                data = base64.b64decode(payload["mask"].split(",", 1)[1])
                MASK_DIR.mkdir(parents=True, exist_ok=True)
                Image.open(io.BytesIO(data)).convert("L").save(MASK_DIR / f"{key}.png", optimize=True)
                ann["image"] = ann.get("image") or image_source(row, ann)["ref"]
                for field in ("lab", "hex", "auto_lab", "manual_color"):
                    ann[field] = payload.get(field)
            write_json(ANNOTATIONS, self.annotations)
            return publish(self.rows, self.annotations)


class Handler(SimpleHTTPRequestHandler):
    app: App = None

    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(ROOT), **kwargs)

    def log_message(self, fmt, *args):  # solo errores, para no llenar la consola
        if args and str(args[1]).startswith(("4", "5")):
            super().log_message(fmt, *args)

    def end_headers(self):
        self.send_header("Cache-Control", "no-store")
        super().end_headers()

    def send_json(self, data, status=HTTPStatus.OK):
        body = json.dumps(data, ensure_ascii=False).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def body(self) -> dict:
        length = int(self.headers.get("Content-Length") or 0)
        return json.loads(self.rfile.read(length) or b"{}")

    def do_GET(self):
        url = urllib.parse.urlparse(self.path)
        q = dict(urllib.parse.parse_qsl(url.query))
        try:
            if url.path in ("/", "/annotate"):
                self.send_response(HTTPStatus.FOUND)
                self.send_header("Location", "/scripts/color/annotate.html")
                self.end_headers()
            elif url.path == "/api/targets":
                self.app.reload()
                self.send_json({
                    "targets": [self.app.summary(r) for r in self.app.rows],
                    "sam": {"available": self.app.sam.available, "model": self.app.sam.name, "error": self.app.sam.error},
                })
            elif url.path == "/api/open":
                key = q["key"]
                ref = self.app.working_image(key)
                if ref and self.app.sam.available:
                    self.app.sam.request(image_path_for(ref), urgent=True)
                ann = self.app.annotations.get(key, {})
                mask = MASK_DIR / f"{key}.png"
                self.send_json({
                    **self.app.summary(self.app.by_key[key]),
                    "image": client_url(ref) if ref else "",
                    "image_ref": ref,
                    "mask": f"/{rel(mask)}?t={int(mask.stat().st_mtime)}" if mask.exists() and ann.get("status") == "done" else "",
                    "annotation": ann,
                })
            elif url.path == "/api/prefetch":  # embedding del siguiente objetivo mientras se trabaja en este
                ref = self.app.working_image(q["key"])
                status = self.app.sam.request(image_path_for(ref), urgent=False) if ref else "none"
                self.send_json({"status": status})
            elif url.path == "/api/proxy":
                target = q.get("url", "")
                if not is_anilist(target):
                    return self.send_error(HTTPStatus.FORBIDDEN, "only AniList images")
                data = cached_download(target).read_bytes()
                self.send_response(HTTPStatus.OK)
                self.send_header("Content-Type", "image/png" if target.endswith(".png") else "image/jpeg")
                self.send_header("Content-Length", str(len(data)))
                self.end_headers()
                self.wfile.write(data)
            else:
                super().do_GET()
        except Exception as err:  # noqa: BLE001
            self.send_json({"error": str(err)}, HTTPStatus.INTERNAL_SERVER_ERROR)

    def do_POST(self):
        url = urllib.parse.urlparse(self.path)
        try:
            payload = self.body()
            if url.path == "/api/image":
                ref = self.app.set_image(payload["key"], payload)
                if ref and self.app.sam.available:
                    self.app.sam.request(image_path_for(ref), urgent=True)
                self.send_json({"image": client_url(ref), "image_ref": ref})
            elif url.path == "/api/sam":
                ref = self.app.working_image(payload["key"])
                masks = self.app.sam.predict(image_path_for(ref), payload["points"], payload["labels"])
                self.send_json({"masks": ["data:image/png;base64," + base64.b64encode(m).decode() for m in masks]})
            elif url.path == "/api/save":
                count = self.app.save(payload["key"], payload)
                self.send_json({"ok": True, "published": count})
            else:
                self.send_error(HTTPStatus.NOT_FOUND)
        except Exception as err:  # noqa: BLE001
            print("Error:", err)
            self.send_json({"error": str(err)}, HTTPStatus.INTERNAL_SERVER_ERROR)


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--port", type=int, default=8001)
    parser.add_argument("--model", choices=[*MODELS, "none"], default="sam2")
    args = parser.parse_args()
    sys.stdout.reconfigure(line_buffering=True)  # que los mensajes salgan al momento aunque se redirija
    if not TARGETS.exists():
        sys.exit(f"Falta {rel(TARGETS)}")
    Handler.app = App(args.model)
    print(f"{len(Handler.app.rows)} objetivos en {rel(TARGETS)}")
    print(f"Herramienta: http://localhost:{args.port}/   (Ctrl+C para salir)")
    ThreadingHTTPServer(("127.0.0.1", args.port), Handler).serve_forever()


if __name__ == "__main__":
    main()
