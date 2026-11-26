export const nodeVertexShader = /* glsl */ `
attribute float aLayer;
attribute float aOpacity;
attribute float aSelected;
attribute float aScale;
attribute float aWarn;
varying vec2 vLocal;
varying float vLayer;
varying float vOpacity;
varying float vSelected;
varying float vWarn;
void main() {
  vLocal = uv * 2.0 - 1.0;
  vLayer = aLayer;
  vOpacity = aOpacity;
  vSelected = aSelected;
  vWarn = aWarn;
  gl_Position = projectionMatrix * modelViewMatrix * instanceMatrix * vec4(position * aScale, 1.0);
}`

export const nodeFragmentShader = /* glsl */ `
uniform vec3 uTone[4];
uniform vec3 uSeal;
uniform vec3 uWarn;
uniform float uTime;
uniform float uZoom;
varying vec2 vLocal;
varying float vLayer;
varying float vOpacity;
varying float vSelected;
varying float vWarn;
void main() {
  float r = length(vLocal);
  bool cluster = vLayer < 0.5 && uZoom < 0.6 && vWarn < 0.05;
  float core = 1.0 - smoothstep(0.55, 0.85, r);
  float baseHalo = vLayer > 2.5 ? 0.8 : vLayer > 1.5 ? 0.35 : vLayer > 0.5 ? 0.15 : 0.0;
  float haloStrength = max(baseHalo, vWarn * 0.5);
  float halo = (1.0 - smoothstep(0.0, 1.0, r)) * haloStrength;
  float breathing = vLayer > 2.5 ? 0.94 + 0.06 * sin(uTime * 1.5) : 1.0;
  float ring = max(vSelected, step(2.5, vLayer) * 0.85) * (1.0 - smoothstep(0.025, 0.075, abs(r - 0.92)));
  float alpha = cluster ? 0.12 * (1.0 - smoothstep(0.0, 1.0, r)) : (core + halo) * breathing;
  vec3 baseColor = mix(uTone[int(vLayer)], uWarn, vWarn);
  vec3 color = mix(baseColor, uSeal, ring);
  gl_FragColor = vec4(color, min(1.0, (alpha + ring) * vOpacity));
}`

export const edgeVertexShader = /* glsl */ `
attribute float aU;
attribute float aOpacity;
attribute float aSpeed;
attribute float aReverse;
varying float vU;
varying float vOpacity;
varying float vSpeed;
varying float vReverse;
void main() {
  vU = aU;
  vOpacity = aOpacity;
  vSpeed = aSpeed;
  vReverse = aReverse;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}`

export const edgeFragmentShader = /* glsl */ `
uniform float uTime;
uniform vec3 uLine;
uniform vec3 uFlow;
uniform vec3 uWarn;
varying float vU;
varying float vOpacity;
varying float vSpeed;
varying float vReverse;
void main() {
  float u = mix(vU, 1.0 - vU, vReverse);
  float phase = fract(uTime * 0.25 * vSpeed - u);
  float pulse = smoothstep(0.0, 0.08, phase) * (1.0 - smoothstep(0.08, 0.16, phase));
  vec3 lineColor = mix(uLine, uWarn, vReverse * 0.75);
  vec3 flowColor = mix(uFlow, uWarn, vReverse);
  gl_FragColor = vec4(mix(lineColor, flowColor, pulse), (0.18 + pulse * 0.6) * vOpacity);
}`
