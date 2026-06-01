export const shaderSources = {
  vertex: `#version 300 es
precision highp float;

in vec3 a_position;
in vec3 a_normal;
in vec3 a_vertex_color;
in vec3 a_material_color;

uniform mat4 u_matrix;
uniform int u_color_mode;
uniform bool u_lighting_enabled;

out vec3 v_color;
out vec3 v_normal;

void main() {
  gl_Position = u_matrix * vec4(a_position, 1.0);
  v_color = u_color_mode == 0 ? a_vertex_color : a_material_color;
  v_normal = normalize(a_normal);
}
`,

  fragment: `#version 300 es
precision highp float;

in vec3 v_color;
in vec3 v_normal;

uniform bool u_lighting_enabled;

out vec4 outColor;

void main() {
  vec3 lightDirection = normalize(vec3(0.35, 0.82, 0.45));
  float diffuse = max(dot(normalize(v_normal), lightDirection), 0.0);
  float light = u_lighting_enabled ? 0.32 + diffuse * 0.78 : 1.0;
  vec3 color = v_color * light;

  outColor = vec4(color, 1.0);
}
`,
};
