// PULSE — главный процесс: окно, трей, оверлей и все действия с системой
const { app, BrowserWindow, ipcMain, clipboard, shell, Tray, Menu, nativeImage, globalShortcut, screen } = require('electron');
const path = require('path');
const os = require('os');
const fs = require('fs');
const https = require('https');
const { exec, spawn } = require('child_process');

let win = null;
let overlayWin = null;
let tray = null;
let quitting = false;

// один экземпляр программы
if (!app.requestSingleInstanceLock()) app.quit();
app.on('second-instance', () => showMain());

// ================= утилиты =================
function run(cmd, timeout = 60000) {
  return new Promise((resolve) => {
    exec(cmd, { windowsHide: true, maxBuffer: 20 * 1024 * 1024, timeout }, (err, stdout, stderr) => {
      resolve({ ok: !err, out: String(stdout || ''), err: String(stderr || (err && err.message) || '') });
    });
  });
}
function ps(script, timeout) {
  const full = '[Console]::OutputEncoding=[Text.Encoding]::UTF8;$ProgressPreference="SilentlyContinue";' + script;
  const enc = Buffer.from(full, 'utf16le').toString('base64');
  return run(`powershell -NoProfile -ExecutionPolicy Bypass -EncodedCommand ${enc}`, timeout);
}
const psStr = (s) => "'" + String(s).replace(/'/g, "''") + "'";
const GUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const send = (ch, data) => { if (win && !win.isDestroyed()) win.webContents.send(ch, data); };

// ================= файлы данных =================
const dataFile = (n) => path.join(app.getPath('userData'), n);
function readJson(n) { try { return JSON.parse(fs.readFileSync(dataFile(n), 'utf8')); } catch { return {}; } }
function writeJson(n, obj) {
  fs.mkdirSync(app.getPath('userData'), { recursive: true });
  fs.writeFileSync(dataFile(n), JSON.stringify(obj, null, 2));
}
function remember(id, value) {
  const b = readJson('backup.json');
  if (!(id in b)) { b[id] = value; writeJson('backup.json', b); }
}
const DEFAULT_SETTINGS = { tray: true, overlayPos: 'tl', trayHintShown: false, autoRP: true };
function getSettings() { return { ...DEFAULT_SETTINGS, ...readJson('settings.json') }; }
function setSettings(patch) { const s = { ...getSettings(), ...patch }; writeJson('settings.json', s); return s; }

// ================= реестр =================
async function regGet(key, name) {
  const r = await run(`reg query "${key}" /v ${name}`);
  if (!r.ok) return null;
  const m = r.out.match(new RegExp(name + '\\s+(REG_\\w+)\\s+(.*)'));
  return m ? { type: m[1], data: m[2].trim() } : null;
}
function regSet(key, name, type, data) {
  if (type === 'REG_DWORD' && /^0x/i.test(data)) data = String(parseInt(data, 16));
  return run(`reg add "${key}" /v ${name} /t ${type} /d "${data}" /f`);
}
const regDel = (key, name) => run(`reg delete "${key}" /v ${name} /f`);
async function regApplyList(list) {
  for (const [key, name, type, data] of list) {
    remember(`reg|${key}|${name}`, await regGet(key, name));
    const r = await regSet(key, name, type, data);
    if (!r.ok) return { ok: false, msg: r.err.trim() || 'Ошибка реестра' };
  }
  return { ok: true };
}

// ================= твики =================
const HIGH = '8c5e7fda-e8bf-4a96-9a85-a6e23a8c635c';
const ULTIMATE = 'e9a42b02-d5df-448d-aa00-03f14749eb61';
const TWEAKS = {
  async power() {
    const cur = await run('powercfg /getactivescheme');
    const g = (cur.out.match(GUID_RE) || [])[0];
    if (g) remember('power', g);
    const settings = getSettings();
    const list = await run('powercfg /list');
    let ult = settings.ultimate && list.out.toLowerCase().includes(settings.ultimate) ? settings.ultimate : null;
    if (!ult) {
      const d = await run(`powercfg -duplicatescheme ${ULTIMATE}`);
      ult = ((d.out.match(GUID_RE) || [])[0] || '').toLowerCase() || null;
      if (ult) setSettings({ ultimate: ult });
    }
    if (ult && (await run(`powercfg /setactive ${ult}`)).ok) return { ok: true, msg: 'Питание: максимальная производительность' };
    if ((await run(`powercfg /setactive ${HIGH}`)).ok) return { ok: true, msg: 'Питание: высокая производительность' };
    return { ok: false, msg: 'Не удалось сменить схему питания' };
  },
  async gamemode() {
    const r = await regApplyList([
      ['HKCU\\Software\\Microsoft\\GameBar', 'AutoGameModeEnabled', 'REG_DWORD', '1'],
      ['HKCU\\Software\\Microsoft\\GameBar', 'AllowAutoGameMode', 'REG_DWORD', '1'],
    ]);
    return r.ok ? { ok: true, msg: 'Игровой режим Windows включён' } : r;
  },
  async gamedvr() {
    const r = await regApplyList([
      ['HKCU\\System\\GameConfigStore', 'GameDVR_Enabled', 'REG_DWORD', '0'],
      ['HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\GameDVR', 'AppCaptureEnabled', 'REG_DWORD', '0'],
    ]);
    return r.ok ? { ok: true, msg: 'Фоновая запись Xbox отключена' } : r;
  },
  async mouse() {
    const k = 'HKCU\\Control Panel\\Mouse';
    const r = await regApplyList([[k, 'MouseSpeed', 'REG_SZ', '0'], [k, 'MouseThreshold1', 'REG_SZ', '0'], [k, 'MouseThreshold2', 'REG_SZ', '0']]);
    return r.ok ? { ok: true, msg: 'Ускорение мыши выключено (после перезахода в Windows)' } : r;
  },
  async dns() {
    const r = await run('ipconfig /flushdns');
    return { ok: r.ok, msg: r.ok ? 'DNS-кэш очищен' : 'Не удалось очистить DNS' };
  },
  async temp() {
    const res = await cleanGroups(['temp']);
    return { ok: true, msg: `Очищено ${fmtBytes(res.freed)}` };
  },
};

// ================= очистка =================
function fmtBytes(b) {
  if (b > 1024 ** 3) return (b / 1024 ** 3).toFixed(2) + ' ГБ';
  if (b > 1024 ** 2) return (b / 1024 ** 2).toFixed(1) + ' МБ';
  return Math.round(b / 1024) + ' КБ';
}
async function steamPath() {
  const r = await regGet('HKCU\\Software\\Valve\\Steam', 'SteamPath');
  return r ? r.data.replace(/\//g, '\\') : null;
}
async function cleanDefs() {
  const L = process.env.LOCALAPPDATA || '';
  const LL = L ? path.join(path.dirname(L), 'LocalLow') : '';
  const sp = await steamPath();
  const j = (...p) => path.join(...p);
  return [
    { id: 'temp', name: 'Временные файлы Windows', dirs: [os.tmpdir(), process.env.SystemRoot && j(process.env.SystemRoot, 'Temp'), L && j(L, 'CrashDumps')] },
    { id: 'shader', name: 'Кэш шейдеров NVIDIA и DirectX', warn: 'Первые запуски игр после очистки могут подтормаживать, пока кэш собирается заново',
      dirs: [L && j(L, 'NVIDIA', 'DXCache'), L && j(L, 'NVIDIA', 'GLCache'), L && j(L, 'D3DSCache'), LL && j(LL, 'NVIDIA', 'PerDriverVersion', 'DXCache'), LL && j(LL, 'NVIDIA', 'PerDriverVersion', 'GLCache')] },
    { id: 'steam', name: 'Кэш Steam', warn: 'Лучше закрыть Steam перед очисткой',
      dirs: [L && j(L, 'Steam', 'htmlcache'), sp && j(sp, 'appcache', 'httpcache')] },
  ].map((g) => ({ ...g, dirs: [...new Set(g.dirs.filter(Boolean))] }));
}
async function dirSize(dir) {
  let total = 0, entries;
  try { entries = await fs.promises.readdir(dir, { withFileTypes: true }); } catch { return 0; }
  for (const e of entries) {
    const p = path.join(dir, e.name);
    try { total += e.isDirectory() ? await dirSize(p) : (await fs.promises.stat(p)).size; } catch {}
  }
  return total;
}
async function scanClean() {
  const defs = await cleanDefs();
  for (const g of defs) {
    g.items = [];
    for (const d of g.dirs) g.items.push({ dir: d, size: await dirSize(d) });
    g.size = g.items.reduce((a, b) => a + b.size, 0);
  }
  return defs;
}
async function cleanGroups(ids) {
  const defs = (await cleanDefs()).filter((g) => ids.includes(g.id));
  let freed = 0;
  for (const g of defs) for (const d of g.dirs) {
    const before = await dirSize(d);
    let entries = [];
    try { entries = await fs.promises.readdir(d); } catch {}
    for (const n of entries) { try { await fs.promises.rm(path.join(d, n), { recursive: true, force: true }); } catch {} }
    freed += Math.max(0, before - (await dirSize(d)));
  }
  return { freed };
}

// ================= процессы =================
const PROTECTED = new Set([
  'system', 'system idle process', 'registry', 'smss.exe', 'csrss.exe', 'wininit.exe', 'winlogon.exe',
  'services.exe', 'lsass.exe', 'svchost.exe', 'dwm.exe', 'explorer.exe', 'memory compression',
  'fontdrvhost.exe', 'sihost.exe', 'ctfmon.exe', 'audiodg.exe', 'conhost.exe', 'taskhostw.exe',
  'runtimebroker.exe', 'searchhost.exe', 'startmenuexperiencehost.exe', 'shellexperiencehost.exe',
  'textinputhost.exe', 'securityhealthservice.exe', 'msmpeng.exe', 'nissrv.exe', 'spoolsv.exe',
  'wudfhost.exe', 'lsaiso.exe', 'rustclient.exe', 'easyanticheat.exe', 'dota2.exe', 'steam.exe',
  'steamwebhelper.exe', 'pulse.exe', 'electron.exe', 'nvcontainer.exe', 'nvdisplay.container.exe',
  'amdrsserv.exe', 'atiesrxx.exe', 'atieclxx.exe', 'tasklist.exe', 'powershell.exe', 'cmd.exe', 'presentmon.exe',
]);
async function tasklist() {
  const r = await run('tasklist /fo csv /nh');
  const out = [];
  for (const line of r.out.split(/\r?\n/)) {
    const cols = (line.match(/"([^"]*)"/g) || []).map((c) => c.slice(1, -1));
    if (cols.length >= 5) out.push({ name: cols[0], mem: (parseInt(cols[4].replace(/\D/g, ''), 10) || 0) * 1024 });
  }
  return out;
}
async function listProcesses() {
  const map = new Map();
  for (const p of await tasklist()) {
    if (PROTECTED.has(p.name.toLowerCase())) continue;
    const cur = map.get(p.name) || { name: p.name, count: 0, mem: 0 };
    cur.count++; cur.mem += p.mem; map.set(p.name, cur);
  }
  return [...map.values()].sort((a, b) => b.mem - a.mem).slice(0, 25);
}
async function killProcesses(names) {
  const results = [];
  for (const n of names) {
    if (!/^[\w .\-()]+\.exe$/i.test(n) || PROTECTED.has(n.toLowerCase())) continue;
    const r = await run(`taskkill /im "${n}" /f`);
    results.push({ name: n, ok: r.ok });
  }
  return results;
}
async function isRunning(exe) {
  const r = await run(`tasklist /fi "imagename eq ${exe}" /fo csv /nh`);
  return r.out.toLowerCase().includes(exe.toLowerCase());
}
async function setHighPriority(exe) {
  const name = exe.replace(/\.exe$/i, '');
  const r = await ps(`$p=Get-Process -Name ${psStr(name)} -ErrorAction SilentlyContinue; if(-not $p){'NONE'} else { try { $p | ForEach-Object { $_.PriorityClass='High' }; 'OK' } catch { 'FAIL' } }`);
  const o = r.out.trim();
  return o.includes('OK') ? 'ok' : o.includes('NONE') ? 'none' : 'fail';
}

// ================= мониторинг =================
let lastCpu = null;
function cpuPercent() {
  const t = os.cpus().reduce((a, c) => {
    const tot = Object.values(c.times).reduce((x, y) => x + y, 0);
    return { idle: a.idle + c.times.idle, total: a.total + tot };
  }, { idle: 0, total: 0 });
  let pct = 0;
  if (lastCpu) { const dt = t.total - lastCpu.total; pct = dt > 0 ? 100 * (1 - (t.idle - lastCpu.idle) / dt) : 0; }
  lastCpu = t;
  return Math.max(0, Math.min(100, pct));
}

const snap = { cpu: 0, ramTotal: os.totalmem(), ramFree: os.freemem(), disk: null, gpu: null, cpuTemp: null, ping: [] };
let gpuSupported = true, cpuTempSupported = true;

async function pollGpu() {
  if (!gpuSupported) return;
  const r = await run('nvidia-smi --query-gpu=name,utilization.gpu,temperature.gpu,clocks.gr,memory.used,memory.total,power.draw,fan.speed --format=csv,noheader,nounits', 5000);
  if (!r.ok) { gpuSupported = false; snap.gpu = null; return; }
  const c = r.out.split(/\r?\n/)[0].split(',').map((s) => s.trim());
  const n = (v) => (isNaN(parseFloat(v)) ? null : parseFloat(v));
  snap.gpu = { name: c[0], util: n(c[1]), temp: n(c[2]), clock: n(c[3]), memUsed: n(c[4]), memTotal: n(c[5]), power: n(c[6]), fan: n(c[7]) };
}
async function pollCpuTemp() {
  if (!cpuTempSupported) return;
  const r = await ps("(Get-CimInstance -Namespace root/wmi -ClassName MSAcpi_ThermalZoneTemperature -ErrorAction Stop | ForEach-Object { $_.CurrentTemperature }) -join ','", 8000);
  const vals = r.out.trim().split(',').map((v) => parseFloat(v) / 10 - 273.15).filter((v) => v > 5 && v < 120);
  if (!r.ok || !vals.length) { cpuTempSupported = false; snap.cpuTemp = null; return; }
  snap.cpuTemp = Math.max(...vals);
}
const PING_HOSTS = [{ name: 'Cloudflare', host: '1.1.1.1' }, { name: 'Google', host: '8.8.8.8' }, { name: 'Яндекс', host: '77.88.8.8' }];
async function pollPing() {
  snap.ping = await Promise.all(PING_HOSTS.map(async (h) => {
    const r = await run(`ping -n 1 -w 1500 ${h.host}`, 4000);
    const m = r.out.match(/[=<]\s*(\d+)\s*(?:ms|мс)/i);
    return { name: h.name, ms: m ? parseInt(m[1], 10) : null };
  }));
}
async function pollDisk() {
  try {
    const root = process.platform === 'win32' ? (process.env.SystemDrive || 'C:') + '\\' : '/';
    const s = await fs.promises.statfs(root);
    snap.disk = { total: s.blocks * s.bsize, free: s.bavail * s.bsize };
  } catch {}
}

let lastAlert = 0;
function checkAlerts() {
  const msgs = [];
  if (snap.gpu && snap.gpu.temp >= 85) msgs.push(`Видеокарта греется: ${snap.gpu.temp}°C`);
  if (snap.cpuTemp && snap.cpuTemp >= 90) msgs.push(`Процессор греется: ${Math.round(snap.cpuTemp)}°C`);
  if (msgs.length && Date.now() - lastAlert > 5 * 60 * 1000) { lastAlert = Date.now(); send('alert', msgs.join('. ')); }
}

function startMonitoring() {
  cpuPercent();
  setInterval(() => {
    snap.cpu = cpuPercent(); snap.ramTotal = os.totalmem(); snap.ramFree = os.freemem();
    pushOverlay();
    sessionTick();
  }, 1000);
  const loop = (fn, ms) => { const tick = async () => { try { await fn(); } catch {} setTimeout(tick, ms); }; tick(); };
  loop(pollGpu, 2000);
  loop(pollPing, 3000);
  loop(pollDisk, 15000);
  loop(pollCpuTemp, 10000);
  setInterval(checkAlerts, 5000);
  loop(sessionWatch, 5000);
}

async function sysinfo() {
  const gpu = await ps('(Get-CimInstance Win32_VideoController | Select-Object -ExpandProperty Name) -join " / "');
  const osName = await ps('(Get-CimInstance Win32_OperatingSystem).Caption');
  const admin = (await run('net session')).ok;
  const cpus = os.cpus();
  return {
    cpu: cpus[0] ? cpus[0].model.trim() : '—', threads: cpus.length, ram: os.totalmem(),
    gpu: gpu.out.trim() || '—', os: osName.out.trim() || `${os.type()} ${os.release()}`, admin,
  };
}

// ================= FPS через PresentMon =================
let pmProc = null;
const fpsState = { fps: null, app: null, frames: new Map(), t0: Date.now() };
const pmPath = () => dataFile('PresentMon.exe');
const FPS_IGNORE = new Set(['dwm.exe', 'pulse.exe', 'electron.exe', 'presentmon.exe', 'explorer.exe', '<unknown>', '<error>', 'nvidia overlay.exe', 'claude.exe']);

function httpsGet(url, headers = {}) {
  return new Promise((resolve, reject) => {
    https.get(url, { headers: { 'User-Agent': 'PULSE-Optimizer', ...headers } }, (res) => {
      if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location) {
        res.resume(); return resolve(httpsGet(res.headers.location, headers));
      }
      if (res.statusCode !== 200) { res.resume(); return reject(new Error('HTTP ' + res.statusCode)); }
      resolve(res);
    }).on('error', reject);
  });
}
async function installPresentMon() {
  let url = 'https://github.com/GameTechDev/PresentMon/releases/download/v2.0.0/PresentMon-2.0.0-x64.exe';
  try {
    const res = await httpsGet('https://api.github.com/repos/GameTechDev/PresentMon/releases?per_page=15', { Accept: 'application/vnd.github+json' });
    let body = ''; for await (const ch of res) body += ch;
    for (const rel of JSON.parse(body)) {
      if (rel.prerelease) continue;
      const a = (rel.assets || []).find((x) => /^PresentMon-[\d.]+-x64\.exe$/i.test(x.name));
      if (a) { url = a.browser_download_url; break; }
    }
  } catch {}
  const res = await httpsGet(url);
  const total = parseInt(res.headers['content-length'] || '0', 10);
  const tmp = pmPath() + '.part';
  fs.mkdirSync(app.getPath('userData'), { recursive: true });
  await new Promise((resolve, reject) => {
    const f = fs.createWriteStream(tmp);
    let got = 0;
    res.on('data', (c) => { got += c.length; if (total) send('pm-progress', Math.round((got / total) * 100)); });
    res.pipe(f);
    f.on('finish', resolve); f.on('error', reject); res.on('error', reject);
  });
  fs.renameSync(tmp, pmPath());
  return { ok: true, url };
}

// PresentMon нужен и оверлею, и записи сессии — держим его, пока есть хоть один «пользователь»
const pmUsers = new Set();
function pmUse(who, on) {
  if (on) pmUsers.add(who); else pmUsers.delete(who);
  if (pmUsers.size) startPresentMon(); else stopPresentMon();
}
function startPresentMon() {
  if (pmProc || !fs.existsSync(pmPath())) return;
  pmProc = spawn(pmPath(), ['--output_stdout', '--stop_existing_session', '--session_name', 'PULSE_FPS'], { windowsHide: true });
  let header = null, buf = '';
  pmProc.stdout.on('data', (chunk) => {
    buf += chunk.toString();
    const lines = buf.split(/\r?\n/); buf = lines.pop();
    for (const line of lines) {
      const cols = line.split(',');
      if (!header) {
        if (cols.includes('Application')) {
          const ft = ['MsBetweenPresents', 'msBetweenPresents', 'FrameTime', 'MsBetweenDisplayChange'].map((c) => cols.indexOf(c)).find((i) => i >= 0);
          header = { app: cols.indexOf('Application'), ft: ft == null ? -1 : ft };
        }
        continue;
      }
      const appName = (cols[header.app] || '').toLowerCase();
      if (!appName || FPS_IGNORE.has(appName)) continue;
      fpsState.frames.set(appName, (fpsState.frames.get(appName) || 0) + 1);
      if (session && appName === session.exeLower) {
        session.frameCount++;
        if (header.ft >= 0 && session.frameTimes.length < 3000000) {
          const v = parseFloat(cols[header.ft]);
          if (v > 0 && v < 1000) session.frameTimes.push(v);
        }
      }
    }
  });
  pmProc.on('exit', () => { pmProc = null; });
  pmProc.on('error', () => { pmProc = null; });
}
function stopPresentMon() { if (pmProc) { try { pmProc.kill(); } catch {} pmProc = null; } fpsState.fps = null; fpsState.app = null; }
function updateFps() {
  const dt = (Date.now() - fpsState.t0) / 1000;
  if (dt < 0.9) return;
  let best = null, cnt = 0;
  for (const [k, v] of fpsState.frames) if (v > cnt) { cnt = v; best = k; }
  fpsState.fps = best && cnt / dt > 3 ? Math.round(cnt / dt) : null;
  fpsState.app = fpsState.fps ? best : null;
  fpsState.frames.clear(); fpsState.t0 = Date.now();
}

// ================= оверлей =================
function placeOverlay() {
  if (!overlayWin) return;
  const wa = screen.getPrimaryDisplay().bounds;
  const [w] = overlayWin.getSize();
  const pos = getSettings().overlayPos;
  overlayWin.setPosition(pos === 'tr' ? wa.x + wa.width - w - 16 : wa.x + 16, wa.y + 16);
}
function showOverlay() {
  if (!overlayWin) {
    overlayWin = new BrowserWindow({
      width: 236, height: 168, frame: false, transparent: true, resizable: false, skipTaskbar: true,
      focusable: false, alwaysOnTop: true, hasShadow: false, show: false,
      webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true },
    });
    overlayWin.setAlwaysOnTop(true, 'screen-saver');
    overlayWin.setIgnoreMouseEvents(true);
    overlayWin.loadFile(path.join(__dirname, 'src', 'overlay.html'));
    overlayWin.once('ready-to-show', () => overlayWin && overlayWin.showInactive());
    overlayWin.on('closed', () => { overlayWin = null; });
  } else overlayWin.showInactive();
  placeOverlay();
  pmUse('overlay', true);
  send('overlay-state', true); updateTrayMenu();
}
function hideOverlay() {
  if (overlayWin) { overlayWin.close(); overlayWin = null; }
  pmUse('overlay', false);
  send('overlay-state', false); updateTrayMenu();
}
const toggleOverlay = () => (overlayWin ? hideOverlay() : showOverlay());
function pushOverlay() {
  if (!overlayWin || overlayWin.isDestroyed()) return;
  updateFps();
  overlayWin.webContents.send('overlay-data', { ...snap, fps: fpsState.fps, fpsApp: fpsState.app, pm: fs.existsSync(pmPath()) });
}

