// PULSE — оверлей поверх игры
try { const c = localStorage.getItem('pulse.hot'); if (c) document.documentElement.style.setProperty('--hot', c); } catch {}
const $ = (id) => document.getElementById(id);

function render(d) {
  const fps = $('fps');
  if (d.fps) { fps.textContent = d.fps; fps.className = 'fps' + (d.fps < 40 ? ' hot' : ''); $('app').textContent = d.fpsApp || ''; }
  else { fps.textContent = d.pm ? 'нет игры' : 'нет модуля'; fps.className = 'fps na'; $('app').textContent = ''; }
  $('cpu').textContent = Math.round(d.cpu) + '%';
  if (d.gpu) {
    $('gpu').textContent = (d.gpu.util ?? '—') + '%';
    $('gt').textContent = (d.gpu.temp ?? '—') + '°C';
    $('gt').className = d.gpu.temp >= 83 ? 'hot' : '';
  }
  const used = d.ramTotal - d.ramFree;
  $('ram').textContent = (used / 1024 ** 3).toFixed(1) + ' / ' + (d.ramTotal / 1024 ** 3).toFixed(0) + ' ГБ';
  const p = (d.ping || []).map((x) => x.ms).filter((x) => x != null);
  $('ping').textContent = p.length ? Math.min(...p) + ' мс' : '—';
}

if (window.pulse) window.pulse.on('overlay-data', render);
else render({ fps: 144, fpsApp: 'rustclient.exe', cpu: 37, gpu: { util: 96, temp: 66 }, ramTotal: 32 * 1024 ** 3, ramFree: 18 * 1024 ** 3, ping: [{ ms: 21 }], pm: true });
