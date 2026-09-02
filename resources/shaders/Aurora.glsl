// Aurora - stacked translucent curtains over a star field.

float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }

float vnoise(vec2 p) {
    vec2 i = floor(p);
    vec2 f = fract(p);
    f = f * f * (3.0 - 2.0 * f);
    return mix(mix(hash(i), hash(i + vec2(1, 0)), f.x),
               mix(hash(i + vec2(0, 1)), hash(i + vec2(1, 1)), f.x), f.y);
}

float fbm(vec2 p) {
    float v = 0.0;
    float a = 0.5;
    for (int i = 0; i < 5; i++) { v += vnoise(p) * a; p *= 2.04; a *= 0.5; }
    return v;
}

void mainImage(out vec4 fragColor, in vec2 fragCoord) {
    vec2 uv = fragCoord / iResolution.xy;
    vec2 p = (fragCoord * 2.0 - iResolution.xy) / iResolution.y;

    // Night sky gradient plus stars, drawn first so curtains sit over them.
    vec3 color = mix(vec3(0.02, 0.03, 0.08), vec3(0.00, 0.01, 0.03), uv.y);
    float star = step(0.9985, hash(floor(fragCoord * 0.75)));
    color += vec3(0.7, 0.8, 1.0) * star * (0.35 + 0.5 * hash(floor(fragCoord * 0.75) + 3.0));

    // Six curtains at increasing height, each a warped vertical band.
    for (int i = 0; i < 6; i++) {
        float fi = float(i);
        float band = dominoSpectrum(0.03 + fi * 0.11);

        // Horizontal warp is what makes the curtain ripple rather than hang.
        float warp = fbm(vec2(p.x * 1.1 + fi * 3.7, iTime * 0.14 + fi)) * 1.5;
        float centre = -0.30 + fi * 0.135 + warp * 0.28 + band * 0.10;

        float thickness = 0.055 + band * 0.10;
        float curtain = exp(-pow(abs(p.y - centre) / thickness, 1.7));

        // Vertical streaking, the characteristic aurora texture.
        float streak = 0.55 + 0.45 * fbm(vec2(p.x * 7.0 + fi * 11.0, p.y * 2.2 - iTime * 0.35));
        curtain *= streak;

        // Fade the ends so curtains don't terminate abruptly at the edges.
        curtain *= smoothstep(1.35, 0.55, abs(p.x));

        vec3 tint = 0.5 + 0.5 * cos(vec3(0.0, 1.6, 3.2) + fi * 0.6 + iTime * 0.12);
        tint = mix(vec3(0.25, 1.00, 0.55), tint, 0.55);

        color += tint * curtain * (0.10 + band * 0.75);
    }

    color += vec3(0.3, 0.9, 0.6) * iBeatPulse * 0.10;
    fragColor = vec4(color, 1.0);
}
