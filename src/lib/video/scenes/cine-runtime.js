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
    var flag = new T.Mesh(poly(T, [[0, 0], [0.5, 0.18], [0, 0.36]]), new T.MeshBasicMaterial({ color: E.acc, side: T.DoubleSide }));
    flag.position.set(0, 2.2, -1.0); g.add(flag);
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
        flag.rotation.y = Math.sin(t * 3) * 0.25;
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