// ================= игры =================
const GAMES = {}; // встроенных игр нет — пользователь добавляет свои
// для известных игр заранее знаем главный exe (у Unity/Source игр он маленький)
const KNOWN_EXE = { '252490': 'RustClient.exe', '570': 'game\\bin\\win64\\dota2.exe', '730': 'game\\bin\\win64\\cs2.exe' };
// встроенные + добавленные пользователем игры
function allGames() {
  const custom = getSettings().customGames || {};
  const out = { ...GAMES };
  for (const [id, g] of Object.entries(custom)) out[id] = { ...g, custom: true };
  return out;
}

async function steamLibs() {
  const sp = await steamPath();
  const libs = new Map(); // ключ без учёта регистра: Steam пишет один путь по-разному
  const add = (p) => { const n = path.resolve(p).replace(/[\\/]+$/, ''); const k = n.toLowerCase(); if (!libs.has(k)) libs.set(k, n); };
  if (sp) {
    add(sp);
    try {
      const vdf = fs.readFileSync(path.join(sp, 'steamapps', 'libraryfolders.vdf'), 'utf8');
      for (const m of vdf.matchAll(/"path"\s+"([^"]+)"/g)) add(m[1].replace(/\\\\/g, '\\'));
    } catch {}
  }
  return [...libs.values()];
}
const acfField = (acf, key) => (acf.match(new RegExp(`"${key}"\\s+"([^"]*)"`)) || [])[1];

