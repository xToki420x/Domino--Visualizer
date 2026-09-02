// Open Wound - a wet aperture that dilates on the low end.
//
// Organic rather than geometric: the opening is a circle whose radius is
// modulated by noise around its circumference, so the edge is ragged and never
// repeats. Bass dilates it, and the inside stays darker than the rim so it
// reads as depth rather than a red disc.

float hash(vec2 p) {
    p = fract(p * vec2(443.897, 441.423));
    p += dot(p, p + 19.19);
    return fract(p.x * p.y);
}

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
    for (int i = 0; i < 5; i++) { v += vnoise(p) * a; p = p * 2.09 + 23.0; a *= 0.5; }
    return v;
}

void mainImage(out vec4 fragColor, in vec2 fragCoord) {
    vec2 uv = fragCoord / iResolution.xy;
    vec2 p = (fragCoord * 2.0 - iResolution.xy) / min(iResolution.x, iResolution.y);

    float r = length(p);
    float a = atan(p.y, p.x);

    // Two heartbeats: a slow constant one, and the music on top of it.
    float pulse = 0.5 + 0.5 * sin(iTime * 1.1);
    float dilate = 0.26 + iBassAtt * 0.14 + pulse * 0.020 + iBeatPulse * 0.045;

    // Ragged edge. Sampling noise on a circle (cos/sin of the angle) keeps it
    // seamless where the angle wraps, which a plain atan-based lookup does not.
    vec2 ring = vec2(cos(a), sin(a));
    float ragged = fbm(ring * 2.6 + vec2(iTime * 0.06, 0.0)) - 0.5;
    ragged += (fbm(ring * 7.0 - vec2(0.0, iTime * 0.11)) - 0.5) * 0.45;

    float edge = dilate + ragged * (0.055 + iBassAtt * 0.035);

    // --- surrounding tissue ------------------------------------------------
    float flesh = fbm(p * 3.2 + 5.0) * 0.6 + fbm(p * 11.0) * 0.3;
    vec3 col = mix(vec3(0.045, 0.020, 0.021), vec3(0.115, 0.036, 0.034), flesh);

    // Veins: thin dark filaments radiating outward from the opening.
    float vein = abs(fbm(vec2(a * 3.4, r * 4.5 - iTime * 0.05)) - 0.5);
    col *= 1.0 - smoothstep(0.055, 0.0, vein) * 0.55 * smoothstep(0.9, edge, r);

    // Inflammation: tissue reddens as it approaches the opening.
    col += vec3(0.34, 0.030, 0.028) * smoothstep(edge + 0.42, edge, r) * (0.35 + iMidAtt * 0.55);

    // --- the opening -------------------------------------------------------
    float inside = smoothstep(edge + 0.010, edge - 0.010, r);

    // Interior falls away to near black toward the centre.
    vec3 interior = mix(vec3(0.115, 0.008, 0.010), vec3(0.006, 0.001, 0.002),
                        smoothstep(edge, 0.0, r));
    col = mix(col, interior, inside);

    // Wet rim: a bright specular ring right on the boundary, brightest where
    // the raggedness pushes the edge outward.
    float rim = smoothstep(0.030, 0.0, abs(r - edge));
    col += vec3(0.62, 0.14, 0.12) * rim * (0.40 + iBassAtt * 0.75);
    col += vec3(0.85, 0.42, 0.38) * pow(rim, 3.0) * (0.25 + ragged + 0.5) * 0.30;

    // Fluid pooling just inside the rim.
    float pool = smoothstep(edge, edge - 0.10, r) * inside;
    col += vec3(0.26, 0.012, 0.014) * pool * (0.5 + pulse * 0.5);

    // Wet sheen scattered over the tissue.
    float sheen = pow(max(fbm(p * 9.0 + iTime * 0.04) - 0.55, 0.0) * 3.0, 2.0);
    col += vec3(0.30, 0.10, 0.10) * sheen * smoothstep(edge, edge + 0.5, r) * 0.35;

    float grain = hash(fragCoord + fract(iTime) * 571.0) - 0.5;
    col += grain * 0.026;

    vec2 d = uv - 0.5;
    col *= 1.0 - smoothstep(0.16, 0.82, dot(d, d) * 2.1);

    fragColor = vec4(max(col, 0.0), 1.0);
}
