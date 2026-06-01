"use strict";

window.shaderSources = {
  vertex: `#version 300 es
precision highp float;

in vec3 a_position;
in vec3 a_color;

uniform float u_time;
uniform vec2 u_resolution;

out vec3 v_color;
out float v_wave;

void main() {
  vec3 pos = a_position;

  float wave = sin((pos.x * 5.0) + u_time * 2.0) * 0.08;
  pos.y += wave;

  float aspect = u_resolution.x / u_resolution.y;
  pos.x /= aspect;

  gl_Position = vec4(pos, 1.0);
  v_color = a_color;
  v_wave = wave;
}
`,

  fragment: `#version 300 es
precision highp float;

in vec3 v_color;
in float v_wave;

uniform float u_time;

out vec4 outColor;

void main() {
  float pulse = 0.65 + 0.35 * sin(u_time + v_wave * 18.0);
  vec3 color = v_color * pulse;
  outColor = vec4(color, 1.0);
}
`,
};