// ищем игры в библиотеках Steam и берём их настоящие иконки из exe
let gamesCache = null;
async function findGames() {
  if (gamesCache) return gamesCache;
  const out = {};
  const libs = await steamLibs();
  for (const [id, g] of Object.entries(allGames())) {
    const info = { ...g, installed: false, exePath: null, icon: null };
    for (const lib of libs) {
      try {
        const acf = fs.readFileSync(path.join(lib, 'steamapps', `appmanifest_${g.appid}.acf`), 'utf8');
        const dir = acfField(acf, 'installdir');
        if (!dir) continue;
        const exePath = path.join(lib, 'steamapps', 'common', dir, g.rel);
        info.installed = true;
        if (fs.existsSync(exePath)) {
          info.exePath = exePath;
          try { info.icon = (await app.getFileIcon(exePath, { size: 'large' })).toDataURL(); } catch {}
        }
        break;
      } catch {}
    }
    out[id] = info;
  }
  gamesCache = out;
  return out;
}

// список всех установленных игр Steam (для «Добавить игру»)
const SKIP_APPIDS = new Set(['228980', '1070560', '1391110', '1628350', '1493710', '1826330', '2180100']);
async function listSteamGames() {
  const added = allGames();
  const addedIds = new Set(Object.values(added).map((g) => String(g.appid)));
  const out = [];
  for (const lib of await steamLibs()) {
    let files = [];
    try { files = await fs.promises.readdir(path.join(lib, 'steamapps')); } catch { continue; }
    for (const f of files) {
      if (!/^appmanifest_\d+\.acf$/.test(f)) continue;
      try {
        const acf = await fs.promises.readFile(path.join(lib, 'steamapps', f), 'utf8');
        const appid = acfField(acf, 'appid'), name = acfField(acf, 'name'), dir = acfField(acf, 'installdir');
        if (!appid || !name || !dir || SKIP_APPIDS.has(appid) || /redist|runtime|proton|steamworks|dedicated server|sdk/i.test(name)) continue;
        if (out.some((x) => x.appid === appid)) continue; // одна игра — одна строка
        out.push({ appid, name, dir, lib, added: addedIds.has(appid) });
      } catch {}
    }
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}
// exe-кандидаты в папке игры (главный exe обычно самый большой)
const EXE_SKIP = /unins|crash|setup|redist|vcredist|dxsetup|directx|easyanticheat|eac_|battleye|be_service|prereq|dotnet|cefsharp|helper|report|updater|install|launcherpatcher|vc_|dxwebsetup|oalinst|physx|uplay|epicgames|ue4prereq|unitycrashhandler|crs-|steamerrorreporter/i;
async function exeCandidates(root, gameName = '', known = null) {
  const found = [];
  async function walk(dir, depth) {
    let entries;
    try { entries = await fs.promises.readdir(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const p = path.join(dir, e.name);
      if (e.isDirectory() && depth < 4 && !/^(_commonredist|redist|redistributables|directx|prereqs|easyanticheat|battleye|support)$/i.test(e.name)) await walk(p, depth + 1);
      else if (e.isFile() && /\.exe$/i.test(e.name) && !EXE_SKIP.test(e.name)) {
        try { found.push({ rel: path.relative(root, p), size: (await fs.promises.stat(p)).size }); } catch {}
      }
    }
  }
  await walk(root, 0);
  const tokens = gameName.toLowerCase().split(/[^a-zа-я0-9]+/).filter((t) => t.length > 2);
  for (const f of found) {
    const n = path.basename(f.rel).toLowerCase();
    let score = Math.log10(f.size + 1);
    if (/shipping\.exe$/.test(n)) score += 6;                      // Unreal: настоящий процесс игры
    if (tokens.some((t) => n.includes(t))) score += 2;              // имя похоже на название игры
    if (/launcher|server|editor|tool|benchmark|config/.test(n)) score -= 3;
    if (known && f.rel.toLowerCase() === known.toLowerCase()) score += 100;
    f.score = score;
  }
  return found.sort((a, b) => b.score - a.score).slice(0, 8);
}
async function gameCandidates(appid) {
  const g = (await listSteamGames()).find((x) => x.appid === String(appid));
  if (!g) return { ok: false, msg: 'Игра не найдена' };
  const root = path.join(g.lib, 'steamapps', 'common', g.dir);
  const list = await exeCandidates(root, g.name, KNOWN_EXE[g.appid]);
  for (const c of list) { try { c.icon = (await app.getFileIcon(path.join(root, c.rel), { size: 'normal' })).toDataURL(); } catch {} }
  return { ok: true, name: g.name, candidates: list };
}
async function addGame(appid, rel) {
  const g = (await listSteamGames()).find((x) => x.appid === String(appid));
  if (!g || !rel || /\.\./.test(rel) || !/\.exe$/i.test(rel)) return { ok: false, msg: 'Не получилось добавить' };
  const custom = getSettings().customGames || {};
  custom['steam_' + g.appid] = { name: g.name, appid: Number(g.appid), exe: path.basename(rel), rel };
  setSettings({ customGames: custom });
  gamesCache = null;
  return { ok: true };
}
function removeGame(id) {
  const s = getSettings();
  const custom = s.customGames || {};
  delete custom[id];
  const profiles = s.profiles || {};
  delete profiles[id];
  setSettings({ customGames: custom, profiles });
  gamesCache = null;
  return { ok: true };
}

const DEFAULT_PROFILE = { tweaks: ['power', 'gamemode', 'gamedvr', 'dns'], close: [], priority: true, overlay: false, restore: true, dnd: true };
function getProfiles() {
  const s = getSettings().profiles || {};
  const out = {};
  for (const id of Object.keys(allGames())) out[id] = { ...DEFAULT_PROFILE, ...(s[id] || {}) };
  return out;
}

// ---- «Не беспокоить»: уведомления Windows выключаются на время игры ----
const PUSH_KEY = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\PushNotifications';
async function setToasts(enabled) {
  const r = await ps(`
$k='HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\PushNotifications'
if(-not (Test-Path $k)){ New-Item -Path $k -Force | Out-Null }
Set-ItemProperty -Path $k -Name ToastEnabled -Value ${enabled ? 1 : 0} -Type DWord
Get-Service -Name 'WpnUserService_*' -ErrorAction SilentlyContinue | Restart-Service -Force -ErrorAction SilentlyContinue
'OK'`, 30000);
  return r.out.includes('OK');
}
async function dndOn() {
  const s = getSettings();
  if (!s.dndActive) {
    const cur = await regGet(PUSH_KEY, 'ToastEnabled');
    setSettings({ dndActive: true, dndOrig: cur ? parseInt(cur.data, 16) : 1 });
  }
  return setToasts(false);
}
async function dndOff() {
  const s = getSettings();
  if (!s.dndActive) return true;
  const ok = await setToasts(s.dndOrig !== 0);
  setSettings({ dndActive: false });
  return ok;
}

const gameState = {}; // id -> {stage}
async function gameStatus() {
  const out = {};
  for (const [id, g] of Object.entries(allGames())) out[id] = { running: await isRunning(g.exe), stage: (gameState[id] || {}).stage || null };
  return out;
}
async function playGame(id) {
  const g = allGames()[id];
  if (!g) return { ok: false, msg: 'Неизвестная игра' };
  if (gameState[id] && gameState[id].stage) return { ok: false, msg: 'Уже запускается' };
  const p = getProfiles()[id];
  const st = (stage, msg) => { gameState[id] = { stage }; send('game-status', { id, stage, msg }); };

  st('prepare', 'Проверяю точку восстановления');
  const rp = await ensureRestorePoint();
  if (!rp.skipped) send('game-status', { id, stage: 'prepare', msg: (rp.ok ? '✓ ' : '• ') + rp.msg });
  st('prepare', 'Применяю буст');
  for (const t of p.tweaks) if (TWEAKS[t]) { const r = await TWEAKS[t](); send('game-status', { id, stage: 'prepare', msg: (r.ok ? '✓ ' : '✕ ') + r.msg }); }
  if (p.close.length) {
    const running = new Set((await tasklist()).map((x) => x.name.toLowerCase()));
    const toKill = p.close.filter((n) => running.has(n.toLowerCase()));
    if (toKill.length) { await killProcesses(toKill); send('game-status', { id, stage: 'prepare', msg: '✓ Закрыто: ' + toKill.join(', ') }); }
  }
  if (p.dnd) { const ok = await dndOn(); send('game-status', { id, stage: 'prepare', msg: ok ? '✓ Уведомления Windows выключены на время игры' : '✕ Не удалось выключить уведомления' }); }
  if (p.overlay) showOverlay();

  st('launch', `Запускаю ${g.name} через Steam`);
  shell.openExternal(`steam://rungameid/${g.appid}`);

  (async () => {
    let found = false;
    for (let i = 0; i < 90; i++) { await sleep(3000); if (await isRunning(g.exe)) { found = true; break; } }
    if (!found) {
      if (p.dnd) await dndOff();
      if (p.overlay) hideOverlay();
      st(null, `${g.name} не запустился за 4 минуты${p.dnd ? ', уведомления включены обратно' : ''}`);
      return;
    }
    st('running', `${g.name} запущен`);
    if (p.priority) {
      await sleep(8000);
      const r = await setHighPriority(g.exe);
      send('game-status', { id, stage: 'running', msg: r === 'ok' ? '✓ Высокий приоритет' : '✕ Приоритет не сменился (античит)' });
    }
    while (await isRunning(g.exe)) await sleep(5000);
    if (p.overlay) hideOverlay();
    if (p.dnd) await dndOff();
    if (p.restore) { await restoreAll(); st(null, `${g.name} закрыт, настройки и уведомления возвращены`); }
    else st(null, `${g.name} закрыт${p.dnd ? ', уведомления включены' : ''}`);
  })();
  return { ok: true };
}

// ================= отчёты после игры =================
let session = null;
const pct = (arr, p) => { if (!arr.length) return null; const s = [...arr].sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))]; };
const avg = (arr) => (arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : null);
function startSession(id, g) {
  const b = readJson('backup.json');
  session = {
    id, name: g.name, appid: g.appid, exeLower: g.exe.toLowerCase(), start: Date.now(), last: Date.now(),
    boost: Object.keys(b).length > 0, pm: fs.existsSync(pmPath()), samples: [], frameTimes: [], frameCount: 0,
  };
  pmUse('session', true);
}
function sessionTick() {
  if (!session) return;
  const now = Date.now(), dt = (now - session.last) / 1000;
  session.last = now;
  const fps = session.pm && dt > 0 ? session.frameCount / dt : null;
  session.frameCount = 0;
  const pings = (snap.ping || []).map((p) => p.ms).filter((x) => x != null);
  session.samples.push({
    t: Math.round((now - session.start) / 1000), fps: fps != null ? Math.round(fps) : null, cpu: Math.round(snap.cpu),
    gpu: snap.gpu ? snap.gpu.util : null, gpuTemp: snap.gpu ? snap.gpu.temp : null, cpuTemp: snap.cpuTemp != null ? Math.round(snap.cpuTemp) : null,
    ping: pings.length ? Math.min(...pings) : null,
  });
  if (session.samples.length > 6 * 3600) session.samples.shift(); // не больше 6 часов
}
function endSession() {
  const s = session; session = null;
  pmUse('session', false);
  if (!s) return;
  const dur = Math.round((Date.now() - s.start) / 1000);
  if (dur < 60) return; // слишком короткая — не считаем
  const live = s.samples.slice(15); // первые секунды — загрузка
  const fpsS = live.map((x) => x.fps).filter((x) => x != null && x > 0);
  let avgFps = null, low1 = null;
  if (s.frameTimes.length > 500) {
    const ft = s.frameTimes;
    avgFps = 1000 / avg(ft);
    const worst = [...ft].sort((a, b) => b - a).slice(0, Math.max(1, Math.floor(ft.length / 100)));
    low1 = 1000 / avg(worst);
  } else if (fpsS.length > 10) {
    avgFps = avg(fpsS);
    low1 = pct(fpsS, 1);
  }
  const num = (k) => live.map((x) => x[k]).filter((x) => x != null);
  // график: не больше 300 точек
  const step = Math.max(1, Math.ceil(s.samples.length / 300));
  const timeline = [];
  for (let i = 0; i < s.samples.length; i += step) {
    const chunk = s.samples.slice(i, i + step);
    const f = chunk.map((x) => x.fps).filter((x) => x != null), gt = chunk.map((x) => x.gpuTemp).filter((x) => x != null);
    timeline.push({ t: chunk[0].t, fps: f.length ? Math.round(avg(f)) : null, gpuTemp: gt.length ? Math.max(...gt) : null });
  }
  const rep = {
    id: 's' + s.start, gameId: s.id, name: s.name, appid: s.appid, start: s.start, duration: dur, boost: s.boost, hasFps: avgFps != null,
    avgFps: avgFps != null ? Math.round(avgFps) : null, low1: low1 != null ? Math.round(low1) : null,
    maxGpuTemp: num('gpuTemp').length ? Math.max(...num('gpuTemp')) : null, avgGpu: num('gpu').length ? Math.round(avg(num('gpu'))) : null,
    avgCpu: num('cpu').length ? Math.round(avg(num('cpu'))) : null, maxCpuTemp: num('cpuTemp').length ? Math.max(...num('cpuTemp')) : null,
    avgPing: num('ping').length ? Math.round(avg(num('ping'))) : null, timeline,
  };
  const list = readJson('sessions.json').list || [];
  list.unshift(rep);
  writeJson('sessions.json', { list: list.slice(0, 60) });
  send('session-report', { id: rep.id, name: rep.name, avgFps: rep.avgFps });
  if (tray) tray.displayBalloon({ title: `Отчёт по ${rep.name} готов`, content: rep.avgFps ? `Средний FPS: ${rep.avgFps}, 1% low: ${rep.low1}` : 'Температуры и загрузка за игру — в разделе «Отчёты»', iconType: 'info' });
}
// следим за запуском добавленных игр (и через «Играть», и как обычно)
async function sessionWatch() {
  const games = allGames();
  if (!Object.keys(games).length) return;
  const running = new Set((await tasklist()).map((p) => p.name.toLowerCase()));
  if (session) { if (!running.has(session.exeLower)) endSession(); return; }
  for (const [id, g] of Object.entries(games)) if (g.exe && running.has(g.exe.toLowerCase())) { startSession(id, g); break; }
}
function listSessions() { return readJson('sessions.json').list || []; }
function deleteSession(id) { const list = listSessions().filter((x) => x.id !== id); writeJson('sessions.json', { list }); return list; }

