// Draws the camera image into a WebGL canvas: colour adjustments, the selected filter
// (public/filters/), rotation, mirroring and zoom. Photos and recordings are taken from the same
// canvas, so they look exactly like the preview.

export const DEFAULT_ADJUST = { brightness: 0, contrast: 1, saturation: 1, hue: 0, gamma: 1 };
export const DEFAULT_VIEW = { rotate: 0, mirror: false, zoom: 1, panX: 0, panY: 0 };

const VERTEX = `
attribute vec2 a_pos;
uniform mat2 u_m;
uniform vec2 u_off;
varying vec2 v_uv;
void main() {
  vec2 o = vec2(a_pos.x * 0.5 + 0.5, 0.5 - a_pos.y * 0.5);
  v_uv = u_m * (o - 0.5) + u_off;
  gl_Position = vec4(a_pos, 0.0, 1.0);
}`;

// Everything a filter's GLSL can use: luma(), src() (the adjusted source pixel at any uv),
// u_texel (one source pixel in uv units) and its own p_<param> uniforms.
const FRAGMENT_HEAD = `
#ifdef GL_FRAGMENT_PRECISION_HIGH
precision highp float;
#else
precision mediump float;
#endif
uniform sampler2D u_tex;
uniform vec2 u_texel;
uniform float u_brightness;
uniform float u_contrast;
uniform float u_saturation;
uniform float u_hue;
uniform float u_gamma;
varying vec2 v_uv;

float luma(vec3 c) { return dot(c, vec3(0.2126, 0.7152, 0.0722)); }

vec3 adjust(vec3 c) {
  c = pow(max(c, vec3(0.0)), vec3(1.0 / u_gamma));
  c += u_brightness;
  c = (c - 0.5) * u_contrast + 0.5;
  c = mix(vec3(luma(c)), c, u_saturation);
  if (u_hue != 0.0) {
    vec3 k = vec3(0.57735);
    float ca = cos(u_hue);
    c = c * ca + cross(k, c) * sin(u_hue) + k * dot(k, c) * (1.0 - ca);
  }
  return clamp(c, 0.0, 1.0);
}

vec3 src(vec2 uv) { return adjust(texture2D(u_tex, uv).rgb); }
`;

const FRAGMENT_MAIN = `
void main() {
  if (v_uv.x < 0.0 || v_uv.x > 1.0 || v_uv.y < 0.0 || v_uv.y > 1.0) {
    gl_FragColor = vec4(0.0, 0.0, 0.0, 1.0);
    return;
  }
  gl_FragColor = vec4(clamp(applyFilter(v_uv, src(v_uv)), 0.0, 1.0), 1.0);
}`;

/** "Original": no filter. */
const NO_FILTER = { id: '', params: [], glsl: 'vec3 applyFilter(vec2 uv, vec3 color) { return color; }' };

export function fragmentSource(filter) {
  const uniforms = (filter.params || []).map((p) => `uniform float p_${p.id};`).join('\n');
  return `${FRAGMENT_HEAD}\n${uniforms}\n${filter.glsl}\n${FRAGMENT_MAIN}`;
}

function compile(gl, type, source) {
  const shader = gl.createShader(type);
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    const log = gl.getShaderInfoLog(shader);
    gl.deleteShader(shader);
    throw new Error(log);
  }
  return shader;
}

/**
 * Maps output coordinates (centred, y down) to source texture coordinates:
 * the view is mirror(rotate(source)), so we undo the mirror, then the rotation, then zoom.
 * Returns the 2x2 matrix [[a, b], [c, d]].
 */
export function uvMatrix({ rotate = 0, mirror = false, zoom = 1 }) {
  let a = mirror ? -1 : 1, b = 0, c = 0, d = 1;
  const turns = (((rotate / 90) % 4) + 4) % 4;
  for (let k = 0; k < turns; k++) [a, b, c, d] = [c, d, -a, -b];
  const s = 1 / zoom;
  return { a: a * s, b: b * s, c: c * s, d: d * s };
}

