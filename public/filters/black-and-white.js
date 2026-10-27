export default {
  apiVersion: 1,
  id: 'black-and-white',
  name: 'Black & white',
  description: 'Grey tones only.',
  glsl: `
vec3 applyFilter(vec2 uv, vec3 color) {
  return vec3(luma(color));
}`,
};
