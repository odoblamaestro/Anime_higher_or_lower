(() => {
  'use strict';

  /* ---------- Color (copiado de game.js: mismas fórmulas que el juego) ---------- */
  const toLinear = (c) => (c > 0.04045 ? ((c + 0.055) / 1.055) ** 2.4 : c / 12.92);
  const toGamma = (c) => (c > 0.0031308 ? 1.055 * c ** (1 / 2.4) - 0.055 : 12.92 * c);
  const labF = (t) => (t > 216 / 24389 ? Math.cbrt(t) : ((24389 / 27) * t + 16) / 116);
  const labFInv = (t) => (t * t * t > 216 / 24389 ? t * t * t : (116 * t - 16) / (24389 / 27));
  const LINEAR = Float64Array.from({ length: 256 }, (_, i) => toLinear(i / 255));

  function rgbToLab(r, g, b) {
    r = LINEAR[r];
    g = LINEAR[g];
    b = LINEAR[b];
    const fx = labF((0.4124564 * r + 0.3575761 * g + 0.1804375 * b) / 0.95047);
    const fy = labF(0.2126729 * r + 0.7151522 * g + 0.072175 * b);
    const fz = labF((0.0193339 * r + 0.119192 * g + 0.9503041 * b) / 1.08883);
    return [116 * fy - 16, 500 * (fx - fy), 200 * (fy - fz)];
  }

  function labToLinear(L, a, b) {
    const fy = (L + 16) / 116;
    const x = labFInv(fy + a / 500) * 0.95047;
    const y = labFInv(fy);
    const z = labFInv(fy - b / 200) * 1.08883;
    return [
      3.2404542 * x - 1.5371385 * y - 0.4985314 * z,
      -0.969266 * x + 1.8760108 * y + 0.041556 * z,
      0.0556434 * x - 0.2040259 * y + 1.0572252 * z,
    ];
  }

  const labToRgb = (L, a, b) =>
    labToLinear(L, a, b).map((c) => Math.round(toGamma(Math.min(1, Math.max(0, c))) * 255));
  const rgbHex = (rgb) => `#${rgb.map((c) => c.toString(16).padStart(2, '0')).join('')}`;
  const lchToLab = (L, C, h) => [L, C * Math.cos((h * Math.PI) / 180), C * Math.sin((h * Math.PI) / 180)];

  function maxChroma(L, h) {
    let lo = 0;
    let hi = 150;
    for (let i = 0; i < 14; i++) {
      const mid = (lo + hi) / 2;
      if (labToLinear(...lchToLab(L, mid, h)).every((c) => c >= -1e-4 && c <= 1 + 1e-4)) lo = mid;
      else hi = mid;
    }
    return lo;
  }

  function colorFromLab([L, a, b]) {
    const C = Math.hypot(a, b);
    const h = ((Math.atan2(b, a) * 180) / Math.PI + 360) % 360;
    const max = maxChroma(L, h);
    return { L, C, h, s: max ? Math.min(1, C / max) : 0 };
  }

  // Igual que hairLut() del juego: claridad desplazada en bloque, croma limitada a la gama.
  function recolorLut(color, baseL) {
    const shift = color.L - baseL;
    const lut = new Uint8ClampedArray(101 * 3);
    for (let L0 = 0; L0 <= 100; L0++) {
      const L = Math.min(100, Math.max(0, L0 + shift));
      const C = Math.min(color.C, color.s * maxChroma(L, color.h));
      lut.set(labToRgb(...lchToLab(L, C, color.h)), L0 * 3);
    }
    return lut;
  }

  /* ---------- Estado ---------- */
  const $ = (id) => document.getElementById(id);
  const UNDO_LIMIT = 60;
  const OVERLAY_RGB = [255, 40, 190];

  const S = {
    targets: [],
    index: -1,
    cur: null, // respuesta de /api/open
    img: null, // { w, h, canvas, data (RGBA), lab (Float32Array 3·N), lbin (claridad 0-100) }
    mask: null, // Uint8Array w·h, 0-255
    undo: [],
    redo: [],
    tool: 'wand',
    view: { scale: 1, x: 0, y: 0 },
    overlayOn: true,
    color: { auto: null, manual: null },
    sam: { available: false, points: [], labels: [], base: null, subtract: false, candidates: [], level: 1, seq: 0 },
    previewMode: 'target',
    dirty: false,
    pointer: null, // última posición en pantalla (para el cursor del pincel)
  };

  const view = $('view');
  const vctx = view.getContext('2d');
  const viewport = $('viewport');
  const overlay = document.createElement('canvas');
  const octx = overlay.getContext('2d');
  const preview = $('preview');
  const pctx = preview.getContext('2d');

  /* ---------- Utilidades de interfaz ---------- */
  let toastTimer = 0;
  function toast(text, error = false) {
    const node = $('toast');
    node.textContent = text;
    node.classList.toggle('is-error', error);
    node.classList.add('is-visible');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => node.classList.remove('is-visible'), error ? 4000 : 1800);
  }

  function busy(text) {
    $('busy').hidden = !text;
    $('busy').textContent = text || '';
  }

  async function api(path, body) {
    const res = await fetch(path, body ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : {});
    const data = await res.json();
    if (!res.ok || data.error) throw new Error(data.error || `HTTP ${res.status}`);
    return data;
  }

  const current = () => S.targets[S.index];
  const questionText = (t, short) => `What color is ${short || t.character?.name || t.ident}’s ${t.target.toLowerCase()}?`;

  /* ---------- Lista y progreso ---------- */
  function renderList() {
    const list = $('list');
    const onlyPending = $('only-pending').checked;
    list.replaceChildren(...S.targets.map((t, i) => {
      const li = document.createElement('li');
      li.className = i === S.index ? 'is-current' : '';
      if (onlyPending && t.status !== 'pending' && i !== S.index) li.classList.add('is-hidden');
      const dot = document.createElement('span');
      dot.className = `dot ${t.status}`;
      const text = document.createElement('span');
      text.className = 'li-text';
      const b = document.createElement('b');
      b.textContent = `${t.short || t.character?.name || t.ident} · ${t.target}`;
      const sub = document.createElement('span');
      sub.textContent = t.character ? t.character.anime || t.character.name : `No encontrado en AniList (línea ${t.line})`;
      text.append(b, sub);
      li.append(dot, text);
      li.addEventListener('click', () => open(i));
      return li;
    }));
    const done = S.targets.filter((t) => t.status !== 'pending').length;
    const total = S.targets.length;
    $('progress-bar').style.width = total ? `${(100 * done) / total}%` : '0';
    const ok = S.targets.filter((t) => t.status === 'done').length;
    $('progress-text').textContent = `${done}/${total} · ${ok} guardados`;
  }

  /* ---------- Carga de un objetivo ---------- */
  function confirmDiscard() {
    return !S.dirty || confirm('Hay cambios sin guardar en este objetivo. ¿Descartarlos?');
  }

  async function open(index) {
    if (index < 0 || index >= S.targets.length || !confirmDiscard()) return;
    S.index = index;
    renderList();
    const t = current();
    $('who-name').textContent = t.character ? t.character.name : t.ident;
    $('who-anime').textContent = t.character?.anime ? `· ${t.character.anime}` : '';
    $('short').value = t.short || '';
    updateQuestion();
    resetSam();
    try {
      S.cur = await api(`/api/open?key=${encodeURIComponent(t.key)}`);
    } catch (err) {
      toast(`No se pudo abrir: ${err.message}`, true);
      return;
    }
    if (current() !== t) return;
    const ann = S.cur.annotation || {};
    S.color.manual = ann.manual_color && ann.lab ? ann.lab : null;
    S.color.auto = null;
    $('source-kind').textContent = { local: 'Imagen propia', url: 'AniList', csv: 'targets.csv', none: 'Sin imagen' }[S.cur.source] || '';
    await loadImage(S.cur.image, S.cur.mask);
    prefetchNext();
  }

  function loadImg(src) {
    return new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => resolve(img);
      img.onerror = () => reject(new Error(`No se pudo cargar ${src}`));
      img.src = src;
    });
  }

  async function loadImage(src, maskSrc) {
    S.img = null;
    S.mask = null;
    S.undo = [];
    S.redo = [];
    S.dirty = false;
    $('empty').hidden = false;
    $('empty').textContent = src ? 'Cargando imagen…' : 'Sin imagen: arrastra una captura, pégala con Ctrl+V o pega una URL arriba.';
    draw();
    if (!src) return;
    let img;
    try {
      img = await loadImg(src);
    } catch (err) {
      $('empty').textContent = err.message;
      return;
    }
    const w = img.naturalWidth;
    const h = img.naturalHeight;
    const canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    ctx.drawImage(img, 0, 0);
    const data = ctx.getImageData(0, 0, w, h).data;
    const lab = new Float32Array(w * h * 3);
    const lbin = new Uint8Array(w * h);
    for (let i = 0; i < w * h; i++) {
      const [L, a, b] = rgbToLab(data[i * 4], data[i * 4 + 1], data[i * 4 + 2]);
      lab[i * 3] = L;
      lab[i * 3 + 1] = a;
      lab[i * 3 + 2] = b;
      lbin[i] = Math.round(Math.min(100, Math.max(0, L)));
    }
    S.img = { w, h, canvas, data, lab, lbin };
    S.mask = new Uint8Array(w * h);
    if (maskSrc) {
      try {
        const m = await loadImg(maskSrc);
        const mc = document.createElement('canvas');
        mc.width = w;
        mc.height = h;
        const mctx = mc.getContext('2d', { willReadFrequently: true });
        mctx.drawImage(m, 0, 0, w, h);
        const md = mctx.getImageData(0, 0, w, h).data;
        // La máscara guardada lleva el borde suavizado: se vuelve a binarizar para editarla.
        for (let i = 0; i < w * h; i++) S.mask[i] = md[i * 4] >= 128 ? 255 : 0;
      } catch {
        toast('No se pudo cargar la máscara guardada', true);
      }
    }
    overlay.width = w;
    overlay.height = h;
    preview.width = w;
    preview.height = h;
    $('empty').hidden = true;
    fit();
    maskChanged(false);
  }

  function prefetchNext() {
    const next = S.targets.findIndex((t, i) => i > S.index && t.status === 'pending');
    if (next >= 0 && S.sam.available) api(`/api/prefetch?key=${encodeURIComponent(S.targets[next].key)}`).catch(() => {});
  }

  /* ---------- Vista: zoom, desplazamiento y dibujo ---------- */
  function fit() {
    if (!S.img) return;
    const r = viewport.getBoundingClientRect();
    const scale = Math.min((r.width - 40) / S.img.w, (r.height - 40) / S.img.h);
    S.view.scale = scale;
    S.view.x = (r.width - S.img.w * scale) / 2;
    S.view.y = (r.height - S.img.h * scale) / 2;
    draw();
  }

  function zoomAt(factor, sx, sy) {
    const v = S.view;
    const scale = Math.min(40, Math.max(0.1, v.scale * factor));
    v.x = sx - ((sx - v.x) * scale) / v.scale;
    v.y = sy - ((sy - v.y) * scale) / v.scale;
    v.scale = scale;
    draw();
  }

  const toImage = (sx, sy) => [(sx - S.view.x) / S.view.scale, (sy - S.view.y) / S.view.scale];

  function draw() {
    const dpr = window.devicePixelRatio || 1;
    const r = viewport.getBoundingClientRect();
    if (view.width !== Math.round(r.width * dpr) || view.height !== Math.round(r.height * dpr)) {
      view.width = Math.round(r.width * dpr);
      view.height = Math.round(r.height * dpr);
    }
    vctx.setTransform(1, 0, 0, 1, 0, 0);
    vctx.clearRect(0, 0, view.width, view.height);
    if (!S.img) return;
    const { scale, x, y } = S.view;
    vctx.setTransform(dpr * scale, 0, 0, dpr * scale, dpr * x, dpr * y);
    vctx.imageSmoothingEnabled = scale < 2;
    vctx.drawImage(S.img.canvas, 0, 0);
    if (S.overlayOn) {
      vctx.globalAlpha = $('overlay').value / 100;
      vctx.drawImage(overlay, 0, 0);
      vctx.globalAlpha = 1;
    }
    vctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    // Puntos de SAM
    for (const [i, [px, py]] of S.sam.points.entries()) {
      const sx = x + (px + 0.5) * scale;
      const sy = y + (py + 0.5) * scale;
      vctx.beginPath();
      vctx.arc(sx, sy, 6, 0, Math.PI * 2);
      vctx.fillStyle = S.sam.labels[i] ? '#55bf86' : '#f0675e';
      vctx.fill();
      vctx.lineWidth = 2;
      vctx.strokeStyle = '#fff';
      vctx.stroke();
    }
    // Cursor del pincel
    if ((S.tool === 'brush' || S.tool === 'eraser') && S.pointer) {
      vctx.beginPath();
      vctx.arc(S.pointer[0], S.pointer[1], Math.max(1, brushRadius() * scale), 0, Math.PI * 2);
      vctx.lineWidth = 1.5;
      vctx.strokeStyle = S.tool === 'brush' ? '#fff' : '#f0675e';
      vctx.stroke();
    }
  }

  let drawQueued = false;
  function queueDraw() {
    if (drawQueued) return;
    drawQueued = true;
    requestAnimationFrame(() => {
      drawQueued = false;
      draw();
    });
  }

  /* ---------- Máscara: capa, deshacer y operaciones ---------- */
  function renderOverlay() {
    const { w, h } = S.img;
    const out = octx.createImageData(w, h);
    const d = out.data;
    for (let i = 0; i < w * h; i++) {
      const m = S.mask[i];
      if (!m) continue;
      d[i * 4] = OVERLAY_RGB[0];
      d[i * 4 + 1] = OVERLAY_RGB[1];
      d[i * 4 + 2] = OVERLAY_RGB[2];
      d[i * 4 + 3] = m;
    }
    octx.putImageData(out, 0, 0);
  }

  let colorTimer = 0;
  function maskChanged(dirty = true) {
    if (!S.img) return;
    if (dirty) S.dirty = true;
    renderOverlay();
    queueDraw();
    clearTimeout(colorTimer);
    colorTimer = setTimeout(() => {
      S.color.auto = autoColor();
      updateColor();
    }, 120);
    $('undo').disabled = !S.undo.length;
    $('redo').disabled = !S.redo.length;
  }

  function pushUndo() {
    S.undo.push(S.mask.slice());
    if (S.undo.length > UNDO_LIMIT) S.undo.shift();
    S.redo = [];
  }

  function undo() {
    if (!S.undo.length) return;
    endSam(false);
    S.redo.push(S.mask);
    S.mask = S.undo.pop();
    maskChanged();
  }

  function redo() {
    if (!S.redo.length) return;
    endSam(false);
    S.undo.push(S.mask);
    S.mask = S.redo.pop();
    maskChanged();
  }

  function morph(grow) {
    const { w, h } = S.img;
    const src = S.mask;
    const out = new Uint8Array(w * h);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        let v = grow ? 0 : 255;
        for (let dy = -1; dy <= 1; dy++) {
          for (let dx = -1; dx <= 1; dx++) {
            const xx = x + dx;
            const yy = y + dy;
            const m = xx < 0 || yy < 0 || xx >= w || yy >= h ? 0 : src[yy * w + xx];
            v = grow ? Math.max(v, m) : Math.min(v, m);
          }
        }
        out[y * w + x] = v;
      }
    }
    pushUndo();
    S.mask = out;
    maskChanged();
  }

  // Máscara que se guarda (y que usa la vista previa): binaria o con 1 px de borde suave.
  function exportMask() {
    if (!$('soft').checked) return S.mask;
    const { w, h } = S.img;
    const out = new Uint8Array(w * h);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        let sum = 0;
        let n = 0;
        for (let dy = -1; dy <= 1; dy++) {
          for (let dx = -1; dx <= 1; dx++) {
            const xx = x + dx;
            const yy = y + dy;
            if (xx < 0 || yy < 0 || xx >= w || yy >= h) continue;
            sum += S.mask[yy * w + xx];
            n++;
          }
        }
        out[y * w + x] = Math.round(sum / n);
      }
    }
    return out;
  }

  /* ---------- Varita ---------- */
  // Zona conectada (4 vecinos) cuya distancia Lab al píxel pulsado no supera la tolerancia.
  function floodRegion(x0, y0, tol) {
    const { w, h, lab } = S.img;
    const seed = y0 * w + x0;
    const L0 = lab[seed * 3];
    const a0 = lab[seed * 3 + 1];
    const b0 = lab[seed * 3 + 2];
    const tol2 = tol * tol;
    const region = new Uint8Array(w * h);
    const queue = new Int32Array(w * h);
    let head = 0;
    let tail = 0;
    region[seed] = 1;
    queue[tail++] = seed;
    while (head < tail) {
      const i = queue[head++];
      const x = i % w;
      const neighbors = [x > 0 ? i - 1 : -1, x < w - 1 ? i + 1 : -1, i >= w ? i - w : -1, i < w * (h - 1) ? i + w : -1];
      for (const j of neighbors) {
        if (j < 0 || region[j]) continue;
        const dL = lab[j * 3] - L0;
        const da = lab[j * 3 + 1] - a0;
        const db = lab[j * 3 + 2] - b0;
        if (dL * dL + da * da + db * db <= tol2) {
          region[j] = 1;
          queue[tail++] = j;
        }
      }
    }
    return region;
  }

  function wandClick(ix, iy, e) {
    const region = floodRegion(ix, iy, +$('tol').value);
    pushUndo();
    const subtract = e.altKey || e.ctrlKey;
    if (!e.shiftKey && !subtract) S.mask.fill(0);
    for (let i = 0; i < region.length; i++) {
      if (region[i]) S.mask[i] = subtract ? 0 : 255;
    }
    maskChanged();
  }

  /* ---------- SAM ---------- */
  function resetSam() {
    Object.assign(S.sam, { points: [], labels: [], base: null, candidates: [], subtract: false });
    S.sam.seq++;
    updateSamHint();
  }

  // Termina el objeto actual; si `restore`, devuelve la máscara a como estaba antes de él.
  function endSam(restore) {
    if (restore && S.sam.base) {
      S.mask = S.sam.base;
      maskChanged();
    }
    resetSam();
    busy('');
    queueDraw();
  }

  function updateSamHint() {
    const { candidates, level } = S.sam;
    $('sam-level').disabled = candidates.length < 2;
    $('sam-level').textContent = candidates.length > 1 ? `Nivel ${level + 1}/${candidates.length}` : 'Nivel';
    $('sam-level').append(' ', Object.assign(document.createElement('kbd'), { textContent: 'M' }));
  }

  function applySam() {
    const cand = S.sam.candidates[Math.min(S.sam.level, S.sam.candidates.length - 1)];
    if (!cand) return;
    S.mask = S.sam.base.slice();
    for (let i = 0; i < cand.length; i++) {
      if (cand[i]) S.mask[i] = S.sam.subtract ? 0 : 255;
    }
    maskChanged();
  }

  async function decodeMask(dataUrl) {
    const img = await loadImg(dataUrl);
    const { w, h } = S.img;
    const c = document.createElement('canvas');
    c.width = w;
    c.height = h;
    const ctx = c.getContext('2d', { willReadFrequently: true });
    ctx.drawImage(img, 0, 0, w, h);
    const d = ctx.getImageData(0, 0, w, h).data;
    const m = new Uint8Array(w * h);
    for (let i = 0; i < w * h; i++) m[i] = d[i * 4] >= 128 ? 1 : 0;
    return m;
  }

  async function samClick(ix, iy, positive, e) {
    if (!S.sam.available) {
      toast('SAM no está disponible (mira la consola del servidor)', true);
      return;
    }
    if (!S.sam.base) {
      pushUndo();
      S.sam.base = S.mask.slice();
      S.sam.subtract = e.altKey || e.ctrlKey;
    }
    S.sam.points.push([ix, iy]);
    S.sam.labels.push(positive ? 1 : 0);
    queueDraw();
    const seq = ++S.sam.seq;
    const key = current().key;
    busy('SAM calculando… (la primera vez en cada imagen tarda unos segundos)');
    try {
      const { masks } = await api('/api/sam', { key, points: S.sam.points, labels: S.sam.labels });
      if (seq !== S.sam.seq || current().key !== key) return; // llegó otro clic o se cambió de objetivo
      S.sam.candidates = await Promise.all(masks.map(decodeMask));
      if (seq !== S.sam.seq) return;
      if (S.sam.candidates.length === 1) S.sam.level = Math.min(S.sam.level, 2);
      busy('');
      applySam();
      updateSamHint();
    } catch (err) {
      if (seq === S.sam.seq) {
        busy('');
        toast(`SAM: ${err.message}`, true);
      }
    }
  }

  function cycleSamLevel() {
    if (S.sam.candidates.length < 2) return;
    S.sam.level = (S.sam.level + 1) % S.sam.candidates.length;
    applySam();
    updateSamHint();
  }

  /* ---------- Pincel y goma ---------- */
  const brushRadius = () => +$('brush').value / 2;

  function stamp(cx, cy, value) {
    const { w, h } = S.img;
    const r = brushRadius();
    const r2 = r * r;
    for (let y = Math.max(0, Math.floor(cy - r)); y <= Math.min(h - 1, Math.ceil(cy + r)); y++) {
      for (let x = Math.max(0, Math.floor(cx - r)); x <= Math.min(w - 1, Math.ceil(cx + r)); x++) {
        const dx = x + 0.5 - cx;
        const dy = y + 0.5 - cy;
        if (dx * dx + dy * dy <= r2 || (r < 1 && Math.floor(cx) === x && Math.floor(cy) === y)) S.mask[y * w + x] = value;
      }
    }
  }

  function strokeTo(from, to, value) {
    const steps = Math.max(1, Math.ceil(Math.hypot(to[0] - from[0], to[1] - from[1]) / Math.max(0.5, brushRadius() / 2)));
    for (let s = 1; s <= steps; s++) {
      stamp(from[0] + ((to[0] - from[0]) * s) / steps, from[1] + ((to[1] - from[1]) * s) / steps, value);
    }
  }

  /* ---------- Color objetivo ---------- */
  // Mediana en Lab de los píxeles de la máscara, sin sombras ni brillos extremos (percentiles
  // 15-85 de claridad), como el pipeline anterior.
  function autoColor() {
    const { lab } = S.img;
    const idx = [];
    for (let i = 0; i < S.mask.length; i++) if (S.mask[i] >= 128) idx.push(i);
    if (idx.length < 20) return null;
    const Ls = Float32Array.from(idx, (i) => lab[i * 3]).sort();
    const lo = Ls[Math.floor(0.15 * (Ls.length - 1))];
    const hi = Ls[Math.ceil(0.85 * (Ls.length - 1))];
    const keep = idx.filter((i) => lab[i * 3] >= lo && lab[i * 3] <= hi);
    const median = (k) => {
      const v = Float32Array.from(keep, (i) => lab[i * 3 + k]).sort();
      return v[Math.floor(v.length / 2)];
    };
    return [median(0), median(1), median(2)].map((x) => Math.round(x * 10) / 10);
  }

  const chosenColor = () => S.color.manual || S.color.auto;

  function updateColor() {
    const lab = chosenColor();
    const text = $('color-text');
    const n = S.mask ? S.mask.reduce((acc, m) => acc + (m >= 128), 0) : 0;
    if (!lab) {
      $('swatch').style.background = 'transparent';
      text.textContent = n ? 'Máscara demasiado pequeña' : 'Sin máscara';
    } else {
      const hex = rgbHex(labToRgb(...lab));
      $('swatch').style.background = hex;
      text.innerHTML = '';
      const b = document.createElement('b');
      b.textContent = hex;
      text.append(b, ` · ${S.color.manual ? 'manual' : 'automático'}`, document.createElement('br'),
        `L ${lab[0].toFixed(1)}  a ${lab[1].toFixed(1)}  b ${lab[2].toFixed(1)}`, document.createElement('br'),
        `${n.toLocaleString('es')} px`);
    }
    $('color-auto').disabled = !S.color.manual;
    renderPreview();
  }

  function pickColorAt(ix, iy) {
    const { w, h, lab } = S.img;
    const acc = [0, 0, 0];
    let n = 0;
    for (let y = Math.max(0, iy - 1); y <= Math.min(h - 1, iy + 1); y++) {
      for (let x = Math.max(0, ix - 1); x <= Math.min(w - 1, ix + 1); x++) {
        const i = (y * w + x) * 3;
        acc[0] += lab[i];
        acc[1] += lab[i + 1];
        acc[2] += lab[i + 2];
        n++;
      }
    }
    S.color.manual = acc.map((v) => Math.round((v / n) * 10) / 10);
    S.dirty = true;
    updateColor();
  }

  /* ---------- Vista previa del juego ---------- */
  function renderPreview() {
    if (!S.img) return;
    const { w, h, data, lbin } = S.img;
    const target = chosenColor();
    const baseL = target ? target[0] : 50;
    let lut;
    if (S.previewMode === 'gray') {
      lut = new Uint8ClampedArray(101 * 3);
      for (let L = 0; L <= 100; L++) lut.set(labToRgb(L, 0, 0), L * 3);
    } else if (S.previewMode === 'test') {
      const hue = +$('test-hue').value;
      lut = recolorLut({ L: baseL, h: hue, s: 0.7, C: 0.7 * maxChroma(baseL, hue) }, baseL);
    } else if (target) {
      lut = recolorLut(colorFromLab(target), baseL);
    }
    const out = new ImageData(new Uint8ClampedArray(data), w, h);
    if (lut) {
      const mask = exportMask();
      const d = out.data;
      for (let i = 0; i < w * h; i++) {
        const m = mask[i] / 255;
        if (m < 0.02) continue;
        const q = lbin[i] * 3;
        const p = i * 4;
        d[p] = data[p] + (lut[q] - data[p]) * m;
        d[p + 1] = data[p + 1] + (lut[q + 1] - data[p + 1]) * m;
        d[p + 2] = data[p + 2] + (lut[q + 2] - data[p + 2]) * m;
      }
    }
    pctx.putImageData(out, 0, 0);
  }

  /* ---------- Guardar, saltar, navegar ---------- */
  function updateQuestion() {
    const t = current();
    if (t) $('question').textContent = questionText(t, $('short').value.trim());
  }

  function maskPng() {
    const { w, h } = S.img;
    const mask = exportMask();
    const c = document.createElement('canvas');
    c.width = w;
    c.height = h;
    const ctx = c.getContext('2d');
    const out = ctx.createImageData(w, h);
    for (let i = 0; i < w * h; i++) {
      out.data[i * 4] = out.data[i * 4 + 1] = out.data[i * 4 + 2] = mask[i];
      out.data[i * 4 + 3] = 255;
    }
    ctx.putImageData(out, 0, 0);
    return c.toDataURL('image/png');
  }

  function goNext() {
    const next = S.targets.findIndex((t, i) => i > S.index && t.status === 'pending');
    const wrap = S.targets.findIndex((t) => t.status === 'pending');
    const target = next >= 0 ? next : wrap;
    if (target >= 0 && target !== S.index) open(target);
    else {
      renderList();
      toast('¡No quedan objetivos pendientes!');
    }
  }

  async function save() {
    const t = current();
    if (!t || !S.img) return;
    const lab = chosenColor();
    if (!lab) {
      toast('La máscara está vacía o es demasiado pequeña', true);
      return;
    }
    try {
      endSam(false);
      const res = await api('/api/save', {
        key: t.key,
        status: 'done',
        mask: maskPng(),
        lab,
        hex: rgbHex(labToRgb(...lab)),
        auto_lab: S.color.auto,
        manual_color: Boolean(S.color.manual),
        short: $('short').value,
      });
      t.status = 'done';
      t.short = $('short').value.trim() || t.short;
      S.dirty = false;
      toast(`Guardado · ${res.published} en data/color.json`);
      goNext();
    } catch (err) {
      toast(`No se pudo guardar: ${err.message}`, true);
    }
  }

  async function skip() {
    const t = current();
    if (!t) return;
    try {
      await api('/api/save', { key: t.key, status: 'skipped', short: $('short').value });
      t.status = 'skipped';
      S.dirty = false;
      toast('Saltado');
      goNext();
    } catch (err) {
      toast(`Error: ${err.message}`, true);
    }
  }

  /* ---------- Cambiar la imagen ---------- */
  async function setImage(payload) {
    const t = current();
    if (!t) return;
    if (S.mask && S.mask.some((m) => m) && !confirm('Cambiar la imagen borra la máscara actual. ¿Seguir?')) return;
    busy('Importando imagen…');
    try {
      const res = await api('/api/image', { key: t.key, ...payload });
      t.status = 'pending';
      S.cur.image = res.image;
      S.color.manual = null;
      $('source-kind').textContent = payload.reset ? '' : res.image_ref.startsWith('http') ? 'AniList' : 'Imagen propia';
      busy('');
      endSam(false);
      await loadImage(res.image, '');
      renderList();
      toast(payload.reset ? 'Imagen original' : 'Imagen guardada (400 px, WebP)');
    } catch (err) {
      busy('');
      toast(`No se pudo usar la imagen: ${err.message}`, true);
    }
  }

  const fileToDataUrl = (file) => new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });

  /* ---------- Herramientas ---------- */
  function setTool(tool) {
    if (S.tool === 'sam' && tool !== 'sam') endSam(false);
    S.tool = tool;
    viewport.className = `tool-${tool}`;
    for (const btn of document.querySelectorAll('#tools button')) btn.classList.toggle('is-on', btn.dataset.tool === tool);
    $('opt-wand').hidden = tool !== 'wand';
    $('opt-sam').hidden = tool !== 'sam';
    $('opt-brush').hidden = tool !== 'brush' && tool !== 'eraser';
    $('opt-picker').hidden = tool !== 'picker';
    queueDraw();
  }

  /* ---------- Eventos del lienzo ---------- */
  let spaceDown = false;
  let drag = null; // { kind: 'pan' | 'paint', ... }

  const localPoint = (e) => {
    const r = view.getBoundingClientRect();
    return [e.clientX - r.left, e.clientY - r.top];
  };

  view.addEventListener('contextmenu', (e) => e.preventDefault());

  view.addEventListener('pointerdown', (e) => {
    if (!S.img) return;
    const [sx, sy] = localPoint(e);
    if (e.button === 1 || spaceDown) {
      drag = { kind: 'pan', sx, sy, x: S.view.x, y: S.view.y };
      viewport.classList.add('is-panning');
      view.setPointerCapture(e.pointerId);
      e.preventDefault();
      return;
    }
    const [fx, fy] = toImage(sx, sy);
    const ix = Math.floor(fx);
    const iy = Math.floor(fy);
    const inside = ix >= 0 && iy >= 0 && ix < S.img.w && iy < S.img.h;
    if (S.tool === 'brush' || S.tool === 'eraser') {
      if (e.button !== 0) return;
      pushUndo();
      const value = S.tool === 'brush' ? 255 : 0;
      stamp(fx, fy, value);
      drag = { kind: 'paint', last: [fx, fy], value };
      view.setPointerCapture(e.pointerId);
      maskChanged();
      return;
    }
    if (!inside) return;
    if (S.tool === 'wand' && e.button === 0) wandClick(ix, iy, e);
    else if (S.tool === 'sam' && (e.button === 0 || e.button === 2)) samClick(ix, iy, e.button === 0, e);
    else if (S.tool === 'picker' && e.button === 0) pickColorAt(ix, iy);
  });

  view.addEventListener('pointermove', (e) => {
    const [sx, sy] = localPoint(e);
    S.pointer = [sx, sy];
    if (drag?.kind === 'pan') {
      S.view.x = drag.x + sx - drag.sx;
      S.view.y = drag.y + sy - drag.sy;
      queueDraw();
    } else if (drag?.kind === 'paint') {
      const p = toImage(sx, sy);
      strokeTo(drag.last, p, drag.value);
      drag.last = p;
      maskChanged();
    } else if (S.tool === 'brush' || S.tool === 'eraser') {
      queueDraw();
    }
  });

  const endDrag = () => {
    drag = null;
    viewport.classList.remove('is-panning');
  };
  view.addEventListener('pointerup', endDrag);
  view.addEventListener('pointercancel', endDrag);
  view.addEventListener('pointerleave', () => {
    S.pointer = null;
    queueDraw();
  });

  view.addEventListener('wheel', (e) => {
    e.preventDefault();
    const [sx, sy] = localPoint(e);
    zoomAt(e.deltaY < 0 ? 1.15 : 1 / 1.15, sx, sy);
  }, { passive: false });

  window.addEventListener('resize', () => queueDraw());

  // Arrastrar una imagen local
  let dragDepth = 0;
  window.addEventListener('dragenter', (e) => {
    if (![...e.dataTransfer.types].includes('Files')) return;
    dragDepth++;
    viewport.classList.add('is-dragging');
  });
  window.addEventListener('dragleave', () => {
    dragDepth = Math.max(0, dragDepth - 1);
    if (!dragDepth) viewport.classList.remove('is-dragging');
  });
  window.addEventListener('dragover', (e) => e.preventDefault());
  window.addEventListener('drop', async (e) => {
    e.preventDefault();
    dragDepth = 0;
    viewport.classList.remove('is-dragging');
    const file = [...e.dataTransfer.files].find((f) => f.type.startsWith('image/'));
    if (file) setImage({ data_url: await fileToDataUrl(file) });
    else {
      const url = e.dataTransfer.getData('text/uri-list') || e.dataTransfer.getData('text/plain');
      if (/^https?:\/\//.test(url)) setImage({ url });
    }
  });

  // Pegar (Ctrl+V): una captura del portapapeles o una URL
  document.addEventListener('paste', async (e) => {
    const file = [...e.clipboardData.files].find((f) => f.type.startsWith('image/'));
    if (file) {
      e.preventDefault();
      setImage({ data_url: await fileToDataUrl(file) });
      return;
    }
    if (e.target.tagName === 'INPUT') return;
    const text = e.clipboardData.getData('text').trim();
    if (/^https?:\/\//.test(text)) {
      e.preventDefault();
      setImage({ url: text });
    }
  });

  /* ---------- Teclado ---------- */
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Alt') e.preventDefault(); // en Windows, Alt suelto activa el menú del navegador
    const typing = e.target.tagName === 'INPUT' && e.target.type !== 'range' && e.target.type !== 'checkbox';
    if (typing) {
      if (e.key === 'Escape') e.target.blur();
      return;
    }
    const k = e.key.toLowerCase();
    if ((e.ctrlKey || e.metaKey) && k === 'z') {
      e.preventDefault();
      if (e.shiftKey) redo();
      else undo();
    } else if ((e.ctrlKey || e.metaKey) && k === 'y') {
      e.preventDefault();
      redo();
    } else if (e.ctrlKey || e.metaKey) {
      // Ctrl+V y demás atajos del navegador
    } else if (e.key === ' ') {
      spaceDown = true;
      e.preventDefault();
    } else if (e.key === 'Enter') {
      e.preventDefault();
      if (e.shiftKey) skip();
      else save();
    } else if (e.key === 'PageDown') {
      e.preventDefault();
      open(S.index + 1);
    } else if (e.key === 'PageUp') {
      e.preventDefault();
      open(S.index - 1);
    } else if (e.key === 'Escape') {
      if (S.sam.base) endSam(true);
    } else if (k === 'w') setTool('wand');
    else if (k === 'a') setTool('sam');
    else if (k === 'b') setTool('brush');
    else if (k === 'e') setTool('eraser');
    else if (k === 'i') setTool('picker');
    else if (k === 'n') endSam(false);
    else if (k === 'm') cycleSamLevel();
    else if (k === 'h') {
      S.overlayOn = !S.overlayOn;
      queueDraw();
    } else if (k === '0') fit();
    else if (e.key === '+' || e.key === '=') {
      const r = viewport.getBoundingClientRect();
      zoomAt(1.25, r.width / 2, r.height / 2);
    } else if (e.key === '-') {
      const r = viewport.getBoundingClientRect();
      zoomAt(1 / 1.25, r.width / 2, r.height / 2);
    } else if (e.key === '[' || e.key === ']') {
      const input = S.tool === 'wand' ? $('tol') : $('brush');
      input.value = +input.value + (e.key === ']' ? 1 : -1) * (S.tool === 'wand' ? 2 : Math.max(1, Math.round(input.value / 8)));
      input.dispatchEvent(new Event('input'));
    }
  });

  document.addEventListener('keyup', (e) => {
    if (e.key === ' ') spaceDown = false;
    if (e.key === 'Alt') e.preventDefault();
  });

  /* ---------- Controles ---------- */
  for (const btn of document.querySelectorAll('#tools button')) btn.addEventListener('click', () => setTool(btn.dataset.tool));
  for (const [id, out] of [['tol', 'tol-out'], ['brush', 'brush-out'], ['overlay', 'overlay-out']]) {
    $(id).addEventListener('input', () => {
      $(out).textContent = $(id).value;
      queueDraw();
    });
  }
  $('soft').addEventListener('change', renderPreview);
  $('grow').addEventListener('click', () => S.img && morph(true));
  $('shrink').addEventListener('click', () => S.img && morph(false));
  $('clear').addEventListener('click', () => {
    if (!S.img) return;
    pushUndo();
    S.mask.fill(0);
    maskChanged();
  });
  $('undo').addEventListener('click', undo);
  $('redo').addEventListener('click', redo);
  $('sam-new').addEventListener('click', () => endSam(false));
  $('sam-level').addEventListener('click', cycleSamLevel);
  $('color-auto').addEventListener('click', () => {
    S.color.manual = null;
    S.dirty = true;
    updateColor();
  });
  for (const btn of document.querySelectorAll('#preview-mode button')) {
    btn.addEventListener('click', () => {
      S.previewMode = btn.dataset.mode;
      for (const b of document.querySelectorAll('#preview-mode button')) b.classList.toggle('is-on', b === btn);
      $('test-hue-row').hidden = S.previewMode !== 'test';
      renderPreview();
    });
  }
  $('test-hue').addEventListener('input', renderPreview);
  $('short').addEventListener('input', () => {
    S.dirty = true;
    updateQuestion();
  });
  $('save').addEventListener('click', save);
  $('skip').addEventListener('click', skip);
  $('next').addEventListener('click', () => open(S.index + 1));
  $('only-pending').addEventListener('change', renderList);
  $('url-load').addEventListener('click', () => {
    const url = $('url').value.trim();
    if (/^https?:\/\//.test(url)) setImage({ url });
  });
  $('url').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') $('url-load').click();
  });
  $('use-anilist').addEventListener('click', () => setImage({ reset: true }));
  window.addEventListener('beforeunload', (e) => {
    if (S.dirty) e.preventDefault();
  });

  /* ---------- Inicio ---------- */
  async function init() {
    setTool('wand');
    try {
      const data = await api('/api/targets');
      S.targets = data.targets;
      S.sam.available = data.sam.available;
      if (!data.sam.available) {
        document.querySelector('[data-tool="sam"]').disabled = true;
        document.querySelector('[data-tool="sam"]').title = `SAM no disponible: ${data.sam.error}`;
      }
    } catch (err) {
      $('empty').textContent = `No se pudo leer targets.csv: ${err.message}`;
      return;
    }
    renderList();
    if (!S.targets.length) {
      $('empty').textContent = 'targets.csv no tiene objetivos.';
      return;
    }
    // Se continúa donde se dejó: el primer objetivo pendiente.
    const first = S.targets.findIndex((t) => t.status === 'pending');
    open(first >= 0 ? first : 0);
  }

  init();
})();
