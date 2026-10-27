export default {
  apiVersion: 1,
  id: 'negative',
  name: 'Negative',
  description: 'Inverted colours.',
  glsl: `
vec3 applyFilter(vec2 uv, vec3 color) {
  return 1.0 - color;
}`,
};