export class Renderer {
  constructor(canvas) {
    const gl = canvas.getContext('webgl', { preserveDrawingBuffer: true, antialias: false, alpha: false });
    if (!gl) throw new Error('WebGL is not available');
    this.canvas = canvas;
    this.gl = gl;
    this.vertexShader = compile(gl, gl.VERTEX_SHADER, VERTEX);
    this.programs = new Map();

    gl.bindBuffer(gl.ARRAY_BUFFER, gl.createBuffer());
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);

    this.texture = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, this.texture);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);

    this.srcW = 0;
    this.srcH = 0;
    this.hasFrame = false;
    this.params = { ...DEFAULT_ADJUST };
    this.filter = NO_FILTER;
    this.filterValues = {};
    this.view = { ...DEFAULT_VIEW };
    this.program(NO_FILTER);
  }

  /** Compiles (once) the program for a filter. Throws with the GLSL error log if it does not compile. */
  program(filter) {
    const key = filter.id;
    if (this.programs.has(key)) return this.programs.get(key);
    const gl = this.gl;
    const fragment = compile(gl, gl.FRAGMENT_SHADER, fragmentSource(filter));
    const program = gl.createProgram();
    gl.attachShader(program, this.vertexShader);
    gl.attachShader(program, fragment);
    gl.bindAttribLocation(program, 0, 'a_pos');
    gl.linkProgram(program);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(program));
    const names = ['u_m', 'u_off', 'u_tex', 'u_texel', 'u_brightness', 'u_contrast', 'u_saturation', 'u_hue', 'u_gamma', ...(filter.params || []).map((p) => `p_${p.id}`)];
    const u = Object.fromEntries(names.map((n) => [n, gl.getUniformLocation(program, n)]));
    gl.useProgram(program);
    gl.uniform1i(u.u_tex, 0);
    const entry = { program, u, params: filter.params || [] };
    this.programs.set(key, entry);
    return entry;
  }

  /** Switches to a filter module (null for none). Throws if its GLSL does not compile. */
  setFilter(filter) {
    const next = filter || NO_FILTER;
    this.program(next);
    this.filter = next;
  }

  /**
   * Copies a video frame (or an ImageData / canvas, e.g. a driver's processed image) into the
   * texture. Returns false while there is no frame yet.
   */
  upload(source) {
    const isVideo = source instanceof HTMLVideoElement;
    const w = isVideo ? source.videoWidth : source.width;
    const h = isVideo ? source.videoHeight : source.height;
    if (!w || !h || (isVideo && source.readyState < 2)) return false;
    const gl = this.gl;
    gl.bindTexture(gl.TEXTURE_2D, this.texture);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, source);
    this.srcW = w;
    this.srcH = h;
    this.hasFrame = true;
    return true;
  }

  get outputSize() {
    return this.view.rotate % 180 ? [this.srcH, this.srcW] : [this.srcW, this.srcH];
  }

  /** neutral: no adjustments and no filter (for "unfiltered" photos and recordings). */
  draw({ neutral = false } = {}) {
    if (!this.hasFrame) return;
    const gl = this.gl;
    const [w, h] = this.outputSize;
    if (this.canvas.width !== w || this.canvas.height !== h) {
      this.canvas.width = w;
      this.canvas.height = h;
    }
    gl.viewport(0, 0, w, h);
    const { program, u, params } = this.program(neutral ? NO_FILTER : this.filter);
    gl.useProgram(program);
    const m = uvMatrix(this.view);
    gl.uniformMatrix2fv(u.u_m, false, [m.a, m.c, m.b, m.d]);
    gl.uniform2f(u.u_off, 0.5 + this.view.panX, 0.5 + this.view.panY);
    gl.uniform2f(u.u_texel, 1 / this.srcW, 1 / this.srcH);
    const adj = neutral ? DEFAULT_ADJUST : this.params;
    gl.uniform1f(u.u_brightness, adj.brightness);
    gl.uniform1f(u.u_contrast, adj.contrast);
    gl.uniform1f(u.u_saturation, adj.saturation);
    gl.uniform1f(u.u_hue, (adj.hue * Math.PI) / 180);
    gl.uniform1f(u.u_gamma, adj.gamma);
    for (const p of params) gl.uniform1f(u[`p_${p.id}`], this.filterValues[p.id] ?? p.default);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
  }
}
