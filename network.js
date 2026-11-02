// Subtle animated neural network drawn in the page margins.
// A small feed-forward graph sits in each side gutter (outside the reading
// column). Signals travel from layer to layer and briefly light up the
// connections they pass through. Everything fades out toward the text.
(function () {
  "use strict";

  var FPS = 30;
  var MIN_GUTTER = 110;      // px of free space a side needs before we draw there
  var LAYER_SPACING = 95;    // target px between layers
  var CONTENT_PAD = 28;      // keep this far away from the text column
  var GREEN = "60, 179, 113"; // site accent, drawn at low alpha so it reads dark green

  var canvas = document.createElement("canvas");
  canvas.className = "edge-network";
  canvas.setAttribute("aria-hidden", "true");
  document.body.appendChild(canvas);
  var ctx = canvas.getContext("2d");
  if (!ctx) return;

  var reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)");
  var W = 0, H = 0;
  var nets = [];     // one network per usable gutter
  var pulses = [];

  function rand(a, b) { return a + Math.random() * (b - a); }

  function buildNet(x0, x1, fadeTowardRight) {
    var width = x1 - x0;
    var layers = Math.max(2, Math.min(5, Math.round(width / LAYER_SPACING) + 1));
    var cols = [];
    for (var l = 0; l < layers; l++) {
      var x = x0 + (layers === 1 ? width / 2 : (width * l) / (layers - 1));
      var count = Math.round(rand(5, 9) * (H / 900)) + 2;
      var col = [];
      for (var k = 0; k < count; k++) {
        var y = ((k + 0.5) / count) * H + rand(-0.25, 0.25) * (H / count);
        col.push({
          bx: x + rand(-12, 12), by: y,
          x: 0, y: 0,
          ph: rand(0, Math.PI * 2), amp: rand(3, 8),
          glow: 0, out: []
        });
      }
      cols.push(col);
    }
    // sparse connections: each node links to 2-3 nodes in the next layer
    var edges = [];
    for (var l2 = 0; l2 < layers - 1; l2++) {
      var next = cols[l2 + 1];
      cols[l2].forEach(function (n) {
        var links = Math.min(next.length, 2 + (Math.random() < 0.4 ? 1 : 0));
        var picked = next.slice().sort(function (a, b) {
          return Math.abs(a.by - n.by) - Math.abs(b.by - n.by) + rand(-H * 0.15, H * 0.15);
        }).slice(0, links);
        picked.forEach(function (m) {
          var e = { a: n, b: m, glow: 0 };
          n.out.push(e);
          edges.push(e);
        });
      });
    }
    return { cols: cols, edges: edges, x0: x0, x1: x1, fadeRight: fadeTowardRight };
  }

  function resize() {
    var dpr = Math.min(window.devicePixelRatio || 1, 2);
    W = window.innerWidth;
    H = window.innerHeight;
    canvas.width = Math.round(W * dpr);
    canvas.height = Math.round(H * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    // find the reading column from the page itself
    var rect = document.body.getBoundingClientRect();
    var left = rect.left - CONTENT_PAD;
    var right = W - rect.right - CONTENT_PAD;

    nets = [];
    pulses = [];
    if (left >= MIN_GUTTER) nets.push(buildNet(24, left - 10, true));
    if (right >= MIN_GUTTER) nets.push(buildNet(rect.right + CONTENT_PAD + 10, W - 24, false));
  }

  // alpha falloff toward the text column
  function fade(net, x) {
    var t = (x - net.x0) / Math.max(1, net.x1 - net.x0); // 0..1 left to right
    var d = net.fadeRight ? 1 - t : t;                    // 0 at the side nearest the text
    return 0.35 + 0.65 * Math.min(1, d * 1.6);
  }

  function spawnPulse(net) {
    var start = net.cols[0][Math.floor(Math.random() * net.cols[0].length)];
    var e = start.out[Math.floor(Math.random() * start.out.length)];
    if (e) pulses.push({ net: net, e: e, t: 0, speed: rand(0.6, 1.1) });
  }

  var lastSpawn = 0;

  function step(dt, time) {
    var s = time * 0.001;
    nets.forEach(function (net) {
      net.cols.forEach(function (col) {
        col.forEach(function (n) {
          n.x = n.bx + Math.sin(s * 0.5 + n.ph) * n.amp * 0.5;
          n.y = n.by + Math.cos(s * 0.4 + n.ph) * n.amp;
          n.glow *= Math.pow(0.12, dt);
        });
      });
      net.edges.forEach(function (e) { e.glow *= Math.pow(0.2, dt); });
    });

    if (nets.length && time - lastSpawn > 700) {
      lastSpawn = time;
      spawnPulse(nets[Math.floor(Math.random() * nets.length)]);
    }

    for (var i = pulses.length - 1; i >= 0; i--) {
      var p = pulses[i];
      p.t += dt * p.speed;
      p.e.glow = Math.max(p.e.glow, 1 - Math.abs(p.t - 0.5));
      if (p.t >= 1) {
        p.e.b.glow = 1;
        var outs = p.e.b.out;
        // keep firing into the next layer, sometimes branching
        if (outs.length) {
          p.e = outs[Math.floor(Math.random() * outs.length)];
          p.t = 0;
          if (Math.random() < 0.25 && outs.length > 1 && pulses.length < 40) {
            pulses.push({ net: p.net, e: outs[Math.floor(Math.random() * outs.length)], t: 0, speed: p.speed });
          }
        } else {
          pulses.splice(i, 1);
        }
      }
    }
  }

  function draw() {
    ctx.clearRect(0, 0, W, H);
    ctx.lineWidth = 1;
    nets.forEach(function (net) {
      net.edges.forEach(function (e) {
        var f = fade(net, (e.a.x + e.b.x) / 2);
        ctx.strokeStyle = "rgba(" + GREEN + "," + (f * (0.07 + 0.28 * e.glow)).toFixed(3) + ")";
        ctx.beginPath();
        ctx.moveTo(e.a.x, e.a.y);
        ctx.lineTo(e.b.x, e.b.y);
        ctx.stroke();
      });
      net.cols.forEach(function (col) {
        col.forEach(function (n) {
          var f = fade(net, n.x);
          var r = 2.2 + n.glow * 1.6;
          ctx.fillStyle = "rgba(" + GREEN + "," + (f * (0.22 + 0.5 * n.glow)).toFixed(3) + ")";
          ctx.beginPath();
          ctx.arc(n.x, n.y, r, 0, Math.PI * 2);
          ctx.fill();
        });
      });
    });
    pulses.forEach(function (p) {
      var a = p.e.a, b = p.e.b;
      var x = a.x + (b.x - a.x) * p.t, y = a.y + (b.y - a.y) * p.t;
      var f = fade(p.net, x);
      ctx.fillStyle = "rgba(" + GREEN + "," + (f * 0.55).toFixed(3) + ")";
      ctx.beginPath();
      ctx.arc(x, y, 1.8, 0, Math.PI * 2);
      ctx.fill();
    });
  }

  var raf = 0, last = 0, frameMs = 1000 / FPS;

  function loop(now) {
    raf = requestAnimationFrame(loop);
    if (now - last < frameMs) return;
    var dt = last ? Math.min((now - last) / 1000, 0.1) : 0;
    last = now;
    step(dt, now);
    draw();
  }

  function start() {
    cancelAnimationFrame(raf);
    raf = 0;
    last = 0;
    if (reduceMotion.matches || document.hidden) {
      step(0, 0);
      draw(); // one still frame
      return;
    }
    raf = requestAnimationFrame(loop);
  }

  var resizeTimer = 0;
  window.addEventListener("resize", function () {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(function () { resize(); start(); }, 150);
  });
  document.addEventListener("visibilitychange", start);
  if (reduceMotion.addEventListener) reduceMotion.addEventListener("change", start);

  resize();
  start();
})();
