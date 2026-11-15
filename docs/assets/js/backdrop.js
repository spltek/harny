/* ============================================================================
   backdrop.js — the machine room behind the page.
   A slow constellation of nodes on a teal grid, plus signal packets that run
   the grid lines. Cheap on purpose: ~30fps, pauses when hidden, and a single
   static frame when the visitor asked for reduced motion.
   ========================================================================= */
(() => {
  "use strict";

  const canvas = document.getElementById("backdrop");
  if (!canvas) return;
  const ctx = canvas.getContext("2d", { alpha: true });
  if (!ctx) return;

  const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  const CYAN = "95, 230, 245";
  const TAN = "208, 136, 86";
  const GRID = 72;

  let w = 0;
  let h = 0;
  let dpr = 1;
  let nodes = [];
  let packets = [];
  let raf = 0;
  let last = 0;
  let visible = true;

  const rand = (a, b) => a + Math.random() * (b - a);

  function resize() {
    dpr = Math.min(window.devicePixelRatio || 1, 2);
    w = canvas.clientWidth || window.innerWidth;
    h = canvas.clientHeight || window.innerHeight;
    canvas.width = Math.floor(w * dpr);
    canvas.height = Math.floor(h * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    const count = Math.round(Math.min(84, Math.max(26, (w * h) / 26000)));
    nodes = Array.from({ length: count }, () => ({
      x: rand(0, w),
      y: rand(0, h),
      vx: rand(-0.12, 0.12),
      vy: rand(-0.1, 0.1),
      r: rand(0.7, 1.9),
      tan: Math.random() > 0.86,
      phase: rand(0, Math.PI * 2),
    }));
  }

  function spawnPacket() {
    const horizontal = Math.random() > 0.45;
    const speed = rand(0.9, 2.4);
    if (horizontal) {
      const y = Math.round(rand(1, h / GRID)) * GRID;
      const ltr = Math.random() > 0.5;
      packets.push({
        x: ltr ? -60 : w + 60,
        y,
        vx: ltr ? speed : -speed,
        vy: 0,
        life: 1,
        len: rand(40, 130),
      });
    } else {
      const x = Math.round(rand(1, w / GRID)) * GRID;
      const ttb = Math.random() > 0.5;
      packets.push({
        x,
        y: ttb ? -60 : h + 60,
        vx: 0,
        vy: ttb ? speed : -speed,
        life: 1,
        len: rand(40, 120),
      });
    }
  }

  function grid() {
    ctx.lineWidth = 1;
    ctx.strokeStyle = `rgba(${CYAN}, 0.045)`;
    ctx.beginPath();
    for (let x = 0; x <= w; x += GRID) {
      ctx.moveTo(x + 0.5, 0);
      ctx.lineTo(x + 0.5, h);
    }
    for (let y = 0; y <= h; y += GRID) {
      ctx.moveTo(0, y + 0.5);
      ctx.lineTo(w, y + 0.5);
    }
    ctx.stroke();

    // every fourth line is a little brighter — a circuit board, not graph paper
    ctx.strokeStyle = `rgba(${CYAN}, 0.09)`;
    ctx.beginPath();
    for (let x = 0; x <= w; x += GRID * 4) {
      ctx.moveTo(x + 0.5, 0);
      ctx.lineTo(x + 0.5, h);
    }
    for (let y = 0; y <= h; y += GRID * 4) {
      ctx.moveTo(0, y + 0.5);
      ctx.lineTo(w, y + 0.5);
    }
    ctx.stroke();
  }

  function drawNodes(dt) {
    for (const n of nodes) {
      n.x += n.vx * dt * 0.06;
      n.y += n.vy * dt * 0.06;
      n.phase += dt * 0.001;
      if (n.x < -20) n.x = w + 20;
      if (n.x > w + 20) n.x = -20;
      if (n.y < -20) n.y = h + 20;
      if (n.y > h + 20) n.y = -20;
    }

    // proximity links
    for (let i = 0; i < nodes.length; i++) {
      for (let j = i + 1; j < nodes.length; j++) {
        const a = nodes[i];
        const b = nodes[j];
        const dx = a.x - b.x;
        const dy = a.y - b.y;
        const d2 = dx * dx + dy * dy;
        if (d2 > 150 * 150) continue;
        const alpha = (1 - Math.sqrt(d2) / 150) * 0.16;
        ctx.strokeStyle = `rgba(${a.tan || b.tan ? TAN : CYAN}, ${alpha.toFixed(3)})`;
        ctx.lineWidth = 0.6;
        ctx.beginPath();
        ctx.moveTo(a.x, a.y);
        ctx.lineTo(b.x, b.y);
        ctx.stroke();
      }
    }

    for (const n of nodes) {
      const pulse = 0.55 + 0.45 * Math.sin(n.phase);
      ctx.fillStyle = `rgba(${n.tan ? TAN : CYAN}, ${(0.18 + 0.3 * pulse).toFixed(3)})`;
      ctx.beginPath();
      ctx.arc(n.x, n.y, n.r, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  function drawPackets(dt) {
    if (Math.random() < 0.02 && packets.length < 9) spawnPacket();

    for (let i = packets.length - 1; i >= 0; i--) {
      const p = packets[i];
      p.x += p.vx * dt * 0.12;
      p.y += p.vy * dt * 0.12;

      const off = p.vx !== 0 ? -Math.sign(p.vx) * p.len : 0;
      const offY = p.vy !== 0 ? -Math.sign(p.vy) * p.len : 0;
      const grad = ctx.createLinearGradient(p.x, p.y, p.x + off, p.y + offY);
      grad.addColorStop(0, `rgba(${CYAN}, 0.5)`);
      grad.addColorStop(1, `rgba(${CYAN}, 0)`);
      ctx.strokeStyle = grad;
      ctx.lineWidth = 1.1;
      ctx.beginPath();
      ctx.moveTo(p.x, p.y);
      ctx.lineTo(p.x + off, p.y + offY);
      ctx.stroke();

      ctx.fillStyle = `rgba(${CYAN}, 0.85)`;
      ctx.beginPath();
      ctx.arc(p.x, p.y, 1.5, 0, Math.PI * 2);
      ctx.fill();

      if (p.x < -220 || p.x > w + 220 || p.y < -220 || p.y > h + 220) packets.splice(i, 1);
    }
  }

  function frame(now) {
    raf = requestAnimationFrame(frame);
    if (!visible) return;
    const dt = Math.min(now - last, 48);
    if (dt < 30) return; // ~30fps ceiling
    last = now;

    ctx.clearRect(0, 0, w, h);
    grid();
    drawNodes(dt);
    drawPackets(dt);
  }

  function staticFrame() {
    ctx.clearRect(0, 0, w, h);
    grid();
    drawNodes(16);
  }

  resize();
  window.addEventListener("resize", () => {
    resize();
    if (reduce) staticFrame();
  });

  document.addEventListener("visibilitychange", () => {
    visible = !document.hidden;
    last = 0;
  });

  if (reduce) {
    staticFrame();
  } else {
    raf = requestAnimationFrame(frame);
  }

  // stop the loop if the element is removed (defensive, no leak)
  window.addEventListener("pagehide", () => cancelAnimationFrame(raf));
})();
