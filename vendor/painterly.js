/* Painterly — anisotropic Kuwahara scene.
   Copyright (c) 2026 Christian Ortiz (Cortiz)
   Adapted from cortiz2894/stylized-components (MIT). See LICENSE.
   WebGL2 only. A missing context or a failed texture stays black. */
(function () {
  "use strict";

  var canvas = document.getElementById("canvas");
  var stage = document.getElementById("stage");
  if (!canvas || !stage) return;

  var gl = canvas.getContext("webgl2", {
    alpha: false,
    antialias: false,
    depth: false,
    stencil: false,
    powerPreference: "high-performance",
    preserveDrawingBuffer: false,
    failIfMajorPerformanceCaveat: false,
  });
  if (!gl || !gl.getExtension("EXT_color_buffer_float")) return;

  var FOV = 45 * Math.PI / 180;
  var NEAR = 0.1;
  var FAR = 100;
  var BASE_EYE = [0, 1.2, 6.5];
  var BASE_DIST = Math.hypot(BASE_EYE[0], BASE_EYE[1], BASE_EYE[2]);
  var PHI0 = Math.acos(Math.max(-1, Math.min(1, BASE_EYE[1] / BASE_DIST)));
  var AUTO = 0.6 * Math.PI * 2 / 60;
  var SHADOW = 1024;
  var RADIUS = 9;

  function srgb(hex) {
    var n = parseInt(hex.slice(1), 16);
    var c = [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
    return c.map(function (x) {
      return x <= 0.04045 ? x / 12.92 : Math.pow((x + 0.055) / 1.055, 2.4);
    });
  }

  var ALBEDO = srgb("#c2453a");
  var BACKDROP = srgb("#e8ddc8");
  var FILL_COL = srgb("#9fb8d8").map(function (x) { return x * 0.8; });
  var INK = srgb("#2b2118");
  var TINT = srgb("#1a1a1a");
  var KEY = [2.4, 2.4, 2.4];
  var AMBIENT = [0.6, 0.6, 0.6];

  function vnorm(v) {
    var l = Math.hypot(v[0], v[1], v[2]) || 1;
    return [v[0] / l, v[1] / l, v[2] / l];
  }
  var KEY_DIR = vnorm([5, 8, 5]);
  var FILL_DIR = vnorm([-6, 2, -4]);

  function mul(a, b) {
    var o = new Float32Array(16);
    for (var c = 0; c < 4; c++) {
      for (var r = 0; r < 4; r++) {
        o[c * 4 + r] =
          a[r] * b[c * 4] +
          a[4 + r] * b[c * 4 + 1] +
          a[8 + r] * b[c * 4 + 2] +
          a[12 + r] * b[c * 4 + 3];
      }
    }
    return o;
  }

  function lookAt(eye, target, up) {
    var zx = eye[0] - target[0];
    var zy = eye[1] - target[1];
    var zz = eye[2] - target[2];
    var zl = Math.hypot(zx, zy, zz) || 1;
    zx /= zl; zy /= zl; zz /= zl;
    var xx = up[1] * zz - up[2] * zy;
    var xy = up[2] * zx - up[0] * zz;
    var xz = up[0] * zy - up[1] * zx;
    var xl = Math.hypot(xx, xy, xz) || 1;
    xx /= xl; xy /= xl; xz /= xl;
    var yx = zy * xz - zz * xy;
    var yy = zz * xx - zx * xz;
    var yz = zx * xy - zy * xx;
    var m = new Float32Array(16);
    m[0] = xx; m[1] = yx; m[2] = zx; m[3] = 0;
    m[4] = xy; m[5] = yy; m[6] = zy; m[7] = 0;
    m[8] = xz; m[9] = yz; m[10] = zz; m[11] = 0;
    m[12] = -(xx * eye[0] + xy * eye[1] + xz * eye[2]);
    m[13] = -(yx * eye[0] + yy * eye[1] + yz * eye[2]);
    m[14] = -(zx * eye[0] + zy * eye[1] + zz * eye[2]);
    m[15] = 1;
    return m;
  }

  function perspective(fov, aspect, near, far) {
    var f = 1 / Math.tan(fov * 0.5);
    var m = new Float32Array(16);
    m[0] = f / aspect;
    m[5] = f;
    m[10] = (far + near) / (near - far);
    m[11] = -1;
    m[14] = (2 * far * near) / (near - far);
    return m;
  }

  function ortho(l, r, b, t, n, f) {
    var m = new Float32Array(16);
    m[0] = 2 / (r - l);
    m[5] = 2 / (t - b);
    m[10] = -2 / (f - n);
    m[12] = -(r + l) / (r - l);
    m[13] = -(t + b) / (t - b);
    m[14] = -(f + n) / (f - n);
    m[15] = 1;
    return m;
  }

  var BIAS = new Float32Array([
    0.5, 0, 0, 0,
    0, 0.5, 0, 0,
    0, 0, 0.5, 0,
    0.5, 0.5, 0.5, 1,
  ]);

  function buildKnot() {
    var radius = 1, tube = 0.35, tubular = 220, radial = 32, p = 2, q = 3;
    var positions = [];
    var normals = [];
    var indices = [];
    var bound = 0;
    function curve(u, out) {
      var cu = Math.cos(u), su = Math.sin(u);
      var cs = Math.cos((q / p) * u);
      out[0] = radius * (2 + cs) * 0.5 * cu;
      out[1] = radius * (2 + cs) * su * 0.5;
      out[2] = radius * Math.sin((q / p) * u) * 0.5;
    }
    var P1 = [0, 0, 0], P2 = [0, 0, 0], B = [0, 0, 0], T = [0, 0, 0], N = [0, 0, 0];
    for (var i = 0; i <= tubular; i++) {
      var u = (i / tubular) * p * Math.PI * 2;
      curve(u, P1);
      curve(u + 0.01, P2);
      T[0] = P2[0] - P1[0]; T[1] = P2[1] - P1[1]; T[2] = P2[2] - P1[2];
      N[0] = P2[0] + P1[0]; N[1] = P2[1] + P1[1]; N[2] = P2[2] + P1[2];
      B[0] = T[1] * N[2] - T[2] * N[1];
      B[1] = T[2] * N[0] - T[0] * N[2];
      B[2] = T[0] * N[1] - T[1] * N[0];
      var bl = Math.hypot(B[0], B[1], B[2]) || 1;
      B[0] /= bl; B[1] /= bl; B[2] /= bl;
      var nx = B[1] * T[2] - B[2] * T[1];
      var ny = B[2] * T[0] - B[0] * T[2];
      var nz = B[0] * T[1] - B[1] * T[0];
      var nl = Math.hypot(nx, ny, nz) || 1;
      N[0] = nx / nl; N[1] = ny / nl; N[2] = nz / nl;
      for (var j = 0; j <= radial; j++) {
        var v = (j / radial) * Math.PI * 2;
        var cx = -tube * Math.cos(v);
        var cy = tube * Math.sin(v);
        var px = P1[0] + cx * N[0] + cy * B[0];
        var py = P1[1] + cx * N[1] + cy * B[1];
        var pz = P1[2] + cx * N[2] + cy * B[2];
        positions.push(px, py, pz);
        var dx = px - P1[0], dy = py - P1[1], dz = pz - P1[2];
        var dl = Math.hypot(dx, dy, dz) || 1;
        normals.push(dx / dl, dy / dl, dz / dl);
        bound = Math.max(bound, Math.hypot(px, py, pz));
      }
    }
    for (var jj = 1; jj <= tubular; jj++) {
      for (var ii = 1; ii <= radial; ii++) {
        var a = (radial + 1) * (jj - 1) + (ii - 1);
        var b = (radial + 1) * jj + (ii - 1);
        var c = (radial + 1) * jj + ii;
        var d = (radial + 1) * (jj - 1) + ii;
        indices.push(a, b, d, b, c, d);
      }
    }
    return {
      pos: new Float32Array(positions),
      nor: new Float32Array(normals),
      idx: new Uint16Array(indices),
      bound: bound,
    };
  }

  function makeNoise2D(seed) {
    function hash(xi, yi, period) {
      var x = ((xi % period) + period) % period;
      var y = ((yi % period) + period) % period;
      var h = (x * 374761393 + y * 668265263 + seed * 1442695040) | 0;
      h = Math.imul(h ^ (h >>> 13), 1274126177);
      return ((h ^ (h >>> 16)) >>> 0) / 4294967295;
    }
    function fade(t) { return t * t * (3 - 2 * t); }
    return function (x, y, period) {
      var xi = Math.floor(x), yi = Math.floor(y);
      var fx = fade(x - xi), fy = fade(y - yi);
      var a = hash(xi, yi, period);
      var b = hash(xi + 1, yi, period);
      var c = hash(xi, yi + 1, period);
      var d = hash(xi + 1, yi + 1, period);
      return a * (1 - fx) * (1 - fy) + b * fx * (1 - fy) + c * (1 - fx) * fy + d * fx * fy;
    };
  }

  function paperBytes(size) {
    var noise = makeNoise2D(7);
    var data = new Uint8Array(size * size * 4);
    var stretch = 1.4, frequency = 28, octaves = 4, contrast = 0.8;
    for (var y = 0; y < size; y++) {
      for (var x = 0; x < size; x++) {
        var u = x / size, v = y / size;
        var sum = 0, amp = 1, norm = 0, freq = frequency;
        for (var o = 0; o < octaves; o++) {
          var px = Math.max(1, Math.round(freq));
          var py = Math.max(1, Math.round(freq * stretch));
          sum += noise(u * px, v * py, Math.max(px, py)) * amp;
          norm += amp;
          amp *= 0.5;
          freq *= 2.03;
        }
        var n = sum / norm;
        n = 1 - Math.abs(n * 2 - 1);
        n = Math.pow(n, contrast);
        var byte = Math.max(0, Math.min(255, Math.round(n * 255)));
        var i = (y * size + x) * 4;
        data[i] = data[i + 1] = data[i + 2] = byte;
        data[i + 3] = 255;
      }
    }
    return data;
  }

  function compile(type, src) {
    var sh = gl.createShader(type);
    gl.shaderSource(sh, src);
    gl.compileShader(sh);
    if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
      gl.deleteShader(sh);
      return null;
    }
    return sh;
  }

  function program(vs, fs) {
    var v = compile(gl.VERTEX_SHADER, vs);
    var f = compile(gl.FRAGMENT_SHADER, fs);
    if (!v || !f) return null;
    var p = gl.createProgram();
    gl.attachShader(p, v);
    gl.attachShader(p, f);
    gl.bindAttribLocation(p, 0, "aPos");
    gl.bindAttribLocation(p, 1, "aNormal");
    gl.linkProgram(p);
    gl.deleteShader(v);
    gl.deleteShader(f);
    if (!gl.getProgramParameter(p, gl.LINK_STATUS)) {
      gl.deleteProgram(p);
      return null;
    }
    return p;
  }

  var meshVS = [
    "#version 300 es",
    "layout(location=0) in vec3 aPos;",
    "layout(location=1) in vec3 aNormal;",
    "uniform mat4 uMvp;",
    "out vec3 vWorld;",
    "out vec3 vNormal;",
    "void main() {",
    "  vWorld = aPos;",
    "  vNormal = aNormal;",
    "  gl_Position = uMvp * vec4(aPos, 1.0);",
    "}",
  ].join("\n");

  var shadowFS = "#version 300 es\nprecision highp float;\nvoid main() {}\n";

  var knotFS = [
    "#version 300 es",
    "precision highp float;",
    "in vec3 vWorld;",
    "in vec3 vNormal;",
    "uniform vec3 uEye;",
    "uniform vec3 uKeyDir;",
    "uniform vec3 uFillDir;",
    "uniform vec3 uKeyColor;",
    "uniform vec3 uFillColor;",
    "uniform vec3 uAmbient;",
    "uniform vec3 uAlbedo;",
    "uniform float uRoughness;",
    "uniform float uMetalness;",
    "uniform mat4 uShadowMatrix;",
    "uniform sampler2D uShadowMap;",
    "uniform float uShadowTexel;",
    "out vec4 fragColor;",
    "const float PI = 3.14159265;",
    "float shadowOf(vec3 worldPos) {",
    "  vec4 sc = uShadowMatrix * vec4(worldPos, 1.0);",
    "  vec3 p = sc.xyz / sc.w;",
    "  if (p.x < 0.0 || p.x > 1.0 || p.y < 0.0 || p.y > 1.0 || p.z < 0.0 || p.z > 1.0) return 1.0;",
    "  float vis = 0.0;",
    "  for (int y = -1; y <= 1; y++) {",
    "    for (int x = -1; x <= 1; x++) {",
    "      float d = texture(uShadowMap, p.xy + vec2(float(x), float(y)) * uShadowTexel).r;",
    "      vis += (p.z - 0.0025 > d) ? 0.0 : 1.0;",
    "    }",
    "  }",
    "  return vis / 9.0;",
    "}",
    "vec3 direct(vec3 N, vec3 V, vec3 L, vec3 lightColor, float shadow, vec3 albedo, float metal, float rough, vec3 F0) {",
    "  float NdotL = max(dot(N, L), 0.0);",
    "  if (NdotL <= 0.0) return vec3(0.0);",
    "  vec3 H = normalize(L + V);",
    "  float NdotV = max(dot(N, V), 1e-4);",
    "  float NdotH = max(dot(N, H), 0.0);",
    "  float VdotH = max(dot(V, H), 0.0);",
    "  float a = rough * rough;",
    "  float a2 = a * a;",
    "  float denom = NdotH * NdotH * (a2 - 1.0) + 1.0;",
    "  float D = a2 / (PI * denom * denom);",
    "  float k = (rough + 1.0) * (rough + 1.0) / 8.0;",
    "  float G = (NdotV / (NdotV * (1.0 - k) + k)) * (NdotL / (NdotL * (1.0 - k) + k));",
    "  vec3 F = F0 + (1.0 - F0) * pow(1.0 - VdotH, 5.0);",
    "  vec3 spec = (D * G * F) / max(4.0 * NdotV * NdotL, 1e-4);",
    "  vec3 diff = (vec3(1.0) - F) * albedo * (1.0 - metal) / PI;",
    "  return (diff + spec) * lightColor * NdotL * shadow;",
    "}",
    "void main() {",
    "  vec3 N = normalize(vNormal);",
    "  vec3 V = normalize(uEye - vWorld);",
    "  float rough = clamp(uRoughness, 0.045, 1.0);",
    "  vec3 F0 = mix(vec3(0.04), uAlbedo, uMetalness);",
    "  float sh = shadowOf(vWorld + N * 0.02);",
    "  vec3 col = uAmbient * uAlbedo * (1.0 - uMetalness) / PI;",
    "  col += direct(N, V, uKeyDir, uKeyColor, sh, uAlbedo, uMetalness, rough, F0);",
    "  col += direct(N, V, uFillDir, uFillColor, 1.0, uAlbedo, uMetalness, rough, F0);",
    "  fragColor = vec4(col, 1.0);",
    "}",
  ].join("\n");

  var groundFS = [
    "#version 300 es",
    "precision highp float;",
    "uniform vec3 uBackdrop;",
    "uniform float uOpacity;",
    "uniform mat4 uShadowMatrix;",
    "uniform sampler2D uShadowMap;",
    "uniform float uShadowTexel;",
    "in vec3 vWorld;",
    "out vec4 fragColor;",
    "void main() {",
    "  vec4 sc = uShadowMatrix * vec4(vWorld, 1.0);",
    "  vec3 p = sc.xyz / sc.w;",
    "  float amount = 0.0;",
    "  if (p.x > 0.0 && p.x < 1.0 && p.y > 0.0 && p.y < 1.0 && p.z > 0.0 && p.z < 1.0) {",
    "    float blocked = 0.0;",
    "    for (int y = -1; y <= 1; y++) {",
    "      for (int x = -1; x <= 1; x++) {",
    "        float d = texture(uShadowMap, p.xy + vec2(float(x), float(y)) * uShadowTexel).r;",
    "        blocked += (p.z - 0.0018 > d) ? 1.0 : 0.0;",
    "      }",
    "    }",
    "    amount = blocked / 9.0;",
    "  }",
    "  fragColor = vec4(uBackdrop * (1.0 - uOpacity * amount), 1.0);",
    "}",
  ].join("\n");

  var quadVS = [
    "#version 300 es",
    "layout(location=0) in vec2 aPos;",
    "layout(location=1) in vec2 aUv;",
    "out vec2 vUv;",
    "void main() {",
    "  vUv = aUv;",
    "  gl_Position = vec4(aPos, 0.0, 1.0);",
    "}",
  ].join("\n");

  var tensorFS = [
    "#version 300 es",
    "precision highp float;",
    "in vec2 vUv;",
    "uniform sampler2D uInput;",
    "uniform vec2 uResolution;",
    "out vec4 fragColor;",
    "const mat3 Gx = mat3(-1.0, -2.0, -1.0,  0.0, 0.0, 0.0,  1.0, 2.0, 1.0);",
    "const mat3 Gy = mat3(-1.0,  0.0,  1.0, -2.0, 0.0, 2.0, -1.0, 0.0, 1.0);",
    "void main() {",
    "  vec2 texel = 1.0 / uResolution;",
    "  vec2 uv = vUv;",
    "  vec3 tx0y0 = texture(uInput, uv + vec2(-1.0, -1.0) * texel).rgb;",
    "  vec3 tx0y1 = texture(uInput, uv + vec2(-1.0,  0.0) * texel).rgb;",
    "  vec3 tx0y2 = texture(uInput, uv + vec2(-1.0,  1.0) * texel).rgb;",
    "  vec3 tx1y0 = texture(uInput, uv + vec2( 0.0, -1.0) * texel).rgb;",
    "  vec3 tx1y1 = texture(uInput, uv + vec2( 0.0,  0.0) * texel).rgb;",
    "  vec3 tx1y2 = texture(uInput, uv + vec2( 0.0,  1.0) * texel).rgb;",
    "  vec3 tx2y0 = texture(uInput, uv + vec2( 1.0, -1.0) * texel).rgb;",
    "  vec3 tx2y1 = texture(uInput, uv + vec2( 1.0,  0.0) * texel).rgb;",
    "  vec3 tx2y2 = texture(uInput, uv + vec2( 1.0,  1.0) * texel).rgb;",
    "  vec3 Sx = Gx[0][0] * tx0y0 + Gx[1][0] * tx1y0 + Gx[2][0] * tx2y0",
    "          + Gx[0][1] * tx0y1 + Gx[1][1] * tx1y1 + Gx[2][1] * tx2y1",
    "          + Gx[0][2] * tx0y2 + Gx[1][2] * tx1y2 + Gx[2][2] * tx2y2;",
    "  vec3 Sy = Gy[0][0] * tx0y0 + Gy[1][0] * tx1y0 + Gy[2][0] * tx2y0",
    "          + Gy[0][1] * tx0y1 + Gy[1][1] * tx1y1 + Gy[2][1] * tx2y1",
    "          + Gy[0][2] * tx0y2 + Gy[1][2] * tx1y2 + Gy[2][2] * tx2y2;",
    "  fragColor = vec4(dot(Sx, Sx), dot(Sy, Sy), dot(Sx, Sy), 1.0);",
    "}",
  ].join("\n");

  var outlineFS = [
    "#version 300 es",
    "precision highp float;",
    "in vec2 vUv;",
    "uniform sampler2D uColor;",
    "uniform sampler2D uDepth;",
    "uniform vec2 uTexel;",
    "uniform vec3 uInk;",
    "uniform float uStrength;",
    "uniform float uThickness;",
    "uniform float uThreshold;",
    "uniform float uSoftness;",
    "uniform float uNear;",
    "uniform float uFar;",
    "out vec4 fragColor;",
    "float linearize(float d) {",
    "  return (uNear * uFar) / (uFar - d * (uFar - uNear));",
    "}",
    "void main() {",
    "  vec3 base = texture(uColor, vUv).rgb;",
    "  vec2 t = uTexel * uThickness;",
    "  float s00 = linearize(texture(uDepth, vUv + vec2(-t.x, -t.y)).r);",
    "  float s10 = linearize(texture(uDepth, vUv + vec2( 0.0, -t.y)).r);",
    "  float s20 = linearize(texture(uDepth, vUv + vec2( t.x, -t.y)).r);",
    "  float s01 = linearize(texture(uDepth, vUv + vec2(-t.x,  0.0)).r);",
    "  float s11 = linearize(texture(uDepth, vUv).r);",
    "  float s21 = linearize(texture(uDepth, vUv + vec2( t.x,  0.0)).r);",
    "  float s02 = linearize(texture(uDepth, vUv + vec2(-t.x,  t.y)).r);",
    "  float s12 = linearize(texture(uDepth, vUv + vec2( 0.0,  t.y)).r);",
    "  float s22 = linearize(texture(uDepth, vUv + vec2( t.x,  t.y)).r);",
    "  float gx = -s00 - 2.0 * s01 - s02 + s20 + 2.0 * s21 + s22;",
    "  float gy = -s00 - 2.0 * s10 - s20 + s02 + 2.0 * s12 + s22;",
    "  float g = sqrt(gx * gx + gy * gy) / max(s11, 1e-3);",
    "  float edge = smoothstep(uThreshold, uThreshold + max(uSoftness, 1e-4), g);",
    "  fragColor = vec4(mix(base, uInk, edge * uStrength), 1.0);",
    "}",
  ].join("\n");

  var kuwaharaFS = [
    "#version 300 es",
    "precision highp float;",
    "in vec2 vUv;",
    "uniform sampler2D uTensor;",
    "uniform sampler2D uColor;",
    "uniform sampler2D uDepth;",
    "uniform vec2 uResolution;",
    "uniform float uRadius;",
    "uniform float uAlpha;",
    "uniform float uEta;",
    "uniform float uLambda;",
    "out vec4 fragColor;",
    "#define SECTOR_COUNT 8",
    "const int MAX_RADIUS = 5;",
    "const int ANGLE_STEPS = 5;",
    "const float ANGLE_START = -0.392699;",
    "const float ANGLE_STEP = 0.196349;",
    "vec3 sampleColor(vec2 offset) {",
    "  vec2 coord = (gl_FragCoord.xy + offset) / uResolution;",
    "  return texture(uColor, coord).rgb;",
    "}",
    "vec4 dominant(vec4 structureTensor) {",
    "  float Jxx = structureTensor.r;",
    "  float Jyy = structureTensor.g;",
    "  float Jxy = structureTensor.b;",
    "  float trace = Jxx + Jyy;",
    "  float determinant = Jxx * Jyy - Jxy * Jxy;",
    "  float disc = max(trace * trace * 0.25 - determinant, 0.0);",
    "  float lambda1 = trace * 0.5 + sqrt(disc);",
    "  float lambda2 = trace * 0.5 - sqrt(disc);",
    "  float jxyStrength = abs(Jxy) / (abs(Jxx) + abs(Jyy) + abs(Jxy) + 1e-6);",
    "  vec2 v;",
    "  if (jxyStrength > 0.0) v = vec2(-Jxy, Jxx - lambda1);",
    "  else v = vec2(0.0, 1.0);",
    "  float lenV = length(v);",
    "  v = lenV > 1e-5 ? v / lenV : vec2(0.0, 1.0);",
    "  return vec4(v, lambda1, lambda2);",
    "}",
    "float polyWeight(float x, float y, float eta, float lambda) {",
    "  float polyValue = (x + eta) - lambda * (y * y);",
    "  return max(0.0, polyValue * polyValue);",
    "}",
    "vec4 sectorStats(mat2 anisotropyMat, float angle, float radius) {",
    "  vec3 weightedColorSum = vec3(0.0);",
    "  vec3 weightedSquaredColorSum = vec3(0.0);",
    "  float totalWeight = 0.0;",
    "  for (int ri = 1; ri <= MAX_RADIUS; ri++) {",
    "    float r = float(ri);",
    "    if (r > radius) break;",
    "    for (int ai = 0; ai < ANGLE_STEPS; ai++) {",
    "      float a = ANGLE_START + float(ai) * ANGLE_STEP;",
    "      vec2 sampleOffset = r * vec2(cos(angle + a), sin(angle + a));",
    "      sampleOffset = anisotropyMat * sampleOffset;",
    "      vec3 color = sampleColor(sampleOffset);",
    "      float weight = polyWeight(sampleOffset.x, sampleOffset.y, uEta, uLambda);",
    "      weightedColorSum += color * weight;",
    "      weightedSquaredColorSum += color * color * weight;",
    "      totalWeight += weight;",
    "    }",
    "  }",
    "  float safeWeight = max(totalWeight, 1e-6);",
    "  vec3 avgColor = weightedColorSum / safeWeight;",
    "  vec3 varianceRes = (weightedSquaredColorSum / safeWeight) - (avgColor * avgColor);",
    "  float variance = dot(varianceRes, vec3(0.299, 0.587, 0.114));",
    "  return vec4(avgColor, variance);",
    "}",
    "void main() {",
    "  // Flat backdrop (cleared depth) is unchanged by the brush. Skip it.",
    "  if (texture(uDepth, vUv).r > 0.9995) {",
    "    fragColor = vec4(texture(uColor, vUv).rgb, 1.0);",
    "    return;",
    "  }",
    "  vec4 structureTensor = texture(uTensor, vUv);",
    "  vec4 orientationAndAnisotropy = dominant(structureTensor);",
    "  vec2 orientation = orientationAndAnisotropy.xy;",
    "  float anisotropy = (orientationAndAnisotropy.z - orientationAndAnisotropy.w)",
    "                   / (orientationAndAnisotropy.z + orientationAndAnisotropy.w + 1e-6);",
    "  float alpha = max(uAlpha, 1e-3);",
    "  float scaleX = alpha / (anisotropy + alpha);",
    "  float scaleY = (anisotropy + alpha) / alpha;",
    "  mat2 rotation = mat2(orientation.x, orientation.y, -orientation.y, orientation.x);",
    "  mat2 anisotropyMat = rotation * mat2(scaleX, 0.0, 0.0, scaleY);",
    "  vec3 sectorAvgColors[SECTOR_COUNT];",
    "  float sectorVariances[SECTOR_COUNT];",
    "  for (int i = 0; i < SECTOR_COUNT; i++) {",
    "    float angle = float(i) * 6.28318 / float(SECTOR_COUNT);",
    "    vec4 stats = sectorStats(anisotropyMat, angle, uRadius);",
    "    sectorAvgColors[i] = stats.rgb;",
    "    sectorVariances[i] = stats.a;",
    "  }",
    "  float minVariance = sectorVariances[0];",
    "  vec3 finalColor = sectorAvgColors[0];",
    "  for (int i = 1; i < SECTOR_COUNT; i++) {",
    "    if (sectorVariances[i] < minVariance) {",
    "      minVariance = sectorVariances[i];",
    "      finalColor = sectorAvgColors[i];",
    "    }",
    "  }",
    "  fragColor = vec4(finalColor, 1.0);",
    "}",
  ].join("\n");

  var waterFS = [
    "#version 300 es",
    "precision highp float;",
    "in vec2 vUv;",
    "uniform sampler2D uColor;",
    "uniform sampler2D uPaper;",
    "uniform float uAspect;",
    "uniform float uPaperStrength;",
    "uniform float uPaperScale;",
    "uniform float uSteps;",
    "uniform float uQuantLow;",
    "uniform float uQuantHigh;",
    "uniform vec3 uShadowTint;",
    "uniform float uSaturation;",
    "uniform float uMix;",
    "out vec4 fragColor;",
    "vec3 aces(vec3 x) {",
    "  return clamp((x * (2.51 * x + 0.03)) / (x * (2.43 * x + 0.59) + 0.14), 0.0, 1.0);",
    "}",
    "vec3 sat(vec3 rgb, float adjustment) {",
    "  vec3 intensity = vec3(dot(rgb, vec3(0.2125, 0.7154, 0.0721)));",
    "  return mix(intensity, rgb, adjustment);",
    "}",
    "vec3 lin2srgb(vec3 c) {",
    "  vec3 lo = c * 12.92;",
    "  vec3 hi = 1.055 * pow(max(c, vec3(0.0)), vec3(1.0 / 2.4)) - 0.055;",
    "  return mix(lo, hi, step(vec3(0.0031308), c));",
    "}",
    "void main() {",
    "  vec3 color = texture(uColor, vUv).rgb;",
    "  float lum = dot(color, vec3(0.299, 0.587, 0.114));",
    "  float n = max(uSteps, 2.0);",
    "  float qn = floor(lum * (n - 1.0) + 0.5) / (n - 1.0);",
    "  qn = clamp(qn, uQuantLow, uQuantHigh);",
    "  vec3 graded = (qn < 0.5)",
    "    ? mix(uShadowTint, color, qn * 2.0)",
    "    : mix(color, vec3(1.0), (qn - 0.5) * 2.0);",
    "  graded = sat(graded, uSaturation);",
    "  graded = aces(graded);",
    "  vec2 puv = (vUv - 0.5) * vec2(uAspect, 1.0) * uPaperScale + 0.5;",
    "  vec3 paper = texture(uPaper, puv).rgb;",
    "  graded *= mix(vec3(1.0), paper, uPaperStrength);",
    "  vec3 outc = mix(color, graded, uMix);",
    "  fragColor = vec4(lin2srgb(clamp(outc, 0.0, 1.0)), 1.0);",
    "}",
  ].join("\n");

  var knotProg = program(meshVS, knotFS);
  var groundProg = program(meshVS, groundFS);
  var shadowProg = program(meshVS, shadowFS);
  var tensorProg = program(quadVS, tensorFS);
  var outlineProg = program(quadVS, outlineFS);
  var kuwaharaProg = program(quadVS, kuwaharaFS);
  var waterProg = program(quadVS, waterFS);
  if (!knotProg || !groundProg || !shadowProg || !tensorProg || !outlineProg || !kuwaharaProg || !waterProg) return;

  var knot = buildKnot();
  var BOUND = Math.max(knot.bound * 1.12, 2.15);

  function buffer(target, data, usage) {
    var b = gl.createBuffer();
    gl.bindBuffer(target, b);
    gl.bufferData(target, data, usage);
    return b;
  }

  var knotVAO = gl.createVertexArray();
  gl.bindVertexArray(knotVAO);
  buffer(gl.ARRAY_BUFFER, knot.pos, gl.STATIC_DRAW);
  gl.enableVertexAttribArray(0);
  gl.vertexAttribPointer(0, 3, gl.FLOAT, false, 0, 0);
  buffer(gl.ARRAY_BUFFER, knot.nor, gl.STATIC_DRAW);
  gl.enableVertexAttribArray(1);
  gl.vertexAttribPointer(1, 3, gl.FLOAT, false, 0, 0);
  var knotIndex = buffer(gl.ELEMENT_ARRAY_BUFFER, knot.idx, gl.STATIC_DRAW);
  var knotCount = knot.idx.length;

  var groundPos = new Float32Array([
    -20, -2, -20, 20, -2, -20, 20, -2, 20,
    -20, -2, -20, 20, -2, 20, -20, -2, 20,
  ]);
  var groundNor = new Float32Array([
    0, 1, 0, 0, 1, 0, 0, 1, 0,
    0, 1, 0, 0, 1, 0, 0, 1, 0,
  ]);
  var groundVAO = gl.createVertexArray();
  gl.bindVertexArray(groundVAO);
  buffer(gl.ARRAY_BUFFER, groundPos, gl.STATIC_DRAW);
  gl.enableVertexAttribArray(0);
  gl.vertexAttribPointer(0, 3, gl.FLOAT, false, 0, 0);
  buffer(gl.ARRAY_BUFFER, groundNor, gl.STATIC_DRAW);
  gl.enableVertexAttribArray(1);
  gl.vertexAttribPointer(1, 3, gl.FLOAT, false, 0, 0);

  var quad = new Float32Array([
    -1, -1, 0, 0,
    1, -1, 1, 0,
    -1, 1, 0, 1,
    -1, 1, 0, 1,
    1, -1, 1, 0,
    1, 1, 1, 1,
  ]);
  var quadVAO = gl.createVertexArray();
  gl.bindVertexArray(quadVAO);
  buffer(gl.ARRAY_BUFFER, quad, gl.STATIC_DRAW);
  gl.enableVertexAttribArray(0);
  gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 16, 0);
  gl.enableVertexAttribArray(1);
  gl.vertexAttribPointer(1, 2, gl.FLOAT, false, 16, 8);
  gl.bindVertexArray(null);

  var paperTex = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, paperTex);
  gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
  var paperSize = 256;
  var paperData = paperBytes(paperSize);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, paperSize, paperSize, 0, gl.RGBA, gl.UNSIGNED_BYTE, paperData);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.REPEAT);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.REPEAT);
  gl.generateMipmap(gl.TEXTURE_2D);
  paperData = null;

  function colorTex(w, h) {
    var tex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA16F, w, h, 0, gl.RGBA, gl.HALF_FLOAT, null);
    return tex;
  }

  function depthTex(w, h) {
    var tex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.DEPTH_COMPONENT24, w, h, 0, gl.DEPTH_COMPONENT, gl.UNSIGNED_INT, null);
    return tex;
  }

  function fboColor(tex, depth) {
    var fb = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
    if (depth) gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.DEPTH_ATTACHMENT, gl.TEXTURE_2D, depth, 0);
    var ok = gl.checkFramebufferStatus(gl.FRAMEBUFFER) === gl.FRAMEBUFFER_COMPLETE;
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    return ok ? fb : null;
  }

  var shadowDepth = depthTex(SHADOW, SHADOW);
  var shadowColor = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, shadowColor);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, SHADOW, SHADOW, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
  var shadowFbo = fboColor(shadowColor, shadowDepth);
  if (!shadowFbo) return;

  var lightView = lookAt([5, 8, 5], [0, 0, 0], [0, 1, 0]);
  var lightProj = ortho(-4, 4, -4, 4, 1, 20);
  var shadowMatrix = mul(BIAS, mul(lightProj, lightView));

  var scene = null;
  var viewW = 0;
  var viewH = 0;

  function allocScene(w, h) {
    if (scene) {
      gl.deleteFramebuffer(scene.sceneFbo);
      gl.deleteFramebuffer(scene.lineFbo);
      gl.deleteFramebuffer(scene.tensorFbo);
      gl.deleteFramebuffer(scene.paintFbo);
      gl.deleteTexture(scene.sceneColor);
      gl.deleteTexture(scene.sceneDepth);
      gl.deleteTexture(scene.lineColor);
      gl.deleteTexture(scene.tensorColor);
      gl.deleteTexture(scene.paintColor);
    }
    var ew = Math.max(1, w >> 1);
    var eh = Math.max(1, h >> 1);
    var sceneColor = colorTex(w, h);
    var sceneDepth = depthTex(w, h);
    var lineColor = colorTex(w, h);
    var tensorColor = colorTex(ew, eh);
    var paintColor = colorTex(ew, eh);
    var sceneFbo = fboColor(sceneColor, sceneDepth);
    var lineFbo = fboColor(lineColor, null);
    var tensorFbo = fboColor(tensorColor, null);
    var paintFbo = fboColor(paintColor, null);
    if (!sceneFbo || !lineFbo || !tensorFbo || !paintFbo) return false;
    gl.bindTexture(gl.TEXTURE_2D, paintColor);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    scene = {
      sceneFbo: sceneFbo,
      lineFbo: lineFbo,
      tensorFbo: tensorFbo,
      paintFbo: paintFbo,
      sceneColor: sceneColor,
      sceneDepth: sceneDepth,
      lineColor: lineColor,
      tensorColor: tensorColor,
      paintColor: paintColor,
    };
    return true;
  }

  function viewSize() {
    var w = canvas.clientWidth | 0;
    var h = canvas.clientHeight | 0;
    if (w < 2 || h < 2) {
      var r = stage.getBoundingClientRect();
      w = Math.round(r.width);
      h = Math.round(r.height);
    }
    if (w < 2 || h < 2) {
      w = window.innerWidth | 0;
      h = window.innerHeight | 0;
    }
    w = Math.max(1, w);
    h = Math.max(1, h);
    var cap = 390 * 900;
    if (w * h > cap) {
      var s = Math.sqrt(cap / (w * h));
      w = Math.max(1, Math.round(w * s));
      h = Math.max(1, Math.round(h * s));
    }
    return [w, h];
  }

  function fitDist(aspect) {
    var halfY = Math.tan(FOV * 0.5);
    var halfX = halfY * aspect;
    var distY = BOUND / halfY;
    var distX = BOUND / Math.max(halfX, 1e-3);
    return Math.max(BASE_DIST, distY, distX);
  }

  var theta = 0;
  var phi = PHI0;
  var userDist = null;
  var pointers = new Map();
  var pinch0 = 0;
  var dist0 = 0;

  function eyeAt(dist) {
    var sp = Math.sin(phi);
    return [
      dist * sp * Math.sin(theta),
      dist * Math.cos(phi),
      dist * sp * Math.cos(theta),
    ];
  }

  canvas.addEventListener("contextmenu", function (e) { e.preventDefault(); });
  canvas.addEventListener("pointerdown", function (e) {
    canvas.setPointerCapture(e.pointerId);
    pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pointers.size === 2) {
      var pts = Array.from(pointers.values());
      pinch0 = Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y) || 1;
      dist0 = userDist == null ? fitDist(viewW / Math.max(1, viewH)) : userDist;
    }
  });
  canvas.addEventListener("pointermove", function (e) {
    var prev = pointers.get(e.pointerId);
    if (!prev) return;
    var dx = e.clientX - prev.x;
    var dy = e.clientY - prev.y;
    prev.x = e.clientX;
    prev.y = e.clientY;
    if (pointers.size === 1) {
      theta -= dx * 0.005;
      phi = Math.max(0.35, Math.min(1.45, phi + dy * 0.004));
    } else if (pointers.size >= 2) {
      var pts = Array.from(pointers.values());
      var pinch = Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y) || 1;
      var fit = fitDist(viewW / Math.max(1, viewH));
      userDist = Math.min(16, Math.max(fit, dist0 * (pinch0 / pinch)));
    }
  });
  function endPointer(e) {
    pointers.delete(e.pointerId);
    if (pointers.size < 2) pinch0 = 0;
  }
  canvas.addEventListener("pointerup", endPointer);
  canvas.addEventListener("pointercancel", endPointer);

  function uni(prog, name) { return gl.getUniformLocation(prog, name); }

  function drawQuad(prog) {
    gl.useProgram(prog);
    gl.bindVertexArray(quadVAO);
    gl.drawArrays(gl.TRIANGLES, 0, 6);
  }

  function bindTex(unit, tex) {
    gl.activeTexture(gl.TEXTURE0 + unit);
    gl.bindTexture(gl.TEXTURE_2D, tex);
  }

  var sent = false;
  function signalReady() {
    if (sent) return;
    var gb = window.__gbSandbox;
    if (gb && typeof gb.ready === "function") {
      sent = true;
      gb.ready();
    }
  }

  var gpuFence = null;
  function gpuBusy() {
    if (!gpuFence) return false;
    var st = gl.clientWaitSync(gpuFence, 0, 0);
    if (st === gl.ALREADY_SIGNALED || st === gl.CONDITION_SATISFIED) {
      gl.deleteSync(gpuFence);
      gpuFence = null;
      return false;
    }
    return true;
  }

  var pendingDt = 0;
  function render(dt) {
    pendingDt += dt;
    if (gpuBusy()) return;
    var size = viewSize();
    var w = size[0];
    var h = size[1];
    var ew = Math.max(1, w >> 1);
    var eh = Math.max(1, h >> 1);
    if (w !== viewW || h !== viewH) {
      canvas.width = w;
      canvas.height = h;
      if (!allocScene(w, h)) return;
      viewW = w;
      viewH = h;
    }
    var step = pendingDt;
    pendingDt = 0;
    if (!pointers.size) theta += step * AUTO;
    var aspect = w / Math.max(1, h);
    var dist = userDist == null ? fitDist(aspect) : Math.min(16, Math.max(fitDist(aspect), userDist));
    var eye = eyeAt(dist);
    var view = lookAt(eye, [0, 0, 0], [0, 1, 0]);
    var proj = perspective(FOV, aspect, NEAR, FAR);
    var mvp = mul(proj, view);

    gl.bindFramebuffer(gl.FRAMEBUFFER, shadowFbo);
    gl.viewport(0, 0, SHADOW, SHADOW);
    gl.enable(gl.DEPTH_TEST);
    gl.enable(gl.CULL_FACE);
    gl.cullFace(gl.BACK);
    gl.enable(gl.POLYGON_OFFSET_FILL);
    gl.polygonOffset(2.0, 4.0);
    gl.colorMask(false, false, false, false);
    gl.clear(gl.DEPTH_BUFFER_BIT);
    gl.useProgram(shadowProg);
    gl.uniformMatrix4fv(uni(shadowProg, "uMvp"), false, mul(lightProj, lightView));
    gl.bindVertexArray(knotVAO);
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, knotIndex);
    gl.drawElements(gl.TRIANGLES, knotCount, gl.UNSIGNED_SHORT, 0);
    gl.disable(gl.POLYGON_OFFSET_FILL);
    gl.colorMask(true, true, true, true);

    gl.bindFramebuffer(gl.FRAMEBUFFER, scene.sceneFbo);
    gl.viewport(0, 0, w, h);
    gl.clearColor(BACKDROP[0], BACKDROP[1], BACKDROP[2], 1);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
    gl.disable(gl.CULL_FACE);
    gl.depthMask(false);
    gl.useProgram(groundProg);
    gl.uniformMatrix4fv(uni(groundProg, "uMvp"), false, mvp);
    gl.uniform3fv(uni(groundProg, "uBackdrop"), BACKDROP);
    gl.uniform1f(uni(groundProg, "uOpacity"), 0.28);
    gl.uniformMatrix4fv(uni(groundProg, "uShadowMatrix"), false, shadowMatrix);
    gl.uniform1f(uni(groundProg, "uShadowTexel"), 1 / SHADOW);
    bindTex(0, shadowDepth);
    gl.uniform1i(uni(groundProg, "uShadowMap"), 0);
    gl.bindVertexArray(groundVAO);
    gl.drawArrays(gl.TRIANGLES, 0, 6);
    gl.depthMask(true);
    gl.enable(gl.CULL_FACE);
    gl.useProgram(knotProg);
    gl.uniformMatrix4fv(uni(knotProg, "uMvp"), false, mvp);
    gl.uniform3fv(uni(knotProg, "uEye"), eye);
    gl.uniform3fv(uni(knotProg, "uKeyDir"), KEY_DIR);
    gl.uniform3fv(uni(knotProg, "uFillDir"), FILL_DIR);
    gl.uniform3fv(uni(knotProg, "uKeyColor"), KEY);
    gl.uniform3fv(uni(knotProg, "uFillColor"), FILL_COL);
    gl.uniform3fv(uni(knotProg, "uAmbient"), AMBIENT);
    gl.uniform3fv(uni(knotProg, "uAlbedo"), ALBEDO);
    gl.uniform1f(uni(knotProg, "uRoughness"), 0.56);
    gl.uniform1f(uni(knotProg, "uMetalness"), 0.1);
    gl.uniformMatrix4fv(uni(knotProg, "uShadowMatrix"), false, shadowMatrix);
    gl.uniform1f(uni(knotProg, "uShadowTexel"), 1 / SHADOW);
    gl.uniform1i(uni(knotProg, "uShadowMap"), 0);
    gl.bindVertexArray(knotVAO);
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, knotIndex);
    gl.drawElements(gl.TRIANGLES, knotCount, gl.UNSIGNED_SHORT, 0);

    gl.disable(gl.DEPTH_TEST);
    gl.disable(gl.CULL_FACE);
    gl.bindFramebuffer(gl.FRAMEBUFFER, scene.lineFbo);
    gl.useProgram(outlineProg);
    bindTex(0, scene.sceneColor);
    bindTex(1, scene.sceneDepth);
    gl.uniform1i(uni(outlineProg, "uColor"), 0);
    gl.uniform1i(uni(outlineProg, "uDepth"), 1);
    gl.viewport(0, 0, w, h);
    gl.uniform2f(uni(outlineProg, "uTexel"), 1 / w, 1 / h);
    gl.uniform3fv(uni(outlineProg, "uInk"), INK);
    gl.uniform1f(uni(outlineProg, "uStrength"), 0.93);
    gl.uniform1f(uni(outlineProg, "uThickness"), 3.8);
    gl.uniform1f(uni(outlineProg, "uThreshold"), 0.97);
    gl.uniform1f(uni(outlineProg, "uSoftness"), 0.79);
    gl.uniform1f(uni(outlineProg, "uNear"), NEAR);
    gl.uniform1f(uni(outlineProg, "uFar"), FAR);
    drawQuad(outlineProg);

    gl.bindFramebuffer(gl.FRAMEBUFFER, scene.tensorFbo);
    gl.viewport(0, 0, ew, eh);
    gl.useProgram(tensorProg);
    bindTex(0, scene.lineColor);
    gl.uniform1i(uni(tensorProg, "uInput"), 0);
    gl.uniform2f(uni(tensorProg, "uResolution"), w, h);
    drawQuad(tensorProg);

    gl.bindFramebuffer(gl.FRAMEBUFFER, scene.paintFbo);
    gl.viewport(0, 0, ew, eh);
    gl.useProgram(kuwaharaProg);
    bindTex(0, scene.tensorColor);
    bindTex(1, scene.lineColor);
    bindTex(2, scene.sceneDepth);
    gl.uniform1i(uni(kuwaharaProg, "uTensor"), 0);
    gl.uniform1i(uni(kuwaharaProg, "uColor"), 1);
    gl.uniform1i(uni(kuwaharaProg, "uDepth"), 2);
    gl.uniform2f(uni(kuwaharaProg, "uResolution"), ew, eh);
    gl.uniform1f(uni(kuwaharaProg, "uRadius"), RADIUS * ew / w);
    gl.uniform1f(uni(kuwaharaProg, "uAlpha"), 4.0);
    gl.uniform1f(uni(kuwaharaProg, "uEta"), 0.36);
    gl.uniform1f(uni(kuwaharaProg, "uLambda"), 0.5);
    drawQuad(kuwaharaProg);

    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, w, h);
    gl.useProgram(waterProg);
    bindTex(0, scene.paintColor);
    bindTex(1, paperTex);
    gl.uniform1i(uni(waterProg, "uColor"), 0);
    gl.uniform1i(uni(waterProg, "uPaper"), 1);
    gl.uniform1f(uni(waterProg, "uAspect"), aspect);
    gl.uniform1f(uni(waterProg, "uPaperStrength"), 0.47);
    gl.uniform1f(uni(waterProg, "uPaperScale"), 3.55);
    gl.uniform1f(uni(waterProg, "uSteps"), 33);
    gl.uniform1f(uni(waterProg, "uQuantLow"), 0.21);
    gl.uniform1f(uni(waterProg, "uQuantHigh"), 0.86);
    gl.uniform3fv(uni(waterProg, "uShadowTint"), TINT);
    gl.uniform1f(uni(waterProg, "uSaturation"), 1.0);
    gl.uniform1f(uni(waterProg, "uMix"), 0.72);
    drawQuad(waterProg);
    if (gl.fenceSync) {
      gpuFence = gl.fenceSync(gl.SYNC_GPU_COMMANDS_COMPLETE, 0);
      gl.flush();
    }
    signalReady();
  }

  // Software GL presents the brush on the main thread and blows the
  // publish sentinel. A phone GPU does not, so it still paints every frame.
  var software = false;
  var dbg = gl.getExtension("WEBGL_debug_renderer_info");
  if (dbg) {
    var gpuName = String(gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL) || "");
    software = /swiftshader|llvmpipe|softpipe|software/i.test(gpuName);
  }
  var lastWall = 0;
  var pending = 0;
  var nextDraw = 0;
  function loop() {
    requestAnimationFrame(loop);
    var wall = performance.now();
    var gap = lastWall ? wall - lastWall : 0;
    lastWall = wall;
    var dt = gap / 1000;
    if (dt > 0.05) dt = 0.05;
    pending += dt;
    if (software && wall < nextDraw) return;
    var step = pending;
    if (!software && step > 0.05) step = 0.05;
    pending = 0;
    render(step);
    if (software) nextDraw = performance.now() + 1400;
  }

  var spin = document.createElement("style");
  spin.textContent = "@keyframes gbspin{to{transform:rotate(360deg)}}";
  document.head.appendChild(spin);
  var dot = document.createElement("div");
  dot.setAttribute("aria-hidden", "true");
  dot.style.cssText = "position:fixed;left:0;top:0;width:1px;height:1px;opacity:0;pointer-events:none;animation:gbspin 1.2s linear infinite";
  document.body.appendChild(dot);

  if (software) nextDraw = performance.now() + 1400;
  render(0);
  requestAnimationFrame(loop);
})();
