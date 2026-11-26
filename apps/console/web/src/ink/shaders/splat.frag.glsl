uniform sampler2D uTarget;
uniform vec2 uPoint;      // 0..1
uniform vec3 uValue;      // 速度场：(dx, dy, 0)；墨场：(smoke, zhusha, 0) * amount
uniform float uRadius;    // 归一化半径
uniform float uAspect;
uniform float uSeed;
in vec2 vUv;
out vec4 outColor;
void main() {
  vec2 d = vUv - uPoint; d.x *= uAspect;
  float r = uRadius * (0.85 + 0.3 * fbm(d * 18.0 + uSeed));   // 不规则的边缘
  float w = exp(-dot(d, d) / (r * r));
  outColor = vec4(texture(uTarget, vUv).rgb + uValue * w, 1.0);
}
