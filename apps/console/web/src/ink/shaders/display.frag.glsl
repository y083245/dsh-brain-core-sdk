uniform sampler2D uDye;
uniform sampler2D uPaperFiber;
uniform vec2 uResolution;
uniform float uTime;
uniform float uThemeMix; // 0.0 = night, 1.0 = paper

uniform vec3 uNightVoid;
uniform vec3 uNightSmoke;
uniform vec3 uNightZhusha;

uniform vec3 uPaperVoid;
uniform vec3 uPaperSmoke;
uniform vec3 uPaperZhusha;

in vec2 vUv;
out vec4 outColor;

// 夜墨：发光的烟。底色 --ink-void，墨是自发光的 --smoke，朱砂墨是 --zhusha
vec3 night(vec2 uv, vec3 ink) {
  vec3 uVoid = uNightVoid;
  vec3 uSmoke = uNightSmoke;
  vec3 uZhusha = uNightZhusha;
  vec3 base = uVoid;                                   // night --ink-void
  float smoke = 1.0 - exp(-ink.r * 1.6);               // 浓度到亮度的软饱和，防止过曝
  float cinnabar = 1.0 - exp(-ink.g * 2.2);
  vec3 col = base + uSmoke * smoke * 0.85;             // 骨白烟
  col = mix(col, uZhusha, cinnabar * 0.9);             // 朱砂烟盖在上面
  col += uZhusha * cinnabar * cinnabar * 0.35;         // 朱砂浓处的辉光
  col *= 1.0 - 0.45 * length(uv - 0.5);                // 暗角
  col += (hash(uv * uResolution + uTime) - 0.5) / 255.0 * 2.0; // 抖动防色带
  return col;
}

// 宣纸：真实的墨。底色 --ink-void（纸色），墨是吸收光的 --smoke（近黑）
vec3 paper(vec2 uv, vec3 ink) {
  vec3 uVoid = uPaperVoid;
  vec3 uSmoke = uPaperSmoke;
  vec3 uZhusha = uPaperZhusha;
  vec3 base = uVoid;                                   // paper --ink-void
  float density = 1.0 - exp(-ink.r * 1.9);
  float cinnabar = 1.0 - exp(-ink.g * 2.0);
  float fiber = texture(uPaperFiber, uv * uResolution / 256.0).r; // 纸纤维，见附录 C.5
  density *= mix(0.82, 1.0, fiber);                    // 墨在纤维上的不均匀吸附
  vec3 col = mix(base, uSmoke, density * 0.88);
  col = mix(col, uZhusha, cinnabar * 0.85);
  // 墨的边缘更深（真实墨晕的「水线」）：用浓度的梯度加深边缘
  float edge = clamp(length(vec2(dFdx(ink.r), dFdy(ink.r))) * 40.0, 0.0, 1.0);
  col = mix(col, uSmoke, edge * 0.25);
  return col;
}

void main() {
  vec3 ink = max(texture(uDye, vUv).rgb, vec3(0.0));
  vec3 col;
  if (uThemeMix <= 0.001) {
    col = night(vUv, ink);
  } else if (uThemeMix >= 0.999) {
    col = paper(vUv, ink);
  } else {
    col = mix(night(vUv, ink), paper(vUv, ink), uThemeMix);
  }
  outColor = vec4(col, 1.0);
}
