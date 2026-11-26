uniform sampler2D uVelocity;
uniform sampler2D uSource;
uniform vec2 uTexelSize;
uniform float uDt;
uniform float uDissipation;
in vec2 vUv;
out vec4 outColor;

void main() {
  vec2 coord = vUv - uDt * texture(uVelocity, vUv).xy * uTexelSize;
  vec4 result = texture(uSource, coord);
  outColor = result * uDissipation;
}
