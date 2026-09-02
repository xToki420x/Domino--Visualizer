// Metaball Lava - summed inverse-square fields that merge as they approach.

void mainImage(out vec4 fragColor, in vec2 fragCoord) {
    vec2 uv = (fragCoord * 2.0 - iResolution.xy) / min(iResolution.x, iResolution.y);

    float field = 0.0;
    vec3 accum = vec3(0.0);

    for (int i = 0; i < 7; i++) {
        float fi = float(i);
        float spec = dominoSpectrum(0.04 + fi * 0.12);

        // Lissajous orbits with coprime-ish ratios so the pattern never repeats
        // over a visible timescale.
        float t = iTime * 0.35;
        vec2 centre = vec2(
            sin(t * (0.7 + fi * 0.13) + fi * 1.7),
            cos(t * (0.5 + fi * 0.17) + fi * 2.3)
        ) * (0.35 + 0.25 * sin(t * 0.3 + fi));

        float radius = 0.13 + spec * 0.20 + iBassAtt * 0.05;

        // 1/d^2 falloff: the sum of two nearby balls exceeds the threshold in
        // the space between them, which is what makes them visually merge.
        float d = max(length(uv - centre), 1e-3);
        float contribution = (radius * radius) / (d * d);

        field += contribution;
        accum += (0.5 + 0.5 * cos(vec3(0.0, 2.1, 4.2) + fi * 1.1 + iTime * 0.2)) * contribution;
    }

    vec3 tint = accum / max(field, 1e-3);

    // Threshold with a soft shoulder gives the liquid surface.
    float surface = smoothstep(0.85, 1.35, field);
    float rim = smoothstep(0.75, 0.95, field) - smoothstep(1.05, 1.45, field);

    vec3 color = tint * surface * (0.55 + iVolumeAtt * 0.6);
    color += vec3(1.0, 0.85, 0.55) * rim * (0.35 + iTrebAtt * 0.5);
    color += tint * smoothstep(0.25, 1.0, field) * 0.10;
    color += tint * iBeatPulse * surface * 0.35;

    fragColor = vec4(color, 1.0);
}
