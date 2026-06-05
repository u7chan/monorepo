export const shaderSources = {
  vertex: `#version 300 es
precision highp float;

in vec3 a_position;
in vec3 a_normal;
in vec3 a_vertex_color;
in vec3 a_material_color;
in vec2 a_texcoord;

uniform mat4 u_matrix;
uniform int u_color_mode;
uniform vec3 u_solid_color;
uniform bool u_lighting_enabled;

out vec3 v_color;
out vec3 v_normal;
out vec2 v_texcoord;

void main() {
  gl_Position = u_matrix * vec4(a_position, 1.0);
  v_color = u_color_mode == 0
    ? a_vertex_color
    : u_color_mode == 1
      ? a_material_color
      : u_solid_color;
  v_normal = normalize(a_normal);
  v_texcoord = a_texcoord;
}
`,

  fragment: `#version 300 es
precision highp float;

in vec3 v_color;
in vec3 v_normal;
in vec2 v_texcoord;

uniform bool u_lighting_enabled;
uniform bool u_texture_enabled;
uniform sampler2D u_base_color_texture;

out vec4 outColor;

void main() {
  vec3 lightDirection = normalize(vec3(0.35, 0.82, 0.45));
  float diffuse = max(dot(normalize(v_normal), lightDirection), 0.0);
  float light = u_lighting_enabled ? 0.32 + diffuse * 0.78 : 1.0;
  vec3 baseColor = u_texture_enabled
    ? texture(u_base_color_texture, v_texcoord).rgb * v_color
    : v_color;
  vec3 color = baseColor * light;

  outColor = vec4(color, 1.0);
}
`,
};
