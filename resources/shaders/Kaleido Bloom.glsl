// Kaleido Bloom - mirrored wedges, so any pattern becomes a mandala.

vec2 kaleido(vec2 p, float segments) {
    float a = atan(p.y, p.x);
    float r = length(p);
    float wedge = 6.28318530718 / segments;
    // Fold the angle into a single wedge, then mirror inside it. Reflecting
    // rather than just repeating is what avoids a visible seam.
    a = mod(a, wedge);
    a = abs(a - wedge * 0.5);
    return vec2(cos(a), sin(a)) * r;
}

void mainImage(out vec4 fragColor, in vec2 fragCoord) {
    vec2 uv = (fragCoord * 2.0 - iResolution.xy) / min(iResolution.x, iResolution.y);

    // Segment count steps with the bass, so drops visibly change the symmetry.
    float segments = 6.0 + floor(iBassAtt * 3.0) * 2.0;
    uv = kaleido(uv * (1.1 + sin(iTime * 0.2) * 0.15), segments);

    vec3 color = vec3(0.0);
    for (int i = 0; i < 4; i++) {
        float fi = float(i);
        float spec = dominoSpectrum(0.05 + fi * 0.2);
        vec2 p = uv * (1.0 + fi * 0.45)
               + vec2(sin(iTime * 0.3 + fi), cos(iTime * 0.23 + fi)) * 0.25;
        float d = abs(sin(length(p) * 9.0 - iTime * 1.4 + spec * 7.0));
        vec3 tint = 0.5 + 0.5 * cos(vec3(0.0, 2.1, 4.2) + fi * 1.3 + iTime * 0.35);
        color += tint * pow(1.0 - d, 6.0) * (0.25 + spec * 1.6);
    }

    color *= 0.5 + iVolumeAtt * 0.7;
    color += iBeatPulse * 0.2;
    color *= 1.0 - smoothstep(0.85, 1.4, length(uv)) * 0.8;

    fragColor = vec4(color, 1.0);
}
