/*
 * The cinematic engine: procedural Three.js hero objects for concept scenes.
 *
 * A classic script (no modules) inlined into the composition by build.ts, so it
 * runs after the CDN's three.min.js and gsap and defines exactly one global,
 * window.CINE. It never touches the DOM except to make one offscreen canvas.
 *
 * THE RULES THIS FILE LIVES BY
 *  - Every frame is a PURE FUNCTION of (hero id, t, p): nothing accumulates, so
 *    seeking to any instant, forwards or backwards, cold or warm, draws exactly
 *    what playing through to it would. All "randomness" is a seeded array built
 *    once at setup.
 *  - SINGLE-GROUP geometries only (Sphere, Torus, Lathe, Plane, Tube and
 *    hand-built BufferGeometry). Cone/Cylinder/Box carry several internal
 *    groups and were measured painting blank in a real screenshot-based render
 *    (see three-shapes.ts), so boxes here are built by box() below.
 *  - One shared WebGL context. The caller blits the offscreen canvas into its
 *    own visible 2-D canvas every frame (the proven path for screenshot capture).
 *  - Nothing here is an asset: no textures from disk, no network. Soft glows are
 *    a radial gradient painted into a canvas.
 */
(function () {
  "use strict";

  var HEROES = {};

  function mulberry(a) {
    return function () {
      a |= 0; a = (a + 0x6d2b79f5) | 0;
      var t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }
  function clamp(x, a, b) { return Math.max(a, Math.min(b, x)); }
  function smooth(a, b, x) { x = clamp((x - a) / (b - a), 0, 1); return x * x * (3 - 2 * x); }
  function lerp(a, b, x) { return a + (b - a) * x; }
  function fract(x) { return x - Math.floor(x); }

  /* ---------------------------------------------------------------- helpers */

  function softTexture(T) {
    var c = document.createElement("canvas");
    c.width = c.height = 64;
    var x = c.getContext("2d");
    var g = x.createRadialGradient(32, 32, 0, 32, 32, 32);
    g.addColorStop(0, "rgba(255,255,255,1)");
    g.addColorStop(0.25, "rgba(255,255,255,0.55)");
    g.addColorStop(0.6, "rgba(255,255,255,0.12)");
    g.addColorStop(1, "rgba(255,255,255,0)");
    x.fillStyle = g;
    x.fillRect(0, 0, 64, 64);
    var tex = new T.CanvasTexture(c);
    tex.colorSpace = T.SRGBColorSpace;
    return tex;
  }

  /** An axis-aligned box as one ungrouped, non-indexed geometry. */
  function box(T, w, h, d) {
    var x = w / 2, y = h / 2, z = d / 2;
    var v = [
      [-x, -y, z], [x, -y, z], [x, y, z], [-x, y, z],
      [-x, -y, -z], [x, -y, -z], [x, y, -z], [-x, y, -z],
    ];
    var faces = [[0, 1, 2, 3], [5, 4, 7, 6], [4, 0, 3, 7], [1, 5, 6, 2], [3, 2, 6, 7], [4, 5, 1, 0]];
    var pos = [];
    faces.forEach(function (f) {
      [0, 1, 2, 0, 2, 3].forEach(function (i) { pos.push.apply(pos, v[f[i]]); });
    });
    var g = new T.BufferGeometry();
    g.setAttribute("position", new T.BufferAttribute(new Float32Array(pos), 3));
    g.computeVertexNormals();
    return g;
  }

  /** A flat polygon (triangle fan) in the XY plane, as one ungrouped geometry. */
  function poly(T, pts) {
    var pos = [];
    for (var i = 1; i < pts.length - 1; i++) {
      pos.push(pts[0][0], pts[0][1], 0, pts[i][0], pts[i][1], 0, pts[i + 1][0], pts[i + 1][1], 0);
    }
    var g = new T.BufferGeometry();
    g.setAttribute("position", new T.BufferAttribute(new Float32Array(pos), 3));
    g.computeVertexNormals();
    return g;
  }

  function lathe(T, pts, seg, a0, a1) {
    var g = new T.LatheGeometry(pts.map(function (p) { return new T.Vector2(p[0], p[1]); }), seg || 40, a0 || 0, a1 === undefined ? Math.PI * 2 : a1);
    g.clearGroups();
    return g;
  }

  function sprite(E, color, size, opacity) {
    var T = E.T;
    var m = new T.SpriteMaterial({
      map: E.soft, color: color, transparent: true, opacity: opacity === undefined ? 1 : opacity,
      depthWrite: false, blending: E.light ? T.NormalBlending : T.AdditiveBlending,
    });
    var s = new T.Sprite(m);
    s.scale.set(size, size, 1);
    return s;
  }

  /** N points as one Points object; colours in `color`, additive on dark themes. */
  function points(E, n, size, color, opacity) {
    var T = E.T;
    var g = new T.BufferGeometry();
    g.setAttribute("position", new T.BufferAttribute(new Float32Array(n * 3), 3));
    var m = new T.PointsMaterial({
      map: E.soft, size: size * 2.6, color: color, transparent: true, opacity: opacity === undefined ? 1 : opacity,
      depthWrite: false, blending: E.light ? T.NormalBlending : T.AdditiveBlending, sizeAttenuation: true,
    });
    var p = new T.Points(g, m);
    p.frustumCulled = false;
    return p;
  }

  function lineMat(E, color, opacity) {
    var T = E.T;
    return new T.LineBasicMaterial({
      color: color, transparent: true, opacity: opacity === undefined ? 1 : opacity,
      depthWrite: false, blending: E.light ? T.NormalBlending : T.AdditiveBlending,
    });
  }

  function std(E, color, o) {
    o = o || {};
    var T = E.T;
    return new T.MeshStandardMaterial({
      color: color, metalness: o.metal === undefined ? 0.3 : o.metal, roughness: o.rough === undefined ? 0.5 : o.rough,
      flatShading: !!o.flat, emissive: o.emissive || 0x000000, emissiveIntensity: o.ei === undefined ? 1 : o.ei,
      transparent: o.opacity !== undefined, opacity: o.opacity === undefined ? 1 : o.opacity,
      side: o.double ? T.DoubleSide : T.FrontSide, depthWrite: o.depthWrite === undefined ? true : o.depthWrite,
    });
  }

  /** A soft dark ellipse under an object: what makes it sit on a surface in a bright scene. */
  function contactShadow(E, w, y) {
    var T = E.T;
    var m = new T.MeshBasicMaterial({ map: E.soft, color: 0x000000, transparent: true, opacity: E.light ? 0.34 : 0.5, depthWrite: false });
    var g = new T.PlaneGeometry(w, w * 0.5);
    g.clearGroups();
    var mesh = new T.Mesh(g, m);
    mesh.rotation.x = -Math.PI / 2;
    mesh.position.y = y;
    return mesh;
  }

  function accentOr(E, dark, light) { return E.light ? light : dark; }

  /**
   * A flat ribbon along a polyline: one ungrouped, indexed geometry, so a bolt or a
   * heart-monitor trace can be as thick as it should be (a Line is one pixel wide).
   * `set(pts, halfWidth)` re-lays it every frame, `halfWidth` a number or (i, n) => number.
   * Its positions are rewritten after the first draw, so the mesh must not be frustum-culled.
   */
  function strip(T, n) {
    var g = new T.BufferGeometry(), pos = new Float32Array(n * 6), idx = [];
    for (var i = 0; i < n - 1; i++) { var a = i * 2; idx.push(a, a + 1, a + 2, a + 1, a + 3, a + 2); }
    g.setAttribute("position", new T.BufferAttribute(pos, 3));
    g.setIndex(idx);
    return {
      geo: g,
      set: function (pts, hw) {
        for (var i = 0; i < n; i++) {
          var p = pts[i], a = pts[i > 0 ? i - 1 : 0], b = pts[i < n - 1 ? i + 1 : n - 1];
          var dx = b[0] - a[0], dy = b[1] - a[1], l = Math.sqrt(dx * dx + dy * dy) || 1;
          var w = typeof hw === "function" ? hw(i, n) : hw, nx = -dy / l * w, ny = dx / l * w;
          pos[i * 6] = p[0] + nx; pos[i * 6 + 1] = p[1] + ny; pos[i * 6 + 2] = p[2];
          pos[i * 6 + 3] = p[0] - nx; pos[i * 6 + 4] = p[1] - ny; pos[i * 6 + 5] = p[2];
        }
        g.attributes.position.needsUpdate = true;
      },
    };
  }

  /** A disc with a firm body and a soft rim: what a cloud puff or a billow of smoke is made of. */
  function bodyTexture(T) {
    var c = document.createElement("canvas");
    c.width = c.height = 64;
    var x = c.getContext("2d");
    var g = x.createRadialGradient(32, 32, 0, 32, 32, 32);
    g.addColorStop(0, "rgba(255,255,255,1)");
    g.addColorStop(0.5, "rgba(255,255,255,0.95)");
    g.addColorStop(0.78, "rgba(255,255,255,0.4)");
    g.addColorStop(1, "rgba(255,255,255,0)");
    x.fillStyle = g;
    x.fillRect(0, 0, 64, 64);
    var tex = new T.CanvasTexture(c);
    tex.colorSpace = T.SRGBColorSpace;
    return tex;
  }

  /** An ordinary-blended sprite: unlike sprite(), it can be DARKER than what is behind it (a cloud, smoke, mist). `firm`: a body with a soft rim, not a glow. */
  function puff(E, color, size, opacity, firm) {
    var T = E.T;
    if (firm && !E.bodyTex) E.bodyTex = bodyTexture(T);
    var s = new T.Sprite(new T.SpriteMaterial({ map: firm ? E.bodyTex : E.soft, color: color, transparent: true, opacity: opacity, depthWrite: false, blending: T.NormalBlending }));
    s.scale.set(size, size, 1);
    return s;
  }

  /** Distance between two phases on a circle of circumference 1, signed to (-0.5, 0.5]. */
  function wrap1(d) { return d - Math.floor(d + 0.5); }

  /**
   * A closed outline [[x, y], ...] lofted into a plump solid, as one ungrouped indexed geometry:
   * K+1 slices stacked front to back, each the outline shrunk toward its own centre
   * (`pw` > 2 squares the profile off). The two poles collapse to a point, so they are given
   * the flat cap's normal. `pos` holds the vertices, slice by slice, for contour lines.
   */
  function loft(T, ol, K, D, pw) {
    var N = ol.length, cx = 0, cy = 0, pos = [], idx = [], i, k;
    for (i = 0; i < N; i++) { cx += ol[i][0]; cy += ol[i][1]; }
    cx /= N; cy /= N;
    for (k = 0; k <= K; k++) {
      var w = Math.cos((k / K) * Math.PI), sc = Math.pow(Math.max(0, 1 - Math.pow(Math.abs(w), pw)), 1 / pw);
      for (i = 0; i < N; i++) pos.push(cx + (ol[i][0] - cx) * sc, cy + (ol[i][1] - cy) * sc, D * w);
    }
    for (k = 0; k < K; k++) for (i = 0; i < N; i++) {
      var a = k * N + i, b = k * N + (i + 1) % N, c = (k + 1) * N + i, d = (k + 1) * N + (i + 1) % N;
      idx.push(a, b, c, b, d, c);
    }
    var geo = new T.BufferGeometry(), arr = new Float32Array(pos);
    geo.setAttribute("position", new T.BufferAttribute(arr, 3));
    geo.setIndex(idx); geo.computeVertexNormals();
    var nrm = geo.attributes.normal;
    for (i = 0; i < N; i++) { nrm.setXYZ(i, 0, 0, 1); nrm.setXYZ(K * N + i, 0, 0, -1); }
    return { geo: geo, pos: arr, N: N, K: K, cx: cx, cy: cy };
  }

  /* ----------------------------------------------------------------- heroes
   * Each builder returns { group, update(t, p), cam(t, p, cam) }.
   *   t: seconds since the scene started.   p: 0..1 through the scene.
   * `cam` sets camera.position and calls lookAt; the default is a slow orbit.
   */

  /* -- hourglass: time, patience, deadlines, moments passing -- */
  HEROES.hourglass = function (E) {
    var T = E.T, g = new T.Group();
    var top = new T.SplineCurve([
      new T.Vector2(0.035, 0.0), new T.Vector2(0.07, 0.07), new T.Vector2(0.2, 0.26), new T.Vector2(0.42, 0.55),
      new T.Vector2(0.52, 0.82), new T.Vector2(0.5, 1.02), new T.Vector2(0.36, 1.14),
    ]).getPoints(26);
    var prof = [];
    for (var i = top.length - 1; i >= 0; i--) prof.push([top[i].x, -top[i].y]);
    for (i = 0; i < top.length; i++) prof.push([top[i].x, top[i].y]);
    var glass = new T.Mesh(lathe(T, prof, 56), std(E, E.light ? 0x9db0be : 0x8fc9d8, { metal: 0.1, rough: 0.06, opacity: E.light ? 0.2 : 0.16, double: true, depthWrite: false }));
    g.add(glass);
    // Specular strips hugging the glass: what reads as reflection with no environment map.
    [[-0.95, 0.14, 0.55], [0.55, 0.07, 0.35]].forEach(function (s) {
      var m = new T.Mesh(lathe(T, prof.map(function (p) { return [p[0] * 1.012, p[1]]; }), 4, s[0], s[1]),
        new T.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: s[2], depthWrite: false, side: T.DoubleSide, blending: E.light ? T.NormalBlending : T.AdditiveBlending }));
      g.add(m);
    });
    // Caps
    var capProf = [[0, 0], [0.62, 0], [0.66, 0.03], [0.66, 0.12], [0.56, 0.17], [0.0, 0.17]];
    var capMat = std(E, E.light ? 0x2a2622 : 0x1b1d24, { metal: 0.85, rough: 0.32 });
    var capT = new T.Mesh(lathe(T, capProf, 40), capMat); capT.position.y = 1.12; g.add(capT);
    var capB = new T.Mesh(lathe(T, capProf, 40), capMat); capB.position.y = -1.29; g.add(capB);
    [1.29, -1.12].forEach(function (y) {
      var r = new T.Mesh(new T.TorusGeometry(0.585, 0.012, 6, 56), new T.MeshBasicMaterial({ color: E.acc, transparent: true, opacity: 0.9 }));
      r.rotation.x = Math.PI / 2; r.position.y = y + (y > 0 ? -0.0 : 0); g.add(r);
    });
    // Sand: top bulb shrinks, bottom pile grows
    var sandProf = top.map(function (p) { return [p.x * 0.9, p.y]; });
    var sandMat = std(E, E.acc, { metal: 0.1, rough: 0.7, flat: true, emissive: E.acc, ei: E.light ? 0.0 : 0.55 });
    var topSand = new T.Mesh(lathe(T, sandProf, 36), sandMat);
    var baseY = top.map(function (p) { return p.y; });
    var baseR = top.map(function (p) { return p.x * 0.9; });
    function rAt(y) {
      for (var k = 1; k < baseY.length; k++) if (y <= baseY[k]) {
        var f = (y - baseY[k - 1]) / Math.max(1e-6, baseY[k] - baseY[k - 1]);
        return lerp(baseR[k - 1], baseR[k], clamp(f, 0, 1));
      }
      return baseR[baseR.length - 1];
    }
    var tPos = topSand.geometry.attributes.position;
    var tRings = top.length, tSeg = 37;
    sandMat.side = T.DoubleSide;
    g.add(topSand);
    var topCap = new T.Mesh(new T.CircleGeometry(1, 36), std(E, E.light ? 0xd9a66a : 0xffb070, { metal: 0, rough: 0.9, emissive: E.acc, ei: E.light ? 0 : 0.35 }));
    topCap.geometry.clearGroups(); topCap.rotation.x = -Math.PI / 2; g.add(topCap);
    var pile = new T.Mesh(lathe(T, [[0, 1], [0.24, 0.62], [0.42, 0.22], [0.5, 0]], 28), sandMat);
    g.add(pile);
    var stream = points(E, 150, 0.05, E.acc, 0.95); g.add(stream);
    var halo = sprite(E, E.acc, 3.6, E.light ? 0.0 : 0.3); halo.position.set(0, 0, -0.5); g.add(halo);
    var neck = sprite(E, E.acc, 0.5, E.light ? 0.0 : 0.85); g.add(neck);
    var dust = points(E, 90, 0.045, E.light ? 0x8a7a68 : E.acc2, E.light ? 0.45 : 0.55); g.add(dust);
    var rnd = mulberry(11), dp = [];
    for (i = 0; i < 90; i++) dp.push([rnd() * 5 - 2.5, rnd() * 4.4 - 2.2, rnd() * 3 - 1.8, rnd()]);
    g.add(contactShadow(E, 2.6, -1.36));
    return {
      group: g,
      update: function (t, p) {
        var L = lerp(1.1, 0.12, smooth(0.02, 0.96, p));
        for (var r = 0; r < tRings; r++) {
          var y = Math.min(baseY[r], L);
          var rad = rAt(y);
          for (var s = 0; s < tSeg; s++) {
            var idx = s * tRings + r;
            var ph = (s / (tSeg - 1)) * Math.PI * 2;
            tPos.setXYZ(idx, rad * Math.sin(ph), y, rad * Math.cos(ph));
          }
        }
        tPos.needsUpdate = true;
        topSand.geometry.computeVertexNormals();
        topCap.position.y = L; topCap.scale.setScalar(Math.max(0.02, rAt(L)));
        var f = smooth(0.0, 0.96, p);
        var hp = 0.02 + 0.74 * f;
        pile.position.y = -1.1; pile.scale.set(0.25 + 0.75 * Math.min(1, f * 1.6), hp, 0.25 + 0.75 * Math.min(1, f * 1.6));
        var sp = stream.geometry.attributes.position, flow = p < 0.97 ? 1 : 0;
        for (var k = 0; k < 150; k++) {
          var fr = fract(k / 150 + t * 1.15);
          var yy = lerp(0.02, -1.1 + hp, fr);
          sp.setXYZ(k, Math.sin(k * 12.9) * 0.01, flow ? yy : -9, Math.cos(k * 7.7) * 0.01);
        }
        sp.needsUpdate = true;
        var dpp = dust.geometry.attributes.position;
        for (k = 0; k < 90; k++) {
          var d = dp[k];
          dpp.setXYZ(k, d[0] + Math.sin(t * 0.3 + d[3] * 6) * 0.15, d[1] + ((t * 0.08 * (0.4 + d[3]) + d[3] * 5) % 4.4) - 2.2 - d[1] * 0.0, d[2]);
        }
        dpp.needsUpdate = true;
        neck.material.opacity = (E.light ? 0 : 0.85) * (flow ? 1 : 0);
        g.rotation.y = Math.sin(p * Math.PI * 2) * 0.12 + p * 0.5;
      },
      cam: function (t, p, cam) {
        var a = lerp(-0.25, 0.3, p), d = lerp(7.4, 6.2, ease(p));
        cam.position.set(Math.sin(a) * d, 0.5 + p * 0.3, Math.cos(a) * d); cam.lookAt(0, -0.05, 0);
      },
    };
  };

  function ease(x) { x = clamp(x, 0, 1); return x < 0.5 ? 2 * x * x : 1 - Math.pow(-2 * x + 2, 2) / 2; }

  /* -- clock: urgency, routine, the day, deadlines (a clock inside a vortex of light) -- */
  HEROES.clock = function (E) {
    var T = E.T, g = new T.Group();
    var rim = new T.Mesh(new T.TorusGeometry(1.0, 0.055, 14, 72), std(E, E.light ? 0x2a2622 : 0xd9b36a, { metal: 0.9, rough: 0.28, emissive: E.acc, ei: E.light ? 0 : 0.25 }));
    g.add(rim);
    var face = new T.Mesh(new T.CircleGeometry(0.96, 64), std(E, E.light ? 0xf4ecda : 0x0b0d14, { metal: 0.1, rough: 0.8 }));
    face.position.z = -0.02; g.add(face);
    var ticks = new T.BufferGeometry(), tp = [];
    for (var i = 0; i < 60; i++) {
      var a = (i / 60) * Math.PI * 2, big = i % 5 === 0, r0 = big ? 0.78 : 0.88, r1 = 0.94;
      tp.push(Math.sin(a) * r0, Math.cos(a) * r0, 0.0, Math.sin(a) * r1, Math.cos(a) * r1, 0.0);
    }
    ticks.setAttribute("position", new T.BufferAttribute(new Float32Array(tp), 3));
    g.add(new T.LineSegments(ticks, lineMat(E, E.light ? 0x2a2622 : 0xf0d9a0, 0.95)));
    var hourH = new T.Mesh(poly(T, [[-0.035, -0.05], [0.035, -0.05], [0.02, 0.5], [-0.02, 0.5]]), std(E, E.light ? 0x2a2622 : 0xf6e3b0, { metal: 0.6, rough: 0.35, double: true }));
    var minH = new T.Mesh(poly(T, [[-0.026, -0.07], [0.026, -0.07], [0.012, 0.8], [-0.012, 0.8]]), std(E, E.light ? 0x2a2622 : 0xf6e3b0, { metal: 0.6, rough: 0.35, double: true }));
    var secH = new T.Mesh(poly(T, [[-0.008, -0.16], [0.008, -0.16], [0.004, 0.88], [-0.004, 0.88]]), new T.MeshBasicMaterial({ color: E.acc, side: T.DoubleSide }));
    hourH.position.z = 0.03; minH.position.z = 0.05; secH.position.z = 0.07;
    g.add(hourH, minH, secH);
    g.add(new T.Mesh(new T.SphereGeometry(0.06, 16, 12), std(E, E.acc, { emissive: E.acc, ei: 0.6 }))).position.z = 0.08;
    // The vortex: golden-angle spiral arms that rotate and slowly draw in.
    var N = 900, vort = points(E, N, 0.05, E.acc, E.light ? 0.7 : 0.9), vort2 = points(E, 500, 0.06, E.acc2, E.light ? 0.5 : 0.7);
    var rnd = mulberry(5), seeds = [];
    for (i = 0; i < N; i++) seeds.push([rnd(), rnd(), rnd()]);
    g.add(vort, vort2);
    var halo = sprite(E, E.acc, 4.2, E.light ? 0 : 0.28); halo.position.z = -0.6; g.add(halo);
    g.add(contactShadow(E, 3.2, -1.7));
    return {
      group: g,
      update: function (t, p) {
        var vp = vort.geometry.attributes.position, vq = vort2.geometry.attributes.position;
        for (var k = 0; k < N; k++) {
          var s = seeds[k], arm = k % 3;
          var rr = 1.25 + s[0] * 2.7, ang = arm * 2.094 + rr * 1.7 - t * (0.55 + 0.25 / rr) + s[1] * 0.35;
          var spread = (s[2] - 0.5) * 0.22 * rr;
          vp.setXYZ(k, Math.cos(ang) * rr, Math.sin(ang) * rr * 0.88, -0.25 + spread);
        }
        vp.needsUpdate = true;
        for (k = 0; k < 500; k++) {
          var s2 = seeds[k], rr2 = 1.1 + s2[1] * 3.0, ang2 = 1.05 + rr2 * 1.7 + t * (0.45 + 0.2 / rr2) * -1 + s2[0];
          vq.setXYZ(k, Math.cos(ang2) * rr2, Math.sin(ang2) * rr2 * 0.88, -0.4 + (s2[2] - 0.5) * 0.3);
        }
        vq.needsUpdate = true;
        // Time passes faster as the scene goes on.
        var tt = t * (0.6 + p * 1.8);
        secH.rotation.z = -tt * 6.2832 / 6;
        minH.rotation.z = -tt * 6.2832 / 72;
        hourH.rotation.z = -tt * 6.2832 / 864 + 0.9;
        g.rotation.y = Math.sin(t * 0.35) * 0.18; g.rotation.x = Math.sin(t * 0.27) * 0.06;
      },
      cam: function (t, p, cam) { var d = lerp(8.6, 6.6, ease(p)); cam.position.set(0, 0.1, d); cam.lookAt(0, 0, 0); },
    };
  };

  /* -- orbit: systems, the bigger picture, perspective, order -- */
  HEROES.orbit = function (E) {
    var T = E.T, g = new T.Group();
    var sun = new T.Mesh(new T.SphereGeometry(0.34, 32, 24), new T.MeshBasicMaterial({ color: E.light ? 0xffc27a : 0xfff0cc }));
    g.add(sun);
    var sunHalo = sprite(E, E.acc, 4.6, E.light ? 0.3 : 0.7); g.add(sunHalo);
    var flare = sprite(E, 0xffffff, 1.9, E.light ? 0.0 : 0.7); g.add(flare);
    var defs = [
      { r: 1.15, s: 0.16, sp: 0.9, tilt: 0.0, c: E.light ? 0x6b7f94 : 0x9ab3d0, ph: 0.4 },
      { r: 1.75, s: 0.27, sp: 0.55, tilt: 0.12, c: E.acc, ph: 2.1 },
      { r: 2.45, s: 0.38, sp: 0.34, tilt: -0.08, c: E.light ? 0x2f3b4d : 0x3d5a80, ph: 4.2 },
      { r: 3.15, s: 0.2, sp: 0.22, tilt: 0.06, c: E.light ? 0x8a6a4a : 0xe0b080, ph: 1.2 },
    ];
    var planets = defs.map(function (d) {
      var ring = new T.Mesh(new T.TorusGeometry(d.r, 0.006, 4, 120), new T.MeshBasicMaterial({ color: E.light ? 0x2a2622 : 0xf0e2c8, transparent: true, opacity: E.light ? 0.4 : 0.35, blending: E.light ? T.NormalBlending : T.AdditiveBlending, depthWrite: false }));
      ring.rotation.x = Math.PI / 2 + d.tilt;
      g.add(ring);
      var m = new T.Mesh(new T.SphereGeometry(d.s, 28, 20), std(E, d.c, { metal: 0.15, rough: 0.65 }));
      g.add(m);
      if (d.s > 0.25) {
        var band = new T.Mesh(new T.TorusGeometry(d.s * 1.55, d.s * 0.07, 3, 40), std(E, E.light ? 0x8a7a68 : 0xd8c9a8, { opacity: 0.8, rough: 0.8 }));
        band.rotation.x = Math.PI / 2.4; m.add(band);
      }
      return { m: m, d: d };
    });
    var stars = points(E, 260, 0.04, 0xffffff, E.light ? 0.0 : 0.8);
    var rnd = mulberry(23), sp = stars.geometry.attributes.position;
    for (var i = 0; i < 260; i++) sp.setXYZ(i, rnd() * 14 - 7, rnd() * 10 - 5, -rnd() * 7 - 1);
    sp.needsUpdate = true; g.add(stars);
    g.add(contactShadow(E, 6.5, -1.5));
    g.rotation.x = 0.55; g.scale.setScalar(0.66);
    return {
      group: g,
      update: function (t, p) {
        planets.forEach(function (q) {
          var a = q.d.ph + t * q.d.sp;
          q.m.position.set(Math.cos(a) * q.d.r, Math.sin(q.d.tilt) * Math.cos(a) * q.d.r, Math.sin(a) * q.d.r);
          q.m.rotation.y = t * 0.6;
        });
        flare.scale.setScalar(0.9 + Math.sin(t * 2.1) * 0.12);
      },
      cam: function (t, p, cam) {
        var a = lerp(-0.35, 0.35, p), d = lerp(10.5, 7.4, ease(p));
        cam.position.set(Math.sin(a) * d, 1.6, Math.cos(a) * d); cam.lookAt(0, 0, 0);
      },
    };
  };

  /* -- orb: the fallback for any idea with no object of its own -- */
  HEROES.orb = function (E) {
    var T = E.T, g = new T.Group();
    var core = new T.Mesh(new T.IcosahedronGeometry(0.62, 3), std(E, E.light ? 0xf4ecda : 0x161a24, { metal: 0.7, rough: 0.2, emissive: E.acc, ei: E.light ? 0.0 : 0.65 }));
    g.add(core);
    var shell = new T.Mesh(new T.IcosahedronGeometry(0.9, 1), new T.MeshBasicMaterial({ color: E.acc, wireframe: true, transparent: true, opacity: E.light ? 0.5 : 0.55, blending: E.light ? T.NormalBlending : T.AdditiveBlending, depthWrite: false }));
    g.add(shell);
    var rings = [0, 1, 2].map(function (i) {
      var r = new T.Mesh(new T.TorusGeometry(0.62, 0.008, 6, 96), new T.MeshBasicMaterial({ color: E.light ? 0x2a2622 : E.acc2, transparent: true, opacity: 0.7, blending: E.light ? T.NormalBlending : T.AdditiveBlending, depthWrite: false }));
      g.add(r); return r;
    });
    var N = 700, vort = points(E, N, 0.05, E.acc, E.light ? 0.7 : 0.9), seeds = [], rnd = mulberry(31);
    for (var i = 0; i < N; i++) seeds.push([rnd(), rnd(), rnd()]);
    g.add(vort);
    var halo = sprite(E, E.acc, 4.4, E.light ? 0.0 : 0.3); halo.position.z = -0.5; g.add(halo);
    g.add(contactShadow(E, 3.0, -1.7));
    return {
      group: g,
      update: function (t, p) {
        core.rotation.set(t * 0.3, t * 0.45, 0); shell.rotation.set(-t * 0.2, t * 0.3, 0);
        rings.forEach(function (r, i) {
          var f = fract(t * 0.32 + i / 3), s = 0.9 + f * 2.2;
          r.scale.setScalar(s); r.material.opacity = (1 - f) * (E.light ? 0.6 : 0.8);
          r.rotation.set(Math.PI / 2 + i * 0.5, i * 0.7, 0);
        });
        var vp = vort.geometry.attributes.position;
        for (var k = 0; k < N; k++) {
          var s = seeds[k], rr = 1.2 + s[0] * 2.4, ang = s[1] * 6.283 + t * (0.4 + 0.5 / rr);
          vp.setXYZ(k, Math.cos(ang) * rr, (s[2] - 0.5) * 1.6 * (1.2 - s[0] * 0.5), Math.sin(ang) * rr * 0.7);
        }
        vp.needsUpdate = true;
        g.rotation.y = t * 0.12;
      },
      cam: function (t, p, cam) { var d = lerp(8.2, 6.4, ease(p)); cam.position.set(Math.sin(p * 0.5) * 1.2, 1.0, d); cam.lookAt(0, 0, 0); },
    };
  };


  /* -- staircase: progress, small steps, habits, climbing, improvement -- */
  HEROES.staircase = function (E) {
    var T = E.T, g = new T.Group(), n = 9, steps = [], mats = [];
    var edge = [];
    for (var i = 0; i < n; i++) {
      var top = -1.2 + (i + 1) * 0.36, h = top + 1.5;
      var m = std(E, E.light ? (i % 2 ? 0xe6dac2 : 0xf3eadb) : (i % 2 ? 0x1b2033 : 0x252b45), { metal: 0.25, rough: 0.55, emissive: E.acc, ei: 0 });
      var mesh = new T.Mesh(box(T, 1.15, h, 1.0), m);
      mesh.position.set(-1.7 + i * 0.5, -1.5 + h / 2, -i * 0.2);
      g.add(mesh); mats.push(m);
      steps.push({ x: mesh.position.x, top: top, z: mesh.position.z });
      var x0 = mesh.position.x - 0.575, x1 = mesh.position.x + 0.575, z1 = mesh.position.z + 0.5;
      edge.push(x0, top + 0.002, z1, x1, top + 0.002, z1);
    }
    var eg = new T.BufferGeometry();
    eg.setAttribute("position", new T.BufferAttribute(new Float32Array(edge), 3));
    g.add(new T.LineSegments(eg, lineMat(E, E.light ? 0x2a2622 : E.acc, E.light ? 0.5 : 0.95)));
    var orb = new T.Group();
    orb.add(new T.Mesh(new T.SphereGeometry(0.17, 24, 18), new T.MeshBasicMaterial({ color: E.light ? E.acc : 0xffffff })));
    orb.add(sprite(E, E.acc, E.light ? 0.9 : 1.6, E.light ? 0.35 : 0.85));
    g.add(orb);
    var trail = points(E, 46, 0.05, E.acc, E.light ? 0.7 : 0.9); g.add(trail);
    var dust = points(E, 70, 0.04, E.light ? 0x8a7a68 : E.acc2, E.light ? 0.4 : 0.5); g.add(dust);
    var rnd = mulberry(41), dp = [];
    for (i = 0; i < 70; i++) dp.push([rnd() * 6 - 3, rnd() * 4 - 1.5, rnd() * 3 - 2, rnd()]);
    g.add(contactShadow(E, 5.2, -1.52));
    function posAt(u) {
      u = clamp(u, 0, n - 1.0001);
      var k = Math.floor(u), f = u - k, a = steps[k], b = steps[Math.min(n - 1, k + 1)];
      var e = f * f * (3 - 2 * f);
      return [lerp(a.x, b.x, e), lerp(a.top, b.top, e) + 0.19 + Math.sin(Math.PI * f) * 0.34, lerp(a.z, b.z, e)];
    }
    return {
      group: g,
      update: function (t, p) {
        var u = ease(clamp(p * 1.04, 0, 1)) * (n - 1.0001);
        var o = posAt(u);
        orb.position.set(o[0], o[1], o[2] + 0.1);
        for (var k = 0; k < n; k++) mats[k].emissiveIntensity = (E.light ? 0.0 : 0.22) * smooth(k - 0.2, k + 0.6, u + 0.7);
        var tp = trail.geometry.attributes.position;
        for (k = 0; k < 46; k++) { var q = posAt(Math.max(0, u - k * 0.07)); tp.setXYZ(k, q[0], q[1] - 0.03 * k * 0.1, q[2] + 0.1); }
        tp.needsUpdate = true;
        var dpp = dust.geometry.attributes.position;
        for (k = 0; k < 70; k++) { var d = dp[k]; dpp.setXYZ(k, d[0] + Math.sin(t * 0.4 + d[3] * 6) * 0.2, d[1] + ((t * 0.12 * (0.4 + d[3]) + d[3] * 4) % 4), d[2]); }
        dpp.needsUpdate = true;
        this._o = o;
      },
      cam: function (t, p, cam) {
        var o = this._o || [0, 0, 0];
        cam.position.set(o[0] * 0.5 + 3.0, o[1] * 0.55 + 1.3, 11.6 - p * 1.0); cam.lookAt(o[0] * 0.55, o[1] * 0.55 - 0.1, -0.6);
      },
    };
  };

  /* -- bookletters: knowledge, reading, learning, ideas becoming words -- */
  HEROES.bookletters = function (E) {
    var T = E.T, g = new T.Group();
    var pc = document.createElement("canvas"); pc.width = 256; pc.height = 340;
    var px = pc.getContext("2d");
    px.fillStyle = E.light ? "#fbf7ec" : "#f1e9d4"; px.fillRect(0, 0, 256, 340);
    var rr = mulberry(9); px.fillStyle = "rgba(60,50,40,0.5)";
    for (var y = 34; y < 310; y += 14) px.fillRect(30, y, 140 + rr() * 70, 3.2);
    var pt = new T.CanvasTexture(pc); pt.colorSpace = T.SRGBColorSpace;
    function page(side) {
      var geo = new T.PlaneGeometry(1.5, 2.0, 16, 1), pos = geo.attributes.position;
      for (var k = 0; k < pos.count; k++) {
        var u = (pos.getX(k) + 0.75) / 1.5, d = side > 0 ? u : 1 - u;
        pos.setZ(k, 0.3 * Math.sin(Math.PI * Math.min(1, d * 1.06)) * (1 - d * 0.35) + 0.03 * d);
      }
      geo.computeVertexNormals(); geo.clearGroups();
      var m = new T.Mesh(geo, new T.MeshStandardMaterial({ map: pt, roughness: 0.92, metalness: 0, side: T.DoubleSide }));
      m.rotation.x = -Math.PI / 2; m.position.set(side * 0.75, 0.04, 0);
      if (side < 0) m.scale.x = 1;
      return m;
    }
    g.add(page(1), page(-1));
    var cover = new T.Mesh(box(T, 3.25, 0.14, 2.15), std(E, E.light ? 0x6a3b24 : 0x3a2418, { metal: 0.15, rough: 0.7 }));
    cover.position.y = -0.08; g.add(cover);
    var abc = "KNOWLEDGEABCDHIMRSTUVY", N = 46, ls = [];
    function letterTex(ch, col) {
      var c = document.createElement("canvas"); c.width = 96; c.height = 112;
      var x = c.getContext("2d"); x.font = "bold 92px Georgia, 'Times New Roman', serif"; x.textAlign = "center"; x.textBaseline = "middle";
      x.fillStyle = col; x.fillText(ch, 48, 58);
      var tx = new T.CanvasTexture(c); tx.colorSpace = T.SRGBColorSpace; return tx;
    }
    var lg = new T.PlaneGeometry(0.3, 0.36); lg.clearGroups();
    var cols = E.light ? ["#2a2622", "#b3341c"] : ["#f6ecd6", "#" + E.acc.getHexString()];
    for (var i = 0; i < N; i++) {
      var col = cols[i % 5 === 0 ? 1 : 0];
      var mat = new T.MeshBasicMaterial({ map: letterTex(abc[i % abc.length], col), transparent: true, side: T.DoubleSide, depthWrite: false });
      var m = new T.Mesh(lg, mat); g.add(m); ls.push(m);
    }
    var motes = points(E, 120, 0.035, E.light ? 0x8a7a68 : 0xffe2b0, E.light ? 0.5 : 0.8); g.add(motes);
    var rnd = mulberry(77), mp = [];
    for (i = 0; i < 120; i++) mp.push([rnd(), rnd(), rnd()]);
    var glow = sprite(E, E.acc, 3.2, E.light ? 0.0 : 0.4); glow.position.set(0, 0.5, 0); g.add(glow);
    g.add(contactShadow(E, 4.4, -0.16));
    return {
      group: g,
      update: function (t, p) {
        for (var k = 0; k < N; k++) {
          var fl = fract(k / N + t * 0.15), y = 0.35 + fl * 3.3;
          var ang = k * 0.55 + t * 0.8 + fl * 2.2, rad = 0.42 + fl * 0.95;
          ls[k].position.set(Math.cos(ang) * rad, y, Math.sin(ang) * rad);
          ls[k].rotation.set(0.15 * Math.sin(k), -ang + Math.PI / 2, 0.3 * Math.sin(k * 1.7 + t));
          ls[k].material.opacity = smooth(0, 0.1, fl) * smooth(1, 0.8, fl);
        }
        var mp2 = motes.geometry.attributes.position;
        for (k = 0; k < 120; k++) {
          var m2 = mp[k], f2 = fract(m2[0] + t * 0.1 * (0.5 + m2[1]));
          var a2 = m2[2] * 6.28 + t * 0.5;
          mp2.setXYZ(k, Math.cos(a2) * (0.3 + f2 * 1.3), 0.2 + f2 * 3.6, Math.sin(a2) * (0.3 + f2 * 1.3));
        }
        mp2.needsUpdate = true;
        g.rotation.y = Math.sin(p * 3.14) * 0.2;
      },
      cam: function (t, p, cam) { var d = lerp(8.4, 6.8, ease(p)); cam.position.set(Math.sin(p * 0.8 - 0.3) * 2.2, 1.6 + p * 0.6, d); cam.lookAt(0, 1.45, 0); },
    };
  };

  /* -- chain: the past, a burden, a trap, being weighed down (and breaking free) -- */
  HEROES.chain = function (E) {
    var T = E.T, g = new T.Group(), n = 10, links = [];
    var mat = std(E, E.light ? 0x3a3631 : 0x9aa3b8, { metal: 0.92, rough: 0.28 });
    var lg = new T.TorusGeometry(0.2, 0.058, 10, 28);
    for (var i = 0; i < n; i++) {
      var l = new T.Mesh(lg, mat); l.scale.set(1, 1.55, 1);
      l.position.y = 2.1 - i * 0.36; l.rotation.y = i % 2 ? Math.PI / 2 : 0;
      g.add(l); links.push(l);
    }
    var ballMat = std(E, E.light ? 0x23201d : 0x2a2e3a, { metal: 0.85, rough: 0.35, emissive: E.acc, ei: E.light ? 0 : 0.18 });
    var ball = new T.Mesh(new T.SphereGeometry(0.62, 36, 26), ballMat); g.add(ball);
    var ring = new T.Mesh(new T.TorusGeometry(0.64, 0.012, 6, 64), new T.MeshBasicMaterial({ color: E.acc, transparent: true, opacity: 0.9 }));
    ring.rotation.x = Math.PI / 2; ball.add(ring);
    var halo = sprite(E, E.acc, 3.0, E.light ? 0.0 : 0.3); g.add(halo);
    var flash = sprite(E, 0xffffff, 1.0, 0); g.add(flash);
    var sparks = points(E, 60, 0.04, E.acc, 0.95); g.add(sparks);
    var rnd = mulberry(3), sd = [];
    for (i = 0; i < 60; i++) sd.push([rnd() * 6.28, 0.6 + rnd() * 1.6, rnd() - 0.2]);
    g.add(contactShadow(E, 3.0, -2.2));
    var BREAK = 0.6, K = 5;
    return {
      group: g,
      update: function (t, p) {
        var sway = Math.sin(t * 0.9) * 0.03, q = Math.max(0, p - BREAK - 0.02);
        for (var k = 0; k < n; k++) {
          var l = links[k];
          l.position.set(0, 2.1 - k * 0.36, 0); l.rotation.z = 0; l.rotation.y = k % 2 ? Math.PI / 2 : 0;
          if (k >= K) {
            var w = (k - K + 1) / (n - K);
            l.position.y -= q * q * 16 * (0.6 + w * 0.4) + q * 1.2;
            l.position.x = (k % 2 ? 1 : -1) * q * 1.4 * w;
            l.rotation.z = q * 5 * (k % 2 ? 1 : -1);
          }
        }
        var by = 2.1 - n * 0.36 - 0.45;
        ball.position.set(0, by - (q * q * 22 + q * 2.2), 0); ball.rotation.z = q * 3;
        halo.position.copy(ball.position);
        g.rotation.z = sway * (1 - smooth(BREAK, BREAK + 0.04, p));
        var fp = smooth(BREAK - 0.01, BREAK + 0.03, p) * (1 - smooth(BREAK + 0.03, BREAK + 0.2, p));
        flash.position.set(0, 2.1 - (K - 0.5) * 0.36, 0.3); flash.scale.setScalar(0.6 + fp * 3.4); flash.material.opacity = fp * (E.light ? 0.55 : 0.95);
        var sp = sparks.geometry.attributes.position, sp0 = smooth(BREAK, BREAK + 0.02, p);
        for (k = 0; k < 60; k++) {
          var s = sd[k], r = q * s[1] * 2.2;
          sp.setXYZ(k, flash.position.x + Math.cos(s[0]) * r, flash.position.y + Math.sin(s[0]) * r - q * q * 6 * s[2], 0.2);
          if (!sp0) sp.setXYZ(k, 0, -50, 0);
        }
        sp.needsUpdate = true;
      },
      cam: function (t, p, cam) { cam.position.set(Math.sin(p * 1.4 - 0.4) * 1.6, 0.3, 9.4 - p * 0.8); cam.lookAt(0, -0.1 - p * 0.3, 0); },
    };
  };

  /* -- path: a decision, a direction, a journey with a fork -- */
  HEROES.path = function (E) {
    var T = E.T, g = new T.Group();
    var grid = new T.Mesh(new T.PlaneGeometry(16, 34, 16, 34), new T.MeshBasicMaterial({ color: E.light ? 0x2a2622 : E.acc2, wireframe: true, transparent: true, opacity: E.light ? 0.16 : 0.22, blending: E.light ? T.NormalBlending : T.AdditiveBlending, depthWrite: false }));
    grid.geometry.clearGroups(); grid.rotation.x = -Math.PI / 2; grid.position.set(0, -1.2, -9); g.add(grid);
    function curve(pts) { return new T.CatmullRomCurve3(pts.map(function (v) { return new T.Vector3(v[0], -1.14, v[1]); })); }
    var main = curve([[0, 7], [0, 2], [0, -3]]), left = curve([[0, -3], [-0.9, -6], [-2.8, -12]]), right = curve([[0, -3], [1.0, -6], [3.2, -12]]);
    [[main, E.acc], [left, E.acc], [right, E.light ? 0x2a2622 : E.acc2]].forEach(function (c) {
      var tube = new T.Mesh(new T.TubeGeometry(c[0], 64, 0.06, 6, false), new T.MeshBasicMaterial({ color: c[1] }));
      tube.geometry.clearGroups(); g.add(tube);
      var glowTube = new T.Mesh(new T.TubeGeometry(c[0], 64, 0.2, 6, false), new T.MeshBasicMaterial({ color: c[1], transparent: true, opacity: E.light ? 0.1 : 0.18, depthWrite: false, blending: E.light ? T.NormalBlending : T.AdditiveBlending }));
      glowTube.geometry.clearGroups(); g.add(glowTube);
    });
    var bl = sprite(E, E.acc, 3.4, E.light ? 0.5 : 0.8); bl.position.set(-2.8, -0.6, -12); g.add(bl);
    var br = sprite(E, E.light ? 0x2a2622 : E.acc2, 3.4, E.light ? 0.4 : 0.8); br.position.set(3.2, -0.6, -12); g.add(br);
    function orb(col) { var o = new T.Group(); o.add(new T.Mesh(new T.SphereGeometry(0.15, 20, 14), new T.MeshBasicMaterial({ color: E.light ? col : 0xffffff }))); o.add(sprite(E, col, 1.3, E.light ? 0.4 : 0.9)); g.add(o); return o; }
    var o1 = orb(E.acc), o2 = orb(E.light ? 0x2a2622 : E.acc2);
    var trail = points(E, 60, 0.05, E.acc, 0.9); g.add(trail);
    var stars = points(E, 120, 0.05, 0xffffff, E.light ? 0.0 : 0.7);
    var rnd = mulberry(8), sp = stars.geometry.attributes.position;
    for (var i = 0; i < 120; i++) sp.setXYZ(i, rnd() * 18 - 9, rnd() * 6 + 0.2, -rnd() * 14 - 2);
    sp.needsUpdate = true; g.add(stars);
    g.position.y = 0.0;
    return {
      group: g,
      update: function (t, p) {
        var u = smooth(0.0, 0.55, p), v = smooth(0.55, 1.0, p);
        var a = main.getPoint(u), b = left.getPoint(v), c = right.getPoint(v);
        o1.position.set(v > 0 ? b.x : a.x, -1.0, v > 0 ? b.z : a.z);
        o2.position.set(v > 0 ? c.x : a.x, -1.0, v > 0 ? c.z : a.z);
        o2.visible = v > 0; o2.children[1].material.opacity = E.light ? 0.4 : 0.9;
        var tp = trail.geometry.attributes.position;
        for (var k = 0; k < 60; k++) {
          var uu = Math.max(0, u - k * 0.012), q = main.getPoint(uu);
          tp.setXYZ(k, q.x, -1.05, q.z);
        }
        tp.needsUpdate = true;
        bl.material.opacity = (E.light ? 0.5 : 0.8) * (0.8 + 0.2 * Math.sin(t * 3)); br.material.opacity = (E.light ? 0.4 : 0.8) * (0.8 + 0.2 * Math.sin(t * 3 + 1.5));
      },
      cam: function (t, p, cam) { cam.position.set(Math.sin(p * 0.6) * 0.8, 0.9 + p * 0.4, lerp(8.8, 3.6, ease(p))); cam.lookAt(0, -0.9, -8); },
    };
  };


  /* -- mountain: a challenge, a goal, an obstacle, ambition, the summit -- */
  HEROES.mountain = function (E) {
    var T = E.T, g = new T.Group();
    function noise(x, z) { return Math.sin(x * 1.7 + 1.3) * Math.cos(z * 1.3 - 0.4) * 0.5 + Math.sin(x * 3.1 + z * 2.3) * 0.25 + Math.sin(x * 6.3 - z * 4.1) * 0.1; }
    function terrain(w, d, seg, peaks, col, y0, z0) {
      var geo = new T.PlaneGeometry(w, d, seg, seg), pos = geo.attributes.position;
      for (var k = 0; k < pos.count; k++) {
        var x = pos.getX(k), z = -pos.getY(k), h = 0;
        peaks.forEach(function (pk) {
          var r = Math.sqrt((x - pk[0]) * (x - pk[0]) + (z - pk[1]) * (z - pk[1])) / pk[2];
          h += pk[3] * Math.pow(Math.max(0, 1 - r), 1.35);
        });
        pos.setZ(k, h + noise(x, z) * 0.22 * (1 + h * 0.3));
      }
      geo.computeVertexNormals(); geo.clearGroups();
      var m = new T.Mesh(geo, std(E, col, { metal: 0.05, rough: 0.9, flat: true }));
      m.rotation.x = -Math.PI / 2; m.position.set(0, y0, z0);
      return m;
    }
    g.add(terrain(14, 9, 34, [[0, 0, 3.6, 3.3], [-2.6, 0.8, 2.4, 1.4], [2.7, 1.1, 2.6, 1.7]], E.light ? 0xd8cbb4 : 0x2a2f45, -1.2, -1.0));
    g.add(terrain(22, 8, 26, [[-5, 0, 4, 2.2], [4.5, -1, 4.2, 2.6], [0, -2, 5, 1.6]], E.light ? 0xe6dcc8 : 0x1b1f33, -1.4, -7));
    var beacon = sprite(E, E.acc, 2.8, E.light ? 0.45 : 0.95); beacon.position.set(0, 2.45, -1.0); g.add(beacon);
    var beam = new T.Mesh(new T.PlaneGeometry(0.28, 5.5), new T.MeshBasicMaterial({ map: E.soft, color: E.acc, transparent: true, opacity: E.light ? 0.22 : 0.5, depthWrite: false, blending: E.light ? T.NormalBlending : T.AdditiveBlending, side: T.DoubleSide }));
    beam.geometry.clearGroups(); beam.position.set(0, 4.7, -1.0); g.add(beam);
    /* The summit flag. It used to be a bare triangle hanging in the air with no
       staff, spun about its own vertical axis by flag.rotation.y — so it read as
       a rigid plate swivelling like a weather vane, which is the one thing cloth
       never does. A real flag is pinned along its hoist edge and free at the fly,
       so the motion has to GROW across the cloth from nothing at the pole to its
       full throw at the far edge. That is the whole illusion, and a single
       rotation cannot express it because a rotation moves every point at once.

       So: a staff that does not move, and a cloth whose vertices are displaced by
       a travelling wave whose amplitude rises with distance from the staff. Each
       vertex is recomputed from its STORED base position every frame rather than
       nudged from wherever it ended up last frame — the renderer seeks to
       timestamps in a non-linear order, so anything that accumulates would paint
       a different flag depending on which frames happened to be rendered first. */
    var staff = new T.Mesh(new T.PlaneGeometry(0.045, 0.95), std(E, E.light ? 0x4a4336 : 0xc3cbdd, { metal: 0.65, rough: 0.35, double: true }));
    staff.geometry.clearGroups();
    staff.position.set(0, 2.55, -1.0); g.add(staff);

    var FLAG_W = 0.66, FLAG_H = 0.38;
    var flagGeo = new T.PlaneGeometry(FLAG_W, FLAG_H, 14, 7);
    flagGeo.clearGroups();
    // flatShading so each fold catches the light differently: without it the wave
    // moves the silhouette but the surface stays one dead colour.
    var flag = new T.Mesh(flagGeo, std(E, E.acc, { metal: 0.1, rough: 0.8, flat: true, double: true, emissive: E.acc, ei: E.light ? 0.15 : 0.4 }));
    // Hoisted at the top of the staff and extending to one side, so the plane's
    // own centre sits half a width out from the pole.
    flag.position.set(FLAG_W / 2, 2.83, -1.0); g.add(flag);
    var flagBase = Float32Array.from(flagGeo.attributes.position.array);
    var climber = points(E, 50, 0.05, E.acc, 0.95); g.add(climber);
    var dot = sprite(E, 0xffffff, 0.5, E.light ? 0.0 : 0.95); g.add(dot);
    var mist = [];
    for (var i = 0; i < 7; i++) { var m = sprite(E, E.light ? 0xffffff : 0x8a9ac0, 5 + i % 3, E.light ? 0.35 : 0.14); m.position.set(0, -0.3 + i * 0.1, -3 - i * 0.6); g.add(m); mist.push(m); }
    var stars = points(E, 160, 0.05, 0xffffff, E.light ? 0.0 : 0.8), rnd = mulberry(17), sp = stars.geometry.attributes.position;
    for (i = 0; i < 160; i++) sp.setXYZ(i, rnd() * 18 - 9, rnd() * 5 + 1.2, -rnd() * 9 - 2);
    sp.needsUpdate = true; g.add(stars);
    function trailAt(u) { var x = Math.sin(u * 5) * 0.8 * (1 - u), z = lerp(3.5, -1.0, u), y = lerp(-1.1, 2.3, Math.pow(u, 1.15)); return [x, y, z]; }
    return {
      group: g,
      update: function (t, p) {
        var u = ease(clamp(p * 1.05, 0, 1)), q = trailAt(u);
        dot.position.set(q[0], q[1] + 0.12, q[2]);
        var cp = climber.geometry.attributes.position;
        for (var k = 0; k < 50; k++) { var w = trailAt(Math.max(0, u - k * 0.012)); cp.setXYZ(k, w[0], w[1] + 0.1, w[2]); }
        cp.needsUpdate = true;
        beacon.material.opacity = (E.light ? 0.45 : 0.95) * (0.82 + 0.18 * Math.sin(t * 2.4));
        // The cloth. u runs 0 at the hoist (pinned to the staff) to 1 at the fly
        // (free), and every displacement is scaled by u^1.6 — so the pinned edge
        // is exactly still, the middle ripples, and the free corner throws hardest.
        var fp = flagGeo.attributes.position;
        for (var f = 0; f < fp.count; f++) {
          var bx = flagBase[f * 3], by = flagBase[f * 3 + 1];
          // clamp is load-bearing: the hoist column's bx is -FLAG_W/2, but it was
          // stored through a Float32Array, so it comes back a hair LARGER in
          // magnitude and (bx + FLAG_W/2) lands at about -1e-8 instead of 0.
          // Math.pow of a negative base with a fractional exponent is NaN, which
          // would hand WebGL a whole column of NaN vertices along the edge that
          // is supposed to be pinned to the staff — the one part of the flag that
          // must be exact. Caught by reading the vertex buffer back, not by
          // looking at it: the frame still appeared to render.
          var fu = clamp((bx + FLAG_W / 2) / FLAG_W, 0, 1);
          var amp = Math.pow(fu, 1.6);
          var ph = fu * 7.4 - t * 4.2;
          fp.setXYZ(
            f,
            // Drawn in slightly as the wave deepens: cloth gathers, it does not stretch.
            bx - (1 - Math.cos(ph)) * 0.022 * amp,
            // A vertical ripple plus a little gravity droop toward the free edge.
            by + Math.sin(ph + 0.9) * 0.055 * amp - 0.035 * amp,
            Math.sin(ph) * 0.17 * amp,
          );
        }
        fp.needsUpdate = true;
        flagGeo.computeVertexNormals();
        mist.forEach(function (m2, j) { m2.position.x = Math.sin(t * 0.12 + j) * 2.4; });
      },
      cam: function (t, p, cam) { var e = ease(p); cam.position.set(Math.sin(p * 0.9 - 0.4) * 2.4, lerp(-0.2, 1.8, e), lerp(12.0, 8.4, e)); cam.lookAt(0, lerp(0.4, 1.5, e), -1); },
    };
  };

  /* -- spark: an idea, an insight, a solution, the moment it clicks -- */
  HEROES.spark = function (E) {
    var T = E.T, g = new T.Group();
    var bp = new T.SplineCurve([
      new T.Vector2(0.2, -1.0), new T.Vector2(0.22, -0.7), new T.Vector2(0.3, -0.42), new T.Vector2(0.58, -0.05),
      new T.Vector2(0.72, 0.4), new T.Vector2(0.56, 0.95), new T.Vector2(0.0, 1.18),
    ]).getPoints(30).map(function (v) { return [v.x, v.y]; });
    var glass = new T.Mesh(lathe(T, bp, 48), std(E, E.light ? 0xcfd8e0 : 0xbfe0f0, { metal: 0.05, rough: 0.05, opacity: E.light ? 0.3 : 0.2, double: true, depthWrite: false }));
    g.add(glass);
    var strip = new T.Mesh(lathe(T, bp.map(function (v) { return [v[0] * 1.012, v[1]]; }), 4, -0.9, 0.16), new T.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.55, depthWrite: false, side: T.DoubleSide, blending: E.light ? T.NormalBlending : T.AdditiveBlending }));
    g.add(strip);
    var base = new T.Mesh(lathe(T, [[0.2, 0], [0.24, 0], [0.24, -0.1], [0.2, -0.1], [0.24, -0.2], [0.2, -0.2], [0.24, -0.3], [0.2, -0.3], [0.12, -0.36]], 24), std(E, E.light ? 0x2a2622 : 0x8c93a4, { metal: 0.9, rough: 0.3 }));
    base.position.y = -1.0; g.add(base);
    var core = new T.Mesh(new T.SphereGeometry(0.3, 28, 20), new T.MeshBasicMaterial({ color: E.light ? 0xffb347 : 0xfff3d0 }));
    core.position.y = 0.28; g.add(core);
    var coreHalo = sprite(E, E.acc, 3.0, E.light ? 0.4 : 0.9); coreHalo.position.y = 0.28; g.add(coreHalo);
    var rg = new T.BufferGeometry(), RN = 36, rp = new Float32Array(RN * 6);
    rg.setAttribute("position", new T.BufferAttribute(rp, 3));
    var rays = new T.LineSegments(rg, lineMat(E, E.light ? 0xb3341c : 0xffe2a0, E.light ? 0.7 : 0.8)); rays.position.y = 0.28; g.add(rays);
    var rings = [0, 1].map(function () { var r = new T.Mesh(new T.TorusGeometry(1, 0.01, 6, 80), new T.MeshBasicMaterial({ color: E.acc, transparent: true, opacity: 0.6, depthWrite: false, blending: E.light ? T.NormalBlending : T.AdditiveBlending })); r.position.y = 0.28; g.add(r); return r; });
    var burst = points(E, 260, 0.05, E.acc, E.light ? 0.8 : 1), rnd = mulberry(19), bd = [];
    for (var i = 0; i < 260; i++) bd.push([rnd() * 6.283, rnd() * 3.1416 - 1.57, 0.6 + rnd() * 2.0, rnd()]);
    g.add(burst);
    g.add(contactShadow(E, 2.4, -1.4));
    return {
      group: g,
      update: function (t, p) {
        var pulse = 0.86 + 0.14 * Math.sin(t * 5.5), on = smooth(0.0, 0.12, p);
        core.scale.setScalar(0.4 + 0.6 * on * pulse); coreHalo.scale.setScalar((1.6 + 2.2 * on) * pulse);
        var rpz = rays.geometry.attributes.position;
        for (var k = 0; k < RN; k++) {
          var a = (k / RN) * 6.283 + t * 0.15, len = (0.5 + 0.9 * (0.5 + 0.5 * Math.sin(k * 2.3 + t * 3.2))) * on;
          rpz.setXYZ(k * 2, Math.cos(a) * 0.55, Math.sin(a) * 0.55, 0); rpz.setXYZ(k * 2 + 1, Math.cos(a) * (0.55 + len), Math.sin(a) * (0.55 + len), 0);
        }
        rpz.needsUpdate = true;
        rings.forEach(function (r, j) { var f = fract(t * 0.55 + j * 0.5); r.scale.setScalar(0.7 + f * 2.8); r.material.opacity = (1 - f) * (E.light ? 0.55 : 0.7) * on; });
        var bp2 = burst.geometry.attributes.position;
        for (k = 0; k < 260; k++) {
          var d = bd[k], f2 = fract(t * 0.42 + d[3]), r2 = 0.5 + f2 * d[2];
          bp2.setXYZ(k, Math.cos(d[0]) * Math.cos(d[1]) * r2, 0.28 + Math.sin(d[1]) * r2, Math.sin(d[0]) * Math.cos(d[1]) * r2 * 0.6);
        }
        bp2.needsUpdate = true;
        g.rotation.y = Math.sin(p * 2.4) * 0.3;
      },
      cam: function (t, p, cam) { var d = lerp(13.0, 10.6, ease(p)); cam.position.set(0, 0.35, d); cam.lookAt(0, 0.1, 0); },
    };
  };

  /* -- scales: balance, a trade-off, weighing, fairness, cost against benefit -- */
  HEROES.scales = function (E) {
    var T = E.T, g = new T.Group();
    var metal = std(E, E.light ? 0x2a2622 : 0xc9a96a, { metal: 0.92, rough: 0.28 });
    var post = new T.Mesh(lathe(T, [[0.0, -1.5], [0.7, -1.5], [0.78, -1.4], [0.5, -1.3], [0.14, -1.1], [0.08, 0.6], [0.16, 0.7], [0.0, 0.76]], 32), metal); g.add(post);
    var pivot = new T.Group(); pivot.position.y = 0.72; g.add(pivot);
    var beam = new T.Mesh(box(T, 3.1, 0.09, 0.13), metal); pivot.add(beam);
    var cap = new T.Mesh(new T.SphereGeometry(0.1, 16, 12), std(E, E.acc, { emissive: E.acc, ei: 0.4 })); pivot.add(cap);
    function pan(side) {
      var anchor = new T.Group(); anchor.position.set(side * 1.5, 0, 0);
      var grp = new T.Group(); grp.position.y = -1.15; anchor.add(grp);
      grp.add(new T.Mesh(lathe(T, [[0, -0.05], [0.3, -0.04], [0.62, 0.0], [0.64, 0.04], [0.3, 0.0], [0, 0.0]], 28), metal));
      var cg = new T.BufferGeometry();
      cg.setAttribute("position", new T.BufferAttribute(new Float32Array([0, 1.15, 0, -0.58, 0, 0, 0, 1.15, 0, 0.58, 0, 0, 0, 1.15, 0, 0, 0, 0.58]), 3));
      grp.add(new T.LineSegments(cg, lineMat(E, E.light ? 0x2a2622 : 0xe8d5a0, 0.85)));
      pivot.add(anchor);
      return { anchor: anchor, pan: grp };
    }
    var pl = pan(-1), pr = pan(1);
    for (var i = 0; i < 4; i++) { var b = new T.Mesh(new T.SphereGeometry(0.19, 20, 14), std(E, E.acc, { metal: 0.3, rough: 0.4, emissive: E.acc, ei: E.light ? 0 : 0.35 })); b.position.set(((i % 2) - 0.5) * 0.34, 0.2 + Math.floor(i / 2) * 0.32, (Math.floor(i / 2) - 0.5) * 0.1); pr.pan.add(b); }
    var light = new T.Mesh(new T.SphereGeometry(0.2, 20, 14), std(E, E.light ? 0x6b7f94 : 0xdfe8f5, { metal: 0.3, rough: 0.4 })); light.position.y = 0.2; pl.pan.add(light);
    var halo = sprite(E, E.acc, 3.6, E.light ? 0 : 0.25); halo.position.z = -0.5; g.add(halo);
    g.add(contactShadow(E, 3.6, -1.52));
    return {
      group: g,
      update: function (t, p) {
        var settle = smooth(0.15, 0.85, p);
        var th = 0.34 * Math.exp(-1.5 * t) * Math.cos(5.2 * t) + 0.2 * settle;
        pivot.rotation.z = -th;
        pl.anchor.rotation.z = th; pr.anchor.rotation.z = th;
        g.rotation.y = Math.sin(p * 2.0) * 0.28;
      },
      cam: function (t, p, cam) { var d = lerp(15, 12.4, ease(p)); cam.position.set(Math.sin(p * 0.7) * 1.8, 0.9, d); cam.lookAt(0, -0.2, 0); },
    };
  };

  /* -- network: connection, relationships, community, a system of parts -- */
  HEROES.network = function (E) {
    var T = E.T, g = new T.Group(), N = 24, nodes = [], rnd = mulberry(29);
    for (var i = 0; i < N; i++) {
      var u = rnd() * 2 - 1, a = rnd() * 6.283, r = Math.sqrt(1 - u * u), R = i === 0 ? 0 : 1.2 + rnd() * 0.9;
      nodes.push({ b: [r * Math.cos(a) * R, u * R, r * Math.sin(a) * R], ph: rnd() * 6.28, s: i === 0 ? 0.26 : 0.07 + rnd() * 0.09 });
    }
    var edges = [];
    for (i = 0; i < N; i++) {
      var ds = [];
      for (var j = 0; j < N; j++) if (j !== i) {
        var dx = nodes[i].b[0] - nodes[j].b[0], dy = nodes[i].b[1] - nodes[j].b[1], dz = nodes[i].b[2] - nodes[j].b[2];
        ds.push([dx * dx + dy * dy + dz * dz, j]);
      }
      ds.sort(function (x, y) { return x[0] - y[0]; });
      for (var k = 0; k < (i === 0 ? 6 : 2); k++) edges.push([i, ds[k][1]]);
    }
    var eg = new T.BufferGeometry(); eg.setAttribute("position", new T.BufferAttribute(new Float32Array(edges.length * 6), 3));
    g.add(new T.LineSegments(eg, lineMat(E, E.light ? 0x2a2622 : 0xcfe0ff, E.light ? 0.35 : 0.45)));
    var meshes = nodes.map(function (n, idx) {
      var m = new T.Mesh(new T.SphereGeometry(n.s, 18, 14), idx === 0 ? new T.MeshBasicMaterial({ color: E.light ? E.acc : 0xffffff }) : std(E, idx % 4 === 0 ? E.acc : (E.light ? 0x2a2622 : 0xdfe8f5), { metal: 0.3, rough: 0.4, emissive: idx % 4 === 0 ? E.acc : 0x000000, ei: 0.5 }));
      g.add(m); return m;
    });
    var core = sprite(E, E.acc, 2.8, E.light ? 0.3 : 0.7); g.add(core);
    var pulses = points(E, 40, 0.06, E.acc, 1); g.add(pulses);
    var dust = points(E, 90, 0.035, E.light ? 0x8a7a68 : E.acc2, E.light ? 0.4 : 0.5), dp = [];
    for (i = 0; i < 90; i++) dp.push([rnd() * 6 - 3, rnd() * 5 - 2.5, rnd() * 3 - 2]);
    var dpp = dust.geometry.attributes.position; for (i = 0; i < 90; i++) dpp.setXYZ(i, dp[i][0], dp[i][1], dp[i][2]); dpp.needsUpdate = true; g.add(dust);
    g.add(contactShadow(E, 3.4, -2.1));
    var pos = nodes.map(function () { return [0, 0, 0]; });
    return {
      group: g,
      update: function (t, p) {
        nodes.forEach(function (n, k) {
          var m = n.b, w = k === 0 ? 0 : 0.14;
          pos[k] = [m[0] + Math.sin(t * 0.6 + n.ph) * w, m[1] + Math.cos(t * 0.5 + n.ph) * w, m[2] + Math.sin(t * 0.4 + n.ph * 2) * w];
          meshes[k].position.set(pos[k][0], pos[k][1], pos[k][2]);
        });
        var ep = eg.attributes.position;
        edges.forEach(function (e, k) { ep.setXYZ(k * 2, pos[e[0]][0], pos[e[0]][1], pos[e[0]][2]); ep.setXYZ(k * 2 + 1, pos[e[1]][0], pos[e[1]][1], pos[e[1]][2]); });
        ep.needsUpdate = true;
        var pp = pulses.geometry.attributes.position;
        for (var q = 0; q < 40; q++) {
          var e = edges[(q * 7) % edges.length], f = fract(t * 0.55 + q * 0.37), a = pos[e[0]], b = pos[e[1]];
          pp.setXYZ(q, lerp(a[0], b[0], f), lerp(a[1], b[1], f), lerp(a[2], b[2], f));
        }
        pp.needsUpdate = true;
        core.scale.setScalar(2.4 + 0.5 * Math.sin(t * 2.2));
        g.rotation.y = t * 0.18; g.rotation.x = Math.sin(t * 0.2) * 0.12;
      },
      cam: function (t, p, cam) { var d = lerp(13.2, 10.8, ease(p)); cam.position.set(0, 0.5, d); cam.lookAt(0, 0, 0); },
    };
  };

  /* -- pulse: emotion, energy, rhythm, noise, a feeling spreading outward -- */
  HEROES.pulse = function (E) {
    var T = E.T, g = new T.Group();
    var core = new T.Mesh(new T.SphereGeometry(0.24, 32, 24), new T.MeshBasicMaterial({ color: E.light ? E.acc : 0xfff0d8 })); g.add(core);
    var halo = sprite(E, E.acc, 3.4, E.light ? 0.35 : 0.8); g.add(halo);
    var rings = [];
    for (var i = 0; i < 6; i++) {
      var r = new T.Mesh(new T.TorusGeometry(1, 0.012, 6, 100), new T.MeshBasicMaterial({ color: i % 2 ? (E.light ? 0x2a2622 : E.acc2) : E.acc, transparent: true, opacity: 0.8, depthWrite: false, blending: E.light ? T.NormalBlending : T.AdditiveBlending }));
      r.rotation.x = Math.PI / 2; r.position.y = -0.55; g.add(r); rings.push(r);
    }
    function ribbon(col, op) {
      var gg = new T.BufferGeometry(); gg.setAttribute("position", new T.BufferAttribute(new Float32Array(160 * 3), 3));
      var l = new T.Line(gg, new T.LineBasicMaterial({ color: col, transparent: true, opacity: op, depthWrite: false, blending: E.light ? T.NormalBlending : T.AdditiveBlending }));
      l.frustumCulled = false; g.add(l); return l;
    }
    var w1 = ribbon(E.acc, 0.95), w2 = ribbon(E.light ? 0x2a2622 : E.acc2, 0.8), w3 = ribbon(E.acc, 0.35);
    var dust = points(E, 100, 0.04, E.light ? 0x8a7a68 : E.acc, E.light ? 0.4 : 0.6), rnd = mulberry(61), dp = [];
    for (i = 0; i < 100; i++) dp.push([rnd() * 6.28, rnd(), rnd()]);
    g.add(dust);
    g.add(contactShadow(E, 3.2, -1.0));
    function wave(line, amp, ph, k, y0, t) {
      var p = line.geometry.attributes.position;
      for (var j = 0; j < 160; j++) {
        var x = (j / 159 - 0.5) * 5.2, env = Math.exp(-x * x * 0.22);
        p.setXYZ(j, x, y0 + Math.sin(x * k + t * 3.2 + ph) * amp * env + Math.sin(x * k * 2.3 - t * 2 + ph) * amp * 0.3 * env, 0);
      }
      p.needsUpdate = true;
    }
    return {
      group: g,
      update: function (t, p) {
        var beat = 0.5 + 0.5 * Math.pow(Math.sin(t * 4.2), 2);
        core.scale.setScalar(0.85 + 0.35 * beat); halo.scale.setScalar(2.6 + 1.4 * beat);
        rings.forEach(function (r, i) { var f = fract(t * 0.3 + i / 6); r.scale.setScalar(0.5 + f * 4.4); r.material.opacity = (1 - f) * (E.light ? 0.6 : 0.8); });
        wave(w1, 0.55 + 0.25 * beat, 0, 2.6, 0.6, t); wave(w2, 0.4, 1.7, 3.4, 0.6, t); wave(w3, 0.7, 3.4, 1.9, 0.6, t);
        var dpp = dust.geometry.attributes.position;
        for (var k = 0; k < 100; k++) { var d = dp[k], f = fract(d[1] + t * 0.12); dpp.setXYZ(k, Math.cos(d[0]) * (0.5 + f * 3.2), -0.5 + d[2] * 2.2, Math.sin(d[0]) * (0.5 + f * 3.2) * 0.6); }
        dpp.needsUpdate = true;
        g.rotation.y = Math.sin(p * 2.0) * 0.2;
      },
      cam: function (t, p, cam) { var d = lerp(9.0, 7.0, ease(p)); cam.position.set(0, 1.9, d); cam.lookAt(0, 0.1, 0); },
    };
  };

  /* -- focus: attention, clarity, distraction, filtering what matters -- */
  HEROES.focus = function (E) {
    var T = E.T, g = new T.Group(), rings = [], N = 9;
    for (var i = 0; i < N; i++) {
      var r = new T.Mesh(new T.TorusGeometry(1, 0.014 + (i % 3 === 0 ? 0.012 : 0), 6, 110), new T.MeshBasicMaterial({ color: i % 3 === 0 ? E.acc : (E.light ? 0x2a2622 : 0xdfe8ff), transparent: true, opacity: 0.8, depthWrite: false, blending: E.light ? T.NormalBlending : T.AdditiveBlending }));
      g.add(r); rings.push(r);
    }
    var core = new T.Mesh(new T.SphereGeometry(0.13, 20, 14), new T.MeshBasicMaterial({ color: E.light ? E.acc : 0xffffff })); g.add(core);
    var coreHalo = sprite(E, E.acc, 2.4, E.light ? 0.5 : 0.9); g.add(coreHalo);
    var beamTex = sprite(E, E.acc, 8, E.light ? 0.0 : 0.16); beamTex.position.z = -1; g.add(beamTex);
    var noise = points(E, 220, 0.05, E.light ? 0x5a5048 : 0xbfd0ff, E.light ? 0.6 : 0.75), rnd = mulberry(51), nd = [];
    for (i = 0; i < 220; i++) nd.push([rnd() * 6.283, 0.5 + rnd() * 3.0, rnd(), (rnd() - 0.5) * 2.4]);
    g.add(noise);
    g.add(contactShadow(E, 3.0, -2.0));
    return {
      group: g,
      update: function (t, p) {
        var f = smooth(0.05, 0.9, p);
        rings.forEach(function (r, i) {
          var z = -i * 0.55 + (t * 0.5 % 0.55) * 0, s = lerp(2.2 - i * 0.12, 0.45 + i * 0.09, f);
          r.position.z = z; r.scale.setScalar(Math.max(0.1, s)); r.rotation.z = i * 0.4 + t * (i % 2 ? 0.2 : -0.2);
          r.material.opacity = (E.light ? 0.5 : 0.75) * (1 - i / (N + 2));
        });
        core.scale.setScalar(0.6 + 1.1 * f); coreHalo.scale.setScalar(1.8 + 2.6 * f);
        var np = noise.geometry.attributes.position;
        for (var k = 0; k < 220; k++) {
          var d = nd[k], out = lerp(d[1], d[1] + 2.4 + d[2] * 2.4, f);
          np.setXYZ(k, Math.cos(d[0] + t * 0.3) * out, Math.sin(d[0] + t * 0.3) * out * 0.9, d[3]);
        }
        np.needsUpdate = true;
        noise.material.opacity = (E.light ? 0.6 : 0.75) * (1 - f * 0.85);
      },
      cam: function (t, p, cam) { cam.position.set(0, 0, lerp(9.4, 6.0, ease(p))); cam.lookAt(0, 0, -2.2); },
    };
  };

  /* -- growth: compounding, small gains piling up, a snowball of progress -- */
  HEROES.growth = function (E) {
    var T = E.T, g = new T.Group(), N = 28, orbs = [];
    var lg = new T.BufferGeometry(); lg.setAttribute("position", new T.BufferAttribute(new Float32Array(N * 3), 3));
    var line = new T.Line(lg, new T.LineBasicMaterial({ color: E.light ? 0x2a2622 : 0xffe2b0, transparent: true, opacity: 0.6, depthWrite: false })); line.frustumCulled = false; g.add(line);
    var P = [];
    for (var i = 0; i < N; i++) {
      var f = i / (N - 1), ang = i * 0.62, rad = 0.35 + f * 1.25, y = -1.5 + Math.pow(f, 1.25) * 3.2;
      P.push([Math.cos(ang) * rad, y, Math.sin(ang) * rad]);
      var s = 0.05 * Math.pow(1.082, i);
      var m = new T.Mesh(new T.SphereGeometry(s, 20, 14), std(E, i === N - 1 ? E.acc : (E.light ? (i % 3 ? 0xe6dac2 : 0x2a2622) : (i % 3 ? 0xdfe8f5 : 0x3d4668)), { metal: 0.35, rough: 0.4, emissive: E.acc, ei: 0 }));
      g.add(m); orbs.push(m);
    }
    var head = sprite(E, E.acc, 1.6, E.light ? 0.4 : 0.9); g.add(head);
    var disk = new T.Mesh(new T.TorusGeometry(1.5, 0.01, 6, 90), new T.MeshBasicMaterial({ color: E.acc, transparent: true, opacity: 0.55, depthWrite: false })); disk.rotation.x = Math.PI / 2; disk.position.y = -1.55; g.add(disk);
    var dust = points(E, 90, 0.04, E.light ? 0x8a7a68 : E.acc2, E.light ? 0.4 : 0.55), rnd = mulberry(71), dp = [];
    for (i = 0; i < 90; i++) dp.push([rnd() * 6 - 3, rnd() * 4.5 - 1.8, rnd() * 3 - 1.5, rnd()]);
    g.add(dust);
    g.add(contactShadow(E, 3.6, -1.6));
    return {
      group: g,
      update: function (t, p) {
        var upto = p * 1.15 * (N - 1), lp = line.geometry.attributes.position;
        for (var k = 0; k < N; k++) {
          var on = smooth(k - 1.0, k + 0.4, upto);
          orbs[k].position.set(P[k][0], P[k][1], P[k][2]); orbs[k].scale.setScalar(Math.max(0.001, on));
          orbs[k].material.emissiveIntensity = (E.light ? 0 : 0.5) * on * (k === Math.floor(Math.min(N - 1, upto)) ? 1 : 0.3);
          lp.setXYZ(k, P[Math.min(N - 1, Math.min(k, Math.floor(upto + 1)))][0], P[Math.min(N - 1, Math.min(k, Math.floor(upto + 1)))][1], P[Math.min(N - 1, Math.min(k, Math.floor(upto + 1)))][2]);
        }
        lp.needsUpdate = true;
        var hi = Math.min(N - 1, Math.floor(upto));
        head.position.set(P[hi][0], P[hi][1], P[hi][2]); head.scale.setScalar(1.2 + 0.8 * Math.sin(t * 4));
        var dpp = dust.geometry.attributes.position;
        for (k = 0; k < 90; k++) { var d = dp[k]; dpp.setXYZ(k, d[0] + Math.sin(t * 0.4 + d[3] * 6) * 0.2, d[1] + ((t * 0.1 * (0.4 + d[3]) + d[3] * 4) % 4.5), d[2]); }
        dpp.needsUpdate = true;
        g.rotation.y = t * 0.25;
      },
      cam: function (t, p, cam) { cam.position.set(0, lerp(-0.2, 1.2, p), lerp(11.5, 12.8, ease(p))); cam.lookAt(0, lerp(0.0, 0.5, p), 0); },
    };
  };

  /* -- loop: habit, routine, repetition, the cycle you repeat without noticing (runners lapping one ring) -- */
  HEROES.loop = function (E) {
    var T = E.T, g = new T.Group(), R = 1.6, N = 40, TAU = Math.PI * 2;
    var ink = E.light ? 0x2a2622 : 0xdfe8f5, add = E.light ? T.NormalBlending : T.AdditiveBlending;
    // The circuit is laid down flat, so it reads as a track the eye can follow round and round.
    var ring = new T.Group(); ring.rotation.x = 0.9; g.add(ring);
    var road = new T.Mesh(new T.RingGeometry(R * 0.9, R * 1.1, 120), new T.MeshBasicMaterial({ color: E.acc, transparent: true, opacity: E.light ? 0.1 : 0.09, depthWrite: false, side: T.DoubleSide, blending: add }));
    road.geometry.clearGroups(); ring.add(road);
    ring.add(new T.Mesh(new T.TorusGeometry(R, 0.016, 8, 180), new T.MeshBasicMaterial({ color: ink, transparent: true, opacity: E.light ? 0.5 : 0.42, depthWrite: false })));
    ring.add(new T.Mesh(new T.TorusGeometry(R * 1.22, 0.008, 6, 180), new T.MeshBasicMaterial({ color: E.light ? 0x2a2622 : E.acc2, transparent: true, opacity: E.light ? 0.28 : 0.34, depthWrite: false })));
    ring.add(new T.Mesh(new T.TorusGeometry(R * 0.7, 0.006, 6, 140), new T.MeshBasicMaterial({ color: E.light ? 0x2a2622 : E.acc2, transparent: true, opacity: E.light ? 0.22 : 0.28, depthWrite: false })));
    // The beads of the circuit swell as a runner passes them and shrink again behind it.
    var bg = new T.SphereGeometry(1, 16, 12), beads = [];
    for (var i = 0; i < N; i++) {
      var b = new T.Mesh(bg, std(E, E.light ? 0x3a3631 : 0xdfe8f5, { metal: 0.3, rough: 0.4, emissive: E.acc, ei: 0 }));
      ring.add(b); beads.push(b);
    }
    // Three runners lap the same ring: the same start, the same finish, forever.
    var RUN = 3, runners = [];
    for (i = 0; i < RUN; i++) {
      var r = new T.Group();
      r.add(new T.Mesh(new T.SphereGeometry(0.26, 24, 18), new T.MeshBasicMaterial({ color: E.light ? E.acc : 0xffffff })));
      r.add(sprite(E, E.acc, E.light ? 1.4 : 2.4, E.light ? 0.4 : 0.9));
      ring.add(r); runners.push(r);
    }
    // Cue, routine, reward: three stations that flash as a runner goes through them.
    var stations = [0, 1, 2].map(function (k) {
      var s = new T.Group(), a = k * TAU / 3 + 0.5;
      var m = new T.Mesh(new T.TorusGeometry(0.3, 0.02, 8, 48), new T.MeshBasicMaterial({ color: k === 1 ? (E.light ? 0x2a2622 : E.acc2) : E.acc, transparent: true, opacity: 0.9, depthWrite: false, blending: add }));
      s.add(m);
      var halo = sprite(E, k === 1 ? (E.light ? 0x2a2622 : E.acc2) : E.acc, 1.4, 0); s.add(halo);
      s.position.set(Math.cos(a) * R, Math.sin(a) * R, 0); ring.add(s);
      return { g: s, m: m, halo: halo, a: a };
    });
    var dust = points(E, 70, 0.04, E.light ? 0x8a7a68 : E.acc2, E.light ? 0.4 : 0.5), rnd = mulberry(83), dp = [];
    for (i = 0; i < 70; i++) dp.push([rnd() * 6 - 3, rnd() * 4 - 2, rnd() * 3 - 2, rnd()]);
    g.add(dust);
    var core = sprite(E, E.acc, 3.2, E.light ? 0.0 : 0.22); core.position.z = -0.4; g.add(core);
    g.add(contactShadow(E, 4.4, -1.35));
    function behind(a, head) { return fract((head - a) / TAU); } // 0 at the runner, rising to 1 a full lap behind it
    return {
      group: g,
      update: function (t, p) {
        var w = 0.62, heads = [];
        for (var k = 0; k < RUN; k++) heads.push(t * w + k * TAU / RUN);
        for (k = 0; k < RUN; k++) runners[k].position.set(Math.cos(heads[k]) * R, Math.sin(heads[k]) * R, 0.0);
        for (var j = 0; j < N; j++) {
          var a = (j / N) * TAU, env = 0;
          for (k = 0; k < RUN; k++) env = Math.max(env, Math.exp(-behind(a, heads[k]) * 9));
          beads[j].position.set(Math.cos(a) * R, Math.sin(a) * R, 0);
          beads[j].scale.setScalar(0.05 + 0.12 * env);
          beads[j].material.emissiveIntensity = (E.light ? 0 : 1.2) * env;
        }
        stations.forEach(function (s) {
          var hit = 0;
          for (var q = 0; q < RUN; q++) { var d = wrap1((heads[q] - s.a) / TAU); hit = Math.max(hit, Math.exp(-d * d * 1400)); }
          s.g.scale.setScalar(0.85 + 0.55 * hit); s.m.material.opacity = 0.45 + 0.55 * hit; s.halo.material.opacity = (E.light ? 0.5 : 0.9) * hit;
        });
        var dpp = dust.geometry.attributes.position;
        for (j = 0; j < 70; j++) { var d2 = dp[j]; dpp.setXYZ(j, d2[0] + Math.sin(t * 0.3 + d2[3] * 6) * 0.2, d2[1] + Math.cos(t * 0.25 + d2[3] * 5) * 0.15, d2[2]); }
        dpp.needsUpdate = true;
        ring.rotation.x = 0.9 + Math.sin(t * 0.35) * 0.05;
        ring.rotation.z = Math.sin(p * 2.2) * 0.12;
        g.rotation.y = Math.sin(p * 2.6) * 0.18;
      },
      cam: function (t, p, cam) { var d = lerp(11.2, 9.6, ease(p)); cam.position.set(Math.sin(p * 0.7 - 0.2) * 1.4, 2.2, d); cam.lookAt(0, -0.1, 0); },
    };
  };

  /* -- heart: health, the body, vitality, a heartbeat (a beating heart with a monitor trace through it) -- */
  HEROES.heart = function (E) {
    var T = E.T, g = new T.Group(), N = 96, K = 22, D = 0.9, S = 0.1, ol = [], cy, i;
    for (i = 0; i < N; i++) {
      var a = (i / N) * Math.PI * 2, sn = Math.sin(a);
      var y = (13 * Math.cos(a) - 5 * Math.cos(2 * a) - 2 * Math.cos(3 * a) - Math.cos(4 * a)) * S;
      ol.push([16 * sn * sn * sn * S, y]);
    }
    // Three passes of a [1 2 1] blur round the tip and the cleft, which would otherwise loft into hard creases.
    for (var pass = 0; pass < 3; pass++) ol = ol.map(function (q, j) {
      var a0 = ol[(j + N - 1) % N], a1 = ol[(j + 1) % N];
      return [(a0[0] + 2 * q[0] + a1[0]) / 4, (a0[1] + 2 * q[1] + a1[1]) / 4];
    });
    // The classic outline, lofted into a plump solid.
    var hl = loft(T, ol, K, D, 2.4), hg = hl.geo;
    cy = hl.cy;
    var body = new T.Color(E.light ? 0xa8170f : 0xc2281f).lerp(E.acc, E.light ? 0.15 : 0.3);
    var hm = std(E, body, { metal: 0.12, rough: 0.3, double: true, emissive: E.acc, ei: 0 });
    var heart = new T.Mesh(hg, hm); g.add(heart);
    var glow = sprite(E, E.acc, 5.0, E.light ? 0.0 : 0.4); glow.position.z = -0.6; g.add(glow);
    var rings = [0, 1].map(function () {
      var r = new T.Mesh(new T.TorusGeometry(1, 0.012, 6, 120), new T.MeshBasicMaterial({ color: E.acc, transparent: true, opacity: 0, depthWrite: false, blending: E.light ? T.NormalBlending : T.AdditiveBlending }));
      r.position.z = -0.3; g.add(r); return r;
    });
    // The monitor trace: a ribbon that scrolls, its tall spike landing on the heart as the heart beats.
    var TN = 120, trace = strip(T, TN), glowTrace = strip(T, TN), tp = [], gp = [];
    for (i = 0; i < TN; i++) { tp.push([0, 0, 0]); gp.push([0, 0, 0]); }
    var tm = new T.Mesh(trace.geo, new T.MeshBasicMaterial({ color: E.light ? 0x2a2622 : 0xffffff, side: T.DoubleSide, transparent: true, opacity: 0.95, depthWrite: false })); tm.frustumCulled = false; g.add(tm);
    var gm = new T.Mesh(glowTrace.geo, new T.MeshBasicMaterial({ color: E.acc, side: T.DoubleSide, transparent: true, opacity: E.light ? 0.0 : 0.3, depthWrite: false, blending: T.AdditiveBlending })); gm.frustumCulled = false; g.add(gm);
    // Circulation: cells flowing round a loop that follows the heart's own outline.
    var cells = points(E, 80, 0.05, E.acc, E.light ? 0.8 : 0.95), rnd = mulberry(91), cd = [];
    for (i = 0; i < 80; i++) cd.push([rnd(), (rnd() - 0.5) * 0.5, rnd()]);
    g.add(cells);
    var dust = points(E, 60, 0.04, E.light ? 0x8a7a68 : E.acc2, E.light ? 0.4 : 0.5), dd = [];
    for (i = 0; i < 60; i++) dd.push([rnd() * 6 - 3, rnd() * 4.4 - 2.2, rnd() * 3 - 2, rnd()]);
    g.add(dust);
    g.add(contactShadow(E, 3.4, -1.95));
    var PERIOD = 0.9, V = 2.7;
    function gauss(d, s) { return Math.exp(-(d * d) / (s * s)); }
    /** One heartbeat's trace, by phase 0..1: small P, then Q, R, S in a spike, then a broad T. */
    function ecg(ph) {
      return 0.1 * gauss(wrap1(ph - 0.955), 0.025) - 0.12 * gauss(wrap1(ph - 0.035), 0.009) + 1.0 * gauss(wrap1(ph - 0.057), 0.0075) - 0.3 * gauss(wrap1(ph - 0.082), 0.01) + 0.24 * gauss(wrap1(ph - 0.27), 0.04);
    }
    return {
      group: g,
      update: function (t, p) {
        var ph = fract(t / PERIOD), lub = gauss(wrap1(ph - 0.075), 0.05), dub = 0.55 * gauss(wrap1(ph - 0.3), 0.05), beat = Math.min(1, lub + dub);
        heart.scale.setScalar(1 + 0.15 * beat);
        hm.emissiveIntensity = (E.light ? 0.06 : 0.3) + (E.light ? 0.15 : 0.7) * beat;
        glow.material.opacity = (E.light ? 0 : 0.28) + (E.light ? 0 : 0.22) * beat;
        rings.forEach(function (r, j) {
          var f = fract(ph * 1 + j * 0.5 - 0.05);
          r.scale.setScalar(1.25 + f * 1.05); r.material.opacity = (1 - f) * (1 - f) * (E.light ? 0.45 : 0.55) * (j ? 0.6 : 1);
        });
        for (var q = 0; q < TN; q++) {
          var u = q / (TN - 1), x = (u - 0.5) * 6.4, edge = smooth(0, 0.1, u) * smooth(1, 0.9, u);
          tp[q][0] = x; tp[q][1] = -0.05 + 0.95 * ecg(fract((t - x / V) / PERIOD)) * edge; tp[q][2] = D + 0.6;
          gp[q][0] = x; gp[q][1] = tp[q][1]; gp[q][2] = D + 0.55;
        }
        trace.set(tp, function (j, n) { return 0.032 * (0.35 + 0.65 * Math.sin(Math.PI * j / (n - 1))); });
        glowTrace.set(gp, function (j, n) { return 0.12 * Math.sin(Math.PI * j / (n - 1)); });
        var cp = cells.geometry.attributes.position;
        for (q = 0; q < 80; q++) {
          var c = cd[q], a2 = (fract(c[0] + t * (0.07 + c[2] * 0.04))) * Math.PI * 2, s2 = Math.sin(a2);
          var oy = (13 * Math.cos(a2) - 5 * Math.cos(2 * a2) - 2 * Math.cos(3 * a2) - Math.cos(4 * a2)) * S;
          var gro = 1.32 + c[1] * 0.5 + 0.05 * beat;
          cp.setXYZ(q, 16 * s2 * s2 * s2 * S * gro, cy + (oy - cy) * gro, (c[2] - 0.5) * 0.9);
        }
        cp.needsUpdate = true;
        var dpp = dust.geometry.attributes.position;
        for (q = 0; q < 60; q++) { var d = dd[q]; dpp.setXYZ(q, d[0] + Math.sin(t * 0.3 + d[3] * 6) * 0.2, d[1] + ((t * 0.1 * (0.4 + d[3]) + d[3] * 4.4) % 4.4) - 2.2, d[2]); }
        dpp.needsUpdate = true;
        heart.rotation.y = Math.sin(t * 0.55) * 0.2 + Math.sin(p * 2.0) * 0.06;
      },
      cam: function (t, p, cam) { var d = lerp(10.4, 8.8, ease(p)); cam.position.set(0, 0.4, d); cam.lookAt(0, -0.1, 0); },
    };
  };

  /* -- wall: an obstacle, a barrier, resistance, whatever stands in the way (a brick wall that cracks and gives) -- */
  HEROES.wall = function (E) {
    var T = E.T, g = new T.Group(), COLS = 5, ROWS = 13, BW = 0.62, BH = 0.3, BD = 0.36, W = COLS * BW, H = ROWS * BH, rnd = mulberry(47), i, k;
    // A crack that climbs the wall, off the middle, in a jagged line.
    var CN = 18, cx = [], cyy = [];
    for (i = 0; i < CN; i++) { var u = i / (CN - 1); cyy.push(-H / 2 + u * H); cx.push(0.2 + Math.sin(u * 5.4) * 0.2 + (i % 2 ? 0.07 : -0.07) * (0.4 + rnd())); }
    function crackAt(y) {
      var u = clamp((y + H / 2) / H, 0, 1) * (CN - 1), j = Math.min(CN - 2, Math.floor(u));
      return lerp(cx[j], cx[j + 1], u - j);
    }
    var bgeo = box(T, BW - 0.025, BH - 0.025, BD), bricks = [];
    function brick(x, y, w) {
      var col = new T.Color(E.light ? 0xb98462 : 0x6a4034).offsetHSL((rnd() - 0.5) * 0.03, (rnd() - 0.5) * 0.1, (rnd() - 0.5) * 0.08);
      var m = new T.Mesh(bgeo, std(E, col, { metal: 0.05, rough: 0.85, emissive: E.acc, ei: 0 }));
      m.scale.x = w / BW; g.add(m);
      var side = x >= crackAt(y) ? 1 : -1, dist = Math.abs(x - crackAt(y));
      bricks.push({ m: m, x: x, y: y, side: side, dist: dist, bt: 0.5 + dist * 0.85 + (rnd() - 0.5) * 0.05, a: rnd(), b: rnd(), c: rnd(), z: (rnd() - 0.5) * 0.03 });
    }
    for (var r = 0; r < ROWS; r++) {
      var y = -H / 2 + (r + 0.5) * BH;
      if (r % 2 === 0) for (k = 0; k < COLS; k++) brick(-W / 2 + (k + 0.5) * BW, y, BW);
      else {
        brick(-W / 2 + BW * 0.25, y, BW / 2);
        for (k = 0; k < COLS - 1; k++) brick(-W / 2 + (k + 1) * BW, y, BW);
        brick(W / 2 - BW * 0.25, y, BW / 2);
      }
    }
    var trace = strip(T, CN), tpts = [];
    for (i = 0; i < CN; i++) tpts.push([0, 0, 0]);
    var tm = new T.Mesh(trace.geo, new T.MeshBasicMaterial({ color: E.light ? E.acc : 0xfff0d8, side: T.DoubleSide, transparent: true, opacity: 0.95, depthWrite: false })); tm.frustumCulled = false; g.add(tm);
    var glowBack = sprite(E, E.acc, 3.4, 0); glowBack.position.z = -0.5; g.add(glowBack);
    var beam = new T.Mesh(new T.PlaneGeometry(0.7, 4.6), new T.MeshBasicMaterial({ map: E.soft, color: E.acc, transparent: true, opacity: 0, depthWrite: false, blending: E.light ? T.NormalBlending : T.AdditiveBlending, side: T.DoubleSide }));
    beam.geometry.clearGroups(); beam.position.z = -0.3; g.add(beam);
    // Pressure: motes streaming at the wall from the left, and stopping against it.
    var PN = 46, push = points(E, PN, 0.05, E.acc, E.light ? 0.85 : 1), pd = [];
    for (i = 0; i < PN; i++) pd.push([rnd(), (rnd() - 0.5) * H * 0.95, (rnd() - 0.5) * 0.5, 0.6 + rnd() * 0.8]);
    g.add(push);
    var dustN = 90, dust = points(E, dustN, 0.05, E.light ? 0x8a7a68 : 0xd8c9a8, E.light ? 0.55 : 0.6), dd = [];
    for (i = 0; i < dustN; i++) dd.push([rnd(), rnd(), rnd(), rnd()]);
    g.add(dust);
    g.add(contactShadow(E, 5.6, -H / 2 - 0.02));
    return {
      group: g,
      update: function (t, p) {
        var front = smooth(0.14, 0.52, p), frontY = -H / 2 + front * H, shake = 0.011 * smooth(0.0, 0.35, p) * (1 - smooth(0.5, 0.62, p));
        bricks.forEach(function (b, n) {
          var e = Math.max(0, p - b.bt), glow = (b.y - BH / 2 < frontY && b.dist < 0.9) ? Math.exp(-b.dist * 3.4) : 0;
          var fall = Math.min(e, 0.5);
          var x = b.x + Math.sin(t * 41 + n * 1.7) * shake, yy = b.y + Math.cos(t * 37 + n * 2.3) * shake * 0.6;
          if (e > 0) {
            x += b.side * (fall * 1.8 * (0.5 + b.a) + e * 0.5);
            yy = Math.max(-H / 2 + BH * 0.5 + b.c * 0.05, b.y - fall * fall * 11 * (0.6 + b.b * 0.8));
            b.m.rotation.set((b.b - 0.5) * fall * 3, 0, -b.side * fall * 3.2 * (0.4 + b.c));
            b.m.position.set(x, yy, b.z + fall * 0.9 * b.a);
          } else {
            b.m.rotation.set(0, 0, 0);
            b.m.position.set(x, yy, b.z);
          }
          b.m.material.emissiveIntensity = (E.light ? 0.5 : 1.7) * glow * (0.75 + 0.25 * Math.sin(t * 6 + n));
        });
        for (var j = 0; j < CN; j++) {
          var y2 = Math.min(cyy[j], frontY);
          tpts[j][0] = crackAt(y2) + (j > 0 ? Math.sin(j * 2.9) * 0.03 : 0); tpts[j][1] = y2; tpts[j][2] = BD / 2 + 0.03;
        }
        trace.set(tpts, 0.022 * smooth(0.12, 0.2, p) * (1 + 0.6 * smooth(0.5, 0.9, p)));
        var breach = smooth(0.46, 0.95, p);
        glowBack.position.x = 0.15; glowBack.material.opacity = (E.light ? 0.5 : 0.85) * breach; glowBack.scale.setScalar(2.6 + 2.4 * breach);
        beam.position.x = 0.15; beam.material.opacity = (E.light ? 0.3 : 0.6) * breach; beam.scale.x = 0.6 + 2.4 * breach;
        var pp = push.geometry.attributes.position;
        for (j = 0; j < PN; j++) {
          var d = pd[j], f = fract(d[0] + t * 0.38 * d[3]), x0 = -3.4 + f * (3.4 - W / 2 - 0.05);
          pp.setXYZ(j, x0 + Math.sin(t * 9 + j) * 0.01, d[1] + Math.sin(t * 2 + j) * 0.03, d[2] * 0.6);
        }
        pp.needsUpdate = true;
        var dp = dust.geometry.attributes.position, dOn = smooth(0.46, 0.62, p);
        for (j = 0; j < dustN; j++) {
          var q = dd[j], f2 = fract(q[0] + t * 0.18 * (0.5 + q[1]));
          dp.setXYZ(j, 0.15 + (q[2] - 0.5) * (0.8 + 2.4 * breach) + Math.sin(t * 0.7 + q[3] * 6) * 0.1, -H / 2 + f2 * (H * 0.9), (q[3] - 0.5) * 0.9);
        }
        dp.needsUpdate = true;
        dust.material.opacity = (E.light ? 0.55 : 0.6) * dOn;
        g.rotation.y = Math.sin(p * 2.0) * 0.12;
      },
      cam: function (t, p, cam) { var a = lerp(-0.3, 0.22, ease(p)), d = lerp(12.6, 11.2, ease(p)); cam.position.set(Math.sin(a) * d, 0.9, Math.cos(a) * d); cam.lookAt(0, -0.1, 0); },
    };
  };

  /* -- dialogue: a conversation, listening, what passes between two people (two figures trading light) -- */
  HEROES.dialogue = function (E) {
    var T = E.T, g = new T.Group(), SEP = 1.5, i;
    var add = E.light ? T.NormalBlending : T.AdditiveBlending;
    var colB = E.light ? 0x2a2622 : E.acc2;
    var body = [[0, -1.25], [0.5, -1.25], [0.68, -1.1], [0.76, -0.75], [0.7, -0.3], [0.52, 0.05], [0.3, 0.3], [0.17, 0.42], [0.15, 0.56], [0, 0.58]];
    function figure(x, dir, col) {
      var f = new T.Group(); f.position.x = x; g.add(f);
      var mat = std(E, col, { metal: 0.3, rough: 0.35, emissive: col, ei: 0 });
      var torso = new T.Mesh(lathe(T, body, 40), mat); f.add(torso);
      var head = new T.Group(); head.position.y = 0.98; f.add(head);
      var skull = new T.Mesh(new T.SphereGeometry(0.36, 32, 24), mat); skull.scale.y = 1.1; head.add(skull);
      var nose = new T.Mesh(new T.SphereGeometry(0.075, 16, 12), mat); nose.position.set(dir * 0.35, -0.04, 0); head.add(nose);
      var halo = sprite(E, col, 3.0, 0); halo.position.set(dir * 0.2, 0.98, -0.5); f.add(halo);
      var arcs = [0, 1, 2].map(function () {
        var a = new T.Mesh(new T.TorusGeometry(0.5, 0.014, 6, 40, 1.3), new T.MeshBasicMaterial({ color: col, transparent: true, opacity: 0, depthWrite: false, blending: add }));
        a.rotation.z = (dir > 0 ? 0 : Math.PI) - 0.65; a.position.set(dir * 0.38, 0.95, 0); f.add(a); return a;
      });
      var base = new T.Mesh(new T.TorusGeometry(0.95, 0.01, 6, 80), new T.MeshBasicMaterial({ color: col, transparent: true, opacity: 0, depthWrite: false, blending: add }));
      base.rotation.x = Math.PI / 2; base.position.y = -1.24; f.add(base);
      return { f: f, mat: mat, head: head, halo: halo, arcs: arcs, base: base, dir: dir };
    }
    var A = figure(-SEP, 1, E.acc), B = figure(SEP, -1, colB);
    // What passes between them: points of light riding an arch from the speaker's head to the listener's.
    var P0 = [-SEP + 0.45, 1.05], P1 = [0, 2.5], P2 = [SEP - 0.45, 1.05], FN = 34;
    function flow(col) {
      var p = points(E, FN, 0.11, col, 0), lead = sprite(E, col, 0.9, 0); g.add(p, lead);
      return { pts: p, lead: lead };
    }
    var flowA = flow(E.acc), flowB = flow(colB);
    function arch(u, out) {
      var a = (1 - u) * (1 - u), b = 2 * (1 - u) * u, c = u * u;
      out[0] = a * P0[0] + b * P1[0] + c * P2[0]; out[1] = a * P0[1] + b * P1[1] + c * P2[1];
    }
    var archLine = new T.BufferGeometry(), al = new Float32Array(48 * 3);
    for (i = 0; i < 48; i++) { var o = [0, 0]; arch(i / 47, o); al[i * 3] = o[0]; al[i * 3 + 1] = o[1]; }
    archLine.setAttribute("position", new T.BufferAttribute(al, 3));
    var archMat = new T.LineBasicMaterial({ color: E.light ? 0x2a2622 : 0xdfe8ff, transparent: true, opacity: E.light ? 0.3 : 0.25, depthWrite: false, blending: add });
    var archObj = new T.Line(archLine, archMat); archObj.frustumCulled = false; g.add(archObj);
    var dust = points(E, 80, 0.04, E.light ? 0x8a7a68 : E.acc2, E.light ? 0.4 : 0.5), rnd = mulberry(59), dp = [];
    for (i = 0; i < 80; i++) dp.push([rnd() * 6 - 3, rnd() * 4 - 1.5, rnd() * 3 - 2, rnd()]);
    g.add(dust);
    g.add(contactShadow(E, 6.4, -1.27));
    var PERIOD = 4.8, tmp = [0, 0];
    function speak(t, shift) {
      var ph = fract(t / PERIOD + 0.06 + shift);
      return smooth(0.0, 0.08, ph) * (1 - smooth(0.42, 0.5, ph));
    }
    function lay(fp, u0, speakerEnv, from) {
      var pp = fp.pts.geometry.attributes.position;
      for (var k = 0; k < FN; k++) {
        var u = fract(k / FN + u0); arch(from ? u : 1 - u, tmp);
        pp.setXYZ(k, tmp[0], tmp[1], 0.05 * Math.sin(k * 1.7));
      }
      pp.needsUpdate = true;
      fp.pts.material.opacity = speakerEnv * (E.light ? 0.85 : 1);
      arch(from ? fract(u0) : 1 - fract(u0), tmp);
      fp.lead.position.set(tmp[0], tmp[1], 0.1); fp.lead.material.opacity = speakerEnv * (E.light ? 0.6 : 0.9);
    }
    return {
      group: g,
      update: function (t, p) {
        var ea = speak(t, 0), eb = speak(t, 0.5);
        lay(flowA, t * 0.3, ea, true); lay(flowB, t * 0.3, eb, false);
        [[A, ea, eb], [B, eb, ea]].forEach(function (s) {
          var fg = s[0], me = s[1], other = s[2];
          fg.mat.emissiveIntensity = (E.light ? 0.04 : 0.1) + (E.light ? 0.2 : 0.5) * me;
          fg.halo.material.opacity = (E.light ? 0.08 : 0.14) + (E.light ? 0.4 : 0.55) * me;
          fg.f.rotation.z = -fg.dir * (0.045 * me - 0.02 * other) + Math.sin(t * 1.3 + fg.dir) * 0.006;
          fg.head.rotation.z = -fg.dir * (0.16 * other) + Math.sin(t * 3.1) * 0.012 * me;
          fg.f.scale.y = 1 + Math.sin(t * 1.9 + fg.dir) * 0.006;
          fg.arcs.forEach(function (a, k) {
            var f = fract(t * 0.9 + k / 3);
            a.scale.setScalar(0.55 + f * 1.7); a.material.opacity = (1 - f) * (1 - f) * me * (E.light ? 0.7 : 0.9);
          });
          fg.base.scale.setScalar(0.9 + 0.12 * me + 0.1 * Math.sin(t * 2.4)); fg.base.material.opacity = (E.light ? 0.25 : 0.4) * me;
        });
        var dpp = dust.geometry.attributes.position;
        for (var k = 0; k < 80; k++) { var d = dp[k]; dpp.setXYZ(k, d[0] + Math.sin(t * 0.3 + d[3] * 6) * 0.2, d[1] + ((t * 0.09 * (0.4 + d[3]) + d[3] * 4) % 4), d[2]); }
        dpp.needsUpdate = true;
        g.rotation.y = Math.sin(p * 2.2) * 0.2;
      },
      cam: function (t, p, cam) { var d = lerp(12.6, 10.8, ease(p)); cam.position.set(Math.sin(p * 0.6 - 0.2) * 1.2, 1.1, d); cam.lookAt(0, 0.2, 0); },
    };
  };

  /* -- storm: fear, anger, stress, turmoil (a dark cloud churning, lit from inside by lightning) -- */
  HEROES.storm = function (E) {
    var T = E.T, g = new T.Group(), rnd = mulberry(67), i;
    var add = E.light ? T.NormalBlending : T.AdditiveBlending;
    var under = new T.Color(E.light ? 0x38342f : 0x232b44), crown = new T.Color(E.light ? 0x857d73 : 0x66769c), glow = new T.Color(E.light ? 0xe8672e : 0xffd9a8), tmpC = new T.Color();
    // The cloud: firm puffs heaped into a thunderhead, flat and dark underneath, pale on the crown.
    var PN = 58, puffs = [];
    for (i = 0; i < PN; i++) {
      var x = (rnd() + rnd() + rnd() - 1.5) * 1.5, top = 0.4 + 1.1 * Math.exp(-(x * x) / 1.1), hgt = Math.pow(rnd(), 0.85), y = 0.3 + hgt * top, z = (rnd() - 0.5) * 1.0;
      var size = 0.7 + rnd() * 0.75;
      var base = new T.Color().copy(under).lerp(crown, clamp(hgt * 0.8 + (rnd() - 0.5) * 0.3, 0, 1));
      var pf = puff(E, base, size, E.light ? 0.82 : 0.9, true);
      pf.position.set(x, y, z); g.add(pf);
      puffs.push({ s: pf, x: x, y: y, z: z, size: size, base: base, a: rnd() * 6.28, b: rnd() * 6.28, sp: 0.6 + rnd() * 0.8 });
    }
    // Lightning: two channels strike on their own rhythms; each strike's jagged path comes from its own seed.
    var BN = 15, CHANNELS = [{ period: 2.4, off: 0.5, x: -0.5 }, { period: 3.3, off: 1.9, x: 0.9 }];
    var bolts = CHANNELS.map(function () {
      var core = strip(T, BN), halo = strip(T, BN), branch = strip(T, 8), pts = [], hp = [], bp = [];
      for (var j = 0; j < BN; j++) { pts.push([0, 0, 0.5]); hp.push([0, 0, 0.45]); }
      for (j = 0; j < 8; j++) bp.push([0, 0, 0.5]);
      var cm = new T.Mesh(core.geo, new T.MeshBasicMaterial({ color: E.light ? 0xe8672e : 0xffffff, side: T.DoubleSide, transparent: true, opacity: 0, depthWrite: false }));
      var hm = new T.Mesh(halo.geo, new T.MeshBasicMaterial({ color: E.acc, side: T.DoubleSide, transparent: true, opacity: 0, depthWrite: false, blending: add }));
      var bm = new T.Mesh(branch.geo, new T.MeshBasicMaterial({ color: E.light ? 0xe8672e : 0xffffff, side: T.DoubleSide, transparent: true, opacity: 0, depthWrite: false }));
      cm.frustumCulled = hm.frustumCulled = bm.frustumCulled = false;
      g.add(hm, cm, bm);
      return { core: core, halo: halo, branch: branch, cm: cm, hm: hm, bm: bm, pts: pts, hp: hp, bp: bp };
    });
    var flash = sprite(E, glow, 4.2, 0); flash.position.set(0, 0.9, 0.2); g.add(flash);
    // Rain: short streaks falling under the cloud.
    var RN = 90, rg = new T.BufferGeometry(); rg.setAttribute("position", new T.BufferAttribute(new Float32Array(RN * 6), 3));
    var rain = new T.LineSegments(rg, lineMat(E, E.light ? 0x3a4a66 : 0xbfd0ff, E.light ? 0.45 : 0.4)); rain.frustumCulled = false; g.add(rain);
    var rd = [];
    for (i = 0; i < RN; i++) rd.push([(rnd() - 0.5) * 5.2, rnd(), 0.8 + rnd() * 0.6, (rnd() - 0.5) * 1.2]);
    // Turmoil: grit whipped round the underside of the cloud.
    var SN = 70, grit = points(E, SN, 0.05, E.light ? 0x6b5f55 : 0xbfd0ff, E.light ? 0.6 : 0.7), gd = [];
    for (i = 0; i < SN; i++) gd.push([rnd() * 6.28, 1.0 + rnd() * 1.7, rnd(), 0.4 + rnd() * 0.8]);
    g.add(grit);
    var shake = 0;
    function strike(ch, t) {
      var c = CHANNELS[ch], tt = t + c.off, k = Math.floor(tt / c.period), age = tt - k * c.period;
      var env = age < 0.3 ? (1 - age / 0.3) * (0.72 + 0.28 * Math.sin(age * 130)) : 0;
      return { k: k, env: Math.max(0, env) };
    }
    return {
      group: g,
      update: function (t, p) {
        var s0 = strike(0, t), s1 = strike(1, t), lightTotal = Math.min(1, s0.env + s1.env);
        shake = lightTotal * 0.05;
        puffs.forEach(function (q) {
          var churn = 0.09 * (0.5 + 0.5 * p);
          q.s.position.set(q.x + Math.sin(t * q.sp + q.a) * churn + Math.sin(t * 0.3 + q.b) * 0.05, q.y + Math.cos(t * q.sp * 0.8 + q.b) * churn * 0.8, q.z);
          q.s.scale.setScalar(q.size * (1 + 0.07 * Math.sin(t * 1.3 + q.a)));
          var lit = 0;
          [[s0, CHANNELS[0].x], [s1, CHANNELS[1].x]].forEach(function (c) { var dx = q.x - c[1], dy = q.y - 0.9; lit += c[0].env * Math.exp(-(dx * dx + dy * dy * 0.6) / 0.9); });
          lit = Math.min(0.72, lit);
          tmpC.copy(q.base).lerp(glow, lit); q.s.material.color.copy(tmpC);
        });
        flash.material.opacity = (E.light ? 0.3 : 0.55) * lightTotal; flash.scale.setScalar(3.6 + 1.2 * lightTotal);
        [s0, s1].forEach(function (s, ch) {
          var b = bolts[ch], c = CHANNELS[ch], r = mulberry(1000 + s.k * 7 + ch * 131 + 3), x = c.x + (r() - 0.5) * 0.7, y = 0.5, step = 2.0 / (BN - 1);
          for (var j = 0; j < BN; j++) {
            b.pts[j][0] = x; b.pts[j][1] = y; b.hp[j][0] = x; b.hp[j][1] = y;
            if (j === 6) { b.bx = x; b.by = y; b.bd = r() < 0.5 ? -1 : 1; }
            x += (r() - 0.5) * 0.62 + (j > 0 ? 0.02 : 0); y -= step * (0.7 + r() * 0.6);
          }
          var bx = b.bx, by = b.by;
          for (j = 0; j < 8; j++) { b.bp[j][0] = bx; b.bp[j][1] = by; bx += b.bd * (0.14 + r() * 0.2); by -= 0.18 + r() * 0.16; }
          b.core.set(b.pts, function (i2, n) { return 0.04 * (1 - i2 / (n * 1.5)); });
          b.halo.set(b.hp, function (i2, n) { return 0.11 * (1 - i2 / (n * 1.6)); });
          b.branch.set(b.bp, function (i2, n) { return 0.034 * (1 - i2 / n); });
          b.cm.material.opacity = s.env > 0.02 ? Math.min(1, s.env * 1.3) : 0;
          b.hm.material.opacity = s.env * (E.light ? 0.25 : 0.45);
          b.bm.material.opacity = s.env > 0.02 ? Math.min(1, s.env * 1.1) * 0.9 : 0;
        });
        var rp = rain.geometry.attributes.position;
        for (var k = 0; k < RN; k++) {
          var d = rd[k], f = fract(d[1] + t * 1.5 * d[2]), yy = 0.3 - f * 2.1, xx = d[0] * 0.55 + d[3] * f - 0.1;
          rp.setXYZ(k * 2, xx, yy, 0.2); rp.setXYZ(k * 2 + 1, xx - 0.05, yy - 0.28, 0.2);
        }
        rp.needsUpdate = true;
        var gp = grit.geometry.attributes.position;
        for (k = 0; k < SN; k++) {
          var q2 = gd[k], a = q2[0] + t * q2[3] * (0.7 + 0.5 * p), rr = q2[1];
          gp.setXYZ(k, Math.cos(a) * rr * 1.25, 0.15 + Math.sin(a) * rr * 0.28 + (q2[2] - 0.5) * 0.7, Math.sin(a) * rr * 0.5);
        }
        gp.needsUpdate = true;
        g.rotation.y = Math.sin(p * 2.0) * 0.12;
      },
      cam: function (t, p, cam) {
        var d = lerp(11.4, 9.6, ease(p)), sx = Math.sin(t * 61) * shake, sy = Math.cos(t * 53) * shake;
        cam.position.set(Math.sin(p * 0.5) * 0.7 + sx, 0.6 + sy, d); cam.lookAt(0, 0.0, 0);
      },
    };
  };

  /* -- rest: sleep, rest, recovery, stillness (a still moonlit lake under a slow moon, everything at rest) -- */
  HEROES.rest = function (E) {
    var T = E.T, g = new T.Group(), rnd = mulberry(73), i;
    var add = E.light ? T.NormalBlending : T.AdditiveBlending;
    var moonCol = E.light ? 0xe8883a : 0xf3eee0;
    // The moon: a pale sphere mottled by a painted canvas, lit from within so it glows, rising very slowly.
    var mc = document.createElement("canvas"); mc.width = mc.height = 256;
    var mx = mc.getContext("2d"), mr = mulberry(5);
    mx.fillStyle = E.light ? "#f2a95a" : "#f2eee2"; mx.fillRect(0, 0, 256, 256);
    for (i = 0; i < 28; i++) {
      var rx = mr() * 256, ry = mr() * 256, rr = 14 + mr() * 40, gr = mx.createRadialGradient(rx, ry, 0, rx, ry, rr);
      gr.addColorStop(0, E.light ? "rgba(170,100,50,0.34)" : "rgba(140,145,170,0.36)"); gr.addColorStop(1, "rgba(0,0,0,0)");
      mx.fillStyle = gr; mx.fillRect(rx - rr, ry - rr, rr * 2, rr * 2);
    }
    var mt = new T.CanvasTexture(mc); mt.colorSpace = T.SRGBColorSpace;
    var moon = new T.Mesh(new T.SphereGeometry(0.66, 48, 36), new T.MeshStandardMaterial({ map: mt, emissiveMap: mt, emissive: 0xffffff, emissiveIntensity: E.light ? 0.6 : 0.7, roughness: 1, metalness: 0 }));
    moon.position.z = -3.0; g.add(moon);
    var halo = sprite(E, moonCol, 4.6, E.light ? 0.4 : 0.5); halo.position.z = -3.4; g.add(halo);
    var halo2 = sprite(E, moonCol, 9, E.light ? 0.18 : 0.16); halo2.position.z = -3.6; g.add(halo2);
    // Land and water, as paper-thin layers that fade out toward the foot of the picture.
    function band(z, top, bottom, col, aTop, seed, amp) {
      var N = 44, pos = [], cols = [], idx = [], r = mulberry(seed), p1 = r() * 6.28, p2 = r() * 6.28, c = new T.Color(col);
      for (var k = 0; k <= N; k++) {
        var x = -6 + (k / N) * 12, y = top + (amp ? Math.sin(x * 0.6 + p1) * amp + Math.sin(x * 1.7 + p2) * amp * 0.4 : 0);
        pos.push(x, y, 0, x, bottom, 0); cols.push(c.r, c.g, c.b, aTop, c.r, c.g, c.b, 0);
      }
      for (k = 0; k < N; k++) { var a = k * 2; idx.push(a, a + 1, a + 2, a + 1, a + 3, a + 2); }
      var geo = new T.BufferGeometry();
      geo.setAttribute("position", new T.BufferAttribute(new Float32Array(pos), 3));
      geo.setAttribute("color", new T.BufferAttribute(new Float32Array(cols), 4));
      geo.setIndex(idx);
      var m = new T.Mesh(geo, new T.MeshBasicMaterial({ vertexColors: true, transparent: true, depthWrite: false, side: T.DoubleSide }));
      m.position.z = z; g.add(m); return m;
    }
    band(-2.6, -0.2, -1.5, E.light ? 0x8f8270 : 0x1b2442, 1, 11, 0.2);
    band(-2.2, -0.2, -2.9, E.light ? 0x7f95a8 : 0x141c33, E.light ? 0.62 : 0.92, 13, 0);
    band(-0.9, -1.65, -2.55, E.light ? 0x7a6e5c : 0x0b0f1d, 1, 17, 0.22);
    // The moon's reflection on the water and the slow ripples that spread from it.
    var refl = sprite(E, moonCol, 1, E.light ? 0.55 : 0.7); refl.position.set(0, -0.95, -2.1); g.add(refl);
    var ripples = [0, 1, 2].map(function () {
      var r = new T.Mesh(new T.TorusGeometry(1, 0.012, 6, 90), new T.MeshBasicMaterial({ color: E.light ? 0x8a7a68 : 0xcfd8f0, transparent: true, opacity: 0, depthWrite: false, blending: add }));
      r.position.z = -2.0; g.add(r); return r;
    });
    var shimmer = [];
    for (i = 0; i < 7; i++) {
      var sg = new T.PlaneGeometry(1, 0.026); sg.clearGroups();
      var sm = new T.Mesh(sg, new T.MeshBasicMaterial({ color: moonCol, transparent: true, opacity: 0, depthWrite: false, blending: add }));
      sm.position.z = -2.05; g.add(sm); shimmer.push(sm);
    }
    // Stars on a dark night, a few drifting clouds on a pale one.
    var starsA = points(E, 70, 0.045, 0xffffff, E.light ? 0.0 : 0.85), starsB = points(E, 70, 0.045, 0xdfe8ff, E.light ? 0.0 : 0.85), sd = [];
    for (i = 0; i < 140; i++) sd.push([rnd() * 12 - 6, rnd() * 3.2 + 0.4, -rnd() * 2 - 4]);
    [starsA, starsB].forEach(function (s, n) {
      var sp = s.geometry.attributes.position;
      for (var k = 0; k < 70; k++) sp.setXYZ(k, sd[n * 70 + k][0], sd[n * 70 + k][1], sd[n * 70 + k][2]);
      sp.needsUpdate = true; g.add(s);
    });
    var mist = [];
    for (i = 0; i < 6; i++) { var mp = puff(E, E.light ? 0xffffff : 0x8a9ac0, 4.2 + (i % 3), E.light ? 0.4 : 0.1); mp.position.set(0, -0.3 - (i % 3) * 0.5, -1.5 - i * 0.1); g.add(mp); mist.push(mp); }
    var motes = points(E, 40, 0.04, E.light ? 0x8a7a68 : moonCol, E.light ? 0.4 : 0.55), md = [];
    for (i = 0; i < 40; i++) md.push([rnd() * 5 - 2.5, rnd() * 2.4 - 1.2, rnd() * 2 - 1.5, rnd()]);
    g.add(motes);
    return {
      group: g,
      update: function (t, p) {
        var rise = smooth(0.0, 1.0, p), breath = Math.sin(t * 1.15);
        var my = lerp(-0.05, 0.72, rise), mx2 = lerp(0.5, 0.25, rise);
        moon.position.set(mx2, my, -3.0); moon.rotation.y = t * 0.02; moon.scale.setScalar(1 + 0.012 * breath);
        halo.position.set(mx2, my, -3.4); halo.scale.setScalar(4.6 + 0.35 * breath); halo.material.opacity = (E.light ? 0.4 : 0.5) * (0.9 + 0.1 * breath);
        halo2.position.set(mx2, my, -3.6); halo2.scale.setScalar(9 + 0.6 * breath);
        var rx2 = mx2 * 0.78;
        refl.position.set(rx2, -1.0, -2.1); refl.scale.set(0.9 + 0.04 * breath, 2.6, 1);
        ripples.forEach(function (r, k) {
          var f = fract(t * 0.07 + k / 3);
          r.position.set(rx2, -1.05, -2.0); r.scale.set(0.3 + f * 2.3, (0.3 + f * 2.3) * 0.12, 1); r.material.opacity = (1 - f) * (1 - f) * (E.light ? 0.45 : 0.4);
        });
        shimmer.forEach(function (s, k) {
          var w = 0.5 + 0.9 * (0.5 + 0.5 * Math.sin(t * 0.6 + k * 1.7)), y = -0.55 - k * 0.2;
          s.position.set(rx2 + Math.sin(t * 0.3 + k) * 0.08, y, -2.05); s.scale.set(w * (1 - k * 0.07), 1, 1); s.material.opacity = (E.light ? 0.4 : 0.5) * (0.5 + 0.5 * Math.sin(t * 0.8 + k * 2.1)) * (1 - k * 0.1);
        });
        starsA.material.opacity = (E.light ? 0 : 0.85) * (0.55 + 0.45 * Math.sin(t * 0.9)); starsB.material.opacity = (E.light ? 0 : 0.85) * (0.55 + 0.45 * Math.sin(t * 0.9 + 3.14));
        mist.forEach(function (m, k) { m.position.x = lerp(-3.2, 3.2, fract(t * 0.012 + k / 6)); });
        var mpz = motes.geometry.attributes.position;
        for (var k = 0; k < 40; k++) { var d = md[k]; mpz.setXYZ(k, d[0] + Math.sin(t * 0.18 + d[3] * 6) * 0.3, d[1] + Math.sin(t * 0.13 + d[3] * 9) * 0.25, d[2]); }
        mpz.needsUpdate = true;
        g.rotation.y = Math.sin(p * 1.6) * 0.05;
      },
      cam: function (t, p, cam) { var d = lerp(10.6, 9.4, ease(p)); cam.position.set(Math.sin(p * 0.5) * 0.4, 0.35, d); cam.lookAt(0, -0.2, 0); },
    };
  };

  /* -- mind: thinking, memory, what happens inside your head (a head in profile, scanned, thoughts moving inside it) -- */
  HEROES.mind = function (E) {
    var T = E.T, g = new T.Group(), rnd = mulberry(37), i, k;
    var ink = E.light ? 0x2a2622 : 0xcfeaf6;
    // The profile of a head, facing right: back of the neck, up over the crown, down the face, under the chin.
    var key = [
      [-0.5, -1.5], [-0.56, -1.1], [-0.78, -0.7], [-0.98, -0.25], [-1.06, 0.25], [-1.0, 0.72], [-0.78, 1.12], [-0.4, 1.38], [0.05, 1.46],
      [0.5, 1.38], [0.86, 1.12], [1.04, 0.78], [1.1, 0.42], [1.13, 0.12], [1.18, -0.02], [1.46, -0.32], [1.2, -0.4], [1.2, -0.55],
      [1.14, -0.64], [1.18, -0.72], [1.1, -0.84], [1.12, -1.02], [0.95, -1.22], [0.55, -1.28], [0.4, -1.34], [0.36, -1.5], [-0.07, -1.54],
    ];
    var curve = new T.CatmullRomCurve3(key.map(function (q) { return new T.Vector3(q[0], q[1], 0); }), true, "centripetal");
    var ol = curve.getSpacedPoints(120).slice(0, 120).map(function (q) { return [q.x, q.y]; });
    var N = ol.length, K = 15, hl = loft(T, ol, K, 0.8, 2.2);
    // A pane of glass, the contour of every slice (a scan), and the bright outline of the profile itself.
    g.add(new T.Mesh(hl.geo, std(E, E.light ? 0x6f6a62 : 0x7fb4d6, { metal: 0.1, rough: 0.2, opacity: E.light ? 0.1 : 0.16, double: true, depthWrite: false, emissive: E.light ? 0x000000 : 0x2f6f96, ei: 0.5 })));
    var cp = [];
    for (k = 1; k < K; k++) for (i = 0; i < N; i++) {
      var a = (k * N + i) * 3, b = (k * N + (i + 1) % N) * 3;
      cp.push(hl.pos[a], hl.pos[a + 1], hl.pos[a + 2], hl.pos[b], hl.pos[b + 1], hl.pos[b + 2]);
    }
    var cg = new T.BufferGeometry(); cg.setAttribute("position", new T.BufferAttribute(new Float32Array(cp), 3));
    g.add(new T.LineSegments(cg, lineMat(E, ink, E.light ? 0.3 : 0.3)));
    var outline = strip(T, N + 1), op = [];
    for (i = 0; i <= N; i++) op.push([ol[i % N][0], ol[i % N][1], 0]);
    outline.set(op, 0.026);
    var om = new T.Mesh(outline.geo, new T.MeshBasicMaterial({ color: E.light ? 0x2a2622 : 0xe6f6ff, side: T.DoubleSide, transparent: true, opacity: 0.95, depthWrite: false })); om.frustumCulled = false; g.add(om);
    var og = strip(T, N + 1); og.set(op, 0.1);
    var ogm = new T.Mesh(og.geo, new T.MeshBasicMaterial({ color: E.acc2, side: T.DoubleSide, transparent: true, opacity: E.light ? 0.0 : 0.22, depthWrite: false, blending: T.AdditiveBlending })); ogm.frustumCulled = false; ogm.position.z = -0.01; g.add(ogm);
    // Thoughts: a web of nodes in the skull, impulses running along it, and a few bright ideas wandering through.
    var NN = 34, base = [], nodes = points(E, NN, 0.1, E.acc, E.light ? 0.95 : 1);
    for (i = 0; i < NN; i++) {
      var u = rnd() * 2 - 1, an = rnd() * 6.283, rr = Math.sqrt(1 - u * u), sh = Math.pow(rnd(), 0.5);
      base.push([-0.1 + rr * Math.cos(an) * 0.74 * sh, 0.56 + u * 0.6 * sh, rr * Math.sin(an) * 0.4 * sh]);
    }
    var edges = [];
    for (i = 0; i < NN; i++) {
      var ds = [];
      for (var j = 0; j < NN; j++) if (j !== i) { var dx = base[i][0] - base[j][0], dy = base[i][1] - base[j][1], dz = base[i][2] - base[j][2]; ds.push([dx * dx + dy * dy + dz * dz, j]); }
      ds.sort(function (x, y) { return x[0] - y[0]; });
      for (j = 0; j < 2; j++) edges.push([i, ds[j][1]]);
    }
    var eg = new T.BufferGeometry(); eg.setAttribute("position", new T.BufferAttribute(new Float32Array(edges.length * 6), 3));
    var edgeObj = new T.LineSegments(eg, lineMat(E, E.light ? 0xb3341c : 0xffd8b0, E.light ? 0.55 : 0.5)); edgeObj.frustumCulled = false; g.add(edgeObj);
    g.add(nodes);
    var PN = 36, impulses = points(E, PN, 0.12, E.light ? 0xb3341c : 0xffffff, 1); g.add(impulses);
    var ideas = [0, 1, 2].map(function (n) {
      var o = new T.Group();
      o.add(new T.Mesh(new T.SphereGeometry(0.09, 20, 14), new T.MeshBasicMaterial({ color: E.light ? E.acc : 0xffffff })));
      o.add(sprite(E, E.acc, E.light ? 0.8 : 1.5, E.light ? 0.4 : 0.9));
      g.add(o); return { o: o, w: [0.5 + n * 0.17, 0.7 + n * 0.11, 0.9 + n * 0.07], ph: n * 2.1 };
    });
    var scan = new T.Mesh(new T.PlaneGeometry(0.035, 3.3), new T.MeshBasicMaterial({ color: E.acc2, transparent: true, opacity: E.light ? 0.0 : 0.5, depthWrite: false, blending: T.AdditiveBlending, side: T.DoubleSide }));
    scan.geometry.clearGroups(); g.add(scan);
    var halo = sprite(E, E.acc, 4.6, E.light ? 0.0 : 0.18); halo.position.set(0, 0.5, -0.9); g.add(halo);
    var dust = points(E, 70, 0.04, E.light ? 0x8a7a68 : E.acc2, E.light ? 0.4 : 0.5), dd = [];
    for (i = 0; i < 70; i++) dd.push([rnd() * 5 - 2.5, rnd() * 4.4 - 2.2, rnd() * 3 - 1.8, rnd()]);
    g.add(dust);
    g.add(contactShadow(E, 3.2, -1.62));
    var pos = base.map(function () { return [0, 0, 0]; });
    return {
      group: g,
      update: function (t, p) {
        var q;
        for (q = 0; q < NN; q++) {
          var w = 0.045, b = base[q];
          pos[q] = [b[0] + Math.sin(t * 0.7 + q) * w, b[1] + Math.cos(t * 0.6 + q * 1.3) * w, b[2] + Math.sin(t * 0.5 + q * 2) * w];
        }
        var nattr = nodes.geometry.attributes.position, ep = eg.attributes.position;
        for (q = 0; q < NN; q++) nattr.setXYZ(q, pos[q][0], pos[q][1], pos[q][2]);
        nattr.needsUpdate = true;
        edges.forEach(function (e, n) { ep.setXYZ(n * 2, pos[e[0]][0], pos[e[0]][1], pos[e[0]][2]); ep.setXYZ(n * 2 + 1, pos[e[1]][0], pos[e[1]][1], pos[e[1]][2]); });
        ep.needsUpdate = true;
        var ip = impulses.geometry.attributes.position;
        for (q = 0; q < PN; q++) {
          var e2 = edges[(q * 5) % edges.length], f = fract(t * 0.5 + q * 0.31), a2 = pos[e2[0]], b2 = pos[e2[1]];
          ip.setXYZ(q, lerp(a2[0], b2[0], f), lerp(a2[1], b2[1], f), lerp(a2[2], b2[2], f));
        }
        ip.needsUpdate = true;
        ideas.forEach(function (d) {
          d.o.position.set(-0.1 + Math.sin(t * d.w[0] + d.ph) * 0.58, 0.56 + Math.sin(t * d.w[1] + d.ph * 1.3) * 0.46, Math.sin(t * d.w[2] + d.ph) * 0.3);
        });
        scan.position.set(lerp(-1.2, 1.35, fract(t * 0.16 + 0.2)), 0.0, 0.0);
        halo.material.opacity = (E.light ? 0 : 0.14) + (E.light ? 0 : 0.05) * Math.sin(t * 1.8);
        var dpp = dust.geometry.attributes.position;
        for (q = 0; q < 70; q++) { var d3 = dd[q]; dpp.setXYZ(q, d3[0] + Math.sin(t * 0.3 + d3[3] * 6) * 0.2, d3[1] + ((t * 0.09 * (0.4 + d3[3]) + d3[3] * 4.4) % 4.4) - 2.2, d3[2]); }
        dpp.needsUpdate = true;
      },
      cam: function (t, p, cam) { var a = lerp(0.62, 0.12, ease(p)), d = lerp(11.2, 9.4, ease(p)); cam.position.set(Math.sin(a) * d, 0.35, Math.cos(a) * d); cam.lookAt(0, -0.05, 0); },
    };
  };

  /* ------------------------------------------------------------------ engine */

  function create(o) {
    var T = o.THREE, W = o.width, H = o.height, light = !!o.light;
    var canvas = document.createElement("canvas");
    canvas.width = W; canvas.height = H;
    var renderer = new T.WebGLRenderer({ canvas: canvas, alpha: true, antialias: true, preserveDrawingBuffer: true });
    renderer.setSize(W, H, false);
    renderer.setClearColor(0x000000, 0);
    renderer.toneMapping = T.ACESFilmicToneMapping;
    renderer.toneMappingExposure = light ? 0.95 : 1.1;
    var scene = new T.Scene();
    var camera = new T.PerspectiveCamera(32, W / H, 0.1, 80);
    var acc = new T.Color(o.accent || "#d9531e");
    var acc2 = acc.clone().offsetHSL(0.5, -0.05, light ? -0.1 : 0.04);
    if (light) {
      scene.add(new T.AmbientLight(0xffffff, 1.35));
      var key = new T.DirectionalLight(0xfff4e0, 2.6); key.position.set(-2.5, 4, 3.5); scene.add(key);
      var fill = new T.DirectionalLight(0xdfe8ff, 0.9); fill.position.set(3, 1, 2); scene.add(fill);
    } else {
      scene.add(new T.AmbientLight(0x2b3550, 1.1));
      var k2 = new T.DirectionalLight(0xffe2b8, 2.6); k2.position.set(-3, 3.5, 4); scene.add(k2);
      var rim = new T.DirectionalLight(acc2.getHex(), 3.2); rim.position.set(3.5, 2, -4); scene.add(rim);
      var pl = new T.PointLight(acc.getHex(), 9, 12, 1.6); pl.position.set(0, 0.2, 1.4); scene.add(pl);
    }
    var E = { T: T, light: light, acc: acc, acc2: acc2, soft: softTexture(T), scene: scene, camera: camera };
    var built = {};
    function ensure(id) {
      var key = HEROES[id] ? id : "orb";
      if (!built[key]) {
        built[key] = HEROES[key](E);
        built[key].group.visible = false;
        scene.add(built[key].group);
      }
      return built[key];
    }
    // How each hero is framed in the 9:16 frame: zoom < 1 pulls the camera back,
    // dy (buffer pixels) pushes the object DOWN, so the top third stays free for
    // the headline. Tall objects shrink and drop; wide scenes keep filling.
    var FIT = {
      hourglass: { z: 0.56, dy: 70 }, clock: { z: 0.64, dy: 60 }, bookletters: { z: 0.52, dy: 110 }, chain: { z: 0.54, dy: 60 },
      spark: { z: 0.66, dy: 80 }, staircase: { z: 0.78, dy: 40 }, scales: { z: 0.78, dy: 60 }, growth: { z: 0.72, dy: 70 },
      network: { z: 0.8, dy: 60 }, orb: { z: 0.72, dy: 70 }, orbit: { z: 0.9, dy: 70 }, path: { z: 1.0, dy: 30 },
      mountain: { z: 0.88, dy: 110 }, pulse: { z: 0.95, dy: 50 }, focus: { z: 0.92, dy: 30 },
      mind: { z: 0.74, dy: 80 }, storm: { z: 0.7, dy: 140 }, rest: { z: 0.9, dy: 80 }, dialogue: { z: 0.78, dy: 70 },
      wall: { z: 0.66, dy: 90 }, heart: { z: 0.62, dy: 60 }, loop: { z: 0.84, dy: 90 },
    };
    return {
      canvas: canvas,
      ensure: ensure,
      draw: function (id, t, p, low) {
        var h = ensure(id);
        Object.keys(built).forEach(function (k) { built[k].group.visible = built[k] === h; });
        h.group.position.y = 0;
        h.update(t, p);
        if (h.cam) h.cam(t, p, camera); else { camera.position.set(0, 0.6, 7); camera.lookAt(0, 0, 0); }
        var fit = FIT[HEROES[id] ? id : "orb"] || { z: 1, dy: 0 };
        // `low`: the opening hook's headline can run to four or five lines from the top, so
        // the hero steps back and down to sit below it instead of under its letters.
        camera.zoom = low ? fit.z * 0.82 : fit.z;
        camera.setViewOffset(W, H, 0, -(low ? fit.dy + 120 : fit.dy), W, H);
        camera.updateProjectionMatrix();
        renderer.render(scene, camera);
        try { renderer.getContext().finish(); } catch (e) { /* the blit below still reads what is there */ }
      },
      dispose: function () {
        try { renderer.dispose(); } catch (e) { /* the page is going away regardless */ }
      },
    };
  }

  window.CINE = { create: create, heroes: Object.keys(HEROES), mulberry: mulberry };
})();
