uniform sampler2D uTarget;
uniform vec2 uPoint;      // 0..1
uniform float uRadius;    // normalized radius
uniform float uStrength;  // positive = counter-clockwise
uniform float uAspect;
uniform float uDt;
in vec2 vUv;
out vec4 outColor;

void main() {
  vec2 d = vUv - uPoint;
  d.x *= uAspect;
  float dist = length(d);
  float r = max(uRadius, 0.001);
  // Ring-peaked tangential swirl force (zero at exact center, smooth falloff outside r)
  float normDist = dist / r;
  float weight = normDist * exp(-normDist * normDist * 1.4);
  vec2 dir = dist > 1e-5 ? d / dist : vec2(0.0);
  // Counter-clockwise tangent in OpenGL UV space
  vec2 tangent = vec2(-dir.y, dir.x);
  // Subtle inward pull keeps ink curled around the vortex
  vec2 force = (tangent - dir * 0.14) * uStrength * weight * uDt;
  vec2 vel = texture(uTarget, vUv).xy + force;
  outColor = vec4(clamp(vel, vec2(-1000.0), vec2(1000.0)), 0.0, 1.0);
}
