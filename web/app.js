/* Japan Phrasebook: an offline, speaking-first travel phrasebook.
 *
 * Everything runs from local files. Data lives in data/*.json; the viewer's
 * own state (favorites, recents, custom phrases, settings) lives in
 * localStorage under "jp.*". When running inside the Android shell,
 * window.Native provides text-to-speech and clipboard; in a desktop browser
 * the Web Speech API stands in so the app can be tested without a phone.
 */
'use strict';

const $ = (sel, el = document) => el.querySelector(sel);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const HAS_JA = /[぀-ヿ一-鿿々]/;

/* ------------------------------------------------------------------ storage */

const store = {
  get(key, fallback) {
    try {
      const v = localStorage.getItem('jp.' + key);
      return v == null ? fallback : JSON.parse(v);
    } catch (e) { return fallback; }
  },
  set(key, value) {
    try { localStorage.setItem('jp.' + key, JSON.stringify(value)); } catch (e) { /* storage full or blocked */ }
  },
};

const state = {
  cats: [],
  topics: [],
  entries: [],
  byId: new Map(),
  etiquette: { groups: [] },
  favs: store.get('favs', {}),        // id -> snapshot
  recents: store.get('recents', []),  // [{id, snap}]
  mine: store.get('mine', []),        // custom phrases
  stays: store.get('stays', []),      // [{id, name, address}]
  settings: Object.assign({ dots: true, script: true, kana: false, theme: 'auto' }, store.get('settings', {})),
  searchCat: '',
  practice: null,
};

/* ------------------------------------------------------------- normalizing */

function deaccent(s) {
  return s.normalize('NFC').toLowerCase()
    .replace(/[āâ]/g, 'aa').replace(/[īî]/g, 'ii').replace(/[ūû]/g, 'uu').replace(/[ēê]/g, 'ee').replace(/[ōô]/g, 'oo');
}

/* Romaji -> a loose key so "arigato", "arigatou" and "Arigatō" all match. */
function romaNorm(s) {
  s = deaccent(s).replace(/\([^)]*\)/g, '').replace(/[^a-z]/g, '');
  let prev;
  do {
    prev = s;
    s = s.replace(/([aiueo])\1+/g, '$1').replace(/ou/g, 'o').replace(/ei/g, 'e');
  } while (s !== prev);
  return s;
}

function kanaNorm(s) {
  return s.replace(/[ァ-ヶ]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0x60))
    .replace(/[\s　。、？！?!・「」〜~…ー]/g, '');
}

/* "Arigatō gozaimasu" -> "A·ri·ga·tō go·za·i·ma·su" (one dot per beat). */
const VOWELS = 'aiueoāīūēō';
function dotWord(w) {
  const lo = w.toLowerCase();
  const out = [];
  const attach = (s) => { if (out.length) out[out.length - 1] += s; else out.push(s); };
  let i = 0;
  while (i < w.length) {
    const c = lo[i];
    if (VOWELS.includes(c)) { out.push(w[i]); i++; continue; }
    if (c === "'" || c === '’') { i++; continue; }
    const next = lo[i + 1];
    if (c === 'n' && (next === undefined || (!VOWELS.includes(next) && next !== 'y'))) { attach(w[i]); i++; continue; }
    if (next === c || (c === 't' && next === 'c' && lo[i + 2] === 'h')) { attach(w[i]); i++; continue; }
    let j = i;
    while (j < w.length && !VOWELS.includes(lo[j])) j++;
    if (j >= w.length) { attach(w.slice(i)); break; }
    out.push(w.slice(i, j + 1));
    i = j + 1;
  }
  return out.join('·');
}
function dotted(romaji) {
  return romaji.split(/(\([^)]*\)|[A-Za-zāīūēōĀĪŪĒŌ'’]+)/).map((tok) => {
    if (!tok || tok[0] === '(' || !/[A-Za-z]/.test(tok)) return tok;
    return dotWord(tok);
  }).join('');
}

/* ------------------------------------------------------------------ speech */

const Native = window.Native;
const tts = {
  native: !!(Native && typeof Native.speak === 'function'),
  speak(text, slow) {
    text = String(text).replace(/〜/g, '').trim();
    if (!text) return;
    const rate = slow ? 0.55 : 0.9;
    if (this.native) { Native.speak(text, rate); return; }
    if (!('speechSynthesis' in window)) { toast('Speech is not available here'); return; }
    speechSynthesis.cancel();
    const u = new SpeechSynthesisUtterance(text);
    u.lang = 'ja-JP';
    u.rate = rate;
    const voice = speechSynthesis.getVoices().find((v) => (v.lang || '').replace('_', '-').toLowerCase().startsWith('ja'));
    if (voice) u.voice = voice;
    speechSynthesis.speak(u);
  },
  status() {
    if (this.native) {
      try { return Native.ttsStatus(); } catch (e) { return 'unknown'; }
    }
    if (!('speechSynthesis' in window)) return 'unsupported';
    const voices = speechSynthesis.getVoices();
    if (!voices.length) return 'unknown';
    return voices.some((v) => (v.lang || '').toLowerCase().startsWith('ja')) ? 'ready' : 'missing';
  },
};
if ('speechSynthesis' in window) speechSynthesis.onvoiceschanged = () => { if (ready && route().view === 'settings') refresh(); };

