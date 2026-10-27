export default {
  apiVersion: 1,
  id: 'sepia',
  name: 'Sepia',
  description: 'Warm brown tones, like an old photograph.',
  glsl: `
vec3 applyFilter(vec2 uv, vec3 color) {
  return vec3(
    dot(color, vec3(0.393, 0.769, 0.189)),
    dot(color, vec3(0.349, 0.686, 0.168)),
    dot(color, vec3(0.272, 0.534, 0.131)));
}`,
};