// ================= анализ диска =================
function makeLimiter(n) {
  let active = 0; const q = [];
  const next = () => {
    if (active >= n || !q.length) return;
    active++;
    const { fn, res, rej } = q.shift();
    fn().then(res, rej).finally(() => { active--; next(); });
  };
  return (fn) => new Promise((res, rej) => { q.push({ fn, res, rej }); next(); });
}
const KEEP_DEPTH = 6;
let diskMap = new Map();
let diskJob = null;
async function listDrives() {
  const r = await ps(`ConvertTo-Json -Compress -InputObject @(Get-PSDrive -PSProvider FileSystem | Where-Object { $_.Used -ne $null } | ForEach-Object { [pscustomobject]@{name=$_.Name; root=$_.Root; used=[double]$_.Used; free=[double]$_.Free} })`);
  try { const v = JSON.parse(r.out.trim() || '[]'); return Array.isArray(v) ? v : [v]; } catch { return []; }
}
async function diskScan(root) {
  if (diskJob) diskJob.cancelled = true;
  const job = diskJob = { cancelled: false, files: 0, bytes: 0 };
  const limit = makeLimiter(48);
  const map = new Map();
  let lastEmit = 0;
  async function walk(dir, depth) {
    if (job.cancelled) return 0;
    let entries;
    try { entries = await limit(() => fs.promises.readdir(dir, { withFileTypes: true })); } catch { return 0; }
    let total = 0;
    const subdirs = [], big = [], jobs = [];
    for (const e of entries) {
      if (e.isSymbolicLink()) continue; // пропускаем ссылки и junction, чтобы не считать дважды
      const p = path.join(dir, e.name);
      if (e.isDirectory()) subdirs.push(p);
      else if (e.isFile()) jobs.push(limit(() => fs.promises.stat(p)).then((st) => {
        total += st.size; job.files++; job.bytes += st.size;
        if (depth < KEEP_DEPTH && st.size >= 50 * 1024 * 1024) big.push({ path: p, size: st.size });
      }).catch(() => {}));
    }
    await Promise.all(jobs);
    const sizes = await Promise.all(subdirs.map(async (d) => ({ path: d, size: await walk(d, depth + 1) })));
    for (const s of sizes) total += s.size;
    if (depth < KEEP_DEPTH) {
      map.set(dir.toLowerCase(), {
        path: dir, size: total,
        dirs: sizes.filter((s) => s.size > 0).sort((a, b) => b.size - a.size).slice(0, 80),
        files: big.sort((a, b) => b.size - a.size).slice(0, 30),
      });
    }
    const now = Date.now();
    if (now - lastEmit > 400) { lastEmit = now; send('disk-progress', { files: job.files, bytes: job.bytes, dir }); }
    return total;
  }
  const total = await walk(root, 0);
  if (job.cancelled) return { ok: false, cancelled: true };
  for (const [k, v] of map) diskMap.set(k, v);
  diskJob = null;
  return { ok: true, root, size: total, files: job.files };
}
function diskNode(p) { return diskMap.get(String(p).toLowerCase()) || null; }
function openInExplorer(p) {
  p = String(p || '');
  if (!p || !fs.existsSync(p)) return false;
  try { if (fs.statSync(p).isDirectory()) shell.openPath(p); else shell.showItemInFolder(p); return true; } catch { return false; }
}

