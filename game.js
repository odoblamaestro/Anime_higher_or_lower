(() => {
  'use strict';

  /* ---------- Datasets, modos y categorías ----------
   * Un dataset sabe cómo leer cada elemento (nombre, subtítulo, imagen, color),
   * qué campo indica su popularidad (rankKey) y su curva de dificultad: el pool
   * (los más populares del dataset) crece con la racha, a escala de su tamaño.
   * Un modo elige un dataset y el campo numérico que se compara; `label` es su
   * nombre completo (marcador, compartir) y `name` el corto dentro de su categoría.
   */
  const ANIME_FIELDS = {
    name: (it) => it.title || it.romaji || 'Untitled',
    sub: (it) => (it.year ? String(it.year) : ''),
    image: (it) => it.image,
    color: (it) => it.color,
    rankKey: 'members',
  };

  const DATASETS = {
    anime: {
      ...ANIME_FIELDS,
      url: 'data/anime.json', // top 1000
      difficulty: [
        { fromStreak: 0, poolSize: 150 },
        { fromStreak: 10, poolSize: 400 },
        { fromStreak: 25, poolSize: Infinity },
      ],
    },
    romance: {
      ...ANIME_FIELDS,
      url: 'data/romance.json', // top 400
      difficulty: [
        { fromStreak: 0, poolSize: 60 },
        { fromStreak: 10, poolSize: 150 },
        { fromStreak: 25, poolSize: Infinity },
      ],
    },
    characters: {
      url: 'data/characters.json', // top 1000
      name: (it) => it.name || 'Unknown',
      sub: (it) => it.anime || '',
      image: (it) => it.image,
      color: () => null,
      rankKey: 'favourites',
      difficulty: [
        { fromStreak: 0, poolSize: 150 },
        { fromStreak: 10, poolSize: 400 },
        { fromStreak: 25, poolSize: Infinity },
      ],
    },
    // Hair Color: solo se usa la carga (loadDataset). Lo genera scripts/build_hair_colors.py.
    hair: { url: 'data/hair.json' },
  };

  const MEMBERS = { key: 'members', name: 'Members', unit: 'members', unitOne: 'member', icon: 'people' };
  const FAVORITES = { key: 'favourites', name: 'Favorites', unit: 'favorites', unitOne: 'favorite', icon: 'heart' };

  const MODES = [
    {
      ...MEMBERS,
      id: 'anime-members',
      category: 'anime',
      dataset: 'anime',
      label: 'Anime · Members',
      description: 'Which one is on more people’s lists?',
    },
    {
      ...FAVORITES,
      id: 'anime-favourites',
      category: 'anime',
      dataset: 'anime',
      label: 'Anime · Favorites',
      description: 'Which one has been favorited more?',
    },
    {
      ...MEMBERS,
      id: 'romance-members',
      category: 'romance',
      dataset: 'romance',
      label: 'Romance · Members',
      description: 'Which love story is on more lists?',
    },
    {
      ...FAVORITES,
      id: 'romance-favourites',
      category: 'romance',
      dataset: 'romance',
      label: 'Romance · Favorites',
      description: 'Which love story has more favorites?',
    },
    {
      ...FAVORITES,
      id: 'characters-favourites',
      category: 'characters',
      dataset: 'characters',
      label: 'Character favorites',
      description: 'Which character has more fans?',
      icon: 'star',
    },
  ];

  // Botón principal "Play" de la portada: el modo más fácil de entender, sin pasos intermedios.
  const PLAY_MODE = MODES.find((mode) => mode.id === 'anime-members');

  // Tarjetas de la portada (el diario va aparte, encima). Una categoría con un solo
  // modo se juega directamente; con varios, al tocarla muestra sus modos.
  // `hidden`: no sale en la portada (el código del modo se conserva).
  const CATEGORIES = [
    { id: 'anime', label: 'Anime', description: 'The 1,000 most popular anime.', icon: 'tv' },
    { id: 'romance', label: 'Romance', description: 'The 400 most popular romance anime.', icon: 'heart' },
    { id: 'characters', label: 'Characters', description: 'Which character has more fans?', icon: 'star' },
    // Oculta mientras se rehace con datos anotados a mano (scripts/color/).
    { id: 'hair', label: 'Hair Color', description: 'Paint a character’s hair. New one daily.', icon: 'palette', hidden: true },
  ];

  // Modos de Hair Color: otro juego (sección "Hair Color" más abajo), no Higher or Lower.
  // `menu()` da la descripción y el dato lateral de su botón en la portada.
  const HAIR_MODES = [
    {
      id: 'hair-daily',
      game: 'hair',
      category: 'hair',
      daily: true,
      name: 'Daily',
      label: 'Hair Color',
      description: 'Same character for everyone. One try a day.',
      icon: 'calendar',
      menu: () => hairDailyMenu(),
    },
    {
      id: 'hair-practice',
      game: 'hair',
      category: 'hair',
      daily: false,
      name: 'Practice',
      label: 'Hair Color · Practice',
      description: 'Unlimited random characters.',
      icon: 'shuffle',
      menu: () => hairPracticeMenu(),
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

  const SVG_ATTRS = 'viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"';
  const ICONS = {
    people: `<svg ${SVG_ATTRS} width="22" height="22" stroke-width="2"><path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M22 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/></svg>`,
    heart: `<svg ${SVG_ATTRS} width="22" height="22" stroke-width="2"><path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z"/></svg>`,
    calendar: `<svg ${SVG_ATTRS} width="22" height="22" stroke-width="2"><rect x="3" y="4" width="18" height="18" rx="3"/><path d="M16 2v4M8 2v4M3 10h18"/></svg>`,
    star: `<svg ${SVG_ATTRS} width="22" height="22" stroke-width="2"><path d="M12 2l3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01L12 2z"/></svg>`,
    tv: `<svg ${SVG_ATTRS} width="22" height="22" stroke-width="2"><rect x="2" y="7" width="20" height="14" rx="3"/><path d="M17 2l-5 5-5-5"/></svg>`,
    palette: `<svg ${SVG_ATTRS} width="22" height="22" stroke-width="2"><circle cx="13.5" cy="6.5" r="1.3"/><circle cx="17.5" cy="10.5" r="1.3"/><circle cx="8.5" cy="7.5" r="1.3"/><circle cx="6.5" cy="12.5" r="1.3"/><path d="M12 2C6.5 2 2 6.5 2 12s4.5 10 10 10c.93 0 1.65-.75 1.65-1.69 0-.44-.18-.84-.44-1.13-.29-.29-.44-.65-.44-1.13a1.64 1.64 0 0 1 1.67-1.67h2c3.05 0 5.56-2.5 5.56-5.55C21.97 6.01 17.46 2 12 2z"/></svg>`,
    shuffle: `<svg ${SVG_ATTRS} width="22" height="22" stroke-width="2"><path d="M16 3h5v5M4 20L21 3M21 16v5h-5M15 15l6 6M4 4l5 5"/></svg>`,
    forward: `<svg ${SVG_ATTRS} width="20" height="20" stroke-width="2.2"><path d="M9 18l6-6-6-6"/></svg>`,
    back: `<svg ${SVG_ATTRS} width="22" height="22" stroke-width="2.2"><path d="M15 18l-6-6 6-6"/></svg>`,
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
    const tiers = state.ds.difficulty;
    let size = tiers[0].poolSize;
    for (const tier of tiers) if (streak >= tier.fromStreak) size = tier.poolSize;
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
    hair: $('screen-hair'),
    modeList: $('mode-list'),
    btnPlay: $('btn-play'),
    playBest: $('play-best'),
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
    els.hair.hidden = name !== 'hair';
    document.body.classList.toggle('is-playing', name !== 'start');
    if (name === 'start') fitLogo();
  }

  function setStatus(text) {
    els.status.textContent = text;
  }

  /* ---------- Menú: categorías y modos ---------- */
  let openCategory = null; // id de la categoría desplegada en la portada, o null

  const modesOf = (category) => [...MODES, ...HAIR_MODES].filter((mode) => mode.category === category.id);

  function sideStat(label, value) {
    const side = el('span', 'mode-best');
    const valueNode = el('span', 'mode-best-value');
    valueNode.append(value);
    side.append(el('span', 'mode-best-label', label), valueNode);
    return side;
  }

  const bestStat = (mode) => sideStat('Best', fmt(getBest(mode)));

  function menuButton({ icon, title, description, side, onClick }) {
    const btn = el('button', 'mode-btn');
    btn.type = 'button';
    const iconNode = el('span', 'mode-icon');
    iconNode.setAttribute('aria-hidden', 'true');
    iconNode.innerHTML = ICONS[icon] || '';
    const text = el('span', 'mode-text');
    text.append(el('span', 'mode-title', title), el('span', 'mode-desc', description));
    btn.append(iconNode, text, side);
    btn.addEventListener('click', onClick);
    return btn;
  }

  function dailyButton() {
    const day = utcDay();
    const result = getDailyResult(day);
    const btn = menuButton({
      icon: DAILY_MODE.icon,
      title: DAILY_MODE.label,
      description: result ? `Today’s streak: ${fmt(result.score)}. See you tomorrow!` : DAILY_MODE.description,
      side: result ? sideStat('Next in', countdownNode()) : sideStat('Day', `#${dailyNumber(day)}`),
      onClick: () => startGame(DAILY_MODE),
    });
    btn.classList.add('mode-btn-daily');
    if (result) btn.querySelector('.mode-best-value').classList.add('is-small');
    return btn;
  }

  function categoryButton(category) {
    const modes = modesOf(category);
    const single = modes.length === 1;
    const chevron = el('span', 'mode-chevron');
    chevron.setAttribute('aria-hidden', 'true');
    chevron.innerHTML = ICONS.forward;
    const btn = menuButton({
      icon: category.icon,
      title: category.label,
      description: category.description,
      side: single ? bestStat(modes[0]) : chevron,
      onClick: () => (single ? startGame(modes[0]) : openMenu(category.id)),
    });
    btn.dataset.category = category.id;
    return btn;
  }

  function categoryView(category) {
    const head = el('div', 'modes-head');
    const back = el('button', 'icon-btn');
    back.type = 'button';
    back.setAttribute('aria-label', 'Back to categories');
    back.innerHTML = ICONS.back;
    back.addEventListener('click', () => openMenu(null));
    head.append(back, el('h2', 'modes-head-title', category.label));
    const buttons = modesOf(category).map((mode) => {
      const { description, side } = mode.menu ? mode.menu() : { description: mode.description, side: bestStat(mode) };
      return menuButton({ icon: mode.icon, title: mode.name, description, side, onClick: () => startGame(mode) });
    });
    return [head, ...buttons];
  }

  // Las dos vistas (categorías y modos de una categoría) ocupan la misma celda de la
  // rejilla: la lista mide siempre lo que la más alta y el título no salta al cambiar.
  function renderModes() {
    const best = getBest(PLAY_MODE);
    els.playBest.hidden = !best;
    els.playBest.textContent = best ? `Best ${fmt(best)}` : '';
    const category = CATEGORIES.find((c) => c.id === openCategory);
    const home = el('div', 'modes-view');
    home.append(dailyButton(), ...CATEGORIES.filter((c) => !c.hidden).map(categoryButton));
    const detail = el('div', 'modes-view');
    if (category) detail.append(...categoryView(category));
    (category ? detail : home).classList.add('is-active');
    els.modeList.replaceChildren(home, detail);
  }

  function openMenu(categoryId) {
    const previous = openCategory;
    openCategory = categoryId;
    renderModes();
    const view = els.modeList.querySelector('.modes-view.is-active');
    view.classList.add('is-entering');
    // Lleva el foco a lo que acaba de aparecer (o a la categoría de la que se vuelve).
    const target = categoryId
      ? view.querySelector('.mode-btn')
      : view.querySelector(`[data-category="${previous}"]`);
    if (target) target.focus({ preventScroll: true });
  }

  els.btnPlay.addEventListener('click', () => {
    track('play_click', { mode: PLAY_MODE.id });
    startGame(PLAY_MODE);
  });

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
    if (mode.game === 'hair') {
      startHair(mode);
      return;
    }
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
    hair.token++;
    state.busy = false;
    els.gameover.hidden = true;
    renderModes();
    showScreen('start');
  }

  /* ---------- Hair Color ----------
   * Se muestra un personaje con el pelo desaturado y el jugador lo pinta con tres sliders
   * (tono, saturación y claridad). El recoloreado usa la máscara de data/hair.json (ver
   * scripts/build_hair_colors.py) y conserva el sombreado de cada píxel: su claridad se
   * desplaza en bloque hasta la elegida y solo se sustituye el color.
   * Puntuación según la distancia CIEDE2000 entre el color elegido y el real.
   */
  const HAIR_FIRST_DAY = Math.floor(Date.UTC(2026, 9, 11) / DAY_MS); // Hair Color #1
  const HAIR_SCORE = { maxDelta: 50, curve: 1.6 }; // ΔE 0 → 100 %, ΔE ≥ 50 → 0 %
  const HAIR_REVEAL = { color: 900, original: 450 }; // ms: hacia el color real y fundido a la imagen
  const HAIR_DEFAULT = { h: 40, s: 50, l: 50 };
  const HAIR_PRACTICE_KEY = 'hol:hair:practice';

  /* Color: sRGB ↔ CIELAB (D65), LCh y CIEDE2000 */
  const toLinear = (c) => (c > 0.04045 ? ((c + 0.055) / 1.055) ** 2.4 : c / 12.92);
  const toGamma = (c) => (c > 0.0031308 ? 1.055 * c ** (1 / 2.4) - 0.055 : 12.92 * c);
  const labF = (t) => (t > 216 / 24389 ? Math.cbrt(t) : ((24389 / 27) * t + 16) / 116);
  const labFInv = (t) => (t * t * t > 216 / 24389 ? t * t * t : (116 * t - 16) / (24389 / 27));

  function rgbToLab(r, g, b) {
    r = toLinear(r / 255);
    g = toLinear(g / 255);
    b = toLinear(b / 255);
    const fx = labF((0.4124564 * r + 0.3575761 * g + 0.1804375 * b) / 0.95047);
    const fy = labF(0.2126729 * r + 0.7151522 * g + 0.072175 * b);
    const fz = labF((0.0193339 * r + 0.119192 * g + 0.9503041 * b) / 1.08883);
    return [116 * fy - 16, 500 * (fx - fy), 200 * (fy - fz)];
  }

  // CIELAB a sRGB lineal sin recortar: fuera de [0, 1] significa fuera de la gama.
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

  // Croma máxima representable en sRGB para una claridad y un tono (búsqueda binaria).
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

  function ciede2000([L1, a1, b1], [L2, a2, b2]) {
    const rad = Math.PI / 180;
    const pow7 = (x) => x ** 7;
    const Cm = (Math.hypot(a1, b1) + Math.hypot(a2, b2)) / 2;
    const G = 0.5 * (1 - Math.sqrt(pow7(Cm) / (pow7(Cm) + pow7(25))));
    const a1p = a1 * (1 + G);
    const a2p = a2 * (1 + G);
    const C1p = Math.hypot(a1p, b1);
    const C2p = Math.hypot(a2p, b2);
    const hue = (a, b) => (a === 0 && b === 0 ? 0 : ((Math.atan2(b, a) / rad) + 360) % 360);
    const h1p = hue(a1p, b1);
    const h2p = hue(a2p, b2);
    const chromatic = C1p * C2p !== 0;

    let dhp = 0;
    if (chromatic) {
      dhp = h2p - h1p;
      if (dhp > 180) dhp -= 360;
      else if (dhp < -180) dhp += 360;
    }
    const dLp = L2 - L1;
    const dCp = C2p - C1p;
    const dHp = 2 * Math.sqrt(C1p * C2p) * Math.sin((dhp / 2) * rad);

    const Lpm = (L1 + L2) / 2;
    const Cpm = (C1p + C2p) / 2;
    let hpm = h1p + h2p;
    if (chromatic) {
      if (Math.abs(h1p - h2p) > 180) hpm += hpm < 360 ? 360 : -360;
      hpm /= 2;
    }
    const T =
      1 -
      0.17 * Math.cos((hpm - 30) * rad) +
      0.24 * Math.cos(2 * hpm * rad) +
      0.32 * Math.cos((3 * hpm + 6) * rad) -
      0.2 * Math.cos((4 * hpm - 63) * rad);
    const dTheta = 30 * Math.exp(-(((hpm - 275) / 25) ** 2));
    const Rc = 2 * Math.sqrt(pow7(Cpm) / (pow7(Cpm) + pow7(25)));
    const Sl = 1 + (0.015 * (Lpm - 50) ** 2) / Math.sqrt(20 + (Lpm - 50) ** 2);
    const Sc = 1 + 0.045 * Cpm;
    const Sh = 1 + 0.015 * Cpm * T;
    const Rt = -Math.sin(2 * dTheta * rad) * Rc;
    return Math.sqrt((dLp / Sl) ** 2 + (dCp / Sc) ** 2 + (dHp / Sh) ** 2 + Rt * (dCp / Sc) * (dHp / Sh));
  }

  /* Un color del juego es { L, C, h, s }: claridad, croma, tono (grados) y saturación,
   * que es la croma como fracción de la máxima posible para esa claridad y ese tono. */
  function pickColor({ h, s, l }) {
    return { L: l, h, s: s / 100, C: (s / 100) * maxChroma(l, h) };
  }

  function colorFromLab([L, a, b]) {
    const C = Math.hypot(a, b);
    const h = ((Math.atan2(b, a) * 180) / Math.PI + 360) % 360;
    const max = maxChroma(L, h);
    return { L, C, h, s: max ? Math.min(1, C / max) : 0 };
  }

  const colorLab = (c) => lchToLab(c.L, c.C, c.h);

  function mixColor(a, b, t) {
    // Un gris no tiene tono: se usa el del otro color para no dar vueltas por el arcoíris.
    const ha = a.C < 1 ? b.h : a.h;
    const hb = b.C < 1 ? ha : b.h;
    const dh = ((hb - ha + 540) % 360) - 180; // por el arco más corto
    const lerp = (x, y) => x + (y - x) * t;
    return { L: lerp(a.L, b.L), C: lerp(a.C, b.C), s: lerp(a.s, b.s), h: (ha + dh * t + 360) % 360 };
  }

  const hairScore = (delta) =>
    Math.round(100 * Math.max(0, 1 - delta / HAIR_SCORE.maxDelta) ** HAIR_SCORE.curve);

  // Barra de 10 casillas para compartir; el color de las llenas depende de la nota.
  function hairBar(score) {
    const filled = Math.round(score / 10);
    const square = score >= 80 ? '🟩' : score >= 50 ? '🟨' : '🟧';
    return square.repeat(filled) + '⬜'.repeat(10 - filled);
  }

  /* Diario, práctica y almacenamiento */
  const hairNumber = (day) => day - HAIR_FIRST_DAY + 1;
  const hairKey = (day) => `hol:hair:${day}`;

  function readStored(key) {
    try {
      return JSON.parse(store.get(key));
    } catch {
      return null;
    }
  }

  function getHairResult(day) {
    const result = readStored(hairKey(day));
    return result && Number.isFinite(result.score) && Array.isArray(result.guess) ? result : null;
  }

  function getHairPractice() {
    const stats = readStored(HAIR_PRACTICE_KEY);
    return stats && stats.n > 0 ? stats : { n: 0, total: 0, best: 0 };
  }

  function hairDailyMenu() {
    const day = utcDay();
    const result = getHairResult(day);
    if (!result) return { description: HAIR_MODES[0].description, side: sideStat('Day', `#${hairNumber(day)}`) };
    const side = sideStat('Next in', countdownNode());
    side.querySelector('.mode-best-value').classList.add('is-small');
    return { description: `Today: ${result.score}%. See you tomorrow!`, side };
  }

  function hairPracticeMenu() {
    const { n, total } = getHairPractice();
    return { description: HAIR_MODES[1].description, side: sideStat('Avg', n ? `${Math.round(total / n)}%` : '–') };
  }

  // data/hair.json ya trae solo los aprobados en la revisión. Se ordenan por id para que el
  // personaje del día no dependa del orden del archivo.
  const hairPool = (data) =>
    data.filter((e) => e && e.mask && Array.isArray(e.lab)).sort((a, b) => a.id - b.id);

  // Personaje del día: recorre una permutación fija de la lista según la fecha UTC, así es el
  // mismo para todo el mundo y no se repite ninguno hasta que han salido todos.
  function hairOfDay(pool, day) {
    const order = pool.slice();
    const rng = mulberry32(hashString('hol-hair-order'));
    for (let i = order.length - 1; i > 0; i--) {
      const j = Math.floor(rng() * (i + 1));
      [order[i], order[j]] = [order[j], order[i]];
    }
    const n = order.length;
    return order[(((day - HAIR_FIRST_DAY) % n) + n) % n];
  }

  // Práctica: al azar, sin repetir hasta agotar la lista y nunca el personaje del diario de hoy.
  function hairPracticePick(pool, day) {
    const daily = hairOfDay(pool, day);
    const fits = (e) => e !== daily && e !== hair.entry;
    let options = pool.filter((e) => fits(e) && !hair.seen.has(e.id));
    if (!options.length) {
      hair.seen.clear();
      options = pool.filter(fits);
    }
    if (!options.length) options = pool;
    const entry = options[Math.floor(Math.random() * options.length)];
    hair.seen.add(entry.id);
    return entry;
  }

  /* Estado y DOM */
  const hair = {
    token: 0, // se incrementa al empezar/salir para cancelar cargas y animaciones pendientes
    mode: null,
    entry: null,
    day: null,
    px: null, // píxeles de la imagen y de la máscara (loadHairPixels)
    pick: { ...HAIR_DEFAULT },
    touched: false, // hasta mover un slider el pelo se ve gris y no se puede confirmar
    done: false,
    seen: new Set(), // ids ya mostrados en práctica
    frame: 0,
  };

  const hairEls = {
    title: $('hair-title'),
    name: $('hair-name'),
    anime: $('hair-anime'),
    figure: document.querySelector('.hair-figure'),
    canvas: $('hair-canvas'),
    hint: $('hair-hint'),
    controls: $('hair-controls'),
    hue: $('hair-hue'),
    sat: $('hair-sat'),
    light: $('hair-light'),
    confirm: $('hair-confirm'),
    result: $('hair-result'),
    score: $('hair-score'),
    swGuess: $('hair-sw-guess'),
    swReal: $('hair-sw-real'),
    detail: $('hair-detail'),
    next: $('hair-next'),
    share: $('hair-share'),
    announcer: $('hair-announcer'),
  };
  const hairSliders = [hairEls.hue, hairEls.sat, hairEls.light];
  const hairCtx = hairEls.canvas.getContext('2d');

  /* Imagen y máscara */
  function loadCorsImage(url) {
    return new Promise((resolve, reject) => {
      const img = new Image();
      img.crossOrigin = 'anonymous';
      img.decoding = 'async';
      img.onload = () => resolve(img);
      img.onerror = () => reject(new Error(`Image failed: ${url}`));
      img.src = url;
    });
  }

  // Lee los píxeles de una imagen (opcionalmente escalada a w x h). Si el navegador reutiliza
  // una copia en caché pedida sin CORS (p. ej. la del modo Characters), el canvas queda
  // bloqueado y getImageData falla: se repite con otra URL para forzar una petición nueva.
  async function readPixels(url, w, h) {
    for (const src of [url, `${url}${url.includes('?') ? '&' : '?'}cors`]) {
      try {
        const img = await loadCorsImage(src);
        const canvas = document.createElement('canvas');
        canvas.width = w || img.naturalWidth;
        canvas.height = h || img.naturalHeight;
        const ctx = canvas.getContext('2d', { willReadFrequently: true });
        ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
        return ctx.getImageData(0, 0, canvas.width, canvas.height);
      } catch {
        /* siguiente intento */
      }
    }
    throw new Error(`Couldn’t read ${url}`);
  }

  async function loadHairPixels(entry) {
    const image = await readPixels(entry.image);
    const { width: w, height: h, data } = image;
    const maskData = (await readPixels(entry.mask, w, h)).data;
    const mask = new Float32Array(w * h);
    const lbin = new Uint8Array(w * h); // claridad original redondeada (0-100), índice de la tabla
    const idx = []; // píxeles con pelo: el recoloreado solo recorre estos
    for (let i = 0; i < w * h; i++) {
      const m = maskData[i * 4] / 255;
      if (m < 0.02) continue;
      mask[i] = m;
      lbin[i] = Math.round(rgbToLab(data[i * 4], data[i * 4 + 1], data[i * 4 + 2])[0]);
      idx.push(i);
    }
    return { w, h, image, mask, lbin, idx: Uint32Array.from(idx), out: new ImageData(new Uint8ClampedArray(data), w, h) };
  }

  /* Recoloreado */
  // Color de salida para cada claridad original del pelo (0-100). La claridad se desplaza
  // para que la del pelo pase a la elegida, conservando luces y sombras, y la croma se limita
  // a la gama disponible en cada claridad, así brillos y sombras se apagan con naturalidad.
  function hairLut(color) {
    const shift = color.L - hair.entry.lab[0];
    const lut = new Uint8ClampedArray(101 * 3);
    for (let L0 = 0; L0 <= 100; L0++) {
      const L = Math.min(100, Math.max(0, L0 + shift));
      const C = Math.min(color.C, color.s * maxChroma(L, color.h));
      lut.set(labToRgb(...lchToLab(L, C, color.h)), L0 * 3);
    }
    return lut;
  }

  let grayLut = null; // pelo desaturado: misma claridad, sin color
  function hairGrayLut() {
    if (!grayLut) {
      grayLut = new Uint8ClampedArray(101 * 3);
      for (let L = 0; L <= 100; L++) grayLut.set(labToRgb(L, 0, 0), L * 3);
    }
    return grayLut;
  }

  // amount: peso del pelo recoloreado frente a la imagen original (1 = solo recoloreado).
  function paintHair(lut, amount = 1) {
    const { image, mask, lbin, idx, out } = hair.px;
    const src = image.data;
    const dst = out.data;
    for (let k = 0; k < idx.length; k++) {
      const i = idx[k];
      const p = i * 4;
      const q = lbin[i] * 3;
      const m = mask[i] * amount;
      dst[p] = src[p] + (lut[q] - src[p]) * m;
      dst[p + 1] = src[p + 1] + (lut[q + 1] - src[p + 1]) * m;
      dst[p + 2] = src[p + 2] + (lut[q + 2] - src[p + 2]) * m;
    }
    hairCtx.putImageData(out, 0, 0);
  }

  // El canvas ocupa el mayor tamaño que cabe en su hueco sin deformar la imagen.
  function fitHairCanvas() {
    if (!hair.px || els.hair.hidden) return;
    const { width, height } = hairEls.figure.getBoundingClientRect();
    const scale = Math.min(width / hair.px.w, height / hair.px.h);
    hairEls.canvas.style.width = `${Math.floor(hair.px.w * scale)}px`;
    hairEls.canvas.style.height = `${Math.floor(hair.px.h * scale)}px`;
  }

  /* Sliders */
  const lchHex = (L, C, h) => rgbHex(labToRgb(...lchToLab(L, C, h)));

  // El tono se pinta con un arcoíris fijo; saturación y claridad, con el color actual.
  hairEls.hue.style.setProperty(
    '--track',
    `linear-gradient(90deg, ${Array.from({ length: 13 }, (_, i) => lchHex(68, 0.8 * maxChroma(68, i * 30), i * 30)).join(', ')})`
  );

  function updateHairSliders() {
    const { h, s, l } = hair.pick;
    const sat = [0, 0.5, 1].map((t) => lchHex(l, t * maxChroma(l, h), h));
    const light = [0, 20, 40, 60, 80, 100].map((L) => lchHex(L, (s / 100) * maxChroma(L, h), h));
    hairEls.sat.style.setProperty('--track', `linear-gradient(90deg, ${sat.join(', ')})`);
    hairEls.light.style.setProperty('--track', `linear-gradient(90deg, ${light.join(', ')})`);
    hairEls.controls.style.setProperty('--thumb', rgbHex(labToRgb(...colorLab(pickColor(hair.pick)))));
  }

  function onHairInput() {
    if (!hair.px || hair.done) return;
    hair.pick = { h: +hairEls.hue.value, s: +hairEls.sat.value, l: +hairEls.light.value };
    if (!hair.touched) {
      hair.touched = true;
      hairEls.hint.classList.add('is-hidden');
      hairEls.confirm.disabled = false;
    }
    updateHairSliders();
    // Un repintado por fotograma aunque lleguen varios eventos.
    cancelAnimationFrame(hair.frame);
    hair.frame = requestAnimationFrame(() => paintHair(hairLut(pickColor(hair.pick))));
  }

  /* Flujo */
  async function startHair(mode) {
    const token = ++hair.token;
    let data;
    try {
      data = await loadDataset('hair');
    } catch {
      setStatus('Couldn’t load the data. Check your connection and try again.');
      return;
    }
    if (token !== hair.token) return;
    const pool = hairPool(data);
    if (!pool.length) {
      setStatus('Hair Color isn’t ready yet. Come back soon!');
      return;
    }

    const day = utcDay();
    const saved = mode.daily ? getHairResult(day) : null;
    const entry = mode.daily
      ? (saved && pool.find((e) => e.id === saved.id)) || hairOfDay(pool, day)
      : hairPracticePick(pool, day);

    let px;
    try {
      px = await loadHairPixels(entry);
    } catch {
      setStatus('Couldn’t load the character. Check your connection and try again.');
      return;
    }
    if (token !== hair.token) return;

    Object.assign(hair, { mode, entry, px, day: mode.daily ? day : null, pick: { ...HAIR_DEFAULT }, touched: false, done: false });
    hairEls.canvas.width = px.w;
    hairEls.canvas.height = px.h;
    hairEls.title.textContent = mode.daily ? `Hair Color #${hairNumber(day)}` : 'Hair Color · Practice';
    hairEls.name.textContent = entry.name;
    hairEls.anime.textContent = entry.anime || '';
    hairEls.anime.hidden = !entry.anime;
    hairEls.hue.value = HAIR_DEFAULT.h;
    hairEls.sat.value = HAIR_DEFAULT.s;
    hairEls.light.value = HAIR_DEFAULT.l;
    hairSliders.forEach((input) => (input.disabled = false));
    hairEls.confirm.disabled = true;
    hairEls.controls.hidden = false;
    hairEls.result.hidden = true;
    hairEls.hint.classList.remove('is-hidden');
    updateHairSliders();
    paintHair(hairGrayLut());

    setStatus('');
    els.gameover.hidden = true;
    showScreen('hair');
    fitHairCanvas();

    if (saved) {
      // Diario ya jugado hoy: se enseña el resultado con la imagen original.
      hair.done = true;
      hairCtx.putImageData(px.image, 0, 0);
      showHairResult(saved, false);
      return;
    }
    track('game_start', { mode: 'hair', type: mode.daily ? 'daily' : 'practice' });
  }

  async function confirmHair() {
    if (!hair.px || hair.done || !hair.touched || els.hair.hidden) return;
    hair.done = true;
    cancelAnimationFrame(hair.frame);
    const token = hair.token;
    const { mode, entry } = hair;

    const guess = pickColor(hair.pick);
    const guessLab = colorLab(guess);
    const delta = ciede2000(guessLab, entry.lab);
    const round1 = (v) => Math.round(v * 10) / 10;
    const result = { id: entry.id, score: hairScore(delta), delta: round1(delta), guess: guessLab.map(round1) };

    if (mode.daily) {
      store.set(hairKey(hair.day), JSON.stringify(result));
    } else {
      const stats = getHairPractice();
      store.set(HAIR_PRACTICE_KEY, JSON.stringify({
        n: stats.n + 1,
        total: stats.total + result.score,
        best: Math.max(stats.best || 0, result.score),
      }));
    }
    track('game_over', { mode: 'hair', type: mode.daily ? 'daily' : 'practice', score: result.score });

    hairSliders.forEach((input) => (input.disabled = true));
    hairEls.confirm.disabled = true;
    await revealHair(guess, token);
    if (token !== hair.token) return;
    showHairResult(result, true);
  }

  // Del color elegido al real y, al final, fundido a la imagen original (el color de verdad).
  function revealHair(guess, token) {
    const target = colorFromLab(hair.entry.lab);
    const targetLut = hairLut(target);
    const { color: toColor, original: toOriginal } = HAIR_REVEAL;
    const total = reducedMotion.matches ? 0 : toColor + toOriginal;
    const ease = (x) => 1 - (1 - x) ** 3;
    return new Promise((resolve) => {
      const start = performance.now();
      const frame = (now) => {
        if (token !== hair.token) return resolve();
        const elapsed = Math.min(total, Math.max(0, now - start));
        if (elapsed >= total) {
          hairCtx.putImageData(hair.px.image, 0, 0);
          return resolve();
        }
        if (elapsed < toColor) paintHair(hairLut(mixColor(guess, target, ease(elapsed / toColor))));
        else paintHair(targetLut, 1 - ease((elapsed - toColor) / toOriginal));
        requestAnimationFrame(frame);
      };
      requestAnimationFrame(frame);
    });
  }

  function showHairResult(result, animate) {
    const { entry, mode } = hair;
    hairEls.hint.classList.add('is-hidden');
    hairEls.controls.hidden = true;
    hairEls.result.hidden = false;
    hairEls.swGuess.style.background = rgbHex(labToRgb(...result.guess));
    hairEls.swReal.style.background = entry.hex;
    hairEls.detail.replaceChildren(`Color difference ΔE ${result.delta.toFixed(1)}`);
    if (mode.daily) hairEls.detail.append(' · Next in ', countdownNode());

    // Diario: compartir es lo principal. Práctica: seguir jugando.
    hairEls.next.textContent = mode.daily ? 'Menu' : 'Next character';
    hairEls.next.classList.toggle('btn-primary', !mode.daily);
    hairEls.next.classList.toggle('btn-secondary', mode.daily);
    hairEls.share.classList.toggle('btn-primary', mode.daily);
    hairEls.share.classList.toggle('btn-secondary', !mode.daily);
    state.shareData = { hair: true, daily: mode.daily, day: hair.day, score: result.score };

    hairEls.announcer.textContent = `${result.score}%. ${entry.name}’s real hair color is ${entry.hex}.`;
    if (animate && !reducedMotion.matches) countUp(hairEls.score, result.score, 700);
    else hairEls.score.textContent = String(result.score);
    (mode.daily ? hairEls.share : hairEls.next).focus({ preventScroll: true });
  }

  hairSliders.forEach((input) => input.addEventListener('input', onHairInput));
  hairEls.confirm.addEventListener('click', confirmHair);
  hairEls.next.addEventListener('click', () => (hair.mode.daily ? goMenu() : startHair(hair.mode)));
  hairEls.share.addEventListener('click', share);
  $('hair-menu').addEventListener('click', goMenu);

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
    track('share_click', { mode: data.hair ? 'hair' : data.daily ? DAILY_MODE.id : data.mode.id });

    let payload;
    let fullText;
    if (data.hair) {
      const title = data.daily ? `Hair Color #${hairNumber(data.day)}` : 'Hair Color · Practice';
      fullText = `${title} · ${data.score}%
${hairBar(data.score)}
${url}`;
      payload = { title: SHARE_TITLE, text: fullText };
    } else if (data.daily) {
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
    if (!els.hair.hidden) {
      if (e.key === 'Escape') goMenu();
      // Enter confirma desde los sliders (en un botón, Enter ya lo pulsa).
      else if (e.key === 'Enter' && e.target.tagName !== 'BUTTON') confirmHair();
      return;
    }
    if (els.game.hidden) {
      if (e.key === 'Escape' && openCategory) openMenu(null);
      return;
    }
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
      fitHairCanvas();
      loadDataset('anime').then(buildMosaic, () => {});
    }, 200);
  });

  /* ---------- Inicio ---------- */
  // La portada se puede desplazar hasta el bloque "About": sin esto, al recargar (incluso con
  // Ctrl+F5) el navegador restauraba el desplazamiento y el título quedaba cortado arriba.
  if ('scrollRestoration' in history) history.scrollRestoration = 'manual';
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
