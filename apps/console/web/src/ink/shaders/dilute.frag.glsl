uniform sampler2D uTarget;
uniform vec4 uRect;      // (minX, minY, maxX, maxY) in UV 0..1
uniform float uFactor;   // multiplicative dye retention (0..1)
uniform float uMark;     // dilution marker intensity stored in B channel
in vec2 vUv;
out vec4 outColor;

void main() {
  vec4 cur = texture(uTarget, vUv);
  vec2 edge = vec2(0.012);
  vec2 inside = smoothstep(uRect.xy - edge, uRect.xy + edge, vUv)
              * (1.0 - smoothstep(uRect.zw - edge, uRect.zw + edge, vUv));
  float mask = inside.x * inside.y;
  vec2 rg = cur.rg * mix(1.0, uFactor, mask);
  float b = max(cur.b * 0.96, mask * uMark);
  outColor = vec4(rg, b, cur.a);
}
