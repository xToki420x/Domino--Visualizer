// Concrete Sermon - brutalist geometry under a single red light.
//
// Hard shadows, flat grey slabs, one warm source. The bass does not brighten
// the scene, it moves the light - which reads as far heavier than a flash.

float hash(vec2 p) {
    p = fract(p * vec2(443.897, 441.423));
    p += dot(p, p + 19.19);
    return fract(p.x * p.y);
}

// Signed distance to a box, the standard rounded-corner formulation.
float sdBox(vec2 p, vec2 b) {
    vec2 d = abs(p) - b;
    return length(max(d, 0.0)) + min(max(d.x, d.y), 0.0);
}

void mainImage(out vec4 fragColor, in vec2 fragCoord) {
    vec2 uv = fragCoord / iResolution.xy;
    vec2 p = (fragCoord * 2.0 - iResolution.xy) / min(iResolution.x, iResolution.y);

    // Very slow tilt: architecture should feel immovable, not animated.
    float t = iTime * 0.045;
    float ca = cos(t * 0.5), sa = sin(t * 0.5);
    p = mat2(ca, -sa, sa, ca) * p;

    // The light source swings on the low end.
    vec2 lightPos = vec2(sin(iTime * 0.23) * 0.55, 0.62 + iBassAtt * 0.12);

    vec3 col = vec3(0.012, 0.011, 0.013);
    float nearest = 1e9;

    // A stack of slabs at different depths. Iterating back to front and
    // keeping the nearest hit gives occlusion without any real geometry.
    for (int i = 0; i < 7; i++) {
        float fi = float(i);
        float depth = 1.0 - fi * 0.11;

        vec2 offset = vec2(
            sin(fi * 2.31 + t * 0.7) * 0.36,
            cos(fi * 1.77 - t * 0.5) * 0.30
        );
        vec2 size = vec2(0.26 - fi * 0.018, 0.055 + fract(fi * 0.37) * 0.16);

        float d = sdBox(p - offset, size);
        if (d < nearest) nearest = d;

        float face = smoothstep(0.006, 0.0, d);
        if (face > 0.0) {
            // Flat grey, shaded only by distance from the light.
            float toLight = length((p - offset) - lightPos);
            float fall = 1.0 / (1.0 + toLight * toLight * 2.2);
            float grey = 0.045 + depth * 0.06;

            vec3 slab = vec3(grey) + vec3(0.55, 0.09, 0.06) * fall * (0.5 + iBassAtt * 1.1);

            // Hard edge highlight along the top of each slab.
            float edge = smoothstep(0.012, 0.0, abs(d)) * smoothstep(0.0, 0.4, size.y - (p.y - offset.y));
            slab += vec3(0.30, 0.10, 0.08) * edge * 0.5;

            col = mix(col, slab, face);
        }
    }

    // Light shafts: a cone from the source, banded so it reads as dusty air.
    vec2 toL = p - lightPos;
    float ang = atan(toL.x, toL.y);
    float shaft = pow(max(0.0, 1.0 - abs(ang) * 0.7), 5.0);
    shaft *= 0.55 + 0.45 * sin(ang * 26.0 + iTime * 0.6);
    col += vec3(0.34, 0.06, 0.045) * shaft * (0.12 + iMidAtt * 0.28)
           * smoothstep(1.6, 0.1, length(toL));

    // Source itself.
    col += vec3(0.85, 0.22, 0.15) * exp(-length(toL) * 13.0) * (0.5 + iBassAtt);

    // Concrete tooth: static per-pixel noise, not animated, so it reads as
    // surface texture rather than film grain.
    col *= 0.90 + 0.10 * hash(floor(fragCoord * 0.85));
    col += (hash(fragCoord + fract(iTime) * 227.0) - 0.5) * 0.026;

    vec2 d2 = uv - 0.5;
    col *= 1.0 - smoothstep(0.18, 0.78, dot(d2, d2) * 2.1);

    fragColor = vec4(max(col, 0.0), 1.0);
}
