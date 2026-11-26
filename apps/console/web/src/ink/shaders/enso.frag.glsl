uniform float uTime;
uniform float uGap;
uniform float uWobble;
uniform float uWidthScale;
uniform float uScale;
uniform float uPadFactor;
uniform float uBrushIn;
uniform float uThemeMix;
uniform float uSpeakingAmount;
uniform float uErrorAmount;
uniform float uNightStrokeAlpha;
uniform float uPaperStrokeAlpha;

uniform vec3 uNightStroke;
uniform vec3 uNightGlow;
uniform float uNightGlowAlpha;
uniform vec3 uPaperStroke;
uniform vec3 uPaperZhusha;
uniform vec3 uNightYanzhi;
uniform vec3 uPaperYanzhi;

in vec2 vUv;
out vec4 outColor;

// p: 以圆相中心为原点、半径归一化到 1 的坐标
float enso(vec2 p, float t, float gap, float wobble) {
  float a = atan(p.y, p.x);                       // -pi..pi
  float u = fract((a / 6.28318) + 0.5 + t * 0.03); // 沿圆周的位置 0..1，缓慢旋转
  if (u < gap) return 1e3;                         // 起笔和收笔之间的断口
  float pressure = smoothstep(gap, gap + 0.08, u) * (1.0 - smoothstep(0.86, 1.0, u)); // 起笔渐粗，收笔渐细
  float r = 0.78 + wobble * (fbm(vec2(a * 2.0, t * 0.2)) - 0.5) * 0.06; // 手抖
  float width = mix(0.03, 0.14, pressure) * uWidthScale;
  float dryBrush = fbm(vec2(u * 40.0, length(p) * 30.0));            // 飞白
  float d = abs(length(p) - r) - width;
  return d + smoothstep(0.55, 0.85, dryBrush) * width * 0.9 * (1.0 - pressure); // 收笔处有飞白
}

void main() {
  vec2 p = (vUv * 2.0 - 1.0) * (uPadFactor / max(uScale, 0.01));
  float a = atan(p.y, p.x);
  float u = fract((a / 6.28318) + 0.5 + uTime * 0.03);

  // Continuous pixel-scale AA width (NEVER call fwidth(d) across the u < gap discontinuity)
  float aa = max(fwidth(length(p)) * 1.25, 0.008);

  float d = enso(p, uTime, uGap, uWobble);

  // Smooth brush start/end tip caps so there is zero radial seam at u = uGap or u = 1.0
  float startCap = smoothstep(uGap, min(uGap + 0.018, 0.999), u);
  float endCap = 1.0 - smoothstep(0.982, 1.0, u);
  float tipMask = startCap * endCap;

  // Brush-in reveal arc (0..1)
  float brushMask = 1.0;
  if (uBrushIn < 0.999) {
    float arcEnd = mix(uGap, 1.0, clamp(uBrushIn, 0.0, 1.0));
    brushMask = smoothstep(arcEnd + 0.018, arcEnd - 0.012, u);
  }

  // Error state crimson crack across the ring
  float crackCut = 0.0;
  float crackEdge = 0.0;
  if (uErrorAmount > 0.001 && d < 100.0) {
    float crackJitter = (fbm(vec2(length(p) * 14.0, a * 6.0)) - 0.5) * 0.035;
    float crackDist = abs(u - (0.52 + crackJitter));
    crackCut = (1.0 - smoothstep(0.007 * uErrorAmount, 0.020 * uErrorAmount, crackDist)) * uErrorAmount;
    crackEdge = (1.0 - smoothstep(0.014 * uErrorAmount, 0.048 * uErrorAmount, crackDist)) * uErrorAmount;
    d = mix(d, 0.08, crackCut);
  }

  float rawStroke = d < 100.0 ? (1.0 - smoothstep(-aa, aa, d)) : 0.0;
  float strokeAlpha = rawStroke * tipMask * brushMask;

  // Soft outer halo for night mode self-glow (--zhusha-glow)
  float gapFade = smoothstep(uGap, min(uGap + 0.08, 0.999), u) * endCap;
  float halo = d < 100.0
    ? exp(-max(d, 0.0) * 6.5) * gapFade * brushMask * (1.0 - crackCut * 0.85)
    : 0.0;

  // Night mode color (self-glow + outer halo, respecting --text-3 alpha on offline)
  vec3 nightStroke = mix(uNightStroke, uNightYanzhi, crackEdge * 0.65);
  float glowA = halo * uNightGlowAlpha;
  float nightA = clamp(strokeAlpha + glowA * (1.0 - strokeAlpha), 0.0, 1.0);
  vec3 nightPremulRgb = nightStroke * strokeAlpha + uNightGlow * glowA * (1.0 - strokeAlpha * 0.45);
  vec4 nightPremul = vec4(nightPremulRgb, nightA) * uNightStrokeAlpha;

  // Paper mode color (black ink, with cinnabar tail when speaking, respecting --text-3 alpha on offline)
  float tailFactor = smoothstep(0.66, 0.94, u) * uSpeakingAmount;
  vec3 paperCol = mix(uPaperStroke, uPaperZhusha, tailFactor);
  paperCol = mix(paperCol, uPaperYanzhi, crackEdge * 0.75);
  vec4 paperPremul = vec4(paperCol * strokeAlpha, strokeAlpha) * uPaperStrokeAlpha;

  outColor = mix(nightPremul, paperPremul, uThemeMix);
}