// ================= автозагрузка =================
const STARTUP_LIST_PS = `
$out=@()
$skip=@('PSPath','PSParentPath','PSChildName','PSDrive','PSProvider')
$sets=@(
 @{src='HKCU';run='HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Run';appr='HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\StartupApproved\\Run'},
 @{src='HKLM';run='HKLM:\\Software\\Microsoft\\Windows\\CurrentVersion\\Run';appr='HKLM:\\Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\StartupApproved\\Run'},
 @{src='HKLM32';run='HKLM:\\Software\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Run';appr='HKLM:\\Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\StartupApproved\\Run32'}
)
foreach($s in $sets){
 $p=Get-ItemProperty -Path $s.run -ErrorAction SilentlyContinue
 if(-not $p){continue}
 $a=Get-ItemProperty -Path $s.appr -ErrorAction SilentlyContinue
 foreach($pr in $p.PSObject.Properties){
  if($skip -contains $pr.Name){continue}
  $en=$true
  if($a -and $a.PSObject.Properties[$pr.Name]){ $b=$a.($pr.Name); if($b -and ($b[0] -band 1)){$en=$false} }
  $out+=[pscustomobject]@{name=$pr.Name;cmd=[string]$pr.Value;src=$s.src;enabled=$en}
 }
}
$fs=@(@{src='UserFolder';path=[Environment]::GetFolderPath('Startup');appr='HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\StartupApproved\\StartupFolder'},
      @{src='CommonFolder';path=[Environment]::GetFolderPath('CommonStartup');appr='HKLM:\\Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\StartupApproved\\StartupFolder'})
foreach($f in $fs){
 if(-not (Test-Path $f.path)){continue}
 $a=Get-ItemProperty -Path $f.appr -ErrorAction SilentlyContinue
 Get-ChildItem -Path $f.path -File -ErrorAction SilentlyContinue | Where-Object { $_.Name -ne 'desktop.ini' } | ForEach-Object {
  $en=$true
  if($a -and $a.PSObject.Properties[$_.Name]){ $b=$a.($_.Name); if($b -and ($b[0] -band 1)){$en=$false} }
  $out+=[pscustomobject]@{name=$_.Name;cmd=$_.FullName;src=$f.src;enabled=$en}
 }
}
ConvertTo-Json -Compress -InputObject @($out)
`;
const APPR = {
  HKCU: 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\StartupApproved\\Run',
  HKLM: 'HKLM:\\Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\StartupApproved\\Run',
  HKLM32: 'HKLM:\\Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\StartupApproved\\Run32',
  UserFolder: 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\StartupApproved\\StartupFolder',
  CommonFolder: 'HKLM:\\Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\StartupApproved\\StartupFolder',
};
async function startupList() {
  const r = await ps(STARTUP_LIST_PS);
  try { const v = JSON.parse(r.out.trim() || '[]'); return Array.isArray(v) ? v : [v]; } catch { return []; }
}
async function startupToggle(item, enable) {
  const key = APPR[item && item.src];
  if (!key) return { ok: false };
  const first = enable ? 2 : 3;
  const r = await ps(`
$k=${psStr(key)}
if(-not (Test-Path $k)){ New-Item -Path $k -Force | Out-Null }
[byte[]]$v=@(${first},0,0,0,0,0,0,0,0,0,0,0)
Set-ItemProperty -Path $k -Name ${psStr(item.name)} -Value $v -Type Binary
'OK'`);
  return { ok: r.out.includes('OK'), err: r.err.trim() };
}


