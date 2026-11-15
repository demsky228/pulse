// PULSE — интерфейс
const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const CHECK = '<svg viewBox="0 0 24 24"><path d="M5 12l5 5L20 7"/></svg>';
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const hot = () => getComputedStyle(document.documentElement).getPropertyValue('--hot').trim() || '#ff2a3d';
const sfx = window.sfx || { click() {}, boostStart() {}, step() {}, boostDone() {}, alert() {}, test() {}, cfg: {}, save() {} };

// Вне Electron (просто в браузере) — демо-режим с выдуманными данными
const api = window.pulse || makeDemoApi();
if (!window.pulse) $('#modeLabel').textContent = 'demo';

function fmtBytes(b) {
  if (b >= 1024 ** 3) return (b / 1024 ** 3).toFixed(1) + ' ГБ';
  if (b >= 1024 ** 2) return (b / 1024 ** 2).toFixed(0) + ' МБ';
  return Math.round(b / 1024) + ' КБ';
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------- тосты и модалка ----------
function toast(msg, type = '') {
  const t = document.createElement('div');
  t.className = 'toast ' + type;
  t.textContent = msg;
  $('#toasts').appendChild(t);
  setTimeout(() => { t.classList.add('out'); setTimeout(() => t.remove(), 300); }, 4200);
}
function confirmBox(title, text, yes = 'Да') {
  return new Promise((resolve) => {
    $('#mTitle').textContent = title; $('#mText').textContent = text; $('#mYes').textContent = yes;
    const m = $('#modal'); m.classList.add('show');
    const done = (v) => { m.classList.remove('show'); $('#mYes').onclick = $('#mNo').onclick = null; resolve(v); };
    $('#mYes').onclick = () => done(true);
    $('#mNo').onclick = () => done(false);
  });
}
api.on('alert', (msg) => { sfx.alert(); toast('⚠ ' + msg, 'bad'); });

// ---------- окно и навигация ----------
$$('[data-win]').forEach((b) => b.addEventListener('click', () => api.win(b.dataset.win)));
const pageHooks = {};
function go(page) {
  $$('.nav').forEach((n) => n.classList.toggle('active', n.dataset.page === page));
  $$('.page').forEach((p) => p.classList.toggle('active', p.id === 'page-' + page));
  if (pageHooks[page]) pageHooks[page]();
}
$$('.nav').forEach((n) => n.addEventListener('click', () => go(n.dataset.page)));
$$('[data-goto]').forEach((b) => b.addEventListener('click', () => go(b.dataset.goto)));

// оверлей
function setOvBtn(on) { $('#ovBtn').classList.toggle('on', on); $('#ovBtn').textContent = on ? '◉ Оверлей вкл' : '◉ Оверлей'; }
$('#ovBtn').addEventListener('click', async () => setOvBtn(await api.overlayToggle()));
api.on('overlay-state', setOvBtn);
api.overlayState().then((s) => setOvBtn(s.on));

// ---------- ПАНЕЛЬ ----------
const CIRC = 2 * Math.PI * 50;
function setGauge(id, pct, sub, label) {
  const g = $('#' + id), val = $('.val', g);
  if (pct == null) { $('.g-in b', g).textContent = '—'; if (sub) $('.g-sub', g).textContent = sub; return; }
  const col = pct < 60 ? '#ffffff' : pct < 85 ? '#b5b5b5' : hot();
  val.style.strokeDashoffset = CIRC * (1 - pct / 100);
  val.style.stroke = col; val.style.color = col;
  $('.g-in b', g).textContent = label || Math.round(pct) + '%';
  if (sub) $('.g-sub', g).textContent = sub;
}

const cpuHist = new Array(60).fill(0), gpuHist = new Array(60).fill(null);
const canvas = $('#cpuChart');
function drawChart() {
  const dpr = window.devicePixelRatio || 1;
  const w = canvas.clientWidth, h = canvas.clientHeight;
  if (!w) return;
  canvas.width = w * dpr; canvas.height = h * dpr;
  const c = canvas.getContext('2d');
  c.scale(dpr, dpr);
  c.strokeStyle = 'rgba(255,255,255,.05)'; c.lineWidth = 1;
  for (let i = 1; i < 4; i++) { const y = (h / 4) * i; c.beginPath(); c.moveTo(0, y); c.lineTo(w, y); c.stroke(); }
  const series = (hist, color, fillA) => {
    if (hist.every((v) => v == null)) return;
    const pts = hist.map((v, i) => [(i / (hist.length - 1)) * w, h - 8 - ((v || 0) / 100) * (h - 16)]);
    const path = () => {
      c.beginPath(); c.moveTo(pts[0][0], pts[0][1]);
      for (let i = 1; i < pts.length; i++) {
        const [x0, y0] = pts[i - 1], [x1, y1] = pts[i], mx = (x0 + x1) / 2;
        c.bezierCurveTo(mx, y0, mx, y1, x1, y1);
      }
    };
    if (fillA) {
      const fill = c.createLinearGradient(0, 0, 0, h);
      fill.addColorStop(0, `rgba(255,255,255,${fillA})`); fill.addColorStop(1, 'rgba(255,255,255,0)');
      path(); c.lineTo(w, h); c.lineTo(0, h); c.closePath(); c.fillStyle = fill; c.fill();
    }
    path(); c.strokeStyle = color; c.lineWidth = 2.2; c.shadowColor = color; c.shadowBlur = 10; c.stroke(); c.shadowBlur = 0;
    const [lx, ly] = pts[pts.length - 1];
    c.fillStyle = color; c.beginPath(); c.arc(lx - 3, ly, 3.5, 0, 7); c.fill();
  };
  series(cpuHist, '#ffffff', 0.14);
  series(gpuHist, hot(), 0);
}
window.addEventListener('resize', drawChart);

function renderPing(list) {
  $('#pingList').innerHTML = (list || []).map((p) => {
    const ms = p.ms, w = ms == null ? 100 : Math.min(100, (ms / 150) * 100);
    const cls = ms == null || ms > 90 ? 'bad' : ms > 45 ? 'mid' : '';
    return `<div class="pg"><span>${esc(p.name)}</span><div class="bar"><i class="${cls}" style="width:${Math.max(4, w)}%"></i></div><b>${ms == null ? 'нет' : ms + ' мс'}</b></div>`;
  }).join('') || '<p class="muted">Измеряю…</p>';
}

async function tick() {
  try {
    const s = await api.stats();
    cpuHist.push(s.cpu); cpuHist.shift();
    gpuHist.push(s.gpu ? s.gpu.util : null); gpuHist.shift();
    setGauge('g-cpu', s.cpu, 'Средняя по всем ядрам');
    if (s.gpu) setGauge('g-gpu', s.gpu.util, `${s.gpu.temp ?? '—'}°C · ${s.gpu.clock ?? '—'} МГц`);
    else setGauge('g-gpu', null, 'Нет данных от NVIDIA');
    const used = s.ramTotal - s.ramFree;
    setGauge('g-ram', (used / s.ramTotal) * 100, `${fmtBytes(used)} из ${fmtBytes(s.ramTotal)}`);
    if (s.disk) setGauge('g-disk', ((s.disk.total - s.disk.free) / s.disk.total) * 100, `Свободно ${fmtBytes(s.disk.free)}`);
    // температуры
    const tg = $('#t-gpu');
    if (s.gpu && s.gpu.temp != null) {
      tg.textContent = s.gpu.temp + '°C'; tg.className = s.gpu.temp >= 83 ? 'hot' : '';
      $('#t-gpu-sub').textContent = `вентилятор ${s.gpu.fan ?? '—'}% · ${s.gpu.power != null ? Math.round(s.gpu.power) + ' Вт' : '—'} · VRAM ${s.gpu.memUsed != null ? (s.gpu.memUsed / 1024).toFixed(1) : '—'}/${s.gpu.memTotal != null ? (s.gpu.memTotal / 1024).toFixed(0) : '—'} ГБ`;
    }
    const tc = $('#t-cpu');
    if (s.cpuTemp != null) { tc.textContent = Math.round(s.cpuTemp) + '°C'; tc.className = s.cpuTemp >= 90 ? 'hot' : ''; $('#t-cpu-sub').textContent = 'датчик ACPI, примерно'; }
    else { tc.textContent = '—'; $('#t-cpu-sub').textContent = 'Windows не отдаёт этот датчик'; }
    renderPing(s.ping);
    drawChart();
  } catch (e) { console.error(e); }
}
setInterval(tick, 1000); tick();

api.sysinfo().then((i) => {
  $('#i-cpu').textContent = `${i.cpu} · ${i.threads} потоков`;
  $('#i-gpu').textContent = i.gpu;
  $('#i-ram').textContent = fmtBytes(i.ram);
  $('#i-os').textContent = i.os;
  const b = $('#adminBadge');
  b.textContent = i.admin ? '● Администратор' : '● Без прав админа';
  b.className = 'badge ' + (i.admin ? 'ok' : 'warn');
});

// ---------- БУСТ ----------
const ICONS = {
  power: '<path d="M18.4 6.6a9 9 0 1 1-12.8 0M12 2v10"/>',
  gamemode: '<rect x="2" y="6" width="20" height="12" rx="6"/><path d="M6 12h4M8 10v4M15 11h.01M18 13h.01"/>',
  gamedvr: '<rect x="2" y="6" width="14" height="12" rx="2"/><path d="m16 10 6-3v10l-6-3M3 3l18 18"/>',
  temp: '<path d="M3 6h18M8 6V4h8v2M6 6l1 15h10l1-15"/>',
  dns: '<circle cx="12" cy="12" r="10"/><path d="M2 12h20M12 2a15 15 0 0 1 0 20M12 2a15 15 0 0 0 0 20"/>',
  mouse: '<rect x="6" y="2" width="12" height="20" rx="6"/><path d="M12 6v4"/>',
};
const TWEAKS = [
  { id: 'power', name: 'Схема питания «Максимум»', short: 'Питание «Максимум»', desc: 'Процессор не сбрасывает частоту во время игры', on: true },
  { id: 'gamemode', name: 'Игровой режим Windows', short: 'Игровой режим', desc: 'Система отдаёт приоритет запущенной игре', on: true },
  { id: 'gamedvr', name: 'Отключить фоновую запись Xbox', short: 'Без записи Xbox', desc: 'Game DVR пишет видео в фоне и съедает FPS', on: true },
  { id: 'temp', name: 'Очистить временные файлы', short: 'Очистка Temp', desc: 'Удаляет мусор из папок Temp', on: true },
  { id: 'dns', name: 'Сбросить DNS-кэш', short: 'Сброс DNS', desc: 'Помогает при проблемах с подключением к серверам', on: true },
  { id: 'mouse', name: 'Выключить ускорение мыши', short: 'Без ускорения мыши', desc: 'Стабильнее прицел. Сработает после перезахода в Windows', on: false },
];
let saved = {};
try { saved = JSON.parse(localStorage.getItem('pulse.tweaks') || '{}'); } catch {}
TWEAKS.forEach((t) => { if (t.id in saved) t.on = saved[t.id]; });

function renderTweaks() {
  $('#tweakList').innerHTML = TWEAKS.map((t) => `
    <div class="card tweak ${t.on ? 'on' : ''}" data-id="${t.id}">
      <div class="ico"><svg viewBox="0 0 24 24">${ICONS[t.id]}</svg></div>
      <div class="tx"><b>${t.name}</b><small>${t.desc}</small></div>
      <div class="st" id="st-${t.id}"></div>
      <div class="toggle"></div>
    </div>`).join('');
  $$('.tweak').forEach((el) => el.addEventListener('click', () => {
    const t = TWEAKS.find((x) => x.id === el.dataset.id);
    t.on = !t.on; el.classList.toggle('on', t.on);
    try { localStorage.setItem('pulse.tweaks', JSON.stringify(Object.fromEntries(TWEAKS.map((x) => [x.id, x.on])))); } catch {}
  }));
}
renderTweaks();

function log(text, cls = '') {
  const l = document.createElement('div');
  l.className = 't-line ' + cls; l.textContent = text;
  const term = $('#term'); term.appendChild(l); term.scrollTop = term.scrollHeight;
}
let boosting = false;
async function refreshBoostState() {
  const b = await api.backup();
  const n = Object.keys(b).length, el = $('#boostState');
  if (n) { el.className = 'boost-state on'; el.innerHTML = `<i></i><span>Буст активен · изменений: ${n}</span><button id="bsUndo">Откатить</button>`; $('#bsUndo').addEventListener('click', () => go('restore')); }
  else { el.className = 'boost-state'; el.innerHTML = '<i></i><span>Система в исходном состоянии</span>'; }
}
function resetBoostUi(msg) {
  const btn = $('#boostBtn');
  btn.classList.remove('done', 'running');
  $('.b-prog').style.strokeDashoffset = 552.9;
  $('#boostLabel').textContent = 'BOOST'; $('#boostSub').textContent = 'готов к запуску';
  $$('.tweak .st').forEach((s) => { s.textContent = ''; s.className = 'st'; });
  $('#term').innerHTML = ''; if (msg) log(msg, 'info');
}
pageHooks.boost = refreshBoostState;
refreshBoostState();
$('#boostBtn').addEventListener('click', async () => {
  if (boosting) return;
  const list = TWEAKS.filter((t) => t.on);
  if (!list.length) return toast('Включи хотя бы один твик', 'bad');
  boosting = true; sfx.boostStart();
  const btn = $('#boostBtn'), prog = $('.b-prog');
  btn.classList.remove('done'); btn.classList.add('running');
  $('#term').innerHTML = ''; $$('.tweak .st').forEach((s) => { s.textContent = ''; s.className = 'st'; });
  log('> PULSE boost запущен', 'info');
  $('#boostSub').textContent = 'точка восстановления…';
  log('> Проверяю точку восстановления', 'dim');
  const rp = await api.restorePointEnsure();
  if (rp.skipped) log(rp.recent ? '  ✓ свежая точка PULSE уже есть' : '  • пропущено (выключено в настройках)', 'dim');
  else log(`  ${rp.ok ? '✓' : '•'} ${rp.msg}`, rp.ok ? 'ok' : 'dim');
  let ok = 0;
  for (let i = 0; i < list.length; i++) {
    const t = list[i];
    $('#boostLabel').textContent = Math.round((i / list.length) * 100) + '%';
    $('#boostSub').textContent = t.name;
    const st = $('#st-' + t.id); st.textContent = '...';
    log(`> ${t.name}`, 'dim');
    const r = await api.tweak(t.id);
    await sleep(250);
    if (r.ok) ok++;
    sfx.step(r.ok);
    st.textContent = r.ok ? 'ГОТОВО' : 'ОШИБКА'; st.className = 'st ' + (r.ok ? 'ok' : 'bad');
    log(`  ${r.ok ? '✓' : '✕'} ${r.msg}`, r.ok ? 'ok' : 'bad');
    prog.style.strokeDashoffset = 552.9 * (1 - (i + 1) / list.length);
  }
  $('#boostLabel').textContent = `${ok}/${list.length}`;
  $('#boostSub').textContent = ok === list.length ? 'всё применено' : 'часть не сработала';
  log(`> завершено: ${ok} из ${list.length}`, 'info');
  btn.classList.remove('running'); btn.classList.add('done');
  sfx.boostDone();
  toast(ok === list.length ? 'Буст применён!' : 'Буст применён частично', ok === list.length ? 'ok' : 'bad');
  boosting = false;
  refreshBoostState();
  setTimeout(() => { if (!boosting) prog.style.strokeDashoffset = 552.9; }, 6000);
});

// ---------- ИГРЫ ----------
const CLOSE_APPS = ['chrome.exe', 'msedge.exe', 'firefox.exe', 'Discord.exe', 'Spotify.exe', 'Telegram.exe', 'OneDrive.exe', 'EpicGamesLauncher.exe'];
const GAME_TWEAKS = ['power', 'gamemode', 'gamedvr', 'dns', 'temp'];
let gamesData = null;
const gameLogs = {};
const PLAY_ICON = '<svg viewBox="0 0 24 24"><path d="M6 4l14 8-14 8z"/></svg>';

async function loadGames() {
  gamesData = await api.games();
  renderGames();
  refreshGameStatus();
}
function renderGames() {
  const { games, profiles } = gamesData;
  if (!Object.keys(games).length) {
    $('#gamesList').innerHTML = `<div class="card empty-games"><div class="eg-ico">${PLAY_ICON}</div><h2>Пока нет игр</h2><p class="muted">Нажми «Добавить игру» — PULSE покажет всё, что установлено в Steam. Для Rust и Dota 2 в меню слева появятся отдельные страницы с советами.</p><button class="btn primary" id="egAdd">Добавить игру</button></div>`;
    $('#egAdd').addEventListener('click', gmOpen);
    return;
  }
  $('#gamesList').innerHTML = Object.entries(games).map(([id, g]) => {
    const p = profiles[id];
    const opt = (key, title, sub) => `<div class="opt ${p[key] ? 'on' : ''}" data-g="${id}" data-k="${key}"><div class="tx"><b>${title}</b><small>${sub}</small></div><div class="toggle"></div></div>`;
    return `<div class="card game" id="game-${id}">
      <div class="game-top"><div class="game-ico ${g.icon ? 'has-img' : ''}">${g.icon ? `<img src="${g.icon}" alt="">` : g.name[0]}</div><div><h2>${g.name}</h2><span class="muted small">${g.installed === false ? 'не найдена в Steam' : 'Steam · ' + g.exe}</span></div><div class="pill off" id="gp-${id}"><i></i>не запущена</div>${g.custom ? `<button class="game-del" data-del="${id}" title="Убрать из PULSE"><svg viewBox="0 0 24 24"><path d="M3 6h18M8 6V4h8v2M6 6l1 15h10l1-15"/></svg></button>` : ''}</div>
      <button class="btn primary play wide" data-play="${id}">${PLAY_ICON}Играть</button>
      <div class="glog" id="gl-${id}">${(gameLogs[id] || []).map((l) => `<div>${esc(l)}</div>`).join('')}</div>
      <div class="sub-h">Перед запуском</div>
      <div class="kchips">${GAME_TWEAKS.map((t) => `<button class="kchip ${p.tweaks.includes(t) ? 'on' : ''}" data-g="${id}" data-t="${t}">${TWEAKS.find((x) => x.id === t).short}</button>`).join('')}</div>
      <div class="sub-h">Закрыть программы</div>
      <div class="kchips">${CLOSE_APPS.map((a) => `<button class="kchip ${p.close.includes(a) ? 'on' : ''}" data-g="${id}" data-c="${a}">${a.replace('.exe', '')}</button>`).join('')}</div>
      <div class="opts">
        ${opt('priority', 'Высокий приоритет', 'Через 8 секунд после старта игры')}
        ${opt('overlay', 'Включить оверлей', 'FPS и температура поверх игры')}
        ${opt('dnd', 'Не беспокоить', 'Уведомления Windows выключаются на время игры')}
        ${opt('restore', 'Вернуть настройки после выхода', 'Когда закроешь игру, всё откатится')}
      </div>
    </div>`;
  }).join('');

  const save = async (id) => { gamesData.profiles = await api.saveProfile(id, gamesData.profiles[id]); };
  $$('#gamesList .kchip').forEach((b) => b.addEventListener('click', () => {
    const p = gamesData.profiles[b.dataset.g];
    const arr = b.dataset.t ? p.tweaks : p.close, v = b.dataset.t || b.dataset.c;
    const i = arr.indexOf(v); i >= 0 ? arr.splice(i, 1) : arr.push(v);
    b.classList.toggle('on', i < 0); save(b.dataset.g);
  }));
  $$('#gamesList .opt').forEach((o) => o.addEventListener('click', () => {
    const p = gamesData.profiles[o.dataset.g];
    p[o.dataset.k] = !p[o.dataset.k]; o.classList.toggle('on', p[o.dataset.k]); save(o.dataset.g);
  }));
  $$('[data-del]').forEach((b) => b.addEventListener('click', async () => {
    const id = b.dataset.del, g = gamesData.games[id];
    if (!(await confirmBox('Убрать игру?', `${g.name} исчезнет из PULSE. Сама игра останется установленной.`, 'Убрать'))) return;
    await api.removeGame(id);
    refreshGamesEverywhere();
  }));
  $$('[data-play]').forEach((b) => b.addEventListener('click', async () => {
    const id = b.dataset.play;
    gameLogs[id] = []; $('#gl-' + id).innerHTML = '';
    sfx.boostStart();
    const r = await api.play(id);
    if (!r.ok) toast(r.msg, 'bad');
  }));
}
function gameLog(id, msg) {
  (gameLogs[id] = gameLogs[id] || []).push(msg);
  const el = $('#gl-' + id);
  if (el) { el.insertAdjacentHTML('beforeend', `<div>${esc(msg)}</div>`); el.scrollTop = el.scrollHeight; }
}
function setGamePill(id, running, stage) {
  const p = $('#gp-' + id); if (!p) return;
  const txt = stage === 'prepare' ? 'подготовка…' : stage === 'launch' ? 'запуск…' : running ? 'в игре' : 'не запущена';
  p.className = 'pill ' + (running || stage ? 'run' : 'off');
  p.innerHTML = `<i></i>${txt}`;
  const btn = $(`[data-play="${id}"]`);
  if (btn) btn.disabled = !!stage || running;
}
async function refreshGameStatus() {
  if (!gamesData) return;
  const st = await api.gameStatus();
  for (const [id, s] of Object.entries(st)) setGamePill(id, s.running, s.stage);
}
api.on('game-status', (d) => {
  if (d.msg) gameLog(d.id, d.msg);
  setGamePill(d.id, d.stage === 'running', d.stage === 'running' ? null : d.stage);
  if (!d.stage && d.msg) { toast(d.msg, 'ok'); refreshGameStatus(); refreshBoostState(); }
  if (d.stage === 'running') sfx.boostDone();
});
pageHooks.games = () => { if (gamesData) refreshGameStatus(); };
setInterval(() => { if ($('#page-games').classList.contains('active')) refreshGameStatus(); }, 4000);

// ---------- ОТЧЁТЫ ----------
let reports = [], repSel = null, repGame = 'all';
const fmtDur = (s) => { const h = Math.floor(s / 3600), m = Math.round((s % 3600) / 60); return h ? `${h} ч ${m} мин` : `${m} мин`; };
const fmtDate = (t) => new Date(t).toLocaleString('ru-RU', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
async function loadReports() {
  reports = await api.sessions();
  const cur = await api.sessionCurrent();
  $('#liveSess').innerHTML = cur ? `<i></i>Идёт запись: ${esc(cur.name)}` : '';
  const empty = !reports.length;
  $('#repEmpty').style.display = empty ? '' : 'none';
  $('#repBody').style.display = empty ? 'none' : '';
  $('#repFilter').style.display = empty ? 'none' : '';
  if (empty) return;
  const games = [...new Map(reports.map((r) => [r.gameId, r.name])).entries()];
  if (repGame !== 'all' && !games.some(([id]) => id === repGame)) repGame = 'all';
  $('#repFilter').innerHTML = [['all', 'Все игры'], ...games].map(([id, n]) => `<button class="kchip ${repGame === id ? 'on' : ''}" data-rg="${esc(id)}">${esc(n)}</button>`).join('');
  $$('#repFilter [data-rg]').forEach((b) => b.addEventListener('click', () => { repGame = b.dataset.rg; repSel = null; loadReports(); }));
  const list = reports.filter((r) => repGame === 'all' || r.gameId === repGame);
  if (!repSel || !list.some((r) => r.id === repSel)) repSel = list[0] && list[0].id;
  $('#repList').innerHTML = list.map((r) => `
    <div class="rr ${r.id === repSel ? 'sel' : ''}" data-rid="${r.id}">
      <div><b>${r.boost ? '<span class="bdot" title="с бустом"></span>' : ''}${esc(r.name)}</b><small>${fmtDate(r.start)} · ${fmtDur(r.duration)}</small></div>
      <span class="fps">${r.avgFps != null ? r.avgFps + ' FPS' : '—'}</span>
      <button class="del" data-rdel="${r.id}" title="Удалить"><svg viewBox="0 0 24 24"><path d="M3 6h18M8 6V4h8v2M6 6l1 15h10l1-15"/></svg></button>
    </div>`).join('');
  $$('#repList .rr').forEach((el) => el.addEventListener('click', (e) => { if (e.target.closest('.del')) return; repSel = el.dataset.rid; loadReports(); }));
  $$('#repList [data-rdel]').forEach((b) => b.addEventListener('click', async () => { reports = await api.sessionDelete(b.dataset.rdel); loadReports(); }));
  renderReport(list.find((r) => r.id === repSel), reports.filter((r) => r.gameId === (list.find((x) => x.id === repSel) || {}).gameId));
}
function renderReport(r, sameGame) {
  if (!r) return;
  $('#rdName').textContent = r.name;
  $('#rdMeta').textContent = `${fmtDate(r.start)} · ${fmtDur(r.duration)}`;
  const bp = $('#rdBoost'); bp.textContent = r.boost ? 'С бустом' : 'Без буста'; bp.className = 'hpill ' + (r.boost ? 'warn' : '');
  const tile = (label, val, unit, hotCls) => `<div class="tile ${hotCls ? 'hot' : ''}"><span>${label}</span><b>${val ?? '—'}${val != null && unit ? ` <small>${unit}</small>` : ''}</b></div>`;
  $('#rdTiles').innerHTML = [
    tile('Средний FPS', r.avgFps, ''), tile('1% low', r.low1, 'FPS', r.low1 != null && r.avgFps && r.low1 < r.avgFps * 0.5),
    tile('Макс. темп. GPU', r.maxGpuTemp, '°C', r.maxGpuTemp >= 83), tile('Загрузка GPU', r.avgGpu, '%'),
    tile('Загрузка CPU', r.avgCpu, '%'), tile('Пинг', r.avgPing, 'мс', r.avgPing > 90),
  ].join('');
  const notes = [];
  if (!r.hasFps) notes.push('FPS не записан: скачай модуль FPS в Настройках, и в следующих играх появится FPS.');
  if (r.low1 != null && r.avgFps && r.low1 < r.avgFps * 0.5) notes.push('1% low сильно ниже среднего — в игре были заметные рывки. Часто это упор в процессор или подгрузка с диска.');
  if (r.avgGpu != null && r.avgGpu < 70 && r.avgFps) notes.push('Видеокарта загружена не полностью — FPS, скорее всего, упирается в процессор или ограничитель FPS в игре.');
  if (r.maxGpuTemp >= 83) notes.push('Видеокарта грелась сильно — проверь пыль и обороты вентиляторов.');
  $('#rdNote').innerHTML = notes.map((n) => '• ' + n).join('<br>');
  drawRepChart(r.timeline || []);
  // сравнение по этой игре
  const withB = sameGame.filter((x) => x.boost && x.avgFps), noB = sameGame.filter((x) => !x.boost && x.avgFps);
  const mean = (arr, k) => Math.round(arr.reduce((s, x) => s + x[k], 0) / arr.length);
  if (withB.length && noB.length) {
    const a1 = mean(withB, 'avgFps'), a0 = mean(noB, 'avgFps'), d = ((a1 - a0) / a0) * 100;
    const l1 = mean(withB.filter((x) => x.low1), 'low1'), l0 = mean(noB.filter((x) => x.low1), 'low1');
    $('#rdCompare').innerHTML = `<div class="cmp-big ${d >= 0 ? 'up' : 'down'}">${d >= 0 ? '+' : ''}${d.toFixed(1)}%</div>
      <div class="muted small" style="margin-bottom:8px">средний FPS в ${esc(r.name)} с бустом</div>
      <div class="cmp-row"><span>С бустом (${withB.length})</span><b>${a1} FPS · 1% low ${isNaN(l1) ? '—' : l1}</b></div>
      <div class="cmp-row"><span>Без буста (${noB.length})</span><b>${a0} FPS · 1% low ${isNaN(l0) ? '—' : l0}</b></div>
      <div class="rep-note">Сравнение примерное: FPS зависит ещё от карты, сервера и того, что происходит в игре. Чем больше игр, тем точнее.</div>`;
  } else {
    $('#rdCompare').innerHTML = `<p class="muted">Сыграй в ${esc(r.name)} хотя бы раз <b>с бустом</b> и раз <b>без</b> — PULSE покажет, сколько FPS реально даёт буст.</p>
      <div class="cmp-row"><span>Игр с бустом</span><b>${withB.length}</b></div><div class="cmp-row"><span>Игр без буста</span><b>${noB.length}</b></div>`;
  }
}
function drawRepChart(tl) {
  const cv = $('#repChart'), dpr = window.devicePixelRatio || 1, w = cv.clientWidth, h = cv.clientHeight;
  if (!w) return;
  cv.width = w * dpr; cv.height = h * dpr;
  const c = cv.getContext('2d'); c.scale(dpr, dpr);
  c.strokeStyle = 'rgba(255,255,255,.05)'; c.lineWidth = 1;
  for (let i = 1; i < 4; i++) { const y = (h / 4) * i; c.beginPath(); c.moveTo(0, y); c.lineTo(w, y); c.stroke(); }
  if (tl.length < 2) return;
  const series = (key, color, max) => {
    const pts = tl.map((p, i) => (p[key] == null ? null : [(i / (tl.length - 1)) * w, h - 10 - (p[key] / max) * (h - 26)]));
    c.beginPath(); let started = false;
    for (const p of pts) { if (!p) { started = false; continue; } if (!started) { c.moveTo(p[0], p[1]); started = true; } else c.lineTo(p[0], p[1]); }
    c.strokeStyle = color; c.lineWidth = 2; c.shadowColor = color; c.shadowBlur = 8; c.stroke(); c.shadowBlur = 0;
  };
  const maxFps = Math.max(60, ...tl.map((p) => p.fps || 0)) * 1.1;
  series('fps', '#ffffff', maxFps);
  series('gpuTemp', hot(), 100);
  c.fillStyle = 'rgba(255,255,255,.45)'; c.font = '11px Bahnschrift, Segoe UI';
  c.fillText(Math.round(maxFps) + ' FPS', 6, 14);
}
pageHooks.reports = loadReports;
window.addEventListener('resize', () => { if ($('#page-reports').classList.contains('active')) loadReports(); });
api.on('session-report', (d) => {
  sfx.boostDone();
  toast(`Отчёт по ${d.name} готов${d.avgFps ? ` · ${d.avgFps} FPS` : ''}`, 'ok');
  if ($('#page-reports').classList.contains('active')) loadReports();
});

// ---------- ПРОЦЕССЫ ----------
const selected = new Set();
async function loadProcs() {
  const box = $('#procList');
  box.innerHTML = '<div class="empty">Загрузка…</div>';
  const list = await api.processes();
  selected.clear();
  if (!list.length) { box.innerHTML = '<div class="empty">Ничего тяжёлого не найдено</div>'; return; }
  const max = list[0].mem || 1;
  box.innerHTML = list.map((p, i) => `
    <div class="proc-row" data-name="${esc(p.name)}" style="animation-delay:${i * 25}ms">
      <div class="chk">${CHECK}</div>
      <div class="pname">${esc(p.name)}</div>
      <div class="muted">×${p.count}</div>
      <div class="pmem"><div class="bar"><i style="width:${Math.max(3, (p.mem / max) * 100)}%"></i></div><span>${fmtBytes(p.mem)}</span></div>
    </div>`).join('');
  $$('.proc-row').forEach((r) => r.addEventListener('click', () => {
    const n = r.dataset.name;
    selected.has(n) ? selected.delete(n) : selected.add(n);
    r.classList.toggle('sel', selected.has(n));
  }));
}
pageHooks.proc = loadProcs;
$('#procRefresh').addEventListener('click', loadProcs);
$('#procKill').addEventListener('click', async () => {
  if (!selected.size) return toast('Сначала выбери программы', 'bad');
  const names = [...selected];
  if (!(await confirmBox('Закрыть программы?', `${names.join(', ')}\n\nНесохранённые данные в них пропадут.`, 'Закрыть'))) return;
  const res = await api.kill(names);
  const ok = res.filter((r) => r.ok).length;
  toast(`Закрыто: ${ok} из ${names.length}`, ok ? 'ok' : 'bad');
  loadProcs();
});

// ---------- АВТОЗАГРУЗКА ----------
const SRC_NAMES = { HKCU: 'Пользователь', HKLM: 'Все', HKLM32: 'Все (32)', UserFolder: 'Папка', CommonFolder: 'Папка (все)' };
let suItems = [];
async function loadStartup() {
  const box = $('#suList');
  box.innerHTML = '<div class="empty">Загрузка…</div>';
  suItems = await api.startupList();
  if (!suItems.length) { box.innerHTML = '<div class="empty">Автозагрузка пуста</div>'; return; }
  suItems.sort((a, b) => (b.enabled - a.enabled) || a.name.localeCompare(b.name));
  box.innerHTML = suItems.map((s, i) => `
    <div class="su ${s.enabled ? 'on' : 'off'}" data-i="${i}" style="animation-delay:${i * 25}ms">
      <div class="tx"><b>${esc(s.name)}</b><small title="${esc(s.cmd)}">${esc(s.cmd)}</small></div>
      <div class="src">${SRC_NAMES[s.src] || s.src}</div>
      <div class="toggle"></div>
    </div>`).join('');
  $$('.su .toggle').forEach((t) => t.addEventListener('click', async () => {
    const row = t.closest('.su'), item = suItems[row.dataset.i];
    const r = await api.startupToggle(item, !item.enabled);
    if (!r.ok) return toast('Не получилось. Для «Все» нужны права администратора', 'bad');
    item.enabled = !item.enabled;
    row.className = 'su ' + (item.enabled ? 'on' : 'off');
    sfx.step(true);
    toast(`${item.name}: ${item.enabled ? 'включено' : 'выключено'} в автозагрузке`, 'ok');
  }));
}
pageHooks.startup = loadStartup;
$('#suRefresh').addEventListener('click', loadStartup);

// ---------- ОЧИСТКА ----------
let cleanData = [];
const cleanSel = new Set(['temp']);
function countUp(el, to) {
  const start = performance.now(), dur = 900;
  const step = (now) => {
    const k = Math.min(1, (now - start) / dur);
    el.textContent = fmtBytes(to * (1 - Math.pow(1 - k, 3)));
    if (k < 1) requestAnimationFrame(step);
  };
  requestAnimationFrame(step);
}
function renderClean() {
  $('#cleanList').innerHTML = cleanData.map((g) => `
    <div class="cg ${cleanSel.has(g.id) ? 'on' : ''}" data-id="${g.id}">
      <div class="cg-top"><div class="chk">${CHECK}</div><span class="gn">${g.name}</span><b>${fmtBytes(g.size)}</b></div>
      ${g.warn ? `<div class="warn">${g.warn}</div>` : ''}
      <div class="dirs" title="${esc(g.dirs.join('\n'))}">${esc(g.dirs.join(' · '))}</div>
    </div>`).join('');
  const total = cleanData.filter((g) => cleanSel.has(g.id)).reduce((a, g) => a + g.size, 0);
  $('#cleanTotal').textContent = fmtBytes(total);
  $('#cleanBtn').disabled = total === 0;
  $$('.cg').forEach((el) => el.addEventListener('click', () => {
    const id = el.dataset.id; cleanSel.has(id) ? cleanSel.delete(id) : cleanSel.add(id); renderClean();
  }));
}
$('#scanBtn').addEventListener('click', async () => {
  $('#scanBtn').disabled = true; $('#cleanTotal').textContent = '...';
  cleanData = await api.scanClean();
  renderClean();
  countUp($('#cleanTotal'), cleanData.filter((g) => cleanSel.has(g.id)).reduce((a, g) => a + g.size, 0));
  $('#scanBtn').disabled = false;
});
$('#cleanBtn').addEventListener('click', async () => {
  const ids = [...cleanSel];
  if (!ids.length) return;
  $('#cleanBtn').disabled = true; $('#cleanTotal').textContent = 'Чистим…';
  const r = await api.clean(ids);
  countUp($('#cleanTotal'), r.freed);
  sfx.boostDone();
  toast(`Освобождено ${fmtBytes(r.freed)}`, 'ok');
  $('#cleanList').innerHTML = '<p class="muted">Готово. Можно просканировать ещё раз.</p>';
});

// ---------- СТРАНИЦЫ СОВЕТОВ ДЛЯ ИЗВЕСТНЫХ ИГР (по appid) ----------
const GAME_INFO = {
  252490: {
    launch: ['-high', '-window-mode exclusive', '-gc.buffer 2048'],
    note: 'С <b>-window-mode exclusive</b> оверлей PULSE поверх игры не виден — убери его, если нужен оверлей.',
    gfx: [['Shadow Quality', 'Минимум'], ['Shadow Lights', 'Минимум'], ['Draw Distance', '1500–2000'], ['Grass Displacement', 'Выкл'],
      ['Parallax Mapping', 'Выкл'], ['Water Quality', 'Минимум'], ['Water Reflections', 'Минимум'], ['Particle Quality', 'Низко'],
      ['Tree / Terrain Quality', 'Средне'], ['Anti-aliasing', 'DLSS / FSR'], ['VSync', 'Выкл'], ['NVIDIA Reflex', 'On + Boost']],
    tip: 'FPS в игре: F1 → <b>perf 1</b> или оверлей PULSE (Ctrl+Shift+F). Возле больших баз FPS падает из-за процессора — это нормально для Rust.',
  },
  570: {
    launch: ['-high', '-map dota', '-novid', '-vulkan', '-dx11'],
    note: 'Выбери только один из <b>-vulkan</b> или <b>-dx11</b>: сыграй матч с одним, потом с другим, и оставь тот, где FPS стабильнее. «Скопировать всё» берёт -vulkan.',
    copyAll: '-high -map dota -novid -vulkan',
    gfx: [['Rendering API', 'Vulkan или DX11'], ['Display Mode', 'Полный экран / без рамки'], ['VSync', 'Выкл'], ['Ambient Occlusion', 'Выкл'],
      ['Shadow Quality', 'Выкл'], ['Effects Quality', 'Низко'], ['Game Screen Render Quality', '80–100%'], ['Max FPS', 'Частота монитора +'],
      ['Dashboard Max FPS', '60'], ['NVIDIA Reflex', 'On + Boost']],
    tip: 'FPS в игре: Настройки → Опции → <b>Показывать сетевую информацию</b>, или оверлей PULSE (Ctrl+Shift+F) в режиме «без рамки». Dota чаще упирается в процессор, чем в видеокарту.',
  },
};
let gameMeta = {};
let gfxDone = {};
try { gfxDone = JSON.parse(localStorage.getItem('pulse.gfx3') || '{}'); } catch {}

function iconHtml(id) { const g = gameMeta[id]; return g && g.icon ? `<img src="${g.icon}" alt="">` : ''; }
function renderGamePage(id) {
  const g = gameMeta[id], info = GAME_INFO[g.appid];
  const sec = $('#page-g-' + id);
  sec.innerHTML = `
    <div class="head"><div class="head-left"><div class="g-head-ico">${iconHtml(id)}</div><div><h1>${esc(g.name)}</h1><p>Приоритет, параметры запуска и графика</p></div></div>
      <div class="pill off" id="gpill-${id}"><i></i>не запущена</div></div>
    <div class="rust-grid">
      <div class="card">
        <div class="card-h"><h3>Приоритет процесса</h3></div>
        <p class="muted">Даёт игре больше процессорного времени. Работает, пока игра открыта.</p>
        <button class="btn primary wide" data-prio="${id}"><svg viewBox="0 0 24 24"><path d="M13 2 4 14h7l-1 8 9-12h-7z"/></svg>Высокий приоритет</button>
        <div class="card-h" style="margin-top:22px"><h3>Параметры запуска Steam</h3></div>
        <p class="muted">Steam → ПКМ по ${esc(g.name)} → Свойства → Параметры запуска. Если игра начнёт вылетать — сотри их.</p>
        <div class="chips">${info.launch.map((l) => `<button class="chip" data-v="${l}">${l}</button>`).join('')}</div>
        <div class="chip-note">${info.note}</div>
        <button class="btn wide" data-copyall="${id}">Скопировать всё</button>
      </div>
      <div class="card">
        <div class="card-h"><h3>Графика в игре</h3><span class="muted" id="gfxc-${id}"></span></div>
        <div class="gfx" id="gfx-${id}"></div>
      </div>
    </div>`;
  $$('.chip', sec).forEach((c) => c.addEventListener('click', () => { api.copy(c.dataset.v); toast('Скопировано: ' + c.dataset.v, 'ok'); }));
  $(`[data-copyall="${id}"]`, sec).addEventListener('click', () => { const t = info.copyAll || info.launch.join(' '); api.copy(t); toast('Скопировано: ' + t, 'ok'); });
  $(`[data-prio="${id}"]`, sec).addEventListener('click', async () => { const r = await api.gamePriority(id); toast(r.msg, r.ok ? 'ok' : 'bad'); });
  renderGfx(id);
}
function renderGfx(id) {
  const appid = gameMeta[id].appid, info = GAME_INFO[appid], done = gfxDone[appid] = gfxDone[appid] || {};
  $('#gfx-' + id).innerHTML = info.gfx.map(([n, v], i) => `
    <div class="g ${done[i] ? 'done' : ''}" data-i="${i}"><div class="chk">${CHECK}</div><span class="gn">${n}</span><span class="gv">${v}</span></div>`).join('')
    + `<div class="tip">${info.tip}</div>`;
  $('#gfxc-' + id).textContent = `${Object.values(done).filter(Boolean).length}/${info.gfx.length}`;
  $$(`#gfx-${id} .g`).forEach((el) => el.addEventListener('click', () => {
    done[el.dataset.i] = !done[el.dataset.i];
    try { localStorage.setItem('pulse.gfx3', JSON.stringify(gfxDone)); } catch {}
    renderGfx(id);
  }));
}
async function pollGamePill(id) {
  const st = await api.gameStatus();
  const p = $('#gpill-' + id); if (!p || !st[id]) return;
  p.className = 'pill ' + (st[id].running ? 'on' : 'off');
  p.innerHTML = `<i></i>${st[id].running ? 'запущена' : 'не запущена'}`;
}
// пункты меню и страницы появляются только для добавленных игр, по которым есть советы
const GAMEPAD_ICO = '<svg viewBox="0 0 24 24"><rect x="2" y="6" width="20" height="12" rx="6"/><path d="M6 12h4M8 10v4M15 11h.01M18 13h.01"/></svg>';
function rebuildGameNav() {
  const ids = Object.keys(gameMeta).filter((id) => GAME_INFO[gameMeta[id].appid]);
  const activePage = ($('.nav.active') || {}).dataset ? $('.nav.active').dataset.page : null;
  $('#gameNav').innerHTML = ids.map((id) => `<button class="nav gnav" data-page="g-${id}"><span class="gi">${gameMeta[id].icon ? `<img src="${gameMeta[id].icon}" alt="">` : GAMEPAD_ICO}</span><span>${esc(gameMeta[id].name)}</span></button>`).join('');
  $('#gamePages').innerHTML = ids.map((id) => `<section class="page gpage" id="page-g-${id}"></section>`).join('');
  for (const id of ids) {
    renderGamePage(id);
    pageHooks['g-' + id] = () => pollGamePill(id);
  }
  $$('#gameNav .nav').forEach((n) => n.addEventListener('click', () => go(n.dataset.page)));
  if (activePage && activePage.startsWith('g-')) go(ids.includes(activePage.slice(2)) ? activePage : 'games');
}
setInterval(() => { $$('.gpage.active').forEach((s) => pollGamePill(s.id.replace('page-g-', ''))); }, 3000);
async function refreshGamesEverywhere() {
  gamesData = await api.games();
  gameMeta = gamesData.games;
  rebuildGameNav();
  renderGames();
  refreshGameStatus();
}
refreshGamesEverywhere();

// ---------- ОТКАТ ----------
const NAMES = {
  power: 'Схема питания', AutoGameModeEnabled: 'Игровой режим', AllowAutoGameMode: 'Игровой режим (разрешение)',
  GameDVR_Enabled: 'Запись Xbox Game DVR', AppCaptureEnabled: 'Захват Xbox', MouseSpeed: 'Ускорение мыши',
  MouseThreshold1: 'Порог мыши 1', MouseThreshold2: 'Порог мыши 2',
};
async function loadRestore() {
  const b = await api.backup();
  const keys = Object.keys(b);
  $('#restoreList').innerHTML = keys.length
    ? keys.map((k) => `<div class="rs"><i></i>${NAMES[k] || NAMES[k.split('|').pop()] || esc(k)}</div>`).join('')
    : '<p class="muted">PULSE пока ничего не менял — откатывать нечего.</p>';
  $('#restoreBtn').disabled = !keys.length;
}
pageHooks.restore = loadRestore;
$('#restoreBtn').addEventListener('click', async () => {
  if (!(await confirmBox('Вернуть всё как было?', 'Схема питания и параметры Windows вернутся к исходным значениям.', 'Вернуть'))) return;
  const r = await api.restore();
  toast(`Восстановлено: ${r.restored.length}`, 'ok');
  resetBoostUi('> буст отменён, настройки Windows возвращены');
  refreshBoostState();
  loadRestore();
});

// ---------- ПРОВЕРКА ПК ----------
const hex = (n) => '0x' + Number(n).toString(16).toUpperCase();
// Разбор процессора: касается ли его проблема Vmin Shift у Intel 13/14 поколения
function cpuAdvice(h) {
  const name = h.cpu || '';
  const m = name.match(/i([3579])-1([34])(\d)(\d{2})([A-Z]*)/);
  if (!/intel/i.test(name) || !m) return { state: 'ok', pill: 'Не касается', text: 'Проблема с микрокодом есть только у Intel Core 13-го и 14-го поколения для настольных ПК. Твоего процессора она не касается.' };
  const tier = +m[1], x = +m[3], suffix = m[5] || '';
  if (/H|U|P/.test(suffix.replace(/K|F|T/g, ''))) return { state: 'ok', pill: 'Не касается', text: 'Это ноутбучный процессор — проблема Vmin Shift касается только настольных моделей.' };
  const listed = tier >= 7 || (tier === 5 && x >= 5);
  const rev = h.rev;
  if (rev == null) return { state: 'info', pill: 'Нет данных', text: 'Windows не отдала версию микрокода. Проверь версию BIOS на сайте производителя платы.' };
  if (rev < 0x100) return { state: 'ok', pill: 'Другой кристалл', text: `Микрокод ${hex(rev)} — похоже, твой процессор сделан на кристалле Alder Lake (так бывает у i5-13400/14400). Исправление 0x12F выпускалось для кристалла Raptor Lake, и Intel не включает такие модели в список затронутых. Обновлять BIOS всё равно полезно, но срочности нет.` };
  if (rev >= 0x12F) return { state: 'ok', pill: 'Свежий', text: `Микрокод ${hex(rev)} — это 0x12F или новее. Всё в порядке.` };
  if (listed) return { state: 'warn', pill: 'Обнови BIOS', text: `Микрокод ${hex(rev)} старее 0x12F, а твоя модель в списке затронутых Intel. Обнови BIOS платы до версии с микрокодом 0x12F или новее и в BIOS оставь профиль «Intel Default Settings».` };
  return { state: 'info', pill: 'Желательно обновить', text: `Микрокод ${hex(rev)} старее 0x12F. Твоей модели нет в списке затронутых Intel, так что риск низкий, но обновить BIOS полезно — заодно уйдут предупреждения в играх.` };
}
let healthData = null;
async function loadHealth() {
  const h = healthData = await api.health();
  if (h.error) { $('#hCpu').innerHTML = `<p class="muted">${esc(h.error)}</p>`; return; }
  const adv = cpuAdvice(h);
  const pill = $('#hCpuPill');
  pill.textContent = adv.pill; pill.className = 'hpill ' + (adv.state === 'warn' ? 'warn' : adv.state === 'ok' ? 'ok' : '');
  $('#hCpu').innerHTML = `
    <div class="kv"><span>Процессор</span><b>${esc(h.cpu)}</b></div>
    <div class="kv"><span>Микрокод</span><b>${h.rev != null ? hex(h.rev) : '—'}</b></div>
    <div class="kv"><span>Идентификатор</span><b>${esc(h.ident || '—')}</b></div>
    <div class="hnote ${adv.state === 'warn' ? 'warn' : ''}">${adv.text}</div>`;
  const board = [h.boardMaker, h.boardModel].filter(Boolean).join(' ') || [h.pcMaker, h.pcModel].filter(Boolean).join(' ') || '—';
  $('#hBios').innerHTML = `
    <div class="kv"><span>Материнская плата</span><b>${esc(board)}</b></div>
    <div class="kv"><span>Версия BIOS</span><b>${esc(h.biosVersion || '—')}</b></div>
    <div class="kv"><span>Дата BIOS</span><b>${esc(h.biosDate || '—')}</b></div>
    <button class="btn wide" id="biosFind">Найти свежий BIOS для этой платы</button>
    <div class="hnote">BIOS качай только с официального сайта производителя платы. Во время прошивки не выключай ПК.</div>`;
  $('#biosFind').addEventListener('click', () => api.openUrl('https://www.google.com/search?q=' + encodeURIComponent(board + ' BIOS download support')));
  const days = h.uptimeH / 24;
  const longUp = h.uptimeH > 72;
  $('#hUpPill').textContent = longUp ? 'Давно' : 'Норма';
  $('#hUpPill').className = 'hpill ' + (longUp && adv.state === 'warn' ? 'warn' : 'ok');
  $('#hUp').innerHTML = `<div class="hbig">${days >= 1 ? days.toFixed(1) + ' дн.' : Math.round(h.uptimeH) + ' ч'}</div>
    <div class="hnote">${longUp ? 'ПК давно не перезагружался. Перезагрузка раз в пару дней освежает систему' + (adv.state === 'warn' ? ', а для твоего процессора со старым микрокодом это ещё и снижает риск нестабильности.' : '.') : 'Всё нормально.'}</div>`;
}
async function loadRp() {
  const pts = await api.restorePoints();
  const fmt = (t) => new Date(t).toLocaleString('ru-RU', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' });
  $('#hRp').innerHTML = pts.length
    ? `<div class="rp-list">${pts.map((p) => `<div class="rp"><b class="${p.desc === 'PULSE' ? 'pulse' : ''}">${esc(p.desc)}</b><span>${fmt(p.time)}</span></div>`).join('')}</div>`
    : '<p class="muted">Точек восстановления нет. Возможно, защита системы выключена.</p>';
  $('#hRp').insertAdjacentHTML('beforeend', '<div class="hnote">Если что-то пойдёт не так: Пуск → «Создание точки восстановления» → «Восстановить» → выбрать точку PULSE.</div>');
}
async function rpCreate() {
  $('#rpCreate').disabled = true; $('#rpCreate').textContent = 'Создаю… (до минуты)';
  const r = await api.restorePointCreate();
  $('#rpCreate').disabled = false; $('#rpCreate').textContent = 'Создать сейчас';
  toast(r.msg, r.ok ? 'ok' : 'bad');
  $('#rpEnable').style.display = r.disabled ? '' : 'none';
  if (r.ok) sfx.boostDone();
  loadRp();
}
$('#rpCreate').addEventListener('click', rpCreate);
$('#rpEnable').addEventListener('click', async () => {
  if (!(await confirmBox('Включить защиту системы?', 'Windows начнёт хранить точки восстановления для диска C:. Под них отводится немного места на диске (обычно несколько ГБ). Выключить можно там же, в настройках защиты системы.', 'Включить'))) return;
  const r = await api.protectionEnable();
  if (!r.ok) return toast('Не получилось: ' + (r.msg || ''), 'bad');
  toast('Защита системы включена, создаю точку…', 'ok');
  rpCreate();
});
$('#hRefresh').addEventListener('click', () => { loadHealth(); loadRp(); });
pageHooks.health = () => { loadHealth(); loadRp(); };

// ---------- ДОБАВИТЬ ИГРУ ----------
let steamList = [];
function gmShow(on) { $('#gmodal').classList.toggle('show', on); }
function gmRenderList() {
  const q = $('#gmSearch').value.trim().toLowerCase();
  const list = steamList.filter((g) => !q || g.name.toLowerCase().includes(q));
  $('#gmList').innerHTML = list.length
    ? list.map((g) => `<button class="gm-row ${g.added ? 'added' : ''}" data-app="${g.appid}"><b>${esc(g.name)}</b><span>${g.added ? 'уже в PULSE' : 'appid ' + g.appid}</span></button>`).join('')
    : '<p class="muted" style="padding:14px">Ничего не найдено</p>';
  $$('#gmList .gm-row').forEach((r) => r.addEventListener('click', () => gmPick(r.dataset.app)));
}
async function gmPick(appid) {
  $('#gmSearch').style.display = 'none';
  $('#gmList').innerHTML = '<p class="muted" style="padding:14px">Ищу файлы игры…</p>';
  const r = await api.gameCandidates(appid);
  if (!r.ok || !r.candidates.length) { $('#gmList').innerHTML = `<p class="muted" style="padding:14px">${r.msg || 'В папке игры не нашёлся exe-файл'}</p>`; return; }
  $('#gmTitle').textContent = r.name;
  let sel = r.candidates[0].rel;
  $('#gmList').innerHTML = `<div class="gm-note">Выбери главный файл игры — по нему PULSE поймёт, что игра запущена, и даст ей приоритет. Обычно это самый большой файл (он выбран).</div>`
    + r.candidates.map((c, i) => `<button class="gm-row ${i === 0 ? 'sel' : ''}" data-rel="${esc(c.rel)}">${c.icon ? `<img src="${c.icon}" alt="">` : ''}<b>${esc(c.rel)}</b><span>${fmtBytes(c.size)}</span></button>`).join('')
    + `<div class="gm-actions"><button class="btn" id="gmBack">Назад</button><button class="btn primary" id="gmAdd">Добавить</button></div>`;
  $$('#gmList [data-rel]').forEach((b) => b.addEventListener('click', () => { sel = b.dataset.rel; $$('#gmList [data-rel]').forEach((x) => x.classList.toggle('sel', x === b)); }));
  $('#gmBack').addEventListener('click', gmOpen);
  $('#gmAdd').addEventListener('click', async () => {
    const res = await api.addGame(appid, sel);
    if (!res.ok) return toast(res.msg, 'bad');
    gmShow(false); sfx.boostDone(); toast(`${r.name} добавлена`, 'ok');
    refreshGamesEverywhere();
  });
}
async function gmOpen() {
  $('#gmTitle').textContent = 'Добавить игру из Steam';
  $('#gmSearch').style.display = ''; $('#gmSearch').value = '';
  $('#gmList').innerHTML = '<p class="muted" style="padding:14px">Читаю библиотеку Steam…</p>';
  gmShow(true);
  steamList = await api.steamGames();
  if (!steamList.length) { $('#gmList').innerHTML = '<p class="muted" style="padding:14px">Игры Steam не найдены</p>'; return; }
  gmRenderList(); $('#gmSearch').focus();
}
$('#addGameBtn').addEventListener('click', gmOpen);
$('#gmClose').addEventListener('click', () => gmShow(false));
$('#gmSearch').addEventListener('input', gmRenderList);
$('#gmodal').addEventListener('mousedown', (e) => { if (e.target.id === 'gmodal') gmShow(false); });

// ---------- ДИСК ----------
const FOLDER_ICO = '<svg viewBox="0 0 24 24"><path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/></svg>';
const FILE_ICO = '<svg viewBox="0 0 24 24"><path d="M14 3H6a1 1 0 0 0-1 1v16a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1V8z"/><path d="M14 3v5h5"/></svg>';
const OPEN_ICO = '<svg viewBox="0 0 24 24"><path d="M14 4h6v6M20 4l-9 9M19 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1h5"/></svg>';
let diskRoot = null, diskCur = null, diskBusy = false;
const baseName = (p) => p.replace(/[\\/]+$/, '').split(/[\\/]/).pop() || p;
async function loadDrives() {
  const ds = await api.drives();
  $('#drives').innerHTML = ds.map((d) => {
    const total = d.used + d.free, pct = total ? (d.used / total) * 100 : 0;
    return `<button class="card drive ${diskRoot && diskRoot.toLowerCase().startsWith(d.root.toLowerCase()) ? 'active' : ''}" data-root="${esc(d.root)}">
      <b>${esc(d.name)}:</b> <span class="muted">${Math.round(pct)}% занято</span>
      <div class="dbar"><i class="${pct > 85 ? 'full' : ''}" style="width:${pct}%"></i></div>
      <small>Свободно ${fmtBytes(d.free)} из ${fmtBytes(total)} · нажми, чтобы просканировать</small></button>`;
  }).join('');
  $$('.drive').forEach((b) => b.addEventListener('click', () => scanFolder(b.dataset.root, true)));
}
async function scanFolder(p, isRoot) {
  if (diskBusy) return;
  diskBusy = true;
  if (isRoot) { diskRoot = p; $$('.drive').forEach((b) => b.classList.toggle('active', b.dataset.root === p)); }
  $('#diskCard').style.display = '';
  $('#diskProgress').style.display = ''; $('#diskList').innerHTML = '';
  $('#dpText').textContent = 'Сканирую… это может занять минуту-две';
  const r = await api.diskScan(p);
  diskBusy = false;
  $('#diskProgress').style.display = 'none';
  if (!r.ok) { $('#diskList').innerHTML = '<p class="muted" style="padding:14px">Сканирование остановлено</p>'; return; }
  showFolder(p);
}
async function showFolder(p) {
  const node = await api.diskNode(p);
  if (!node) return scanFolder(p, false); // слишком глубоко — досканируем
  diskCur = p;
  // хлебные крошки
  const root = diskRoot || p;
  const rel = p.slice(root.length).split(/[\\/]/).filter(Boolean);
  const crumbs = [[root, root.replace(/[\\/]+$/, '')]];
  let acc = root.replace(/[\\/]+$/, '');
  for (const part of rel) { acc += '\\' + part; crumbs.push([acc, part]); }
  $('#crumbs').innerHTML = crumbs.map(([cp, n]) => `<button data-cp="${esc(cp)}">${esc(n)}</button>`).join('<i>›</i>');
  $$('#crumbs [data-cp]').forEach((b) => b.addEventListener('click', () => showFolder(b.dataset.cp)));
  $('#diskSum').textContent = fmtBytes(node.size);
  const items = [...node.dirs.map((d) => ({ ...d, dir: true })), ...node.files.map((f) => ({ ...f, dir: false }))].sort((x, y) => y.size - x.size);
  const max = items.length ? items[0].size : 1;
  $('#diskList').innerHTML = items.length ? items.map((it, i) => `
    <div class="dk ${it.dir ? 'dir' : ''}" data-p="${esc(it.path)}" data-dir="${it.dir ? 1 : 0}" style="animation-delay:${Math.min(i, 30) * 15}ms">
      ${it.dir ? FOLDER_ICO : FILE_ICO}
      <div class="nm" title="${esc(it.path)}">${esc(baseName(it.path))}</div>
      <div class="sz"><div class="bar"><i class="${it.size > 50 * 1024 ** 3 ? 'hotb' : ''}" style="width:${Math.max(1.5, (it.size / max) * 100)}%"></i></div><span>${fmtBytes(it.size)}</span></div>
      <button class="op" data-open="${esc(it.path)}" title="Открыть в Проводнике">${OPEN_ICO}</button>
    </div>`).join('') : '<p class="muted" style="padding:14px">Тут пусто или нет доступа</p>';
  $$('#diskList .dk.dir').forEach((r) => r.addEventListener('click', (e) => { if (!e.target.closest('.op')) showFolder(r.dataset.p); }));
  $$('#diskList [data-open]').forEach((b) => b.addEventListener('click', () => api.openInExplorer(b.dataset.open)));
}
api.on('disk-progress', (d) => { $('#dpText').textContent = `Просмотрено ${d.files.toLocaleString('ru-RU')} файлов · ${fmtBytes(d.bytes)}`; });
$('#dpCancel').addEventListener('click', () => api.diskCancel());
pageHooks.disk = loadDrives;

// ---------- НАСТРОЙКИ ----------
const COLORS = ['#ff2a3d', '#ff7a1a', '#ffd400', '#2bff88', '#00e5ff', '#3d7bff', '#a24dff', '#ff3dbb', '#ffffff'];
function currentHot() { try { return localStorage.getItem('pulse.hot') || '#ff2a3d'; } catch { return '#ff2a3d'; } }
function applyColor(c) {
  if (window.setWebColor) window.setWebColor(c); else document.documentElement.style.setProperty('--hot', c);
  try { localStorage.setItem('pulse.hot', c); } catch {}
  $$('.sw').forEach((s) => s.classList.toggle('on', s.dataset.c === c));
  $('#customColor').value = c;
}
$('#swatches').innerHTML = COLORS.map((c) => `<button class="sw" data-c="${c}" style="background:${c};color:${c}"></button>`).join('');
$$('.sw').forEach((s) => s.addEventListener('click', () => { applyColor(s.dataset.c); sfx.step(true); }));
$('#customColor').addEventListener('input', (e) => applyColor(e.target.value));
applyColor(currentHot());

function bindOpt(key, get, set) {
  const el = $(`[data-opt="${key}"]`);
  el.classList.toggle('on', !!get());
  el.addEventListener('click', () => { const v = !get(); set(v); el.classList.toggle('on', v); });
}
bindOpt('snd-on', () => sfx.cfg.on, (v) => { sfx.cfg.on = v; sfx.save(); });
bindOpt('snd-web', () => sfx.cfg.web, (v) => { sfx.cfg.web = v; sfx.save(); });
$('#vol').value = Math.round((sfx.cfg.vol ?? 0.5) * 100);
$('#vol').addEventListener('input', (e) => { sfx.cfg.vol = e.target.value / 100; sfx.save(); });
$('#sndTest').addEventListener('click', () => sfx.test());

let appSettings = {};
api.settingsGet().then((s) => {
  appSettings = s;
  bindOpt('tray', () => appSettings.tray, async (v) => { appSettings = await api.settingsSet({ tray: v }); });
  bindOpt('autorp', () => appSettings.autoRP !== false, async (v) => { appSettings = await api.settingsSet({ autoRP: v }); });
  $$('#ovPos button').forEach((b) => {
    b.classList.toggle('on', b.dataset.v === s.overlayPos);
    b.addEventListener('click', async () => {
      appSettings = await api.settingsSet({ overlayPos: b.dataset.v });
      $$('#ovPos button').forEach((x) => x.classList.toggle('on', x === b));
    });
  });
});
async function pmRefresh() {
  const s = await api.overlayState();
  $('#pmStatus').textContent = s.pm ? 'Модуль FPS установлен ✓' : 'Модуль FPS не установлен';
  $('#pmInstall').style.display = s.pm ? 'none' : '';
}
$('#pmInstall').addEventListener('click', async () => {
  $('#pmInstall').disabled = true; $('#pmStatus').textContent = 'Скачиваю PresentMon…';
  const r = await api.pmInstall();
  $('#pmInstall').disabled = false;
  if (r.ok) { toast('Модуль FPS установлен', 'ok'); sfx.boostDone(); } else toast('Не скачалось: ' + (r.msg || ''), 'bad');
  pmRefresh();
});
api.on('pm-progress', (p) => { $('#pmStatus').textContent = `Скачиваю PresentMon… ${p}%`; });
pageHooks.settings = pmRefresh;


// ---------- ПОДДЕРЖКА И ОШИБКИ ----------
window.addEventListener('error', (e) => { try { api.logError(`${e.message} @ ${e.filename}:${e.lineno}`); } catch {} });
window.addEventListener('unhandledrejection', (e) => { try { api.logError('promise: ' + (e.reason && e.reason.stack || e.reason)); } catch {} });
api.appVersion().then((v) => { $('#verLabel').textContent = 'версия ' + v; $('.side-foot').firstChild.textContent = 'v' + v + ' · '; });
$('#diagCopy').addEventListener('click', async () => { const t = await api.diagInfo(); await api.copy(t); toast('Сведения скопированы — вставь их в сообщение разработчику', 'ok'); });
$('#logsOpen').addEventListener('click', () => api.openLogs());

// ---------- демо-режим (без Electron) ----------
function makeDemoApi() {
  let backup = {};
  const listeners = {};
  const profiles = {
    rust: { tweaks: ['power', 'gamemode', 'gamedvr', 'dns'], close: ['chrome.exe'], priority: true, overlay: true, restore: true },
    dota: { tweaks: ['power', 'gamemode', 'gamedvr', 'dns'], close: [], priority: true, overlay: false, restore: true },
  };
  const settings = { tray: true, overlayPos: 'tl' };
  const mkTl = (base, n) => Array.from({ length: n }, (_, i) => ({ t: i * 12, fps: Math.round(base + Math.sin(i / 5) * 18 + (i % 37 === 0 ? -60 : 0) + Math.random() * 10), gpuTemp: Math.round(58 + Math.min(10, i / 8) + Math.random() * 2) }));
  let demoSessions = [
    { id: 's3', gameId: 'steam_252490', name: 'Rust', start: Date.now() - 3600e3, duration: 4380, boost: true, hasFps: true, avgFps: 128, low1: 61, maxGpuTemp: 69, avgGpu: 93, avgCpu: 41, avgPing: 63, timeline: mkTl(128, 300) },
    { id: 's2', gameId: 'steam_252490', name: 'Rust', start: Date.now() - 86400e3, duration: 3120, boost: false, hasFps: true, avgFps: 117, low1: 48, maxGpuTemp: 70, avgGpu: 91, avgCpu: 44, avgPing: 66, timeline: mkTl(117, 260) },
    { id: 's1', gameId: 'steam_570', name: 'Dota 2', start: Date.now() - 2 * 86400e3, duration: 2400, boost: false, hasFps: false, avgFps: null, low1: null, maxGpuTemp: 61, avgGpu: 55, avgCpu: 38, avgPing: 58, timeline: mkTl(0, 200).map((p) => ({ ...p, fps: null })) },
  ];
  let ov = false;
  const demoGames = { steam_252490: { name: 'Rust', appid: 252490, exe: 'RustClient.exe', icon: 'icon.png' } };
  const emit = (ch, d) => (listeners[ch] || []).forEach((cb) => cb(d));
  return {
    on: (ch, cb) => { (listeners[ch] = listeners[ch] || []).push(cb); },
    stats: async () => ({ cpu: 18 + Math.random() * 30, ramTotal: 32 * 1024 ** 3, ramFree: 14 * 1024 ** 3, disk: { total: 512 * 1024 ** 3, free: 72 * 1024 ** 3 },
      gpu: { name: 'RTX 4070', util: 40 + Math.random() * 50, temp: 61 + Math.round(Math.random() * 4), clock: 2610, memUsed: 6400, memTotal: 12282, power: 168, fan: 44 },
      cpuTemp: null, ping: [{ name: 'Cloudflare', ms: 18 + Math.round(Math.random() * 4) }, { name: 'Google', ms: 34 }, { name: 'Яндекс', ms: 61 }] }),
    sysinfo: async () => ({ cpu: 'Intel(R) Core(TM) i5-14400F', threads: 16, ram: 32 * 1024 ** 3, gpu: 'NVIDIA GeForce RTX 4070', os: 'Windows 11 Pro', admin: true }),
    tweak: async (id) => { await sleep(400); backup[id] = 1; return { ok: true, msg: 'Применено (демо)' }; },
    scanClean: async () => { await sleep(600); return [
      { id: 'temp', name: 'Временные файлы Windows', dirs: ['C:\\Users\\User\\AppData\\Local\\Temp', 'C:\\Windows\\Temp'], size: 2.1 * 1024 ** 3 },
      { id: 'shader', name: 'Кэш шейдеров NVIDIA и DirectX', warn: 'Первые запуски игр после очистки могут подтормаживать, пока кэш собирается заново', dirs: ['…\\NVIDIA\\DXCache', '…\\D3DSCache'], size: 1.3 * 1024 ** 3 },
      { id: 'steam', name: 'Кэш Steam', warn: 'Лучше закрыть Steam перед очисткой', dirs: ['…\\Steam\\htmlcache'], size: 640 * 1024 ** 2 }]; },
    clean: async () => { await sleep(900); return { freed: 2.05 * 1024 ** 3 }; },
    processes: async () => [['chrome.exe', 14, 2.1e9], ['Discord.exe', 6, 6.2e8], ['msedgewebview2.exe', 8, 4.1e8], ['Spotify.exe', 5, 3.3e8]].map(([name, count, mem]) => ({ name, count, mem })),
    kill: async (n) => n.map((name) => ({ name, ok: true })),
    rustStatus: async () => ({ running: false }),
    rustBoost: async () => ({ ok: false, msg: 'Rust не запущен — сначала зайди в игру' }),
    backup: async () => backup,
    restore: async () => { const r = Object.keys(backup); backup = {}; return { ok: true, restored: r }; },
    copy: async () => true,
    games: async () => { const g = {}; for (const [id, x] of Object.entries(demoGames)) g[id] = { ...x, installed: true, custom: true }; for (const id of Object.keys(g)) profiles[id] = profiles[id] || { tweaks: ['power', 'gamemode', 'gamedvr', 'dns'], close: [], priority: true, overlay: false, restore: true, dnd: true }; return { games: g, profiles }; },
    gamePriority: async () => ({ ok: false, msg: 'Игра не запущена (демо)' }),
    steamGames: async () => { await sleep(300); return [{ appid: '730', name: 'Counter-Strike 2' }, { appid: '570', name: 'Dota 2' }, { appid: '3241660', name: 'ROB RUN' }, { appid: '252490', name: 'Rust' }].map((g) => ({ ...g, added: !!demoGames['steam_' + g.appid] })); },
    gameCandidates: async () => { await sleep(300); return { ok: true, name: 'ROB RUN', candidates: [{ rel: 'RobRun\\Binaries\\Win64\\RobRun-Win64-Shipping.exe', size: 1.6e8, icon: 'icon.png' }, { rel: 'RobRun.exe', size: 4.1e5 }] }; },
    addGame: async (appid) => { const n = { '3241660': 'ROB RUN', '730': 'Counter-Strike 2', '570': 'Dota 2' }[appid] || 'Game'; demoGames['steam_' + appid] = { name: n, appid: Number(appid), exe: 'game.exe', icon: appid === '570' ? 'icon.png' : null }; return { ok: true }; },
    removeGame: async (id) => { delete demoGames[id]; return { ok: true }; },
    sessions: async () => demoSessions,
    sessionDelete: async (id) => { demoSessions = demoSessions.filter((x) => x.id !== id); return demoSessions; },
    sessionCurrent: async () => null,
    logError: async () => true,
    diagInfo: async () => 'PULSE 1.4.0 (demo)',
    openLogs: async () => true,
    appVersion: async () => '1.4.0',
    drives: async () => [{ name: 'C', root: 'C:\\', used: 435e9, free: 76e9 }, { name: 'D', root: 'D:\\', used: 610e9, free: 390e9 }],
    diskScan: async (p) => { for (let f = 0; f < 5; f++) { emit('disk-progress', { files: f * 41234, bytes: f * 37e9 }); await sleep(200); } return { ok: true, root: p, size: 435e9 }; },
    diskNode: async (p) => ({ path: p, size: 435e9, dirs: [['Users', 182e9], ['Program Files (x86)', 121e9], ['Windows', 38e9], ['Program Files', 33e9], ['ProgramData', 9.4e9], ['$Recycle.Bin', 3.1e9]].map(([n, s]) => ({ path: p.replace(/\\$/, '') + '\\' + n, size: s })), files: [{ path: p + 'hiberfil.sys', size: 12.7e9 }] }),
    diskCancel: async () => true,
    openInExplorer: async () => true,
    gameStatus: async () => Object.fromEntries(Object.keys(demoGames).map((id) => [id, { running: false, stage: null }])),
    saveProfile: async (id, p) => { profiles[id] = p; return profiles; },
    play: async (id) => {
      (async () => {
        emit('game-status', { id, stage: 'prepare', msg: 'Применяю буст' }); await sleep(500);
        emit('game-status', { id, stage: 'prepare', msg: '✓ Питание: максимальная производительность' }); await sleep(400);
        emit('game-status', { id, stage: 'launch', msg: 'Запускаю через Steam' }); await sleep(900);
        emit('game-status', { id, stage: 'running', msg: 'Игра запущена' });
      })();
      return { ok: true };
    },
    startupList: async () => [
      { name: 'Discord', cmd: 'C:\\Users\\User\\AppData\\Local\\Discord\\Update.exe --processStart Discord.exe', src: 'HKCU', enabled: true },
      { name: 'Steam', cmd: '"C:\\Program Files (x86)\\Steam\\steam.exe" -silent', src: 'HKCU', enabled: true },
      { name: 'SecurityHealth', cmd: '%windir%\\system32\\SecurityHealthSystray.exe', src: 'HKLM', enabled: true },
      { name: 'Spotify', cmd: 'C:\\Users\\User\\AppData\\Roaming\\Spotify\\Spotify.exe /minimized', src: 'HKCU', enabled: false },
    ],
    startupToggle: async () => ({ ok: true }),
    overlayToggle: async () => { ov = !ov; return ov; },
    overlayState: async () => ({ on: ov, pm: false }),
    pmInstall: async () => { for (let p = 0; p <= 100; p += 20) { emit('pm-progress', p); await sleep(150); } return { ok: true }; },
    settingsGet: async () => settings,
    health: async () => { await sleep(300); return { cpu: 'Intel(R) Core(TM) i5-14400F', ident: 'Intel64 Family 6 Model 191 Stepping 2', rev: 0x12B, biosVendor: 'American Megatrends', biosVersion: '1.80', biosDate: '2024-06-12', boardMaker: 'Micro-Star International Co., Ltd.', boardModel: 'PRO B760M-P DDR4 (MS-7D43)', uptimeH: 101.5 }; },
    restorePoints: async () => [{ desc: 'Windows Update', time: '2026-11-10T09:12:00' }, { desc: 'Установлен драйвер NVIDIA', time: '2026-11-02T21:40:00' }],
    restorePointCreate: async () => { await sleep(1200); return { ok: true, msg: 'Точка восстановления создана' }; },
    restorePointEnsure: async () => ({ skipped: true, recent: true }),
    protectionEnable: async () => ({ ok: true }),
    openUrl: async () => true,
    settingsSet: async (p) => Object.assign(settings, p),
    win: () => {},
  };
}
