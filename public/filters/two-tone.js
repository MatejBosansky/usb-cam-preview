export default {
  apiVersion: 1,
  id: 'two-tone',
  name: 'Two-tone',
  description: 'Pure black and white, split at a brightness level. Good for reading text and edges of parts.',
  params: [
    { id: 'level', name: 'Level', min: 0.05, max: 0.95, step: 0.01, default: 0.5, format: 'percent' },
  ],
  glsl: `
vec3 applyFilter(vec2 uv, vec3 color) {
  return vec3(step(p_level, luma(color)));
}`,
};