function copyText(text) {
  if (Native && typeof Native.copy === 'function') { Native.copy(text); toast('Copied'); return; }
  if (navigator.clipboard) navigator.clipboard.writeText(text).then(() => toast('Copied'), () => toast('Could not copy'));
}

let toastTimer;
function toast(msg) {
  const t = $('#toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('show'), 1800);
}

/* ------------------------------------------------------------------- data */

function makeEntry(kind, src, arr, extra) {
  const [en, ja, kana, romaji, note = '', tags = ''] = arr;
  const e = Object.assign({ id: src + '|' + ja, kind, src, en, ja, kana, romaji, note, tags }, extra);
  indexEntry(e);
  return e;
}

function indexEntry(e) {
  e._en = ' ' + e.en.toLowerCase().replace(/[^a-z0-9' ]+/g, ' ').replace(/\s+/g, ' ') + ' ';
  e._tags = ' ' + (e.tags || '').toLowerCase() + ' ' + (e.section || '').toLowerCase() + ' ';
  e._ro = romaNorm(e.romaji || '');
  e._ja = kanaNorm(e.ja || '');
  e._kana = kanaNorm(e.kana || '');
  e._note = (e.note || '').toLowerCase();
}

async function loadJSON(path) {
  const r = await fetch(path);
  if (!r.ok) throw new Error(path + ': ' + r.status);
  return r.json();
}

async function loadData() {
  const index = await loadJSON('data/index.json');
  state.cats = index.categories;
  state.topics = index.vocab;
  const phraseDocs = await Promise.all(state.cats.map((c) => loadJSON('data/phrases/' + c.id + '.json').catch(() => ({ sections: [] }))));
  const vocabDocs = await Promise.all(state.topics.map((t) => loadJSON('data/vocab/' + t.id + '.json').catch(() => ({ items: [] }))));
  state.etiquette = await loadJSON('data/etiquette.json').catch(() => ({ groups: [] }));

  const entries = [];
  state.cats.forEach((c, ci) => {
    c.sections = phraseDocs[ci].sections.map((s) => ({
      title: s.title,
      hear: !!s.hear,
      items: s.items.map((arr) => makeEntry('phrase', c.id, arr, { section: s.title, hear: !!s.hear, catName: c.name })),
    }));
    c.sections.forEach((s) => entries.push(...s.items));
  });
  state.topics.forEach((t, ti) => {
    t.items = vocabDocs[ti].items.map((arr) => makeEntry('word', 'v-' + t.id, arr, { catName: t.name, topic: t.id }));
    entries.push(...t.items);
  });
  state.etiquette.groups.forEach((g) => g.cards.forEach((c) => {
    if (c.say) c.sayEntry = makeEntry('phrase', 'etq', c.say, { catName: 'Etiquette', section: g.title });
  }));
  state.entries = entries;
  rebuildIds();
}

function mineEntries() {
  return state.mine.map((m) => {
    const e = { id: m.id, kind: 'mine', src: 'mine', en: m.en, ja: m.ja, kana: '', romaji: m.romaji || '', note: m.note || '', tags: 'mine', catName: 'My phrases' };
    indexEntry(e);
    return e;
  });
}

function rebuildIds() {
  state.byId = new Map();
  for (const e of state.entries) state.byId.set(e.id, e);
  for (const e of mineEntries()) state.byId.set(e.id, e);
  state.etiquette.groups.forEach((g) => g.cards.forEach((c) => { if (c.sayEntry) state.byId.set(c.sayEntry.id, c.sayEntry); }));
}

const snap = (e) => ({ en: e.en, ja: e.ja, kana: e.kana, romaji: e.romaji, note: e.note, catName: e.catName, hear: e.hear });
function fromSnap(id, s) {
  return state.byId.get(id) || Object.assign({ id, kind: 'snap', src: '' }, s);
}

/* ----------------------------------------------------------------- search */

function scoreTerm(e, term) {
  if (HAS_JA.test(term)) {
    const k = kanaNorm(term);
    return k && (e._ja.includes(k) || e._kana.includes(k)) ? 90 : 0;
  }
  const t = term.toLowerCase();
  let s = 0;
  if (e._en.includes(' ' + t + ' ')) s = 100;
  else if (e._en.includes(' ' + t)) s = 80;
  else if (t.length >= 3 && e._en.includes(t)) s = 45;
  if (e._tags.includes(' ' + t)) s = Math.max(s, 75);
  const rn = romaNorm(t);
  if (rn.length >= 2) {
    if (e._ro === rn) s = Math.max(s, 100);
    else if (e._ro.startsWith(rn)) s = Math.max(s, 85);
    else if (rn.length >= 3 && e._ro.includes(rn)) s = Math.max(s, 55);
  }
  if (!s && t.length >= 4 && e._note.includes(t)) s = 15;
  return s;
}

function search(q) {
  q = q.trim();
  if (q.length < 2 && !HAS_JA.test(q)) return [];
  const terms = q.split(/\s+/).filter(Boolean);
  const whole = romaNorm(q);
  const pool = state.entries.concat(mineEntries());
  state.etiquette.groups.forEach((g) => g.cards.forEach((c) => { if (c.sayEntry) pool.push(c.sayEntry); }));
  const out = [];
  for (const e of pool) {
    let total = 0;
    let ok = true;
    for (const t of terms) {
      const s = scoreTerm(e, t);
      if (!s) { ok = false; break; }
      total += s;
    }
    // "arigato gozaimasu" typed with a space should still match as a whole.
    if (!ok && terms.length > 1 && whole.length >= 4 && e._ro.includes(whole)) { ok = true; total = 90; }
    if (!ok) continue;
    if (e.kind === 'phrase' || e.kind === 'mine') total += 8;
    if (e.src === 'pronounce') total -= 20; // drills, not phrases to use
    total -= Math.min(e.en.length, 60) * 0.05;
    out.push({ e, score: total });
  }
  out.sort((a, b) => b.score - a.score);
  // The same phrase can live in several situations; show it once.
  const seen = new Set();
  return out.map((r) => r.e).filter((e) => {
    const k = e.kind + '|' + e.ja;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

/* ------------------------------------------------------------------ icons */

const ICON = {
  play: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M7 4.5v15a1 1 0 0 0 1.5.86l12.5-7.5a1 1 0 0 0 0-1.72L8.5 3.64A1 1 0 0 0 7 4.5z"/></svg>',
  star: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m12 3 2.7 5.6 6.1.8-4.5 4.2 1.1 6.1L12 16.8l-5.4 2.9 1.1-6.1-4.5-4.2 6.1-.8z"/></svg>',
};

/* ---------------------------------------------------------------- render */

function itemHTML(e, opts = {}) {
  const fav = !!state.favs[e.id];
  const ro = e.romaji ? (state.settings.dots ? dotted(e.romaji) : e.romaji) : '';
  const badge = e.hear ? '<span class="badge">They say</span>' : (e.kind === 'mine' ? '<span class="badge mine">Mine</span>' : '');
  const where = opts.where && e.catName ? `<div class="where">${esc(e.catName)}${e.section ? ' · ' + esc(e.section) : ''}</div>` : '';
  return `<li class="item${e.hear ? ' hear' : ''}" data-id="${esc(e.id)}">
    <div class="txt">
      ${where}
      <div class="en">${badge}${esc(e.en)}</div>
      ${ro ? `<div class="ro">${esc(ro)}</div>` : ''}
      ${state.settings.script || !ro ? `<div class="ja" lang="ja">${esc(e.ja)}</div>` : ''}
      ${state.settings.kana && e.kana && e.kana.replace(/\s/g, '') !== e.ja.replace(/\s/g, '') ? `<div class="kana" lang="ja">${esc(e.kana)}</div>` : ''}
      ${e.note ? `<div class="note">${esc(e.note)}</div>` : ''}
    </div>
    <div class="acts">
      <button class="btn-ic play" data-act="speak" aria-label="Play (tap again for slow)">${ICON.play}</button>
      ${e.kind === 'mine' ? '<button class="btn-ic edit" data-act="edit" aria-label="Edit">✎</button>' : `<button class="btn-ic fav${fav ? ' on' : ''}" data-act="fav" aria-label="${fav ? 'Remove favorite' : 'Add favorite'}">${ICON.star}</button>`}
    </div>
  </li>`;
}

const listHTML = (items, opts) => `<ul class="list">${items.map((e) => itemHTML(e, opts)).join('')}</ul>`;

function head(icon, title, sub) {
  return `<div class="pagehead">${icon ? `<span class="pi">${icon}</span>` : ''}<div><h1>${esc(title)}</h1>${sub ? `<p>${esc(sub)}</p>` : ''}</div></div>`;
}

function route() {
  const h = decodeURIComponent(location.hash.replace(/^#\/?/, ''));
  const [view = '', ...rest] = h.split('/');
  return { view: view || 'home', arg: rest.join('/') };
}

const TABS = [
  ['home', '🏠', 'Home', '#/'],
  ['favs', '⭐', 'Favorites', '#/favs'],
  ['practice', '🎙️', 'Practice', '#/practice'],
  ['etiquette', '🎎', 'Etiquette', '#/etiquette'],
  ['mine', '✏️', 'Mine', '#/mine'],
];

function renderNav(r) {
  const active = (v, arg) => (r.view === v && (arg === undefined || r.arg === arg) ? ' on' : '');
  $('#tabs').innerHTML = TABS.map(([v, i, label, href]) => `<a href="${href}" class="${active(v).trim()}"><span class="ti">${i}</span>${label}</a>`).join('');
  $('#rail').innerHTML =
    TABS.map(([v, i, label, href]) => `<a href="${href}" class="${active(v).trim()}"><span class="ti">${i}</span>${label}</a>`).join('') +
    `<a href="#/settings" class="${active('settings').trim()}"><span class="ti">⚙️</span>Settings</a>` +
    '<h3>Situations</h3>' +
    state.cats.map((c) => `<a href="#/c/${c.id}" class="${active('c', c.id).trim()}"><span class="ti">${c.icon}</span>${esc(c.name)}</a>`).join('') +
    '<h3>Words</h3>' +
    state.topics.map((t) => `<a href="#/w/${t.id}" class="${active('w', t.id).trim()}"><span class="ti">${t.icon}</span>${esc(t.name)}</a>`).join('');
}

function voiceBanner() {
  const st = tts.status();
  if (st === 'ready' || st === 'unknown') return '';
  const msg = st === 'unsupported'
    ? 'This browser can\'t speak Japanese. Audio works in the Android app.'
    : 'The Japanese voice isn\'t installed, so phrases can\'t be spoken. Install it once on Wi-Fi and audio then works offline.';
  const btn = tts.native ? '<br><button class="btn small primary" data-act="install-voice">Install Japanese voice</button>' : '';
  return `<div class="banner">🔇 ${msg}${btn}</div>`;
}

function viewHome() {
  const favs = Object.entries(state.favs).slice(-5).reverse().map(([id, s]) => fromSnap(id, s));
  const recents = state.recents.slice(0, 6).map((r) => fromSnap(r.id, r.snap));
  return `<div class="wrap">
    ${voiceBanner()}
    ${favs.length ? `<h2 class="sec">Favorites <a class="more" href="#/favs">All ${Object.keys(state.favs).length}</a></h2>${listHTML(favs)}` : ''}
    <h2 class="sec">Situations</h2>
    <div class="grid">${state.cats.map((c) => `<a class="tile" href="#/c/${c.id}"><span class="ti">${c.icon}</span><b>${esc(c.name)}</b><span>${esc(c.blurb || '')}</span></a>`).join('')}</div>
    <h2 class="sec">Words</h2>
    <div class="chips">${state.topics.map((t) => `<a class="chip" href="#/w/${t.id}">${t.icon} ${esc(t.name)}</a>`).join('')}</div>
    ${recents.length ? `<h2 class="sec">Recently played</h2>${listHTML(recents, { where: true })}` : ''}
    <div class="row-btns" style="margin-top:24px">
      <a class="btn small" href="#/settings">⚙️ Settings</a>
      <button class="btn small" data-act="share-app">📤 Share app with a friend</button>
    </div>
  </div>`;
}

function viewCategory(id) {
  const c = state.cats.find((x) => x.id === id);
  if (!c) return viewMissing();
  const tips = c.tips && c.tips.length
    ? `<details class="tips" data-cat="${c.id}"${(state.settings.tipsClosed || {})[c.id] ? '' : ' open'}><summary>💡 Good to know</summary><ul>${c.tips.map((t) => `<li>${esc(t)}</li>`).join('')}</ul></details>` : '';
  const words = (c.vocab || []).map((v) => state.topics.find((t) => t.id === v)).filter(Boolean);
  return `<div class="wrap">
    ${head(c.icon, c.name, c.blurb)}
    ${tips}
    <div class="row-btns">
      <a class="btn small" href="#/practice/cat:${c.id}">🎙️ Practice these</a>
      ${words.map((t) => `<a class="btn small" href="#/w/${t.id}">${t.icon} ${esc(t.name)}</a>`).join('')}
    </div>
    ${c.sections.map((s) => `<h2 class="sec">${s.hear ? '👂 ' : ''}${esc(s.title)}</h2>${listHTML(s.items)}`).join('')}
  </div>`;
}

function viewTopic(id) {
  const t = state.topics.find((x) => x.id === id);
  if (!t) return viewMissing();
  return `<div class="wrap">
    ${head(t.icon, t.name, t.items.length + ' words · tap to hear, tap again for slow')}
    <div class="row-btns"><a class="btn small" href="#/practice/topic:${t.id}">🎙️ Practice these</a></div>
    ${t.items.length ? listHTML(t.items) : '<p class="empty">No words yet.</p>'}
  </div>`;
}

function viewSearch(q) {
  const all = search(q);
  const counts = new Map();
  for (const e of all) counts.set(e.catName, (counts.get(e.catName) || 0) + 1);
  if (state.searchCat && !counts.has(state.searchCat)) state.searchCat = '';
  const shown = (state.searchCat ? all.filter((e) => e.catName === state.searchCat) : all).slice(0, 150);
  const chips = counts.size > 1
    ? `<div class="chips" style="margin-top:12px"><button class="chip${state.searchCat ? '' : ' on'}" data-act="scat" data-cat="">All <small>${all.length}</small></button>${[...counts].map(([name, n]) => `<button class="chip${state.searchCat === name ? ' on' : ''}" data-act="scat" data-cat="${esc(name)}">${esc(name)} <small>${n}</small></button>`).join('')}</div>`
    : '';
  return `<div class="wrap">
    ${chips}
    ${shown.length ? `<h2 class="sec">${all.length} result${all.length === 1 ? '' : 's'}</h2>${listHTML(shown, { where: true })}`
      : `<p class="empty">Nothing found for “${esc(q)}”.<br>Try a simpler word, or Google Translate for this one.</p>`}
  </div>`;
}

function viewFavs() {
  const favs = Object.entries(state.favs).reverse().map(([id, s]) => fromSnap(id, s));
  return `<div class="wrap">
    ${head('⭐', 'Favorites', 'Tap the star on any phrase to keep it here.')}
    ${favs.length ? `<div class="row-btns"><a class="btn small" href="#/practice/favs">🎙️ Practice favorites</a></div>${listHTML(favs, { where: true })}` : '<p class="empty">No favorites yet.</p>'}
  </div>`;
}

function viewEtiquette() {
  return `<div class="wrap">
    ${head('🎎', 'Etiquette', 'Do this, avoid that. Most locals forgive tourists, but these earn real goodwill.')}
    ${state.etiquette.groups.map((g) => `
      <h2 class="sec">${g.icon ? g.icon + ' ' : ''}${esc(g.title)}</h2>
      <div class="cards">${g.cards.map((c) => `
        <div class="card${c.do ? '' : ' dont'}">
          <h3><span class="mark">${c.do ? '✓ Do' : '✗ Don\'t'}</span>${esc(c.title)}</h3>
          <p>${esc(c.body)}</p>
          ${c.sayEntry ? listHTML([c.sayEntry]) : ''}
        </div>`).join('')}</div>`).join('')}
  </div>`;
}

function viewMine(editId) {
  const mine = mineEntries();
  const editing = editId ? state.mine.find((m) => m.id === editId) : null;
  const m = editing || { en: '', ja: '', romaji: '', note: '' };
  return `<div class="wrap">
    ${head('✏️', 'My phrases', 'Save phrases from Google Translate or people you meet.')}
    ${mine.length ? listHTML(mine) : ''}
    <h2 class="sec">${editing ? 'Edit phrase' : 'Add a phrase'}</h2>
    <form class="form" id="mineform" data-id="${esc(editing ? editing.id : '')}">
      <label>English<input name="en" required value="${esc(m.en)}" placeholder="Where is the lake view room?"></label>
      <label>Japanese <small>Paste from Google Translate</small><input name="ja" required lang="ja" value="${esc(m.ja)}" placeholder="日本語"></label>
      <label>Romaji <small>Optional. How to say it, e.g. Translate's pronunciation line</small><input name="romaji" value="${esc(m.romaji)}" placeholder="Nihongo"></label>
      <label>Note <small>Optional</small><input name="note" value="${esc(m.note)}"></label>
      <div class="row-btns" style="margin:0">
        <button class="btn primary" type="submit">${editing ? 'Save' : 'Add phrase'}</button>
        ${editing ? '<button class="btn" type="button" data-act="mine-cancel">Cancel</button><button class="btn" type="button" data-act="mine-delete">Delete</button>' : ''}
      </div>
    </form>
    <h2 class="sec">Where I'm staying</h2>
    ${state.stays.map((s) => `<div class="card" style="margin-bottom:10px">
        <h3>🏨 ${esc(s.name)}</h3>
        ${listHTML([stayEntry(s)])}
        <div class="row-btns" style="margin-bottom:0"><button class="btn small" data-act="stay-delete" data-sid="${esc(s.id)}">Remove</button></div>
      </div>`).join('')}
    <form class="form" id="stayform">
      <label>Hotel name<input name="name" required placeholder="Hotel Gracery Shinjuku"></label>
      <label>Address in Japanese <small>Copy it from Google Maps or the booking email</small><textarea name="address" required lang="ja" placeholder="東京都新宿区歌舞伎町1-19-1"></textarea></label>
      <div class="row-btns" style="margin:0"><button class="btn primary" type="submit">Save hotel</button></div>
    </form>
    <h2 class="sec">Backup</h2>
    <div class="row-btns">
      <button class="btn small" data-act="export">Copy backup</button>
      <button class="btn small" data-act="import">Restore from backup</button>
    </div>
  </div>`;
}

function stayEntry(s) {
  return {
    id: 'stay|' + s.id, kind: 'stay', src: 'stay',
    en: 'Please take me to this address',
    ja: 'この住所までお願いします。\n' + s.name + '\n' + s.address,
    say: 'この住所までお願いします。',
    romaji: 'Kono jūsho made onegai shimasu.', kana: '', note: 'Show the driver your screen, or play the phrase.', catName: 'Where I\'m staying',
  };
}

function viewPracticeHome() {
  const scopes = [
    ['favs', '⭐', 'My favorites', Object.keys(state.favs).length],
    ['hear', '👂', 'What you\'ll hear (listening)', state.entries.filter((e) => e.hear).length],
    ['all', '🎲', 'Everything, mixed', practicePool('all').length],
  ];
  return `<div class="wrap">
    ${head('🎙️', 'Practice', 'See the English, say it out loud, then tap to hear how it should sound.')}
    <div class="grid">
      ${scopes.map(([id, icon, name, n]) => `<a class="tile" href="#/practice/${id}"><span class="ti">${icon}</span><b>${esc(name)}</b><span>${n} phrases</span></a>`).join('')}
    </div>
    <h2 class="sec">By situation</h2>
    <div class="chips">${state.cats.map((c) => `<a class="chip" href="#/practice/cat:${c.id}">${c.icon} ${esc(c.name)}</a>`).join('')}</div>
  </div>`;
}

function practicePool(scope) {
  if (scope === 'favs') return Object.entries(state.favs).map(([id, s]) => fromSnap(id, s));
  if (scope === 'hear') return state.entries.filter((e) => e.hear);
  if (scope === 'all') return state.entries.filter((e) => e.kind === 'phrase' && !e.en.includes('('));
  if (scope.startsWith('cat:')) {
    const c = state.cats.find((x) => x.id === scope.slice(4));
    return c ? c.sections.flatMap((s) => s.items) : [];
  }
  if (scope.startsWith('topic:')) {
    const t = state.topics.find((x) => x.id === scope.slice(6));
    return t ? t.items : [];
  }
  return [];
}

function startPractice(scope) {
  // Fill-in-the-blank phrases like "(place) made ..." can't be drilled.
  const pool = practicePool(scope).filter((e) => e.romaji && !e.romaji.includes('('));
  for (let i = pool.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [pool[i], pool[j]] = [pool[j], pool[i]];
  }
  const queue = pool.slice(0, 15);
  state.practice = { scope, queue, total: queue.length, revealed: false, mode: scope === 'hear' ? 'hear' : 'say', done: 0 };
}

function viewPractice(scope) {
  if (!state.practice || state.practice.scope !== scope) startPractice(scope);
  const p = state.practice;
  const back = '<a class="btn small" href="#/practice">← All practice</a>';
  if (!p.total) return `<div class="wrap">${head('🎙️', 'Practice')}<p class="empty">Nothing to practice here yet.</p>${back}</div>`;
  if (!p.queue.length) {
    return `<div class="wrap">${head('🎉', 'Round done', p.total + ' phrases practiced.')}
      <div class="row-btns"><button class="btn primary" data-act="prac-again">Another round</button>${back}</div></div>`;
  }
  const e = p.queue[0];
  const hearing = p.mode === 'hear';
  const ro = state.settings.dots ? dotted(e.romaji) : e.romaji;
  const prompt = hearing
    ? `<button class="btn-ic play bigplay" data-act="prac-play" aria-label="Play">${ICON.play}</button><div class="hint">What does this mean? Answer out loud, then reveal.</div>`
    : `<div class="prompt">${esc(e.en)}</div><div class="hint">Say it out loud in Japanese, then reveal.</div>`;
  const answer = p.revealed
    ? `<div class="answer">
        ${hearing ? `<div class="en">${esc(e.en)}</div>` : ''}
        <div class="ro">${esc(ro)}</div>
        <div class="ja" lang="ja">${esc(e.ja)}</div>
        ${e.note ? `<div class="hint" style="margin-top:8px">${esc(e.note)}</div>` : ''}
        <div class="row-btns">
          <button class="btn" data-act="prac-play">🔊 Hear</button>
          <button class="btn" data-act="prac-slow">🐢 Slow</button>
        </div>
        <div class="row-btns">
          <button class="btn" data-act="prac-again-item">Again later</button>
          <button class="btn primary" data-act="prac-got">Got it ✓</button>
        </div>
      </div>`
    : `<div class="row-btns" style="margin-top:20px"><button class="btn ${hearing ? 'hearbtn' : 'primary'}" data-act="prac-reveal">Reveal &amp; hear</button></div>`;
  return `<div class="wrap">
    <div class="row-btns">${back}
      <button class="btn small" data-act="prac-mode">${hearing ? '🗣️ Switch to speaking' : '👂 Switch to listening'}</button></div>
    <div class="prac${hearing ? ' hearing' : ''}">
      <div class="count">${p.done + 1} of ${p.done + p.queue.length}</div>
      ${prompt}
      ${answer}
    </div>
  </div>`;
}

function viewSettings() {
  const st = tts.status();
  const voice = { ready: '✅ Japanese voice ready', missing: '⚠️ Japanese voice not installed', unsupported: '⚠️ No speech engine', unknown: '… checking voice' }[st] || st;
  const toggle = (key, label, sub) => `<label class="setting"><div>${label}<small>${sub}</small></div><input type="checkbox" class="switch" data-set="${key}"${state.settings[key] ? ' checked' : ''}></label>`;
  const version = Native && typeof Native.version === 'function' ? Native.version() : 'web preview';
  return `<div class="wrap">
    ${head('⚙️', 'Settings')}
    <div class="list" style="padding:0">
      ${toggle('dots', 'Syllable dots', 'A·ri·ga·tō: one dot per beat, to keep the rhythm even')}
      ${toggle('script', 'Show Japanese script', 'To show people your screen')}
      ${toggle('kana', 'Show kana reading', 'Hiragana under the Japanese, for learners')}
    </div>
    <h2 class="sec">Voice</h2>
    <div class="list" style="padding:14px">
      <div>${voice}</div>
      <div class="row-btns" style="margin-bottom:0">
        <button class="btn small" data-act="test-voice">🔊 Test: Konnichiwa</button>
        ${tts.native ? '<button class="btn small" data-act="install-voice">Voice settings</button>' : ''}
      </div>
    </div>
    <h2 class="sec">Share with a friend</h2>
    <div class="list" style="padding:14px">
      <div style="font-size:14px;color:var(--muted)">Sends this app to another Android phone with Quick Share. Works without internet. Their favorites and phrases stay separate.</div>
      <div class="row-btns" style="margin-bottom:0"><button class="btn small primary" data-act="share-app">📤 Share this app</button></div>
    </div>
    <h2 class="sec">About</h2>
    <div class="list" style="padding:14px;font-size:14px;color:var(--muted)">
      ${state.entries.filter((e) => e.kind === 'phrase').length} phrases · ${state.entries.filter((e) => e.kind === 'word').length} words · version ${esc(version)}<br>
      Everything works offline. Your favorites and phrases stay on this phone.
    </div>
  </div>`;
}

function viewMissing() {
  return `<div class="wrap"><p class="empty">Page not found. <a href="#/">Go home</a></p></div>`;
}

/* Keep scroll position per page so Back returns to the same spot. */
const scrollMemory = new Map();
let currentKey = '';

function render() {
  const r = route();
  const main = $('#main');
  if (currentKey) scrollMemory.set(currentKey, main.scrollTop);
  const key = location.hash || '#/';
  let html;
  switch (r.view) {
    case 'home': html = viewHome(); break;
    case 'c': html = viewCategory(r.arg); break;
    case 'w': html = viewTopic(r.arg); break;
    case 's': html = viewSearch(r.arg); break;
    case 'favs': html = viewFavs(); break;
    case 'etiquette': html = viewEtiquette(); break;
    case 'mine': html = viewMine(r.arg); break;
    case 'practice': html = r.arg ? viewPractice(r.arg) : viewPracticeHome(); break;
    case 'settings': html = viewSettings(); break;
    default: html = viewMissing();
  }
  main.innerHTML = html;
  renderNav(r);
  if (r.view !== 's' && document.activeElement !== $('#q')) { $('#q').value = ''; $('#qclear').hidden = true; }
  if (key !== currentKey) main.scrollTop = scrollMemory.get(key) || 0;
  currentKey = key;
}

/* Re-render the current page without moving the scroll position. */
function refresh() {
  const top = $('#main').scrollTop;
  render();
  $('#main').scrollTop = top;
}

/* ---------------------------------------------------------------- actions */

function entryFor(el) {
  const li = el.closest('.item');
  if (!li) return null;
  const id = li.dataset.id;
  if (id.startsWith('stay|')) {
    const s = state.stays.find((x) => 'stay|' + x.id === id);
    return s ? stayEntry(s) : null;
  }
  return state.byId.get(id) || (state.favs[id] && fromSnap(id, state.favs[id])) || (state.recents.find((r) => r.id === id) || {}).snap && fromSnap(id, state.recents.find((r) => r.id === id).snap);
}

/* Like Google Translate: tapping the same phrase again soon after plays it slowly. */
let lastPlay = { id: '', t: 0, slow: false };
function play(e, slow) {
  const now = Date.now();
  if (slow === undefined) slow = lastPlay.id === e.id && now - lastPlay.t < 5000 && !lastPlay.slow;
  lastPlay = { id: e.id, t: now, slow };
  if (slow) toast('🐢 Slow');
  tts.speak(e.say || e.ja, slow);
  if (e.kind === 'stay') return;
  state.recents = [{ id: e.id, snap: snap(e) }].concat(state.recents.filter((r) => r.id !== e.id)).slice(0, 30);
  store.set('recents', state.recents);
}

document.addEventListener('click', (ev) => {
  const btn = ev.target.closest('[data-act]');
  const act = btn ? btn.dataset.act : '';
  const p = state.practice;

  if (!btn) {
    // Tapping anywhere on a phrase plays it.
    const li = ev.target.closest('.item');
    if (li && !ev.target.closest('a')) {
      const e = entryFor(li);
      if (e) play(e);
    }
    return;
  }
  switch (act) {
    case 'speak': {
      const e = entryFor(btn);
      if (e) play(e);
      break;
    }
    case 'fav': {
      const e = entryFor(btn);
      if (!e) break;
      if (state.favs[e.id]) { delete state.favs[e.id]; toast('Removed from favorites'); } else { state.favs[e.id] = snap(e); toast('Added to favorites'); }
      store.set('favs', state.favs);
      if (route().view === 'favs') refresh();
      else {
        btn.classList.toggle('on', !!state.favs[e.id]);
        btn.setAttribute('aria-label', state.favs[e.id] ? 'Remove favorite' : 'Add favorite');
      }
      break;
    }
    case 'edit': {
      const li = btn.closest('.item');
      location.hash = '#/mine/' + li.dataset.id;
      break;
    }
    case 'scat':
      state.searchCat = btn.dataset.cat;
      refresh();
      break;
    case 'install-voice':
      if (Native && Native.openTtsSettings) Native.openTtsSettings();
      break;
    case 'share-app':
      if (Native && typeof Native.shareApp === 'function') Native.shareApp();
      else toast('Sharing works in the Android app');
      break;
    case 'test-voice':
      tts.speak('こんにちは', false);
      break;
    case 'prac-reveal':
      p.revealed = true;
      refresh();
      tts.speak(p.queue[0].ja, false);
      break;
    case 'prac-play':
    case 'prac-slow':
      tts.speak(p.queue[0].ja, act === 'prac-slow');
      break;
    case 'prac-got':
      p.queue.shift();
      p.done++;
      p.revealed = false;
      refresh();
      autoPlayHear();
      break;
    case 'prac-again-item': {
      const e = p.queue.shift();
      p.queue.splice(Math.min(3, p.queue.length), 0, e);
      p.revealed = false;
      refresh();
      autoPlayHear();
      break;
    }
    case 'prac-again':
      startPractice(p.scope);
      refresh();
      autoPlayHear();
      break;
    case 'prac-mode':
      p.mode = p.mode === 'hear' ? 'say' : 'hear';
      p.revealed = false;
      refresh();
      autoPlayHear();
      break;
    case 'mine-cancel':
      location.hash = '#/mine';
      break;
    case 'mine-delete': {
      const id = $('#mineform').dataset.id;
      if (confirm('Delete this phrase?')) {
        state.mine = state.mine.filter((m) => m.id !== id);
        store.set('mine', state.mine);
        delete state.favs[id];
        store.set('favs', state.favs);
        rebuildIds();
        location.hash = '#/mine';
      }
      break;
    }
    case 'stay-delete':
      if (confirm('Remove this hotel?')) {
        state.stays = state.stays.filter((s) => s.id !== btn.dataset.sid);
        store.set('stays', state.stays);
        refresh();
      }
      break;
    case 'export':
      copyText(JSON.stringify({ app: 'japan-phrasebook', mine: state.mine, stays: state.stays, favs: state.favs }));
      break;
    case 'import': {
      const text = prompt('Paste a backup here:');
      if (!text) break;
      try {
        const d = JSON.parse(text);
        if (d.app !== 'japan-phrasebook') throw new Error('not a backup');
        const ids = new Set(state.mine.map((m) => m.id));
        state.mine = state.mine.concat((d.mine || []).filter((m) => !ids.has(m.id)));
        const sids = new Set(state.stays.map((s) => s.id));
        state.stays = state.stays.concat((d.stays || []).filter((s) => !sids.has(s.id)));
        state.favs = Object.assign({}, d.favs || {}, state.favs);
        store.set('mine', state.mine); store.set('stays', state.stays); store.set('favs', state.favs);
        rebuildIds();
        refresh();
        toast('Backup restored');
      } catch (err) { toast('That doesn\'t look like a backup'); }
      break;
    }
  }
});

function autoPlayHear() {
  const p = state.practice;
  if (p && p.mode === 'hear' && p.queue.length) setTimeout(() => tts.speak(p.queue[0].ja, false), 250);
}

// Remember which category tip boxes were collapsed.
document.addEventListener('toggle', (ev) => {
  const d = ev.target;
  if (!d.matches || !d.matches('details.tips')) return;
  const closed = Object.assign({}, state.settings.tipsClosed);
  if (d.open) delete closed[d.dataset.cat]; else closed[d.dataset.cat] = true;
  state.settings.tipsClosed = closed;
  store.set('settings', state.settings);
}, true);

document.addEventListener('change', (ev) => {
  const key = ev.target.dataset && ev.target.dataset.set;
  if (!key) return;
  state.settings[key] = ev.target.checked;
  store.set('settings', state.settings);
});

document.addEventListener('submit', (ev) => {
  ev.preventDefault();
  const f = ev.target;
  const data = Object.fromEntries(new FormData(f).entries());
  for (const k in data) data[k] = String(data[k]).trim();
  if (f.id === 'mineform') {
    if (!data.en || !data.ja) return;
    const id = f.dataset.id;
    if (id) {
      Object.assign(state.mine.find((m) => m.id === id), data);
      if (state.favs[id]) state.favs[id] = Object.assign(state.favs[id], data);
    } else {
      state.mine.push(Object.assign({ id: 'mine|' + Date.now().toString(36) }, data));
    }
    store.set('mine', state.mine);
    store.set('favs', state.favs);
    rebuildIds();
    toast(id ? 'Saved' : 'Phrase added');
    if (id) location.hash = '#/mine'; else refresh();
  } else if (f.id === 'stayform') {
    if (!data.name || !data.address) return;
    state.stays.push({ id: Date.now().toString(36), name: data.name, address: data.address });
    store.set('stays', state.stays);
    toast('Hotel saved');
    refresh();
  }
});

/* ----------------------------------------------------------------- search box */

let searchTimer;
$('#q').addEventListener('input', () => {
  const q = $('#q').value;
  $('#qclear').hidden = !q;
  clearTimeout(searchTimer);
  searchTimer = setTimeout(() => {
    const trimmed = q.trim();
    if (!trimmed) {
      if (route().view === 's') history.back();
      return;
    }
    const target = '#/s/' + encodeURIComponent(trimmed);
    if (route().view === 's') {
      history.replaceState(null, '', target);
      render();
    } else {
      state.searchCat = '';
      location.hash = target;
    }
  }, 120);
});
$('#q').addEventListener('keydown', (ev) => { if (ev.key === 'Enter') $('#q').blur(); });
$('#qclear').addEventListener('click', () => {
  $('#q').value = '';
  $('#qclear').hidden = true;
  if (route().view === 's') history.back();
  $('#q').focus();
});

let ready = false;
window.addEventListener('hashchange', () => {
  if (!ready) return;
  const r = route();
  if (r.view === 'practice' && r.arg && (!state.practice || state.practice.scope !== r.arg)) {
    startPractice(r.arg);
    render();
    autoPlayHear();
    return;
  }
  render();
});

/* Called by the Android shell when the voice finishes installing. */
window.onVoiceChanged = () => { if (ready) refresh(); };

/* The Android shell reports the phone's dark mode, including live changes. */
window.setTheme = (dark) => { document.documentElement.dataset.theme = dark ? 'dark' : 'light'; };
if (Native && typeof Native.isDark === 'function') window.setTheme(Native.isDark());

/* ------------------------------------------------------------------- boot */

loadData().then(() => {
  ready = true;
  const r = route();
  if (r.view === 's') $('#q').value = r.arg;
  render();
}).catch((err) => {
  $('#main').innerHTML = `<p class="empty">Could not load phrase data.<br>${esc(err.message)}</p>`;
});
