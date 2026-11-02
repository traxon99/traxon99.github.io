// Margin decoration: a small convolutional network drawn in 3D.
//
// Each side gutter holds a vertical stack of feature-map planes that shrink
// toward the output, like a CNN diagram. Each node connects only to the
// nodes below it in its receptive field. The stack turns slowly in
// perspective. Forward passes run top to bottom: the input map gets a random
// activation pattern, then each layer lights up in order from the weighted
// sum of the layer above (ReLU).
(function () {
  "use strict";

  var FPS = 30;
  var MIN_GUTTER = 120;        // px of free margin a side needs before we draw there
  var CONTENT_PAD = 28;        // keep this far away from the text column
  var FOCAL = 900;             // perspective strength (smaller = more dramatic)
  var PITCH = 0.42;            // camera looks down on the planes by this much (rad)
  var LAYER_TIME = 0.5;        // seconds for activations to cross one layer
  var GRID = [5, 4, 4, 3, 2];  // nodes per side of each feature map
  var SCALE = [1, 0.84, 0.7, 0.55, 0.38];

  // palette (all derived from the site's accent rgb(60,179,113))
  var C_LINK = "47, 125, 86";    // dim link green
  var C_NODE = "60, 179, 113";   // accent
  var C_HOT = "150, 235, 185";   // core of an active node / signal

  var canvas = document.createElement("canvas");
  canvas.className = "edge-network";
  canvas.setAttribute("aria-hidden", "true");
  document.body.appendChild(canvas);
  var ctx = canvas.getContext("2d");
  if (!ctx) return;

  var reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)");
  var W = 0, H = 0;
  var stacks = [];

  function rand(a, b) { return a + Math.random() * (b - a); }
  function rgba(c, a) { return "rgba(" + c + "," + Math.max(0, Math.min(1, a)).toFixed(3) + ")"; }

  function buildStack(x0, x1, phase) {
    var gw = x1 - x0;
    var side = Math.min(gw * 0.55, 170);
    var height = H * 0.78;
    var layers = [];
    for (var l = 0; l < GRID.length; l++) {
      var n = GRID[l], s = side * SCALE[l];
      var y = -height / 2 + (height * l) / (GRID.length - 1);
      var nodes = [];
      for (var i = 0; i < n; i++) {
        for (var j = 0; j < n; j++) {
          var u = n === 1 ? 0 : i / (n - 1) - 0.5;
          var v = n === 1 ? 0 : j / (n - 1) - 0.5;
          nodes.push({ u: u, v: v, wx: u * s, wy: y, wz: v * s,
                       x: 0, y: 0, k: 1, act: 0, glow: 0, out: [], inp: [] });
        }
      }
      layers.push({ n: n, s: s, y: y, nodes: nodes, glow: 0, corners: [] });
    }
    // receptive-field connections between adjacent maps
    for (var l2 = 0; l2 < layers.length - 1; l2++) {
      var next = layers[l2 + 1];
      var reach = 0.62 / (next.n - 1 || 1) + 0.12;
      layers[l2].nodes.forEach(function (a) {
        next.nodes.forEach(function (b) {
          if (Math.abs(a.u - b.u) <= reach && Math.abs(a.v - b.v) <= reach) {
            var e = { a: a, b: b, w: rand(-0.35, 1), glow: 0 };
            a.out.push(e);
            b.inp.push(e);
          }
        });
      });
    }
    var all = [], edges = [];
    layers.forEach(function (L) {
      all = all.concat(L.nodes);
      L.nodes.forEach(function (a) { edges = edges.concat(a.out); });
    });
    return {
      layers: layers, nodes: all, edges: edges,
      cx: (x0 + x1) / 2, cy: H / 2, x0: x0, x1: x1, phase: phase,
      layer: -1, t: 0, wait: rand(0.3, 1.2)
    };
  }

  function resize() {
    var dpr = Math.min(window.devicePixelRatio || 1, 2);
    W = window.innerWidth;
    H = window.innerHeight;
    canvas.width = Math.round(W * dpr);
    canvas.height = Math.round(H * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    var rect = document.body.getBoundingClientRect();
    var left = rect.left - CONTENT_PAD;
    var right = W - rect.right - CONTENT_PAD;
    stacks = [];
    if (left >= MIN_GUTTER) stacks.push(buildStack(0, left, 0));
    if (right >= MIN_GUTTER) stacks.push(buildStack(rect.right + CONTENT_PAD, W, Math.PI / 3));
  }

  // world -> screen: yaw (turning), then an oblique tilt so every plane is
  // seen from the same angle, with perspective taken from depth only
  function project(st, x, y, z, ca, sa, cp, sp, out) {
    var x1 = x * ca + z * sa;
    var z1 = -x * sa + z * ca;
    var k = FOCAL / (FOCAL + z1 * cp);
    out.x = st.cx + x1 * k;
    out.y = st.cy + y - z1 * sp * k;
    out.k = k;
    return out;
  }

  function advancePass(st, dt) {
    if (st.layer < 0) {
      st.wait -= dt;
      if (st.wait > 0) return;
      st.layers.forEach(function (L) { L.nodes.forEach(function (n) { n.act = 0; }); });
      st.layers[0].nodes.forEach(function (n) {
        n.act = Math.random() < 0.55 ? rand(0.55, 1) : 0;
        n.glow = Math.max(n.glow, n.act);
      });
      st.layers[0].glow = 1;
      st.layer = 0;
      st.t = 0;
      return;
    }
    st.t += dt / LAYER_TIME;
    st.layers[st.layer].nodes.forEach(function (n) {
      if (n.act <= 0) return;
      n.out.forEach(function (e) {
        if (e.w > 0) e.glow = Math.max(e.glow, n.act * e.w * Math.sin(Math.PI * Math.min(1, st.t)));
      });
    });
    if (st.t < 1) return;
    var next = st.layers[st.layer + 1];
    next.nodes.forEach(function (m) {
      var sum = 0;
      m.inp.forEach(function (e) { sum += e.a.act * e.w; });
      sum /= Math.sqrt(m.inp.length || 1);
      m.act = sum > 0.25 ? Math.min(1, sum) : 0;
      m.glow = Math.max(m.glow, m.act);
    });
    next.glow = 1;
    st.layer++;
    st.t = 0;
    if (st.layer >= st.layers.length - 1) {
      st.layer = -1;
      st.wait = rand(1.4, 2.6);
    }
  }

  function step(dt, time) {
    var s = time * 0.001;
    stacks.forEach(function (st) {
      var yaw = s * 0.13 + st.phase;
      var ca = Math.cos(yaw), sa = Math.sin(yaw), cp = Math.cos(PITCH), sp = Math.sin(PITCH);
      st.nodes.forEach(function (n) {
        project(st, n.wx, n.wy, n.wz, ca, sa, cp, sp, n);
        n.glow *= Math.pow(0.35, dt);
      });
      st.layers.forEach(function (L) {
        var h = L.s * 0.62;
        L.corners = [[-h, -h], [h, -h], [h, h], [-h, h]].map(function (c) {
          return project(st, c[0], L.y, c[1], ca, sa, cp, sp, { x: 0, y: 0, k: 1 });
        });
        L.glow *= Math.pow(0.3, dt);
      });
      st.edges.forEach(function (e) { e.glow *= Math.pow(0.15, dt); });
      st.nodes.sort(function (p, q) { return p.k - q.k; });
      advancePass(st, dt);
    });
  }

  // gentle fade on the side nearest the text
  function fade(st, x) {
    var left = st.x0 < W / 2;
    var t = (x - st.x0) / Math.max(1, st.x1 - st.x0);
    var d = left ? 1 - t : t;
    return Math.max(0, Math.min(1, 0.45 + d * 1.1));
  }

  function draw() {
    ctx.clearRect(0, 0, W, H);
    stacks.forEach(function (st) {
      // feature-map planes
      ctx.shadowBlur = 0;
      st.layers.forEach(function (L) {
        var c = L.corners;
        var f = fade(st, (c[0].x + c[2].x) / 2);
        ctx.beginPath();
        ctx.moveTo(c[0].x, c[0].y);
        for (var i = 1; i < 4; i++) ctx.lineTo(c[i].x, c[i].y);
        ctx.closePath();
        ctx.fillStyle = rgba(C_NODE, f * (0.025 + 0.06 * L.glow));
        ctx.fill();
        ctx.lineWidth = 1;
        ctx.strokeStyle = rgba(C_NODE, f * (0.12 + 0.2 * L.glow));
        ctx.stroke();
      });

      // links
      st.edges.forEach(function (e) {
        var f = fade(st, (e.a.x + e.b.x) / 2);
        ctx.lineWidth = 0.6 + 0.5 * e.glow;
        ctx.strokeStyle = e.glow > 0.02
          ? rgba(C_NODE, f * (0.08 + 0.42 * e.glow))
          : rgba(C_LINK, f * 0.09);
        ctx.beginPath();
        ctx.moveTo(e.a.x, e.a.y);
        ctx.lineTo(e.b.x, e.b.y);
        ctx.stroke();
      });

      // signals travelling down from the sending layer
      if (st.layer >= 0) {
        var t = Math.min(1, st.t);
        ctx.shadowColor = rgba(C_NODE, 0.9);
        ctx.shadowBlur = 8;
        st.layers[st.layer].nodes.forEach(function (n) {
          if (n.act <= 0) return;
          n.out.forEach(function (e) {
            if (e.w <= 0) return;
            var a = e.a, b = e.b, t0 = Math.max(0, t - 0.18);
            var f = fade(st, a.x) * Math.min(1, 0.5 + n.act * e.w);
            ctx.lineWidth = 1.4;
            ctx.strokeStyle = rgba(C_HOT, f * 0.55);
            ctx.beginPath();
            ctx.moveTo(a.x + (b.x - a.x) * t0, a.y + (b.y - a.y) * t0);
            ctx.lineTo(a.x + (b.x - a.x) * t, a.y + (b.y - a.y) * t);
            ctx.stroke();
          });
        });
      }

      // nodes, far to near
      ctx.shadowColor = rgba(C_NODE, 0.8);
      st.nodes.forEach(function (n) {
        var f = fade(st, n.x);
        var depth = Math.max(0, Math.min(1, (n.k - 0.85) / 0.3));
        var r = (1.4 + 1.1 * depth) * n.k;
        ctx.shadowBlur = n.glow > 0.05 ? 12 * n.glow : 0;
        ctx.fillStyle = rgba(C_NODE, f * (0.28 + 0.25 * depth + 0.5 * n.glow));
        ctx.beginPath();
        ctx.arc(n.x, n.y, r + n.glow * 1.4, 0, Math.PI * 2);
        ctx.fill();
        if (n.glow > 0.25) {
          ctx.shadowBlur = 0;
          ctx.fillStyle = rgba(C_HOT, f * n.glow * 0.9);
          ctx.beginPath();
          ctx.arc(n.x, n.y, r * 0.55, 0, Math.PI * 2);
          ctx.fill();
        }
      });
    });
    ctx.shadowBlur = 0;
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
