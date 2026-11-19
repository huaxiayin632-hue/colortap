import { Filter, GlProgram } from 'pixi.js';
import { supportedBlend, supportedBlendModes } from '../../core/compositing';

// The editor selects WebGL explicitly. All colors entering this shader are premultiplied.
const vertex = `
in vec2 aPosition;
out vec2 vTextureCoord;
uniform vec4 uInputSize;
uniform vec4 uOutputFrame;
uniform vec4 uOutputTexture;
void main() {
  vec2 p = aPosition * uOutputFrame.zw + uOutputFrame.xy;
  p.x = p.x * (2.0 / uOutputTexture.x) - 1.0;
  p.y = p.y * (2.0 * uOutputTexture.z / uOutputTexture.y) - uOutputTexture.z;
  gl_Position = vec4(p, 0.0, 1.0);
  vTextureCoord = aPosition * uOutputFrame.zw * uInputSize.zw;
}`;

const blendFunctions = `
float softLight(float b, float s) {
  float d = b <= 0.25 ? ((16.0*b-12.0)*b+4.0)*b : sqrt(b);
  return s <= 0.5 ? b-(1.0-2.0*s)*b*(1.0-b) : b+(2.0*s-1.0)*(d-b);
}
float blendChannel(float b, float s, float mode) {
  if (mode < 0.5) return s;
  if (mode < 1.5) return b*s;
  if (mode < 2.5) return b+s-b*s;
  if (mode < 3.5) return b <= 0.5 ? 2.0*b*s : 1.0-2.0*(1.0-b)*(1.0-s);
  if (mode < 4.5) return min(b,s);
  if (mode < 5.5) return max(b,s);
  if (mode < 6.5) return softLight(b,s);
  return s <= 0.5 ? 2.0*b*s : 1.0-2.0*(1.0-b)*(1.0-s);
}`;

/** Source-over blending or source-atop for a clipping stack. Never accumulates base alpha. */
export class CompositeFilter extends Filter {
  constructor(mode: string, clipped = false, opacity = 1) {
    const blend = supportedBlend(mode);
    const backdrop = clipped || blend !== 'normal';
    super({
      glProgram: GlProgram.from({
        vertex,
        fragment: `
in vec2 vTextureCoord;
out vec4 finalColor;
uniform sampler2D uTexture;
uniform float uOpacity;
${backdrop ? 'uniform sampler2D uBackTexture; uniform float uMode; uniform float uClipped;' + blendFunctions : ''}
void main() {
  vec4 s = texture(uTexture, vTextureCoord) * uOpacity;
  ${
    backdrop
      ? `
  vec4 b = texture(uBackTexture, vTextureCoord);
  vec3 cs = s.a > 0.0 ? s.rgb/s.a : vec3(0.0);
  vec3 cb = b.a > 0.0 ? b.rgb/b.a : vec3(0.0);
  vec3 mixed = vec3(blendChannel(cb.r,cs.r,uMode), blendChannel(cb.g,cs.g,uMode), blendChannel(cb.b,cs.b,uMode));
  vec3 rgb = b.rgb*(1.0-s.a) + s.a*b.a*mixed;
  float alpha = b.a;
  if (uClipped < 0.5) { rgb += s.rgb*(1.0-b.a); alpha += s.a*(1.0-b.a); }
  finalColor = vec4(rgb,alpha);`
      : 'finalColor = s;'
  }
}`,
      }),
      resources: {
        compositeUniforms: {
          uOpacity: { value: opacity, type: 'f32' },
          uMode: { value: supportedBlendModes.indexOf(blend), type: 'f32' },
          uClipped: { value: clipped ? 1 : 0, type: 'f32' },
        },
      },
      blendRequired: backdrop,
      // The backdrop is already included in the shader result; replace it exactly once.
      blendMode: backdrop ? 'none' : 'normal',
      resolution: 'inherit',
      antialias: false,
    });
  }
  set alpha(value: number) {
    this.resources.compositeUniforms.uniforms.uOpacity = value;
  }
}