// ================= проверка ПК: микрокод, BIOS, точки восстановления =================
async function healthInfo() {
  const r = await ps(`
$p=Get-ItemProperty 'HKLM:\\HARDWARE\\DESCRIPTION\\System\\CentralProcessor\\0'
$rev=$null; $b=$p.'Update Revision'; if($b -and $b.Length -ge 8){ $rev=[BitConverter]::ToUInt32($b,4) }
$bios=Get-CimInstance Win32_BIOS
$bb=Get-CimInstance Win32_BaseBoard
$cs=Get-CimInstance Win32_ComputerSystem
$os=Get-CimInstance Win32_OperatingSystem
$bd=''; if($bios.ReleaseDate){ $bd=$bios.ReleaseDate.ToString('yyyy-MM-dd') }
[pscustomobject]@{
 cpu=([string]$p.ProcessorNameString).Trim(); ident=[string]$p.Identifier; rev=$rev
 biosVendor=[string]$bios.Manufacturer; biosVersion=[string]$bios.SMBIOSBIOSVersion; biosDate=$bd
 boardMaker=[string]$bb.Manufacturer; boardModel=[string]$bb.Product
 pcMaker=[string]$cs.Manufacturer; pcModel=[string]$cs.Model
 uptimeH=[math]::Round(((Get-Date)-$os.LastBootUpTime).TotalHours,1)
} | ConvertTo-Json -Compress`, 30000);
  try { return JSON.parse(r.out.trim()); } catch { return { error: r.err.trim() || 'Не удалось прочитать данные' }; }
}
async function restorePoints() {
  const r = await ps(`$l=@(Get-ComputerRestorePoint -ErrorAction SilentlyContinue | Sort-Object SequenceNumber -Descending | Select-Object -First 6 | ForEach-Object { [pscustomobject]@{desc=[string]$_.Description; time=$_.ConvertToDateTime($_.CreationTime).ToString('o')} })
ConvertTo-Json -Compress -InputObject $l`, 30000);
  try { const v = JSON.parse(r.out.trim() || '[]'); return Array.isArray(v) ? v : [v]; } catch { return []; }
}
async function createRestorePoint() {
  const r = await ps(`
$before=@(Get-ComputerRestorePoint -ErrorAction SilentlyContinue).Count
try { Checkpoint-Computer -Description 'PULSE' -RestorePointType 'MODIFY_SETTINGS' -ErrorAction Stop -WarningAction SilentlyContinue } catch { 'ERR:' + $_.Exception.Message; return }
$after=@(Get-ComputerRestorePoint -ErrorAction SilentlyContinue).Count
if($after -gt $before){'OK'} else {'LIMIT'}`, 240000);
  const o = r.out.trim();
  if (o.includes('OK')) return { ok: true, msg: 'Точка восстановления создана' };
  if (o.includes('LIMIT')) return { ok: false, limit: true, msg: 'Windows разрешает одну точку в сутки — недавно она уже создавалась' };
  return { ok: false, disabled: true, msg: (o.replace(/^ERR:/, '') || r.err.trim() || 'Защита системы, похоже, выключена').slice(0, 200) };
}
async function enableProtection() {
  const r = await ps(`try { Enable-ComputerRestore -Drive "$env:SystemDrive\\" -ErrorAction Stop; 'OK' } catch { 'ERR:' + $_.Exception.Message }`, 60000);
  return r.out.includes('OK') ? { ok: true } : { ok: false, msg: r.out.replace(/^ERR:/, '').trim() || r.err.trim() };
}
// перед первым бустом/игрой — точка восстановления, если свежей нет (раз в 7 дней)
async function ensureRestorePoint() {
  if (getSettings().autoRP === false) return { skipped: true };
  const week = Date.now() - 7 * 24 * 3600 * 1000;
  const pts = await restorePoints();
  if (pts.some((p) => p.desc === 'PULSE' && Date.parse(p.time) > week)) return { skipped: true, recent: true };
  return createRestorePoint();
}

