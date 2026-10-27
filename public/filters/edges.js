export default {
  apiVersion: 1,
  id: 'edges',
  name: 'Edges',
  description: 'Outlines only (Sobel edge detection). Shows cracks, scratches and the shape of parts.',
  params: [
    { id: 'strength', name: 'Strength', min: 0.5, max: 5, step: 0.1, default: 1 },
  ],
  glsl: `
float lumAt(vec2 uv) { return luma(src(uv)); }

vec3 applyFilter(vec2 uv, vec3 color) {
  vec2 t = u_texel;
  float tl = lumAt(uv + vec2(-t.x, -t.y));
  float tc = lumAt(uv + vec2(0.0, -t.y));
  float tr = lumAt(uv + vec2(t.x, -t.y));
  float ml = lumAt(uv + vec2(-t.x, 0.0));
  float mr = lumAt(uv + vec2(t.x, 0.0));
  float bl = lumAt(uv + vec2(-t.x, t.y));
  float bc = lumAt(uv + vec2(0.0, t.y));
  float br = lumAt(uv + vec2(t.x, t.y));
  float gx = -tl - 2.0 * ml - bl + tr + 2.0 * mr + br;
  float gy = -tl - 2.0 * tc - tr + bl + 2.0 * bc + br;
  return vec3(length(vec2(gx, gy)) * p_strength);
}`,
};
