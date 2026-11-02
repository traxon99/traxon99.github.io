// Animated white ordered-dither border.
// Renders a low-resolution canvas fixed over the viewport, scaled up with
// nearest-neighbour sampling so every dither "pixel" stays crisp.
(function () {
  "use strict";

  var PIXEL = 3;          // CSS px per dither cell
  var FPS = 24;           // frame cap, keeps CPU use low
  var BAND = 0.16;        // edge band, as a fraction of the shorter viewport side
  var MAX_BAND_PX = 180;  // cap so huge screens don't get a giant border

  // 8x8 Bayer matrix, normalised to (0, 1)
  var BAYER = [
     0, 32,  8, 40,  2, 34, 10, 42,
    48, 16, 56, 24, 50, 18, 58, 26,
    12, 44,  4, 36, 14, 46,  6, 38,
    60, 28, 52, 20, 62, 30, 54, 22,
     3, 35, 11, 43,  1, 33,  9, 41,
    51, 19, 59, 27, 49, 17, 57, 25,
    15, 47,  7, 39, 13, 45,  5, 37,
    63, 31, 55, 23, 61, 29, 53, 21
  ].map(function (v) { return (v + 0.5) / 64; });

  var canvas = document.createElement("canvas");
  canvas.className = "dither-edge";
  canvas.setAttribute("aria-hidden", "true");
  document.body.appendChild(canvas);

  var ctx = canvas.getContext("2d");
  if (!ctx) return;

  var reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)");

  var w = 0, h = 0, image = null, buf = null;
  var cells = null;   // indices of cells inside the edge band
  var weight = null;  // normalised distance from the edge per band cell
  var cx = null, cy = null;
  var WHITE = 0xffffffff, CLEAR = 0;

  function resize() {
    w = Math.ceil(window.innerWidth / PIXEL);
    h = Math.ceil(window.innerHeight / PIXEL);
    canvas.width = w;
    canvas.height = h;
    image = ctx.createImageData(w, h);
    buf = new Uint32Array(image.data.buffer);

    // thinner border on narrow (phone) screens so text stays readable
    var frac = window.innerWidth < 700 ? BAND * 0.55 : BAND;
    var band = Math.min(Math.min(w, h) * frac, MAX_BAND_PX / PIXEL);
    var reach = band * 1.35; // extra room for the wavy inner edge
    var idx = [], wt = [], xs = [], ys = [];
    for (var y = 0; y < h; y++) {
      var dy = Math.min(y, h - 1 - y);
      for (var x = 0; x < w; x++) {
        var d = Math.min(Math.min(x, w - 1 - x), dy);
        if (d >= reach) continue;
        idx.push(y * w + x);
        wt.push(d / band);         // 0 at the very edge, 1 at the nominal inner boundary
        xs.push(x);
        ys.push(y);
      }
    }
    cells = new Uint32Array(idx);
    weight = new Float32Array(wt);
    cx = new Uint16Array(xs);
    cy = new Uint16Array(ys);
  }

  function draw(time) {
    var t = time * 0.001;
    buf.fill(CLEAR);
    for (var i = 0, n = cells.length; i < n; i++) {
      var x = cx[i], y = cy[i];
      // cheap flowing field from a few drifting sine waves, roughly -1..1
      var f =
        Math.sin(x * 0.045 + t * 0.9) +
        Math.sin(y * 0.052 - t * 1.1) +
        Math.sin((x + y) * 0.031 + t * 0.6) +
        Math.sin(Math.sqrt(x * x * 0.6 + y * y) * 0.06 - t * 1.4);
      // the field warps how deep the border reaches, so the inner edge ripples
      var depth = weight[i] + 0.09 * f;
      if (depth >= 1) continue;
      var v = 1 - depth;
      v = v * v * 0.95 - 0.04;
      if (v > BAYER[((y & 7) << 3) | (x & 7)]) buf[cells[i]] = WHITE;
    }
    ctx.putImageData(image, 0, 0);
  }

  var raf = 0, last = 0, frameMs = 1000 / FPS;

  function loop(now) {
    raf = requestAnimationFrame(loop);
    if (now - last < frameMs) return;
    last = now;
    draw(now);
  }

  function start() {
    cancelAnimationFrame(raf);
    raf = 0;
    if (reduceMotion.matches || document.hidden) {
      draw(0); // one still frame, no motion
      return;
    }
    raf = requestAnimationFrame(loop);
  }

  var resizeTimer = 0;
  window.addEventListener("resize", function () {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(function () { resize(); start(); }, 120);
  });
  document.addEventListener("visibilitychange", start);
  if (reduceMotion.addEventListener) reduceMotion.addEventListener("change", start);

  resize();
  start();
})();