// ================= откат =================
async function restoreAll() {
  const b = readJson('backup.json');
  const done = [];
  for (const [id, val] of Object.entries(b)) {
    if (id === 'power' && val) { await run(`powercfg /setactive ${val}`); done.push('Схема питания'); }
    else if (id.startsWith('reg|')) {
      const [, key, name] = id.split('|');
      if (val === null) await regDel(key, name); else await regSet(key, name, val.type, val.data);
      done.push(name);
    }
  }
  writeJson('backup.json', {});
  return { ok: true, restored: done };
}


// ================= журнал ошибок =================
function logError(where, err) {
  try {
    const text = err && err.stack ? err.stack : String(err);
    const line = `${new Date().toISOString()} [${where}] v${app.getVersion()} ${text}\n`;
    fs.mkdirSync(app.getPath('userData'), { recursive: true });
    const f = dataFile('errors.log');
    try { if (fs.statSync(f).size > 512 * 1024) fs.renameSync(f, dataFile('errors.old.log')); } catch {}
    fs.appendFileSync(f, line);
  } catch {}
}
process.on('uncaughtException', (e) => logError('main', e));
process.on('unhandledRejection', (e) => logError('main', e));
async function diagInfo() {
  const i = await sysinfo();
  let tail = '';
  try { tail = fs.readFileSync(dataFile('errors.log'), 'utf8').trim().split('\n').slice(-30).join('\n'); } catch {}
  const games = Object.values(allGames()).map((g) => g.name).join(', ') || '—';
  return [
    `PULSE ${app.getVersion()}`, `Windows: ${i.os}`, `CPU: ${i.cpu} (${i.threads} потоков)`, `GPU: ${i.gpu}`,
    `RAM: ${Math.round(i.ram / 1024 ** 3)} ГБ`, `Админ: ${i.admin ? 'да' : 'нет'}`, `Модуль FPS: ${fs.existsSync(pmPath()) ? 'есть' : 'нет'}`, `Игры: ${games}`,
    '', '--- последние ошибки ---', tail || 'ошибок нет',
  ].join('\n');
}

