"use strict";

window.shaderSources = {
  vertex: `#version 300 es
precision highp float;

in vec3 a_position;
in vec3 a_color;

uniform float u_time;
uniform mat4 u_matrix;
uniform float u_wave_strength;

out vec3 v_color;
out float v_wave;

void main() {
  vec3 pos = a_position;

  float wave = sin((pos.x * 5.0) + u_time * 2.0) * u_wave_strength;
  pos.y += wave;

  gl_Position = u_matrix * vec4(pos, 1.0);
  v_color = a_color;
  v_wave = wave;
}
`,

  fragment: `#version 300 es
precision highp float;

in vec3 v_color;
in float v_wave;

uniform float u_time;
uniform float u_pulse_strength;

out vec4 outColor;

void main() {
  float animatedPulse = 0.65 + 0.35 * sin(u_time + v_wave * 18.0);
  float pulse = mix(1.0, animatedPulse, u_pulse_strength);
  vec3 color = v_color * pulse;
  outColor = vec4(color, 1.0);
}
`,
};
