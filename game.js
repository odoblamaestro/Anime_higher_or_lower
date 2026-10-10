(() => {
  'use strict';

  /* ---------- Datasets y modos ----------
   * Un dataset sabe cómo leer cada elemento (nombre, subtítulo, imagen, color)
   * y qué campo indica su popularidad (rankKey), usado por la curva de dificultad.
   * Un modo elige un dataset y el campo numérico que se compara.
   */
  const DATASETS = {
    anime: {
      url: 'data/anime.json',
      name: (it) => it.title || it.romaji || 'Untitled',
      sub: (it) => (it.year ? String(it.year) : ''),
      image: (it) => it.image,
      color: (it) => it.color,
      rankKey: 'members',
    },
    characters: {
      url: 'data/characters.json',
      name: (it) => it.name || 'Unknown',
      sub: (it) => it.anime || '',
      image: (it) => it.image,
      color: () => null,
      rankKey: 'favourites',
    },
  };

  const MODES = [
    {
      id: 'anime-members',
      dataset: 'anime',
      key: 'members',
      label: 'Members',
      unit: 'members',
      unitOne: 'member',
      description: 'Which one is on more people’s lists?',
      icon: 'people',
    },
    {
      id: 'anime-favourites',
      dataset: 'anime',
      key: 'favourites',
      label: 'Favorites',
      unit: 'favorites',
      unitOne: 'favorite',
      description: 'Which one has been favorited more?',
      icon: 'heart',
    },
    {
      id: 'characters-favourites',
      dataset: 'characters',
      key: 'favourites',
      label: 'Character favorites',
      unit: 'favorites',
      unitOne: 'favorite',
      description: 'Which character has more fans?',
      icon: 'star',
    },
  ];

  // Modo diario: la misma partida para todo el mundo cada día (semilla = fecha UTC).
  const DAILY_MODE = {
    id: 'daily',
    dataset: 'anime',
    key: 'members',
    label: 'Daily',
    unit: 'members',
    unitOne: 'member',
    description: 'Same game for everyone. One try a day.',
    icon: 'calendar',
    daily: true,
  };
  const DAY_MS = 24 * 60 * 60 * 1000;
  const DAILY_FIRST_DAY = Math.floor(Date.UTC(2026, 9, 10) / DAY_MS); // Daily #1

  // Mosaico de portadas de la pantalla de inicio.
  const MOSAIC = { count: 36, fromTop: 200 };

  // Curva de dificultad: el pool (los más populares del dataset) crece con la racha.
  const DIFFICULTY = [
    { fromStreak: 0, poolSize: 150 },
    { fromStreak: 10, poolSize: 400 },
    { fromStreak: 25, poolSize: Infinity },
  ];

  const SVG_ATTRS = 'viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"';
  const ICONS = {
    people: `<svg ${SVG_ATTRS} width="22" height="22" stroke-width="2"><path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M22 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/></svg>`,
    heart: `<svg ${SVG_ATTRS} width="22" height="22" stroke-width="2"><path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z"/></svg>`,
    calendar: `<svg ${SVG_ATTRS} width="22" height="22" stroke-width="2"><rect x="3" y="4" width="18" height="18" rx="3"/><path d="M16 2v4M8 2v4M3 10h18"/></svg>`,
    star: `<svg ${SVG_ATTRS} width="22" height="22" stroke-width="2"><path d="M12 2l3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01L12 2z"/></svg>`,
    up: `<svg ${SVG_ATTRS} width="20" height="20" stroke-width="2.6"><path d="M12 19V5M5 12l7-7 7 7"/></svg>`,
    down: `<svg ${SVG_ATTRS} width="20" height="20" stroke-width="2.6"><path d="M12 5v14M19 12l-7 7-7-7"/></svg>`,
  };

  const TIMING = { count: 1000, verdict: 550, slide: 600, gameOver: 950, firstImages: 2500 };
  const FALLBACK_TINT = '#c9b8a3';
  const SHARE_TITLE = 'Higher or Lower · Anime';
  const SITE_URL = 'https://higherloweranime.com/';

  /* ---------- Utilidades ---------- */
  const $ = (id) => document.getElementById(id);
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');

  const fmt = (n) => Math.round(n).toLocaleString('en-US');

  function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text != null) node.textContent = text;
    return node;
  }

  function shuffle(arr) {
    for (let i = arr.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [arr[i], arr[j]] = [arr[j], arr[i]];
    }
    return arr;
  }

  // FNV-1a de 32 bits: convierte la fecha en una semilla.
  function hashString(str) {
    let h = 2166136261;
    for (let i = 0; i < str.length; i++) {
      h ^= str.charCodeAt(i);
      h = Math.imul(h, 16777619);
    }
    return h >>> 0;
  }

  // Generador pseudoaleatorio con semilla (mulberry32): misma semilla, misma secuencia.
  function mulberry32(seed) {
    let a = seed >>> 0;
    return () => {
      a = (a + 0x6d2b79f5) >>> 0;
      let t = a;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  function safeColor(color) {
    return typeof color === 'string' && /^#([0-9a-f]{3}){1,2}$/i.test(color) ? color : FALLBACK_TINT;
  }

  const store = {
    get(key) {
      try {
        return window.localStorage.getItem(key);
      } catch {
        return null;
      }
    },
    set(key, value) {
      try {
        window.localStorage.setItem(key, String(value));
      } catch {
        /* almacenamiento no disponible (modo privado, etc.) */
      }
    },
  };

  const bestKey = (mode) => `hol:best:${mode.id}`;
  function getBest(mode) {
    const n = parseInt(store.get(bestKey(mode)), 10);
    return Number.isFinite(n) && n > 0 ? n : 0;
  }

  /* ---------- Analítica (Umami) ----------
   * Si el script no ha cargado (adblocker, sin conexión, localhost) no hace nada.
   * Solo se registran unos pocos eventos por partida, nunca cada ronda. */
  function track(event, data) {
    try {
      if (window.umami && typeof window.umami.track === 'function') window.umami.track(event, data);
    } catch {
      /* la analítica nunca debe romper el juego */
    }
  }

  /* ---------- Modo diario ---------- */
  const utcDay = () => Math.floor(Date.now() / DAY_MS);
  const dailyNumber = (day) => day - DAILY_FIRST_DAY + 1;
  const dailySeed = (day) => hashString(`hol-daily-${new Date(day * DAY_MS).toISOString().slice(0, 10)}`);
  const dailyKey = (day) => `hol:daily:${day}`;

  function getDailyResult(day) {
    try {
      const result = JSON.parse(store.get(dailyKey(day)));
      return result && Array.isArray(result.rounds) ? result : null;
    } catch {
      return null;
    }
  }

  function saveDailyResult(day, result) {
    store.set(dailyKey(day), JSON.stringify(result));
  }

  function countdown() {
    const total = Math.max(0, Math.floor(((utcDay() + 1) * DAY_MS - Date.now()) / 1000));
    const pad = (n) => String(n).padStart(2, '0');
    return `${pad(Math.floor(total / 3600))}:${pad(Math.floor((total % 3600) / 60))}:${pad(total % 60)}`;
  }

  function countdownNode() {
    return el('span', 'js-countdown', countdown());
  }

  // 🟩 por acierto, 🟥 por el fallo final; en filas de 10.
  function emojiRows(rounds) {
    const squares = rounds.map((ok) => (ok ? '🟩' : '🟥'));
    const rows = [];
    for (let i = 0; i < squares.length; i += 10) rows.push(squares.slice(i, i + 10).join(''));
    return rows.join('\n');
  }

  /* ---------- Carga de datos e imágenes ---------- */
  const datasetCache = new Map();
  function loadDataset(id) {
    if (!datasetCache.has(id)) {
      const promise = fetch(DATASETS[id].url)
        .then((res) => {
          if (!res.ok) throw new Error(`HTTP ${res.status}`);
          return res.json();
        })
        .then((data) => {
          if (!Array.isArray(data)) throw new Error('Invalid data format');
          return data;
        });
      promise.catch(() => datasetCache.delete(id));
      datasetCache.set(id, promise);
    }
    return datasetCache.get(id);
  }

  const imageCache = new Map();
  function preload(url) {
    if (!url) return Promise.resolve(null);
    if (!imageCache.has(url)) {
      imageCache.set(
        url,
        new Promise((resolve) => {
          const img = new Image();
          img.decoding = 'async';
          img.onload = () => resolve(img);
          img.onerror = () => resolve(null);
          img.src = url;
        })
      );
    }
    return imageCache.get(url);
  }

  /* ---------- Estado ---------- */
  const state = {
    mode: null,
    ds: null,
    ranked: [], // elementos del modo, de más a menos popular
    used: new Set(), // ya mostrados en esta partida
    rng: Math.random, // en el modo diario, un generador con semilla
    day: null, // día UTC de la partida diaria en curso
    rounds: [], // acierto/fallo de cada ronda, para el texto de compartir
    shareData: null,
    left: null,
    right: null,
    next: null,
    leftEl: null,
    rightEl: null,
    score: 0,
    best: 0,
    startBest: 0,
    busy: false,
    token: 0, // se incrementa al empezar/salir para cancelar animaciones pendientes
  };

  const value = (item) => item[state.mode.key];

  function poolSize(streak) {
    let size = DIFFICULTY[0].poolSize;
    for (const tier of DIFFICULTY) if (streak >= tier.fromStreak) size = tier.poolSize;
    return size;
  }

  // Elige al azar, entre los más populares según la racha actual, un elemento no usado
  // y con valor distinto de excludeValue. Si ese tramo se agota, amplía a todo el dataset.
  function draw(excludeValue) {
    const { ranked, used } = state;
    const fits = (it) => !used.has(it) && value(it) !== excludeValue;
    let candidates = ranked.slice(0, poolSize(state.score)).filter(fits);
    if (!candidates.length) candidates = ranked.filter(fits);
    if (!candidates.length) return null;
    const item = candidates[Math.floor(state.rng() * candidates.length)];
    used.add(item);
    return item;
  }

  /* ---------- DOM ---------- */
  const els = {
    start: $('screen-start'),
    game: $('screen-game'),
    modeList: $('mode-list'),
    status: $('status'),
    stage: $('stage'),
    vs: $('vs'),
    announcer: $('announcer'),
    hudMode: $('hud-mode'),
    hudScore: $('hud-score'),
    hudBest: $('hud-best'),
    gameover: $('gameover'),
    goTitle: $('go-title'),
    goScore: $('go-score'),
    goLabel: $('go-label'),
    goEmoji: $('go-emoji'),
    btnAgain: $('btn-again'),
    btnShare: $('btn-share'),
    btnModes: $('btn-modes'),
    logo: $('logo'),
    mosaic: $('mosaic'),
    goBest: $('go-best'),
    goDetail: $('go-detail'),
    toast: $('toast'),
  };

  function showScreen(name) {
    els.start.hidden = name !== 'start';
    els.game.hidden = name !== 'game';
    document.body.classList.toggle('is-playing', name === 'game');
    if (name === 'start') fitLogo();
  }

  function setStatus(text) {
    els.status.textContent = text;
  }

  function modeButton(mode, description, sideLabel, sideValue) {
    const btn = el('button', 'mode-btn');
    btn.type = 'button';
    const icon = el('span', 'mode-icon');
    icon.setAttribute('aria-hidden', 'true');
    icon.innerHTML = ICONS[mode.icon] || '';
    const text = el('span', 'mode-text');
    text.append(el('span', 'mode-title', mode.label), el('span', 'mode-desc', description));
    const side = el('span', 'mode-best');
    const sideValueNode = el('span', 'mode-best-value');
    sideValueNode.append(sideValue);
    side.append(el('span', 'mode-best-label', sideLabel), sideValueNode);
    btn.append(icon, text, side);
    btn.addEventListener('click', () => startGame(mode));
    return btn;
  }

  function dailyButton() {
    const day = utcDay();
    const result = getDailyResult(day);
    const btn = result
      ? modeButton(DAILY_MODE, `Today’s streak: ${fmt(result.score)}. See you tomorrow!`, 'Next in', countdownNode())
      : modeButton(DAILY_MODE, DAILY_MODE.description, 'Day', `#${dailyNumber(day)}`);
    btn.classList.add('mode-btn-daily');
    if (result) btn.querySelector('.mode-best-value').classList.add('is-small');
    return btn;
  }

  function renderModes() {
    els.modeList.replaceChildren(
      dailyButton(),
      ...MODES.map((mode) => modeButton(mode, mode.description, 'Best', fmt(getBest(mode))))
    );
  }

  /* ---------- Portada: título y mosaico ---------- */
  const measureCtx = document.createElement('canvas').getContext('2d');

  // Ancho real de la tinta (sin márgenes laterales del glifo) de `text` a `size` px.
  function inkWidth(text, style, size) {
    measureCtx.font = `${style.fontStyle} ${style.fontWeight} ${size}px ${style.fontFamily}`;
    const m = measureCtx.measureText(text);
    const ink = (m.actualBoundingBoxLeft || 0) + (m.actualBoundingBoxRight || 0);
    return ink > 0 ? ink : m.width;
  }

  // Las tres líneas del título miden lo mismo: HIGHER y LOWER ajustando el tamaño de fuente;
  // OR va entre dos líneas finas (CSS) que rellenan el ancho restante.
  function fitLogo() {
    if (!measureCtx || els.start.hidden) return;
    const maxWidth = parseFloat(getComputedStyle(els.logo).getPropertyValue('--logo-width')) || 300;
    const width = Math.min(maxWidth, els.logo.parentElement.clientWidth);
    if (!width) return;
    let refSize = 0;
    for (const line of els.logo.querySelectorAll('[data-fit="size"]')) {
      const size = (100 * width) / inkWidth(line.textContent.trim(), getComputedStyle(line), 100);
      line.style.fontSize = `${size}px`;
      refSize = refSize || size;
    }
    for (const line of els.logo.querySelectorAll('[data-fit="rule"]')) {
      line.style.width = `${width}px`;
      line.style.fontSize = `${refSize * 0.46}px`;
    }
  }

  let mosaicCols = 0;
  let mosaicHeight = 0;
  function buildMosaic(animes) {
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const cols = Math.min(8, Math.max(4, Math.round(vw / 120)));
    // Solo se rehace si cambia el número de columnas o la pantalla crece en alto.
    if (cols === mosaicCols && vh <= mosaicHeight) return;

    const top = animes
      .filter((a) => a && (a.thumb || a.image))
      .sort((a, b) => (b.members || 0) - (a.members || 0))
      .slice(0, MOSAIC.fromTop);
    const picks = shuffle(top).slice(0, MOSAIC.count);
    if (!picks.length) return;
    mosaicCols = cols;
    mosaicHeight = vh;

    // Cada columna repite sus portadas hasta cubrir la pantalla; luego se duplica para el bucle.
    const gap = 12;
    const tileHeight = ((vw + 40 - gap * (cols - 1)) / cols) * 1.5 + gap;
    const perSet = Math.max(Math.ceil((vh + 80) / tileHeight) + 1, Math.ceil(picks.length / cols));

    const track = el('div', 'mosaic-track');
    for (let c = 0; c < cols; c++) {
      let own = picks.filter((_, i) => i % cols === c);
      if (!own.length) own = picks;
      const set = Array.from({ length: perSet }, (_, i) => own[i % own.length]);
      const strip = el('div', 'mosaic-strip');
      const duration = 120 + (c % 3) * 25 + Math.random() * 20;
      strip.style.setProperty('--duration', `${duration.toFixed(1)}s`);
      strip.style.animationDelay = `${(-Math.random() * duration).toFixed(1)}s`;
      for (const item of [...set, ...set]) {
        const tile = el('div', 'mosaic-tile');
        tile.style.setProperty('--tile', safeColor(item.color));
        const img = new Image();
        img.alt = '';
        img.loading = 'lazy';
        img.decoding = 'async';
        img.src = item.thumb || item.image;
        tile.append(img);
        strip.append(tile);
      }
      const col = el('div', 'mosaic-col');
      col.append(strip);
      track.append(col);
    }
    els.mosaic.replaceChildren(track);
    requestAnimationFrame(() => els.mosaic.classList.add('is-ready'));
  }

  function makeCard(item, against) {
    const { ds, mode } = state;
    const card = el('article', 'card is-hidden');
    card.style.setProperty('--tint', safeColor(ds.color(item)));

    const poster = el('div', 'poster');
    const url = ds.image(item);
    if (url) {
      const img = new Image();
      img.alt = '';
      img.decoding = 'async';
      img.addEventListener('load', () => img.classList.add('is-loaded'));
      img.addEventListener('error', () => card.classList.add('no-image'));
      img.src = url;
      if (img.complete && img.naturalWidth) img.classList.add('is-loaded');
      poster.append(img);
    } else {
      card.classList.add('no-image');
    }

    const info = el('div', 'info');
    const title = el('h2', 'title', ds.name(item));
    const sub = ds.sub(item);
    const year = el('p', 'year', sub);
    if (!sub) year.hidden = true;

    const slot = el('div', 'slot');

    const valueBlock = el('div', 'value-block');
    valueBlock.append(el('p', 'value', '0'), el('p', 'unit', mode.unit));

    const choice = el('div', 'choice');
    const buttons = el('div', 'buttons');
    for (const [dir, label, icon] of [['more', 'Higher', ICONS.up], ['less', 'Lower', ICONS.down]]) {
      const btn = el('button', 'choice-btn');
      btn.type = 'button';
      btn.dataset.dir = dir;
      btn.innerHTML = icon;
      btn.append(label);
      buttons.append(btn);
    }
    const caption = el('p', 'caption', `${mode.unit} than `);
    if (against) caption.append(el('strong', null, ds.name(against)));
    choice.append(buttons, caption);

    slot.append(valueBlock, choice);
    info.append(title, year, slot);
    card.append(poster, info);
    return card;
  }

  function revealStatic(card, n) {
    card.querySelector('.value').textContent = fmt(n);
    card.classList.remove('is-hidden');
  }

  function countUp(node, target, duration) {
    return new Promise((resolve) => {
      const start = performance.now();
      const ease = (t) => 1 - Math.pow(1 - t, 4);
      const frame = (now) => {
        // El timestamp de rAF puede ser anterior a `start`: se acota a [0, 1].
        const t = Math.min(1, Math.max(0, (now - start) / duration));
        node.textContent = fmt(target * ease(t));
        if (t < 1) requestAnimationFrame(frame);
        else resolve();
      };
      requestAnimationFrame(frame);
    });
  }

  function setVs(result) {
    els.vs.classList.toggle('is-correct', result === 'correct');
    els.vs.classList.toggle('is-wrong', result === 'wrong');
  }

  function updateHud(pop) {
    els.hudMode.textContent = state.mode.daily ? `Daily #${dailyNumber(state.day)}` : state.mode.label;
    els.hudScore.textContent = fmt(state.score);
    els.hudBest.textContent = fmt(state.best);
    if (pop) {
      for (const node of [els.hudScore, state.best === state.score ? els.hudBest : null]) {
        if (!node) continue;
        node.classList.remove('is-pop');
        void node.offsetWidth; // reinicia la animación
        node.classList.add('is-pop');
      }
    }
  }

  let toastTimer = 0;
  function toast(text) {
    els.toast.textContent = text;
    els.toast.classList.add('is-visible');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => els.toast.classList.remove('is-visible'), 2200);
  }

  /* ---------- Flujo de partida ---------- */
  async function startGame(mode) {
    // El diario solo se juega una vez: si ya hay resultado de hoy, se muestra.
    if (mode.daily) {
      const result = getDailyResult(utcDay());
      if (result) {
        showDailyResult(utcDay(), result);
        return;
      }
    }

    const token = ++state.token;
    state.busy = true;

    let data;
    try {
      data = await loadDataset(mode.dataset);
    } catch {
      setStatus('Couldn’t load the data. Check your connection and try again.');
      return;
    }
    if (token !== state.token) return;

    const ds = DATASETS[mode.dataset];
    const rank = (it) => (Number.isFinite(it[ds.rankKey]) ? it[ds.rankKey] : 0);
    const pool = data.filter((it) => it && Number.isFinite(it[mode.key]));
    Object.assign(state, {
      mode,
      ds,
      ranked: pool.sort((a, b) => rank(b) - rank(a)),
      used: new Set(),
      rng: mode.daily ? mulberry32(dailySeed(utcDay())) : Math.random,
      day: mode.daily ? utcDay() : null,
      rounds: [],
      score: 0,
      best: getBest(mode),
      startBest: getBest(mode),
    });

    state.left = draw(null);
    state.right = state.left && draw(value(state.left));
    if (!state.right) {
      setStatus('Not enough data for this mode.');
      return;
    }
    state.next = draw(value(state.right));

    // Espera (con límite) a las dos primeras portadas para que aparezcan ya cargadas.
    await Promise.race([
      Promise.all([preload(ds.image(state.left)), preload(ds.image(state.right))]),
      sleep(TIMING.firstImages),
    ]);
    if (token !== state.token) return;
    if (state.next) preload(ds.image(state.next));

    els.stage.querySelectorAll('.card').forEach((node) => node.remove());
    state.leftEl = makeCard(state.left, null);
    state.leftEl.classList.add('slot-0');
    revealStatic(state.leftEl, value(state.left));
    state.rightEl = makeCard(state.right, state.left);
    state.rightEl.classList.add('slot-1');
    els.stage.append(state.leftEl, state.rightEl);

    setVs(null);
    updateHud(false);
    setStatus('');
    els.gameover.hidden = true;
    showScreen('game');
    state.busy = false;
    // El intento cuenta desde que empieza: salir o recargar no permite repetir.
    persistDaily(false);
    track('game_start', { mode: mode.id });
  }

  function persistDaily(finished, detail = '') {
    if (!state.mode.daily) return;
    saveDailyResult(state.day, { score: state.score, rounds: state.rounds.slice(), finished, detail });
  }

  async function answer(dir) {
    if (state.busy || !state.rightEl) return;
    state.busy = true;
    const token = state.token;

    const lv = value(state.left);
    const rv = value(state.right);
    const correct = dir === 'more' ? rv > lv : rv < lv;
    const card = state.rightEl;

    card.querySelector(`.choice-btn[data-dir="${dir}"]`).classList.add('is-picked');
    card.classList.remove('is-hidden');
    await countUp(card.querySelector('.value'), rv, reducedMotion.matches ? 250 : TIMING.count);
    if (token !== state.token) return;

    state.rounds.push(correct);
    card.classList.add(correct ? 'is-correct' : 'is-wrong');
    setVs(correct ? 'correct' : 'wrong');
    els.announcer.textContent = `${state.ds.name(state.right)} has ${fmt(rv)} ${state.mode.unit}. ${correct ? 'Correct!' : 'Wrong.'}`;

    if (!correct) {
      persistDaily(true);
      await sleep(TIMING.gameOver);
      if (token === state.token) showGameOver(false);
      return;
    }

    state.score++;
    if (state.score > state.best) {
      state.best = state.score;
      store.set(bestKey(state.mode), state.best);
    }
    persistDaily(false);
    updateHud(true);

    await sleep(TIMING.verdict);
    if (token !== state.token) return;
    await advance(token);
  }

  // El de la derecha pasa a la izquierda y entra uno nuevo por la derecha.
  async function advance(token) {
    const incomingItem = state.next;
    if (!incomingItem) {
      showGameOver(true);
      return;
    }

    const oldLeft = state.leftEl;
    const newLeft = state.rightEl;
    const incoming = makeCard(incomingItem, state.right);
    incoming.classList.add('slot-2');
    els.stage.append(incoming);
    void incoming.offsetWidth; // fija la posición inicial antes de animar

    oldLeft.classList.replace('slot-0', 'slot-out');
    newLeft.classList.replace('slot-1', 'slot-0');
    newLeft.classList.remove('is-correct');
    incoming.classList.replace('slot-2', 'slot-1');
    setVs(null);

    state.left = state.right;
    state.right = incomingItem;
    state.leftEl = newLeft;
    state.rightEl = incoming;
    state.next = draw(value(state.right));
    if (state.next) preload(state.ds.image(state.next));

    await sleep(reducedMotion.matches ? 150 : TIMING.slide);
    oldLeft.remove();
    if (token === state.token) state.busy = false;
  }

  function missDetail() {
    const { mode } = state;
    const rv = value(state.right);
    const lv = value(state.left);
    return (
      `${state.ds.name(state.right)} has ${fmt(rv)} ${rv === 1 ? mode.unitOne : mode.unit}, ` +
      `${rv > lv ? 'more' : 'fewer'} than ${state.ds.name(state.left)}.`
    );
  }

  // Ajusta la hoja de fin de partida al modo normal o al diario.
  function setSheetVariant(daily) {
    els.btnAgain.hidden = daily;
    els.btnShare.classList.toggle('btn-primary', daily);
    els.btnShare.classList.toggle('btn-secondary', !daily);
    els.btnModes.textContent = daily ? 'Back to menu' : 'Change mode';
    els.goEmoji.hidden = !daily;
  }

  function showGameOver(completed) {
    const { mode, score } = state;

    track('game_over', { mode: mode.id, score });

    if (mode.daily) {
      const detail = completed ? '' : missDetail();
      persistDaily(true, detail);
      showDailyResult(state.day, { score, rounds: state.rounds.slice(), finished: true, detail });
      return;
    }

    const isRecord = score > 0 && score > state.startBest;
    setSheetVariant(false);
    els.goTitle.textContent = completed ? 'You got them all!' : 'Game over';
    els.goScore.textContent = fmt(score);
    els.goLabel.textContent = 'in a row';
    els.goBest.textContent = isRecord ? 'New best!' : `Best in ${mode.label}: ${fmt(state.best)}`;
    els.goBest.classList.toggle('is-record', isRecord);
    els.goDetail.textContent = completed ? '' : missDetail();
    state.shareData = { daily: false, score, mode };

    els.gameover.hidden = false;
    els.btnAgain.focus({ preventScroll: true });
  }

  function showDailyResult(day, result) {
    setSheetVariant(true);
    els.goTitle.textContent = `Daily #${dailyNumber(day)}`;
    els.goScore.textContent = fmt(result.score);
    els.goLabel.textContent = 'in a row';
    els.goEmoji.textContent = emojiRows(result.rounds);
    els.goBest.replaceChildren('Next daily in ', countdownNode());
    els.goBest.classList.remove('is-record');
    els.goDetail.textContent = result.detail || '';
    state.shareData = { daily: true, day, result };

    els.gameover.hidden = false;
    els.btnShare.focus({ preventScroll: true });
  }

  function goMenu() {
    state.token++;
    state.busy = false;
    els.gameover.hidden = true;
    renderModes();
    showScreen('start');
  }

  /* ---------- Compartir ---------- */
  async function copyText(text) {
    try {
      if (navigator.clipboard && window.isSecureContext) {
        await navigator.clipboard.writeText(text);
        return true;
      }
    } catch {
      /* probamos el método antiguo */
    }
    try {
      const ta = el('textarea');
      ta.value = text;
      ta.setAttribute('readonly', '');
      ta.style.cssText = 'position:fixed;top:0;left:0;opacity:0;';
      document.body.append(ta);
      ta.select();
      const ok = document.execCommand('copy');
      ta.remove();
      return ok;
    } catch {
      return false;
    }
  }

  async function share() {
    const data = state.shareData;
    if (!data) return;
    const url = SITE_URL;
    track('share_click', { mode: data.daily ? DAILY_MODE.id : data.mode.id });

    let payload;
    let fullText;
    if (data.daily) {
      // El enlace va dentro del texto para que se conserve al pegarlo en cualquier sitio.
      fullText =
        `${SHARE_TITLE} — Daily #${dailyNumber(data.day)}\n` +
        `🔥 Streak: ${data.result.score}\n` +
        `${emojiRows(data.result.rounds)}\n` +
        url;
      payload = { title: SHARE_TITLE, text: fullText };
    } else {
      const text =
        `🔥 I got a streak of ${data.score} in ${SHARE_TITLE} ` +
        `(${data.mode.label} mode). Can you beat me?`;
      fullText = `${text}\n${url}`;
      payload = { title: SHARE_TITLE, text, url };
    }

    if (navigator.share) {
      try {
        await navigator.share(payload);
        return;
      } catch (err) {
        if (err && err.name === 'AbortError') return;
      }
    }
    toast((await copyText(fullText)) ? 'Result copied' : 'Couldn’t copy');
  }

  /* ---------- Eventos ---------- */
  els.stage.addEventListener('click', (e) => {
    const btn = e.target.closest('.choice-btn');
    if (btn && state.rightEl && state.rightEl.contains(btn)) answer(btn.dataset.dir);
  });

  $('btn-menu').addEventListener('click', goMenu);
  els.btnAgain.addEventListener('click', () => startGame(state.mode));
  els.btnModes.addEventListener('click', goMenu);
  els.btnShare.addEventListener('click', share);

  document.addEventListener('keydown', (e) => {
    if (e.altKey || e.ctrlKey || e.metaKey) return;
    if (!els.gameover.hidden) {
      if (e.key === 'Escape') goMenu();
      return;
    }
    if (els.game.hidden) return;
    if (e.key === 'ArrowUp') {
      e.preventDefault();
      answer('more');
    } else if (e.key === 'ArrowDown') {
      e.preventDefault();
      answer('less');
    } else if (e.key === 'Escape') {
      goMenu();
    }
  });

  // Cuenta atrás del diario y cambio de día (UTC) sin recargar.
  let shownDay = utcDay();
  setInterval(() => {
    const text = countdown();
    document.querySelectorAll('.js-countdown').forEach((node) => {
      node.textContent = text;
    });
    if (utcDay() !== shownDay) {
      shownDay = utcDay();
      if (!els.start.hidden && els.gameover.hidden) renderModes();
    }
  }, 1000);

  let resizeTimer = 0;
  window.addEventListener('resize', () => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => {
      fitLogo();
      loadDataset('anime').then(buildMosaic, () => {});
    }, 200);
  });

  /* ---------- Inicio ---------- */
  renderModes();
  fitLogo();
  if (document.fonts && document.fonts.ready) document.fonts.ready.then(fitLogo);
  // Carga anticipada para que la partida empiece al instante.
  for (const id of new Set([DAILY_MODE, ...MODES].map((m) => m.dataset))) {
    loadDataset(id).catch(() =>
      setStatus('Couldn’t load the data. If you opened the file directly, use a local server.')
    );
  }
  loadDataset('anime').then(buildMosaic, () => {});
})();
