uniform sampler2D uTexture;
uniform float uValue;
in vec2 vUv;
out vec4 outColor;

void main() {
  outColor = uValue * texture(uTexture, vUv);
}
