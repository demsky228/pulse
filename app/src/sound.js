// PULSE — звуки, синтезируются на лету (без файлов)
(() => {
  let ctx = null, master = null;
  const cfg = { on: true, web: true, vol: 0.5 };
  try { Object.assign(cfg, JSON.parse(localStorage.getItem('pulse.sound') || '{}')); } catch {}

  function ac() {
    if (!ctx) {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return null;
      ctx = new AC();
      master = ctx.createGain(); master.connect(ctx.destination);
    }
    if (ctx.state === 'suspended') ctx.resume();
    master.gain.value = cfg.vol;
    return ctx;
  }
  function tone(freq, dur, { type = 'sine', gain = 0.2, slide = 0, delay = 0 } = {}) {
    const c = ac(); if (!c) return;
    const t = c.currentTime + delay;
    const o = c.createOscillator(), g = c.createGain();
    o.type = type; o.frequency.setValueAtTime(freq, t);
    if (slide) o.frequency.exponentialRampToValueAtTime(Math.max(30, freq * slide), t + dur);
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(gain, t + 0.01);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    o.connect(g); g.connect(master); o.start(t); o.stop(t + dur + 0.05);
  }

  let lastPluck = 0;
  const SCALE = [220, 247, 277, 330, 370, 440, 494, 554, 659, 740];
  window.sfx = {
    cfg,
    save() { try { localStorage.setItem('pulse.sound', JSON.stringify(cfg)); } catch {} },
    // тихий «щипок» нити паутины
    pluck(ring) {
      if (!cfg.on || !cfg.web) return;
      const now = performance.now();
      if (now - lastPluck < 70) return;
      lastPluck = now;
      const f = SCALE[Math.max(0, SCALE.length - 1 - (ring % SCALE.length))];
      tone(f, 0.35, { type: 'triangle', gain: 0.05 });
    },
    click() { if (cfg.on) tone(160, 0.18, { type: 'sine', gain: 0.12, slide: 0.5 }); },
    boostStart() { if (cfg.on) tone(120, 0.9, { type: 'sawtooth', gain: 0.05, slide: 6 }); },
    step(ok) { if (cfg.on) tone(ok ? 880 : 200, 0.12, { type: ok ? 'triangle' : 'square', gain: ok ? 0.08 : 0.05 }); },
    boostDone() { if (cfg.on) [523, 659, 784, 1047].forEach((f, i) => tone(f, 0.5, { type: 'triangle', gain: 0.09, delay: i * 0.08 })); },
    alert() { if (cfg.on) [0, 0.18].forEach((d) => tone(740, 0.15, { type: 'square', gain: 0.06, delay: d })); },
    test() { this.boostDone(); },
  };
})();
