uniform vec2 uOrigin;     // 点击位置 0..1
uniform float uProgress;  // 0..1
uniform float uAspect;
uniform vec3 uColor;      // 夜墨是 --smoke 的 0.9 倍亮度，宣纸是 --smoke
uniform sampler2D uScene;
uniform float uCoverBoost; // 0..1 full-screen cover guarantee during 300-600ms
in vec2 vUv;
out vec4 outColor;
void main() {
  vec2 d = vUv - uOrigin; d.x *= uAspect;
  vec2 dir = length(d) > 1e-5 ? normalize(d) : vec2(1.0, 0.0);
  float edge = uProgress * 1.6;                                   // 覆盖到屏幕对角线
  float ragged = edge + (fbm(dir * 3.0 + uProgress * 2.0) - 0.5) * 0.18; // 毛边
  float cover = 1.0 - smoothstep(ragged - 0.05, ragged, length(d));
  cover = max(cover, uCoverBoost);
  outColor = vec4(mix(texture(uScene, vUv).rgb, uColor, cover), 1.0);
}
