// PULSE — живая паутина на фоне: нити загораются возле курсора
(() => {
  const cv = document.getElementById('web');
  const ctx = cv.getContext('2d');
  let HOT = [255, 42, 61];
  const toRgb = (c) => { const h = String(c).trim().replace('#', ''); return [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16) || 0); };
  // смена цвета паутины из настроек
  window.setWebColor = (c) => { HOT = toRgb(c); document.documentElement.style.setProperty('--hot', c); };
  try { const saved = localStorage.getItem('pulse.hot'); if (saved) window.setWebColor(saved); } catch {}

  const R_GLOW = 210;   // радиус, в котором нити загораются
  const R_PULL = 170;   // радиус, в котором нити тянутся к курсору
  const rand = (a, b) => a + Math.random() * (b - a);

  let W, H, dpr, cx, cy, nodes, segs;
  const mouse = { x: -9999, y: -9999 };
  const ripples = [];

  function build() {
    dpr = window.devicePixelRatio || 1;
    W = window.innerWidth; H = window.innerHeight;
    cv.width = W * dpr; cv.height = H * dpr;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    cx = W * 0.66; cy = H * 0.36;
    const maxR = Math.hypot(Math.max(cx, W - cx), Math.max(cy, H - cy)) * 1.08;
    const S = 24;
    const angles = Array.from({ length: S }, (_, i) => (i / S) * Math.PI * 2 + rand(-0.07, 0.07));
    const rings = [];
    for (let r = 16; r < maxR; r = r * rand(1.13, 1.19) + 7) rings.push(r);

    const mk = (x, y) => ({ x0: x, y0: y, x, y, vx: 0, vy: 0, heat: 0 });
    const center = mk(cx, cy);
    nodes = [center];
    const grid = rings.map((r) => angles.map((a) => {
      const rr = r * rand(0.95, 1.05);
      const n = mk(cx + Math.cos(a) * rr, cy + Math.sin(a) * rr);
      nodes.push(n);
      return n;
    }));

    segs = [];
    const add = (a, b, ring, k) => segs.push({ a, b, ring, k, heat: 0 });
    for (let s = 0; s < S; s++) {
      add(center, grid[0][s], false, 0);
      for (let k = 0; k < rings.length - 1; k++) add(grid[k][s], grid[k + 1][s], false, k);
    }
    for (let k = 0; k < rings.length; k++) {
      for (let s = 0; s < S; s++) {
        if (k > 2 && Math.random() < 0.03) continue; // пара порванных нитей для живости
        add(grid[k][s], grid[k][(s + 1) % S], true, k);
      }
    }
  }

  function step() {
    // нити слегка тянутся за курсором и пружинят обратно
    for (const n of nodes) {
      let tx = n.x0, ty = n.y0;
      const dx = mouse.x - n.x0, dy = mouse.y - n.y0;
      const d = Math.hypot(dx, dy);
      if (d < R_PULL && d > 0.1) {
        const k = Math.pow(1 - d / R_PULL, 2) * 26;
        tx += (dx / d) * k; ty += (dy / d) * k;
      }
      n.vx = (n.vx + (tx - n.x) * 0.07) * 0.84;
      n.vy = (n.vy + (ty - n.y) * 0.07) * 0.84;
      n.x += n.vx; n.y += n.vy;
      const p = Math.max(0, 1 - Math.hypot(mouse.x - n.x, mouse.y - n.y) / (R_GLOW * 0.6));
      n.heat = Math.max(p * p, n.heat * 0.93);
    }

    // волны от клика
    for (let i = ripples.length - 1; i >= 0; i--) {
      ripples[i].r += 9;
      if (ripples[i].r > Math.max(W, H) * 1.3) ripples.splice(i, 1);
    }

    for (const s of segs) {
      const mx = (s.a.x + s.b.x) / 2, my = (s.a.y + s.b.y) / 2;
      const d = Math.hypot(mouse.x - mx, mouse.y - my);
      let p = Math.max(0, 1 - d / R_GLOW);
      p *= p;
      for (const r of ripples) {
        const dd = Math.abs(Math.hypot(r.x - mx, r.y - my) - r.r);
        if (dd < 40) p = Math.max(p, (1 - dd / 40) * (1 - r.r / (Math.max(W, H) * 1.3)) * 0.9);
      }
      if (s.ring && p > 0.55 && s.heat < 0.55 && window.sfx) window.sfx.pluck(s.k); // звук «щипка» нити
      s.heat = Math.max(p, s.heat * 0.945); // плавное затухание
    }
  }

  function path(s) {
    ctx.moveTo(s.a.x, s.a.y);
    if (s.ring) {
      // кольцевые нити провисают к центру
      const mx = (s.a.x + s.b.x) / 2, my = (s.a.y + s.b.y) / 2;
      const sag = 0.1;
      ctx.quadraticCurveTo(mx + (cx - mx) * sag * 0.25, my + (cy - my) * sag * 0.25, s.b.x, s.b.y);
    } else ctx.lineTo(s.b.x, s.b.y);
  }

  function draw() {
    ctx.clearRect(0, 0, W, H);

    // базовая белая паутина — одним проходом
    ctx.beginPath();
    for (const s of segs) path(s);
    ctx.strokeStyle = 'rgba(255,255,255,0.075)';
    ctx.lineWidth = 1;
    ctx.stroke();

    // горящие нити
    ctx.lineCap = 'round';
    for (const s of segs) {
      if (s.heat < 0.015) continue;
      const h = s.heat;
      const w = Math.min(1, h * 1.6); // от белого к цвету
      const r = Math.round(255 + (HOT[0] - 255) * w);
      const g = Math.round(255 + (HOT[1] - 255) * w);
      const b = Math.round(255 + (HOT[2] - 255) * w);
      ctx.beginPath(); path(s);
      ctx.strokeStyle = `rgba(${r},${g},${b},${0.12 + h * 0.85})`;
      ctx.lineWidth = 1 + h * 1.3;
      ctx.shadowColor = `rgba(${HOT[0]},${HOT[1]},${HOT[2]},${h})`;
      ctx.shadowBlur = h > 0.25 ? 14 * h : 0;
      ctx.stroke();
    }
    ctx.shadowBlur = 0;

    // светящиеся узлы
    for (const n of nodes) {
      if (n.heat < 0.05) continue;
      ctx.beginPath();
      ctx.arc(n.x, n.y, 1 + n.heat * 2.2, 0, Math.PI * 2);
      ctx.fillStyle = `rgba(${HOT[0]},${HOT[1]},${HOT[2]},${n.heat})`;
      ctx.fill();
    }
  }

  function loop() { step(); draw(); requestAnimationFrame(loop); }

  window.addEventListener('mousemove', (e) => { mouse.x = e.clientX; mouse.y = e.clientY; });
  document.addEventListener('mouseleave', () => { mouse.x = mouse.y = -9999; });
  window.addEventListener('mousedown', (e) => { ripples.push({ x: e.clientX, y: e.clientY, r: 0 }); if (window.sfx) window.sfx.click(); });
  let t;
  window.addEventListener('resize', () => { clearTimeout(t); t = setTimeout(build, 120); });

  build();
  loop();
})();
