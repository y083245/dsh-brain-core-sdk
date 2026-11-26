uniform sampler2D uVelocity;
uniform sampler2D uCurl;
uniform vec2 uTexelSize;
uniform float uCurlStrength;
uniform float uDt;
in vec2 vUv;
out vec4 outColor;

void main() {
  float L = texture(uCurl, vUv - vec2(uTexelSize.x, 0.0)).x;
  float R = texture(uCurl, vUv + vec2(uTexelSize.x, 0.0)).x;
  float T = texture(uCurl, vUv + vec2(0.0, uTexelSize.y)).x;
  float B = texture(uCurl, vUv - vec2(0.0, uTexelSize.y)).x;
  float C = texture(uCurl, vUv).x;

  vec2 force = 0.5 * vec2(abs(T) - abs(B), abs(L) - abs(R));
  force /= length(force) + 0.0001;
  force *= uCurlStrength * C;

  vec2 velocity = texture(uVelocity, vUv).xy + force * uDt;
  velocity = clamp(velocity, vec2(-1000.0), vec2(1000.0));
  outColor = vec4(velocity, 0.0, 1.0);
}