// ================= IPC =================
const handle = (ch, fn) => ipcMain.handle(ch, (_e, ...a) => fn(...a));
handle('stats', () => ({ ...snap }));
handle('sysinfo', sysinfo);
handle('tweak', async (id) => { if (!TWEAKS[id]) return { ok: false, msg: 'Неизвестный твик' }; try { return await TWEAKS[id](); } catch (e) { return { ok: false, msg: String(e.message || e) }; } });
handle('scanClean', scanClean);
handle('clean', (ids) => cleanGroups(Array.isArray(ids) ? ids : []));
handle('processes', listProcesses);
handle('kill', (names) => killProcesses(Array.isArray(names) ? names : []));
handle('rustStatus', async () => ({ running: await isRunning('RustClient.exe') }));
handle('rustBoost', async () => {
  const r = await setHighPriority('RustClient.exe');
  if (r === 'ok') return { ok: true, msg: 'Rust получил высокий приоритет' };
  if (r === 'none') return { ok: false, msg: 'Rust не запущен — сначала зайди в игру' };
  return { ok: false, msg: 'Античит не дал сменить приоритет. Используй параметр -high в Steam' };
});
handle('backup', () => readJson('backup.json'));
handle('restore', restoreAll);
handle('copy', (text) => { clipboard.writeText(String(text)); return true; });
handle('games', async () => ({ games: await findGames(), profiles: getProfiles() }));
handle('steamGames', listSteamGames);
handle('gameCandidates', gameCandidates);
handle('addGame', addGame);
handle('removeGame', removeGame);
handle('drives', listDrives);
handle('sessions', listSessions);
handle('logError', (msg) => { logError('ui', msg); return true; });
handle('diagInfo', diagInfo);
handle('openLogs', () => { shell.openPath(app.getPath('userData')); return true; });
handle('appVersion', () => app.getVersion());
handle('sessionDelete', deleteSession);
handle('sessionCurrent', () => (session ? { name: session.name, since: session.start, pm: session.pm } : null));
handle('diskScan', diskScan);
handle('diskNode', diskNode);
handle('diskCancel', () => { if (diskJob) diskJob.cancelled = true; return true; });
handle('openInExplorer', openInExplorer);
handle('gamePriority', async (id) => {
  const g = allGames()[id]; if (!g) return { ok: false, msg: 'Неизвестная игра' };
  const r = await setHighPriority(g.exe);
  if (r === 'ok') return { ok: true, msg: `${g.name} получил высокий приоритет` };
  if (r === 'none') return { ok: false, msg: `${g.name} не запущен — сначала зайди в игру` };
  return { ok: false, msg: 'Не удалось сменить приоритет (возможно, античит). Используй параметр -high в Steam' };
});
handle('gameStatus', gameStatus);
handle('saveProfile', (id, prof) => { const s = getSettings(); const profiles = s.profiles || {}; profiles[id] = prof; setSettings({ profiles }); return getProfiles(); });
handle('play', playGame);
handle('startupList', startupList);
handle('startupToggle', startupToggle);
handle('overlayToggle', () => { toggleOverlay(); return !!overlayWin; });
handle('overlayState', () => ({ on: !!overlayWin, pm: fs.existsSync(pmPath()) }));
handle('pmInstall', async () => { try { return await installPresentMon(); } catch (e) { return { ok: false, msg: String(e.message || e) }; } });
handle('settingsGet', getSettings);
handle('health', healthInfo);
handle('restorePoints', restorePoints);
handle('restorePointCreate', createRestorePoint);
handle('restorePointEnsure', ensureRestorePoint);
handle('protectionEnable', enableProtection);
handle('openUrl', (u) => { if (/^https:\/\//.test(String(u))) shell.openExternal(String(u)); return true; });
handle('settingsSet', (patch) => { const s = setSettings(patch || {}); placeOverlay(); return s; });
ipcMain.on('win', (_e, action) => {
  if (!win) return;
  if (action === 'min') win.minimize();
  else if (action === 'max') win.isMaximized() ? win.unmaximize() : win.maximize();
  else if (action === 'close') win.close();
});

// ================= окно и трей =================
const iconPath = path.join(__dirname, 'src', 'icon.png');
function showMain() { if (!win) return; if (win.isMinimized()) win.restore(); win.show(); win.focus(); }
function updateTrayMenu() {
  if (!tray) return;
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: 'Открыть PULSE', click: showMain },
    { label: overlayWin ? 'Выключить оверлей' : 'Включить оверлей', accelerator: 'Ctrl+Shift+F', click: toggleOverlay },
    { type: 'separator' },
    { label: 'Выход', click: () => { quitting = true; app.quit(); } },
  ]));
}
function createTray() {
  tray = new Tray(nativeImage.createFromPath(iconPath).resize({ width: 16, height: 16 }));
  tray.setToolTip('PULSE');
  tray.on('click', showMain);
  updateTrayMenu();
}
function createWindow() {
  win = new BrowserWindow({
    width: 1280, height: 820, minWidth: 1080, minHeight: 700,
    frame: false, backgroundColor: '#000000', show: false, icon: iconPath,
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false },
  });
  win.loadFile(path.join(__dirname, 'src', 'index.html'));
  win.once('ready-to-show', () => win.show());
  win.on('close', (e) => {
    if (quitting || !getSettings().tray) return;
    e.preventDefault(); win.hide();
    const s = getSettings();
    if (!s.trayHintShown && tray) {
      tray.displayBalloon({ title: 'PULSE работает в трее', content: 'Значок возле часов. Выйти — правый клик → Выход.', iconType: 'info' });
      setSettings({ trayHintShown: true });
    }
  });
}

app.whenReady().then(() => {
  createWindow();
  createTray();
  startMonitoring();
  globalShortcut.register('Ctrl+Shift+F', toggleOverlay);
  // если PULSE закрылся посреди игры — вернуть уведомления, когда игр уже нет
  setTimeout(async () => {
    if (!getSettings().dndActive) return;
    const st = await gameStatus();
    if (!Object.values(st).some((x) => x.running)) dndOff();
  }, 5000);
});
app.on('before-quit', () => { quitting = true; try { endSession(); } catch {} stopPresentMon(); });
app.on('will-quit', () => globalShortcut.unregisterAll());
app.on('window-all-closed', () => app.quit());
