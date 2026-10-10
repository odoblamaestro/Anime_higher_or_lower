(() => {
  'use strict';

  /* ---------- Datasets y modos ----------
   * Un dataset sabe cómo leer cada elemento (nombre, subtítulo, imagen, color).
   * Un modo elige un dataset y el campo numérico que se compara.
   * Para añadir personajes en el futuro basta con algo como:
   *   characters: { url: 'data/characters.json', name: (c) => c.name, sub: (c) => c.anime, ... }
   * y un modo { id: 'characters-favourites', dataset: 'characters', key: 'favourites', ... }.
   */
  const DATASETS = {
    anime: {
      url: 'data/anime.json',
      name: (it) => it.title || it.romaji || 'Untitled',
      sub: (it) => (it.year ? String(it.year) : ''),
      image: (it) => it.image,
      color: (it) => it.color,
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
  ];

  const SVG_ATTRS = 'viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"';
  const ICONS = {
    people: `<svg ${SVG_ATTRS} width="22" height="22" stroke-width="2"><path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M22 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/></svg>`,
    heart: `<svg ${SVG_ATTRS} width="22" height="22" stroke-width="2"><path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z"/></svg>`,
    up: `<svg ${SVG_ATTRS} width="20" height="20" stroke-width="2.6"><path d="M12 19V5M5 12l7-7 7 7"/></svg>`,
    down: `<svg ${SVG_ATTRS} width="20" height="20" stroke-width="2.6"><path d="M12 5v14M19 12l-7 7-7-7"/></svg>`,
  };

  const TIMING = { count: 1000, verdict: 550, slide: 600, gameOver: 950, firstImages: 2500 };
  const FALLBACK_TINT = '#c9b8a3';
  const SHARE_TITLE = 'Higher or Lower · Anime';

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
    deck: [],
    deckIndex: 0,
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

  // Saca del mazo barajado el siguiente elemento cuyo valor sea distinto de excludeValue.
  // Como el mazo solo avanza, nunca se repite un elemento en la misma partida.
  function draw(excludeValue) {
    const { deck } = state;
    for (let i = state.deckIndex; i < deck.length; i++) {
      if (value(deck[i]) !== excludeValue) {
        [deck[i], deck[state.deckIndex]] = [deck[state.deckIndex], deck[i]];
        return deck[state.deckIndex++];
      }
    }
    return null;
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
    goBest: $('go-best'),
    goDetail: $('go-detail'),
    toast: $('toast'),
  };

  function showScreen(name) {
    els.start.hidden = name !== 'start';
    els.game.hidden = name !== 'game';
    document.body.classList.toggle('is-playing', name === 'game');
  }

  function setStatus(text) {
    els.status.textContent = text;
  }

  function renderModes() {
    els.modeList.replaceChildren(
      ...MODES.map((mode) => {
        const btn = el('button', 'mode-btn');
        btn.type = 'button';
        const icon = el('span', 'mode-icon');
        icon.setAttribute('aria-hidden', 'true');
        icon.innerHTML = ICONS[mode.icon] || '';
        const text = el('span', 'mode-text');
        text.append(el('span', 'mode-title', mode.label), el('span', 'mode-desc', mode.description));
        const best = el('span', 'mode-best');
        best.append(el('span', 'mode-best-label', 'Best'), el('span', 'mode-best-value', fmt(getBest(mode))));
        btn.append(icon, text, best);
        btn.addEventListener('click', () => startGame(mode));
        return btn;
      })
    );
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
    els.hudMode.textContent = state.mode.label;
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
    const pool = data.filter((it) => it && Number.isFinite(it[mode.key]));
    Object.assign(state, {
      mode,
      ds,
      deck: shuffle(pool.slice()),
      deckIndex: 0,
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

    card.classList.add(correct ? 'is-correct' : 'is-wrong');
    setVs(correct ? 'correct' : 'wrong');
    els.announcer.textContent = `${state.ds.name(state.right)} has ${fmt(rv)} ${state.mode.unit}. ${correct ? 'Correct!' : 'Wrong.'}`;

    if (!correct) {
      await sleep(TIMING.gameOver);
      if (token === state.token) showGameOver(false);
      return;
    }

    state.score++;
    if (state.score > state.best) {
      state.best = state.score;
      store.set(bestKey(state.mode), state.best);
    }
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

  function showGameOver(completed) {
    const { mode, score } = state;
    const isRecord = score > 0 && score > state.startBest;

    els.goTitle.textContent = completed ? 'You got them all!' : 'Game over';
    els.goScore.textContent = fmt(score);
    els.goLabel.textContent = 'in a row';
    els.goBest.textContent = isRecord ? 'New best!' : `Best in ${mode.label}: ${fmt(state.best)}`;
    els.goBest.classList.toggle('is-record', isRecord);

    if (completed) {
      els.goDetail.textContent = '';
    } else {
      const rv = value(state.right);
      const lv = value(state.left);
      els.goDetail.textContent =
        `${state.ds.name(state.right)} has ${fmt(rv)} ${rv === 1 ? mode.unitOne : mode.unit}, ` +
        `${rv > lv ? 'more' : 'fewer'} than ${state.ds.name(state.left)}.`;
    }

    els.gameover.hidden = false;
    $('btn-again').focus({ preventScroll: true });
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
    const { mode, score } = state;
    const url = window.location.href.split(/[?#]/)[0];
    const text =
      `🔥 I got a streak of ${score} in ${SHARE_TITLE} ` +
      `(${mode.label} mode). Can you beat me?`;

    if (navigator.share) {
      try {
        await navigator.share({ title: SHARE_TITLE, text, url });
        return;
      } catch (err) {
        if (err && err.name === 'AbortError') return;
      }
    }
    toast((await copyText(`${text}\n${url}`)) ? 'Result copied' : 'Couldn’t copy');
  }

  /* ---------- Eventos ---------- */
  els.stage.addEventListener('click', (e) => {
    const btn = e.target.closest('.choice-btn');
    if (btn && state.rightEl && state.rightEl.contains(btn)) answer(btn.dataset.dir);
  });

  $('btn-menu').addEventListener('click', goMenu);
  $('btn-again').addEventListener('click', () => startGame(state.mode));
  $('btn-modes').addEventListener('click', goMenu);
  $('btn-share').addEventListener('click', share);

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

  /* ---------- Inicio ---------- */
  renderModes();
  // Carga anticipada para que la partida empiece al instante.
  for (const id of new Set(MODES.map((m) => m.dataset))) {
    loadDataset(id).catch(() =>
      setStatus('Couldn’t load the data. If you opened the file directly, use a local server.')
    );
  }
})();
