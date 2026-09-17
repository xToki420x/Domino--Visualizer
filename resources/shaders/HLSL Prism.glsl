//! language = hlsl
//
// Written in HLSL rather than GLSL, to show that the editor takes either.
//
// Everything here is HLSL as you would write it in Direct3D: float2/float3
// vector types, lerp, frac, saturate, atan2, and a row-major float2x2 for the
// rotation. Domino translates it to GLSL ES before compiling, so the Shadertoy
// uniforms - iTime, iResolution, and Domino's own iBass/iMid/iTreb/iBeat -
// are available exactly as they are in a GLSL shader.
//
// Change `language = hlsl` to `glsl` and it stops compiling, which is a quick
// way to see the translation is real.

float2x2 rotate(float angle)
{
    float s = sin(angle);
    float c = cos(angle);
    // Row-major in HLSL. Domino transposes this on the way to GLSL, which is
    // why the prism spins the way you would expect.
    return float2x2(c, -s, s, c);
}

// A soft spectral ramp: red through violet, driven by a single parameter.
float3 spectrum(float t)
{
    float3 warm = float3(1.00, 0.18, 0.32);
    float3 mid  = float3(0.95, 0.55, 0.15);
    float3 cool = float3(0.25, 0.45, 1.00);
    float3 c = lerp(warm, mid, saturate(t * 2.0));
    return lerp(c, cool, saturate(t * 2.0 - 1.0));
}

void mainImage(out float4 fragColor, float2 fragCoord)
{
    float2 uv = (fragCoord * 2.0 - iResolution.xy) / iResolution.y;

    // Bass opens the prism out; treble adds the fine ringing at the edges.
    float open = 0.55 + iBass * 0.35;
    uv = mul(uv, rotate(iTime * 0.18 + iBeat * 0.35));

    float r = length(uv);
    float a = atan2(uv.y, uv.x);

    // Six-fold symmetry, folded so the seams never show.
    float wedge = frac(a * 6.0 / 6.2831853 + 0.5) - 0.5;
    float blade = abs(wedge) * 2.0;

    float band = frac(r * (3.0 + iTreb * 4.0) - iTime * 0.35);
    float edge = smoothstep(0.45, 0.0, abs(band - 0.5) - blade * 0.35);

    float3 col = spectrum(saturate(blade + r * 0.35)) * edge;

    // A core that breathes with the mids, and a falloff so the corners settle.
    col += float3(1.0, 0.35, 0.55) * exp(-r * 4.0) * (0.25 + iMid * 0.55);
    col *= saturate(open / (r + 0.25));
    col = col / (col + 0.75);

    fragColor = float4(col, 1.0);
}
