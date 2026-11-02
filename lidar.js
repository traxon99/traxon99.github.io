// Margin decoration: a simulated race car with a 2D lidar.
//
// An invisible one-way track is laid out on the page (it scrolls with the
// content, so the crossing always lines up with its gap). It enters from off
// the left edge and snakes down the left margin. It then cuts across through
// the gap between the resume button and "a brief:", snakes down the right
// margin, and leaves off the right edge. A new car starts about every 20s. An invisible car drives it. All that is drawn are its lidar
// returns, plus its path along the raceline in red: each scan casts a fan of
// rays against the track walls, and the hits linger and fade, revealing the
// track only where the car has just been.
(function () {
  "use strict";

  var FPS = 30;
  var SCAN_HZ = 20;          // lidar scans per second
  var RAYS = 120;            // rays per scan
  var FOV = 270 * Math.PI / 180;
  var RANGE = 170;           // max lidar range, px
  var FADE = 3.2;            // seconds a return stays visible
  var NOISE = 0.8;           // px of range noise
  var CONTENT_PAD = 24;      // walls keep at least this far from the text column
  var GREEN = "60, 179, 113";
  var HOT = "160, 240, 195";

  var canvas = document.createElement("canvas");
  canvas.className = "edge-lidar";
  canvas.setAttribute("aria-hidden", "true");
  document.body.appendChild(canvas);
  var ctx = canvas.getContext("2d");
  if (!ctx) return;

  var reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)");

  var W = 0, H = 0;
  var path = null;           // { pts, dist, speed, len }
  var segs = null;           // wall segments, flattened [ax, ay, bx, by, ...]
  var grid = null, CELL = 64, gw = 0, gh = 0, stamp = null, stampId = 0;
  var RUN_EVERY = 20;        // seconds from one car's start to the next
  var car = { d: 0, wait: 0, start: 0 };
  var clock = 0, nextScan = 0;

  var CAP = 16000;
  var px = new Float32Array(CAP), py = new Float32Array(CAP), pt = new Float32Array(CAP);
  var head = 0, count = 0;

  // the car's recent path, drawn as a fading red line
  var TCAP = 600, TFADE = 4.5;
  var tx = new Float32Array(TCAP), ty = new Float32Array(TCAP), tt = new Float32Array(TCAP);
  var thead = 0, tcount = 0;
  var RED = "232, 72, 72";
  function trail(x, y, t) {
    tx[thead] = x; ty[thead] = y; tt[thead] = t;
    thead = (thead + 1) % TCAP;
    if (tcount < TCAP) tcount++;
  }

  function clamp(v, a, b) { return Math.max(a, Math.min(b, v)); }
  function gauss() { return (Math.random() + Math.random() + Math.random() - 1.5) * 1.15; }

  // Catmull-Rom spline through control points, sampled roughly every `step` px
  function spline(cp, step) {
    var out = [];
    for (var i = 0; i < cp.length - 1; i++) {
      var p0 = cp[Math.max(0, i - 1)], p1 = cp[i], p2 = cp[i + 1], p3 = cp[Math.min(cp.length - 1, i + 2)];
      var n = Math.max(2, Math.ceil(Math.hypot(p2[0] - p1[0], p2[1] - p1[1]) / step));
      for (var k = 0; k < n; k++) {
        var t = k / n, t2 = t * t, t3 = t2 * t;
        out.push([
          0.5 * (2 * p1[0] + (-p0[0] + p2[0]) * t + (2 * p0[0] - 5 * p1[0] + 4 * p2[0] - p3[0]) * t2 + (-p0[0] + 3 * p1[0] - 3 * p2[0] + p3[0]) * t3),
          0.5 * (2 * p1[1] + (-p0[1] + p2[1]) * t + (2 * p0[1] - 5 * p1[1] + 4 * p2[1] - p3[1]) * t2 + (-p0[1] + 3 * p1[1] - 3 * p2[1] + p3[1]) * t3)
        ]);
      }
    }
    out.push(cp[cp.length - 1]);
    return out;
  }

  // moving-average passes over a polyline (ends pinned) to round off any
  // corner tighter than the track is wide
  function smooth(pts, passes, win) {
    for (var p = 0; p < passes; p++) {
      var out = pts.slice();
      for (var i = win; i < pts.length - win; i++) {
        var sx = 0, sy = 0;
        for (var k = -win; k <= win; k++) { sx += pts[i + k][0]; sy += pts[i + k][1]; }
        out[i] = [sx / (2 * win + 1), sy / (2 * win + 1)];
      }
      pts = out;
    }
    return pts;
  }

  function docRect(el) {
    var r = el.getBoundingClientRect();
    return { top: r.top + window.scrollY, bottom: r.bottom + window.scrollY,
             left: r.left + window.scrollX, right: r.right + window.scrollX };
  }

  // Returns false when there isn't enough margin to fit the track.
  function build() {
    var body = docRect(document.body);
    var resume = document.querySelector(".button_holder");
    var brief = document.querySelector(".brief");
    if (!resume || !brief) return false;
    var rb = docRect(resume).bottom, bt = docRect(brief).top;

    var leftEdge = body.left + 20 - CONTENT_PAD;    // text column has 20px padding
    var rightEdge = body.right - 20 + CONTENT_PAD;
    var gutter = Math.min(leftEdge, W - rightEdge);
    var hw = clamp(Math.min(gutter * 0.12, (bt - rb) / 2 - 6), 10, 18); // half track width
    if (gutter < 2 * hw + 70) return false;

    var gapY = (rb + bt) / 2;
    var xL = leftEdge / 2, xR = rightEdge + (W - rightEdge) / 2;
    var a = clamp(gutter * 0.18, 10, 45);            // snake amplitude in the margins
    var yTop = 70;
    // length of the right-margin run: as long as the left one, but it must fit on screen
    var down = clamp(gapY - yTop, 160, H - 40 - hw - gapY);
    if (down < 160) return false;

    // how far the turns into and out of the gap reach sideways
    var turnL = Math.min(70, leftEdge - xL + 10), turnR = Math.min(70, xR - rightEdge + 10);
    var cp = [
      [-RANGE - 60, yTop], [-20, yTop],
      [xL - a * 0.4, yTop + 45],
      [xL + a, yTop + (gapY - yTop) * 0.38],
      [xL - a, yTop + (gapY - yTop) * 0.72],
      [xL, gapY - 60],
      [xL + turnL, gapY]
    ].concat(
      // straight through the gap; extra points only where there's room for them
      leftEdge + 10 > xL + turnL + 10 ? [[leftEdge + 10, gapY]] : [],
      rightEdge - 10 < xR - turnR - 10 ? [[rightEdge - 10, gapY]] : [],
      [
      [xR - turnR, gapY],
      [xR, gapY + 60],
      [xR + a, gapY + down * 0.3],
      [xR - a, gapY + down * 0.62],
      [xR + a * 0.4, gapY + down - 45],
      [W + 20, gapY + down],
      [W + RANGE + 60, gapY + down]
    ]);
    var pts = smooth(spline(cp, 5), 4, 6);

    // walls offset either side of the centerline
    var left = [], right = [], normals = [];
    for (var i = 0; i < pts.length; i++) {
      var p = pts[Math.max(0, i - 1)], q = pts[Math.min(pts.length - 1, i + 1)];
      var tx = q[0] - p[0], ty = q[1] - p[1], tl = Math.hypot(tx, ty) || 1;
      var nx = -ty / tl, ny = tx / tl;
      normals.push([nx, ny]);
      left.push([pts[i][0] + nx * hw, pts[i][1] + ny * hw]);
      right.push([pts[i][0] - nx * hw, pts[i][1] - ny * hw]);
    }
    var list = [];
    [left, right].forEach(function (wall) {
      for (var k = 0; k < wall.length - 1; k++) list.push(wall[k][0], wall[k][1], wall[k + 1][0], wall[k + 1][1]);
    });
    segs = new Float32Array(list);

    // spatial grid (segments off-canvas are clamped into edge cells)
    gw = Math.ceil(W / CELL) + 1;
    gh = Math.ceil(H / CELL) + 1;
    grid = new Array(gw * gh);
    for (var s = 0; s < segs.length / 4; s++) {
      var ax = segs[s * 4], ay = segs[s * 4 + 1], bx = segs[s * 4 + 2], by = segs[s * 4 + 3];
      var c0 = clamp(Math.floor(Math.min(ax, bx) / CELL), 0, gw - 1), c1 = clamp(Math.floor(Math.max(ax, bx) / CELL), 0, gw - 1);
      var r0 = clamp(Math.floor(Math.min(ay, by) / CELL), 0, gh - 1), r1 = clamp(Math.floor(Math.max(ay, by) / CELL), 0, gh - 1);
      for (var gy = r0; gy <= r1; gy++) {
        for (var gx = c0; gx <= c1; gx++) {
          var key = gy * gw + gx;
          (grid[key] || (grid[key] = [])).push(s);
        }
      }
    }
    stamp = new Uint32Array(segs.length / 4);

    // Raceline: an approximate minimum-curvature line. Each point lives on
    // its track cross-section (centerline + normal * offset). We repeatedly
    // pull every point toward the midpoint of its neighbours, which
    // straightens the line, then clamp it to stay a car's width off the walls.
    // The result swings wide on entry, clips the apex and runs out wide on exit.
    var lim = hw * 0.62, N = pts.length, off = new Float32Array(N), race = pts.slice();
    for (var it = 0; it < 600; it++) {
      for (var r = 2; r < N - 2; r++) {
        var mx = (race[r - 2][0] + race[r + 2][0]) / 2, my = (race[r - 2][1] + race[r + 2][1]) / 2;
        var c = pts[r], nrm = normals[r];
        var target = (mx - c[0]) * nrm[0] + (my - c[1]) * nrm[1];
        off[r] = clamp(off[r] + (target - off[r]) * 0.5, -lim, lim);
        race[r] = [c[0] + nrm[0] * off[r], c[1] + nrm[1] * off[r]];
      }
    }
    pts = race;

    // Speed profile: corner speed from a lateral-grip limit (v = sqrt(a / k)),
    // then a forward pass for acceleration and a backward pass for braking,
    // so the car brakes before corners and accelerates out of them.
    var VMAX = 330, A_LAT = 620, A_ACC = 300, A_BRK = 650;   // px/s and px/s^2
    var dist = [0], speed = [];
    for (var z = 1; z < N; z++) dist.push(dist[z - 1] + Math.hypot(pts[z][0] - pts[z - 1][0], pts[z][1] - pts[z - 1][1]));
    var curv = new Float32Array(N), K = 4;
    for (var v = K; v < N - K; v++) {
      var A = pts[v - K], B = pts[v], C = pts[v + K];
      var ab = Math.hypot(B[0] - A[0], B[1] - A[1]), bc = Math.hypot(C[0] - B[0], C[1] - B[1]), ca = Math.hypot(A[0] - C[0], A[1] - C[1]);
      var area2 = Math.abs((B[0] - A[0]) * (C[1] - A[1]) - (B[1] - A[1]) * (C[0] - A[0]));
      curv[v] = ab * bc * ca > 0 ? (2 * area2) / (ab * bc * ca) : 0;  // 1 / circumradius
    }
    for (var w = 0; w < N; w++) {
      var kk = 0, cnt = 0;
      for (var j2 = Math.max(0, w - 3); j2 <= Math.min(N - 1, w + 3); j2++) { kk += curv[j2]; cnt++; }
      kk /= cnt;
      speed.push(kk > 1e-6 ? Math.min(VMAX, Math.sqrt(A_LAT / kk)) : VMAX);
    }
    for (var f = 1; f < N; f++) {
      speed[f] = Math.min(speed[f], Math.sqrt(speed[f - 1] * speed[f - 1] + 2 * A_ACC * (dist[f] - dist[f - 1])));
    }
    for (var g = N - 2; g >= 0; g--) {
      speed[g] = Math.min(speed[g], Math.sqrt(speed[g + 1] * speed[g + 1] + 2 * A_BRK * (dist[g + 1] - dist[g])));
    }
    path = { pts: pts, dist: dist, speed: speed, len: dist[dist.length - 1] };
    return true;
  }

  function sample(d) {
    var P = path;
    d = clamp(d, 0, P.len);
    var lo = 0, hi = P.dist.length - 1;
    while (hi - lo > 1) {
      var mid = (lo + hi) >> 1;
      if (P.dist[mid] <= d) lo = mid; else hi = mid;
    }
    var a = P.pts[lo], b = P.pts[Math.min(lo + 1, P.pts.length - 1)];
    var segLen = P.dist[Math.min(lo + 1, P.pts.length - 1)] - P.dist[lo] || 1;
    var t = clamp((d - P.dist[lo]) / segLen, 0, 1);
    var c = P.pts[Math.min(P.pts.length - 1, lo + 3)];
    if (c === a) c = b;
    return { x: a[0] + (b[0] - a[0]) * t, y: a[1] + (b[1] - a[1]) * t,
             h: Math.atan2(c[1] - a[1], c[0] - a[0]),
             v: P.speed[lo] + (P.speed[Math.min(lo + 1, P.pts.length - 1)] - P.speed[lo]) * t };
  }

  function scan(ox, oy, heading, now) {
    stampId++;
    var near = [];
    var c0 = clamp(Math.floor((ox - RANGE) / CELL), 0, gw - 1), c1 = clamp(Math.floor((ox + RANGE) / CELL), 0, gw - 1);
    var r0 = clamp(Math.floor((oy - RANGE) / CELL), 0, gh - 1), r1 = clamp(Math.floor((oy + RANGE) / CELL), 0, gh - 1);
    for (var gy = r0; gy <= r1; gy++) {
      for (var gx = c0; gx <= c1; gx++) {
        var cell = grid[gy * gw + gx];
        if (!cell) continue;
        for (var k = 0; k < cell.length; k++) {
          var s = cell[k];
          if (stamp[s] !== stampId) { stamp[s] = stampId; near.push(s); }
        }
      }
    }
    for (var i = 0; i < RAYS; i++) {
      var ang = heading - FOV / 2 + (FOV * i) / (RAYS - 1);
      var dx = Math.cos(ang), dy = Math.sin(ang), best = RANGE;
      for (var j = 0; j < near.length; j++) {
        var o = near[j] * 4;
        var ax = segs[o], ay = segs[o + 1], ex = segs[o + 2] - ax, ey = segs[o + 3] - ay;
        var den = dx * ey - dy * ex;
        if (den > -1e-9 && den < 1e-9) continue;
        var qx = ax - ox, qy = ay - oy;
        var t = (qx * ey - qy * ex) / den;
        if (t <= 0 || t >= best) continue;
        var u = (qx * dy - qy * dx) / den;
        if (u >= 0 && u <= 1) best = t;
      }
      if (best < RANGE) {
        var rr = best + gauss() * NOISE;
        px[head] = ox + dx * rr;
        py[head] = oy + dy * rr;
        pt[head] = now;
        head = (head + 1) % CAP;
        if (count < CAP) count++;
      }
    }
  }

  function step(dt) {
    clock += dt;
    if (car.wait > 0) {          // between runs: car is off-screen, lidar idle
      car.wait -= dt;
      nextScan = clock;
      if (car.wait <= 0) car.start = clock;
      return;
    }
    car.d += sample(car.d).v * dt;
    var cur = sample(car.d);
    trail(cur.x, cur.y, clock);
    while (clock >= nextScan) {
      var p = sample(car.d);
      scan(p.x, p.y, p.h, nextScan);
      nextScan += 1 / SCAN_HZ;
    }
    if (car.d >= path.len) {     // left the page on the right; send the next car
      car.d = 0;
      car.wait = Math.max(1, RUN_EVERY - (clock - car.start));
      trail(NaN, NaN, clock);    // break the line between cars
    }
  }

  var BINS = 6, SIZE = 1.7;
  function draw(still) {
    ctx.clearRect(0, 0, W, H);
    ctx.lineCap = "round";
    if (still) {
      ctx.strokeStyle = "rgba(" + RED + ",0.45)";
      ctx.lineWidth = 1.6;
      ctx.beginPath();
      path.pts.forEach(function (q, i) { if (i) ctx.lineTo(q[0], q[1]); else ctx.moveTo(q[0], q[1]); });
      ctx.stroke();
      ctx.fillStyle = "rgba(" + GREEN + ",0.35)";
      for (var i = 0; i < count; i++) ctx.fillRect(px[i] - SIZE / 2, py[i] - SIZE / 2, SIZE, SIZE);
      return;
    }
    // driven path, oldest first, fading out with age
    ctx.lineWidth = 2;
    for (var j = 1; j < tcount; j++) {
      var i1 = (thead - tcount + j + TCAP) % TCAP, i0 = (i1 - 1 + TCAP) % TCAP;
      if (tx[i0] !== tx[i0] || tx[i1] !== tx[i1]) continue; // NaN = break
      var a = 1 - (clock - tt[i1]) / TFADE;
      if (a <= 0) continue;
      ctx.strokeStyle = "rgba(" + RED + "," + (0.75 * a * a).toFixed(3) + ")";
      ctx.beginPath();
      ctx.moveTo(tx[i0], ty[i0]);
      ctx.lineTo(tx[i1], ty[i1]);
      ctx.stroke();
    }
    // the planned path just ahead of the car
    if (car.wait <= 0) {
      ctx.setLineDash([3, 5]);
      ctx.lineWidth = 1.5;
      ctx.strokeStyle = "rgba(" + RED + ",0.35)";
      ctx.beginPath();
      for (var ahead = 0; ahead <= 140; ahead += 7) {
        var q = sample(car.d + ahead);
        if (ahead) ctx.lineTo(q.x, q.y); else ctx.moveTo(q.x, q.y);
      }
      ctx.stroke();
      ctx.setLineDash([]);
    }
    for (var b = 0; b < BINS; b++) {
      var lo = (b / BINS) * FADE, hi = ((b + 1) / BINS) * FADE;
      var alpha = 0.85 * Math.pow(1 - b / BINS, 1.6);
      ctx.fillStyle = "rgba(" + (b === 0 ? HOT : GREEN) + "," + alpha.toFixed(3) + ")";
      for (var k = 0; k < count; k++) {
        var age = clock - pt[k];
        if (age >= lo && age < hi) ctx.fillRect(px[k] - SIZE / 2, py[k] - SIZE / 2, SIZE, SIZE);
      }
    }
  }

  var active = false;

  function layout() {
    W = document.documentElement.clientWidth;
    H = window.innerHeight;
    active = build();
    canvas.style.display = active ? "block" : "none";
    if (!active) return;
    var dpr = Math.min(window.devicePixelRatio || 1, 2);
    canvas.width = Math.round(W * dpr);
    canvas.height = Math.round(H * dpr);
    canvas.style.width = W + "px";
    canvas.style.height = H + "px";
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    head = 0; count = 0; thead = 0; tcount = 0;
    clock = 0; nextScan = 0;
    car.d = 0; car.wait = 0.4;
  }

  var raf = 0, last = 0, frameMs = 1000 / FPS;

  function loop(now) {
    raf = requestAnimationFrame(loop);
    if (now - last < frameMs) return;
    var dt = last ? Math.min((now - last) / 1000, 0.1) : 0;
    last = now;
    step(dt);
    draw(false);
  }

  function start() {
    cancelAnimationFrame(raf);
    raf = 0;
    last = 0;
    if (!active) return;
    if (reduceMotion.matches) {
      // no motion: trace the whole track once and show it still
      head = 0; count = 0; clock = 0; nextScan = 0; car.d = 0; car.wait = 0;
      var saved = SCAN_HZ;
      SCAN_HZ = 5;
      while (car.d < path.len - 1 && count < CAP - RAYS) step(0.05);
      SCAN_HZ = saved;
      draw(true);
      return;
    }
    if (document.hidden) return;
    raf = requestAnimationFrame(loop);
  }

  // re-lay the track whenever the page layout changes (resize, fonts, images)
  var relayTimer = 0;
  function relayout() {
    clearTimeout(relayTimer);
    relayTimer = setTimeout(function () { layout(); start(); }, 150);
  }
  window.addEventListener("resize", relayout);
  window.addEventListener("load", relayout);
  if (window.ResizeObserver) new ResizeObserver(relayout).observe(document.querySelector("main") || document.body);
  document.addEventListener("visibilitychange", start);
  if (reduceMotion.addEventListener) reduceMotion.addEventListener("change", start);

  layout();
  start();
})();
