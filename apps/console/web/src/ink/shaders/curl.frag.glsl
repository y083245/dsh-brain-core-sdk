uniform sampler2D uVelocity;
uniform vec2 uTexelSize;
in vec2 vUv;
out vec4 outColor;

void main() {
  float L = texture(uVelocity, vUv - vec2(uTexelSize.x, 0.0)).y;
  float R = texture(uVelocity, vUv + vec2(uTexelSize.x, 0.0)).y;
  float T = texture(uVelocity, vUv + vec2(0.0, uTexelSize.y)).x;
  float B = texture(uVelocity, vUv - vec2(0.0, uTexelSize.y)).x;
  float vorticity = 0.5 * ((R - L) - (T - B));
  outColor = vec4(vorticity, 0.0, 0.0, 1.0);
}
