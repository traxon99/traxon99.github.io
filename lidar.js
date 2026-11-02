// Margin decoration: a simulated race car with a 2D lidar.
//
// An invisible race track runs around the edge of the viewport. A car (also
// invisible) enters from off-screen and laps it. All that is drawn are the
// car's lidar returns: each scan casts a fan of rays against the track
// walls, and the hits linger and fade, so the track is revealed only around
// where the car has just been.
(function () {
  "use strict";

  var FPS = 30;
  var SCAN_HZ = 20;          // lidar scans per second
  var RAYS = 120;            // rays per scan
  var FOV = 270 * Math.PI / 180;
  var FADE = 3.2;            // seconds a return stays visible
  var NOISE = 1.0;           // px of range noise
  var GREEN = "60, 179, 113";
  var HOT = "160, 240, 195";

  var canvas = document.createElement("canvas");
  canvas.className = "edge-lidar";
  canvas.setAttribute("aria-hidden", "true");
  document.body.appendChild(canvas);
  var ctx = canvas.getContext("2d");
  if (!ctx) return;

  var reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)");

  var W = 0, H = 0, RANGE = 200;
  var path = null;           // car path: lead-in + closed loop
  var segs = null;           // wall segments [ax, ay, bx, by] flattened
  var grid = null, CELL = 80, gw = 0, gh = 0, stamp = null, stampId = 0;
  var car = { d: 0, lapped: false };
  var clock = 0, nextScan = 0;

  // ring buffer of returns
  var CAP = 16000;
  var px = new Float32Array(CAP), py = new Float32Array(CAP), pt = new Float32Array(CAP);
  var head = 0, count = 0;

  function clamp(v, a, b) { return Math.max(a, Math.min(b, v)); }
  function gauss() { return (Math.random() + Math.random() + Math.random() - 1.5) * 1.15; }

  // Walk a rounded rectangle clockwise from the start of the top straight,
  // returning points with their outward normal.
  function roundedRect(x0, y0, x1, y1, r, step) {
    var pts = [];
    function line(ax, ay, bx, by, nx, ny) {
      var len = Math.hypot(bx - ax, by - ay), n = Math.max(1, Math.round(len / step));
      for (var i = 0; i < n; i++) {
        var t = i / n;
        pts.push([ax + (bx - ax) * t, ay + (by - ay) * t, nx, ny]);
      }
    }
    function arc(cx, cy, a0) {
      var n = Math.max(2, Math.round((Math.PI / 2) * r / step));
      for (var i = 0; i < n; i++) {
        var a = a0 + (Math.PI / 2) * (i / n);
        pts.push([cx + Math.cos(a) * r, cy + Math.sin(a) * r, Math.cos(a), Math.sin(a)]);
      }
    }
    line(x0 + r, y0, x1 - r, y0, 0, -1);          // top, left to right
    arc(x1 - r, y0 + r, -Math.PI / 2);            // top-right corner
    line(x1, y0 + r, x1, y1 - r, 1, 0);           // right, downward
    arc(x1 - r, y1 - r, 0);                       // bottom-right
    line(x1 - r, y1, x0 + r, y1, 0, 1);           // bottom, right to left
    arc(x0 + r, y1 - r, Math.PI / 2);             // bottom-left
    line(x0, y1 - r, x0, y0 + r, -1, 0);          // left, upward
    arc(x0 + r, y0 + r, Math.PI);                 // top-left
    return pts;
  }

  function build() {
    var m = Math.min(W, H);
    var hw = clamp(m * 0.03, 14, 26);             // half track width
    var amp = hw * 0.6;                           // how far the track snakes
    var inset = hw + amp + 6;
    var r = clamp(m * 0.16, hw * 2 + amp, 170);
    RANGE = clamp(m * 0.32, 140, 280);

    var base = roundedRect(inset, inset, W - inset, H - inset, r, 6);
    var n = base.length;

    // perimeter length and a whole number of wiggles so the loop closes
    var L = 0, cum = [0];
    for (var i = 1; i <= n; i++) {
      var a = base[i - 1], b = base[i % n];
      L += Math.hypot(b[0] - a[0], b[1] - a[1]);
      cum.push(L);
    }
    var waves = Math.max(3, Math.round(L / 650));
    var center = [], outer = [], inner = [];
    for (var j = 0; j < n; j++) {
      var p = base[j];
      var w = amp * Math.sin((2 * Math.PI * waves * cum[j]) / L);
      var cx = p[0] + p[2] * w, cy = p[1] + p[3] * w;
      center.push([cx, cy]);
      outer.push([cx + p[2] * hw, cy + p[3] * hw]);
      inner.push([cx - p[2] * hw, cy - p[3] * hw]);
    }

    // wall segments
    var list = [];
    [outer, inner].forEach(function (wall) {
      for (var k = 0; k < wall.length; k++) {
        var A = wall[k], B = wall[(k + 1) % wall.length];
        list.push(A[0], A[1], B[0], B[1]);
      }
    });
    segs = new Float32Array(list);

    // spatial grid over the segments
    gw = Math.ceil(W / CELL) + 1;
    gh = Math.ceil(H / CELL) + 1;
    grid = new Array(gw * gh);
    for (var s = 0; s < segs.length / 4; s++) {
      var ax = segs[s * 4], ay = segs[s * 4 + 1], bx = segs[s * 4 + 2], by = segs[s * 4 + 3];
      var c0 = clamp(Math.floor(Math.min(ax, bx) / CELL), 0, gw - 1);
      var c1 = clamp(Math.floor(Math.max(ax, bx) / CELL), 0, gw - 1);
      var r0 = clamp(Math.floor(Math.min(ay, by) / CELL), 0, gh - 1);
      var r1 = clamp(Math.floor(Math.max(ay, by) / CELL), 0, gh - 1);
      for (var gy = r0; gy <= r1; gy++) {
        for (var gx = c0; gx <= c1; gx++) {
          var key = gy * gw + gx;
          (grid[key] || (grid[key] = [])).push(s);
        }
      }
    }
    stamp = new Uint32Array(segs.length / 4);

    // car path: a straight lead-in from off-screen left into the top straight,
    // then the loop. Speeds drop in tight sections.
    var lead = [];
    var start = center[0], leadLen = RANGE + 120;
    for (var q = 0; q < leadLen; q += 6) lead.push([start[0] - leadLen + q, start[1]]);
    var pts = lead.concat(center);
    var dist = [0];
    for (var z = 1; z < pts.length; z++) {
      dist.push(dist[z - 1] + Math.hypot(pts[z][0] - pts[z - 1][0], pts[z][1] - pts[z - 1][1]));
    }
    var loopStart = dist[lead.length];
    var loopLen = dist[dist.length - 1] - loopStart +
      Math.hypot(center[0][0] - center[n - 1][0], center[0][1] - center[n - 1][1]);

    // curvature-based target speed per point
    var vmax = clamp(m * 0.32, 170, 300), speed = [];
    for (var v = 0; v < pts.length; v++) {
      var i0 = Math.max(0, v - 4), i1 = Math.min(pts.length - 1, v + 4);
      if (v >= lead.length) { // wrap around the loop
        i0 = lead.length + ((v - lead.length - 4 + n) % n);
        i1 = lead.length + ((v - lead.length + 4) % n);
      }
      var h0 = Math.atan2(pts[v][1] - pts[i0][1], pts[v][0] - pts[i0][0]);
      var h1 = Math.atan2(pts[i1][1] - pts[v][1], pts[i1][0] - pts[v][0]);
      var turn = Math.abs(Math.atan2(Math.sin(h1 - h0), Math.cos(h1 - h0)));
      speed.push(vmax / (1 + turn * 2.2));
    }
    path = { pts: pts, dist: dist, speed: speed, loopStart: loopStart, loopLen: loopLen,
             leadCount: lead.length, n: n };
  }

  // position, heading and target speed at path distance d
  function sample(d) {
    var P = path;
    if (d >= P.loopStart) d = P.loopStart + ((d - P.loopStart) % P.loopLen);
    var lo = 0, hi = P.dist.length - 1;
    while (hi - lo > 1) {
      var mid = (lo + hi) >> 1;
      if (P.dist[mid] <= d) lo = mid; else hi = mid;
    }
    var a = P.pts[lo];
    var bIdx = lo + 1 < P.pts.length ? lo + 1 : P.leadCount; // loop closes on itself
    var b = P.pts[bIdx];
    var segLen = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1;
    var t = clamp((d - P.dist[lo]) / segLen, 0, 1);
    var cIdx = Math.min(P.pts.length - 1, lo + 3);
    if (lo + 3 >= P.pts.length) cIdx = P.leadCount + ((lo + 3 - P.pts.length) % P.n);
    var c = P.pts[cIdx];
    return {
      x: a[0] + (b[0] - a[0]) * t,
      y: a[1] + (b[1] - a[1]) * t,
      h: Math.atan2(c[1] - a[1], c[0] - a[0]),
      v: P.speed[lo]
    };
  }

  function scan(ox, oy, heading, now) {
    // collect nearby wall segments once per scan
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
    var s = sample(car.d);
    car.d += s.v * dt;
    while (clock >= nextScan) {
      var p = sample(car.d);
      scan(p.x, p.y, p.h, nextScan);
      nextScan += 1 / SCAN_HZ;
    }
  }

  var BINS = 6;
  function draw(still) {
    ctx.clearRect(0, 0, W, H);
    var size = 1.7;
    if (still) {
      ctx.fillStyle = "rgba(" + GREEN + ",0.35)";
      for (var i = 0; i < count; i++) ctx.fillRect(px[i] - size / 2, py[i] - size / 2, size, size);
      return;
    }
    for (var b = 0; b < BINS; b++) {
      var lo = (b / BINS) * FADE, hi = ((b + 1) / BINS) * FADE;
      var alpha = 0.85 * Math.pow(1 - b / BINS, 1.6);
      ctx.fillStyle = b === 0 ? "rgba(" + HOT + "," + alpha.toFixed(3) + ")"
                              : "rgba(" + GREEN + "," + alpha.toFixed(3) + ")";
      for (var k = 0; k < count; k++) {
        var age = clock - pt[k];
        if (age >= lo && age < hi) ctx.fillRect(px[k] - size / 2, py[k] - size / 2, size, size);
      }
    }
  }

  function resize() {
    var dpr = Math.min(window.devicePixelRatio || 1, 2);
    var frac = path ? (car.d - path.loopStart) / path.loopLen : null;
    W = window.innerWidth;
    H = window.innerHeight;
    canvas.width = Math.round(W * dpr);
    canvas.height = Math.round(H * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    build();
    head = 0; count = 0;
    clock = 0; nextScan = 0;
    // keep the car's place on the lap after a resize; start off-screen the first time
    car.d = frac !== null && frac > 0 ? path.loopStart + (frac % 1) * path.loopLen : 0;
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
    if (reduceMotion.matches) {
      // no motion: trace one full lap at a slow scan rate and show it still
      head = 0; count = 0; clock = 0; nextScan = 0;
      car.d = path.loopStart;
      var saved = SCAN_HZ;
      SCAN_HZ = 4;
      while (car.d < path.loopStart + path.loopLen && count < CAP - RAYS) step(0.05);
      SCAN_HZ = saved;
      draw(true);
      return;
    }
    if (document.hidden) return;
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
