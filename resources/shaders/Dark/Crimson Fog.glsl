// Crimson Fog - a dead red sun over layered fog and a black treeline.
//
// Almost entirely value, barely any hue. The sun is the only saturated thing
// in frame, and the bass pushes fog across it rather than lighting anything up.

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
    for (int i = 0; i < 5; i++) { v += vnoise(p) * a; p = p * 2.07 + 11.0; a *= 0.5; }
    return v;
}

void mainImage(out vec4 fragColor, in vec2 fragCoord) {
    vec2 uv = fragCoord / iResolution.xy;
    vec2 p = (fragCoord * 2.0 - iResolution.xy) / iResolution.y;

    const float HORIZON = -0.12;

    // Sky: near-black, warming very slightly toward the horizon.
    vec3 col = mix(vec3(0.020, 0.014, 0.016), vec3(0.075, 0.030, 0.028),
                   smoothstep(0.9, HORIZON, p.y));

    // Dead sun, low and dim. Its size breathes with the low end.
    vec2 sunPos = vec2(0.10, HORIZON + 0.30);
    float sunR = 0.20 + iBassAtt * 0.020;
    float toSun = length((p - sunPos) * vec2(1.0, 1.06));
    float disc = smoothstep(sunR, sunR - 0.012, toSun);

    col += vec3(0.62, 0.10, 0.07) * disc;
    col += vec3(0.34, 0.05, 0.035) * exp(-toSun * 3.4) * (0.5 + iBassAtt * 0.5);

    // Fog banks: several horizontal layers at different speeds, each occluding
    // the sun a little. Parallax between them is what gives the scene depth.
    for (int i = 0; i < 5; i++) {
        float fi = float(i);
        float y = HORIZON + 0.02 + fi * 0.055;
        float drift = iTime * (0.008 + fi * 0.006) * (1.0 + iBassAtt * 0.7);

        float band = fbm(vec2(p.x * (1.0 + fi * 0.4) + drift, y * 3.0 + fi));
        float thickness = 0.030 + band * 0.045;
        float mask = exp(-pow(abs(p.y - y) / thickness, 1.8));
        mask *= smoothstep(1.8, 0.4, abs(p.x));

        // Fog is lit only where it crosses the sun.
        float lit = exp(-length((p - sunPos)) * 2.0);
        vec3 fogColor = mix(vec3(0.050, 0.044, 0.046), vec3(0.42, 0.10, 0.07), lit);

        col = mix(col, fogColor, clamp(mask * (0.35 + band * 0.4), 0.0, 0.85));
    }

    // Treeline: a jagged silhouette, pure black.
    float ridge = HORIZON - 0.02
                - fbm(vec2(p.x * 2.6, 4.0)) * 0.10
                - fbm(vec2(p.x * 11.0, 9.0)) * 0.035;
    col = mix(col, vec3(0.004, 0.004, 0.005), smoothstep(ridge + 0.006, ridge - 0.006, p.y));

    // Rain, slanted, only over the lower half.
    vec2 rainUv = vec2(p.x * 60.0 + p.y * 14.0, p.y * 26.0 - iTime * 9.0);
    float rain = step(0.9955, hash(floor(rainUv)));
    col += vec3(0.16, 0.13, 0.14) * rain * smoothstep(0.55, -0.4, p.y) * (0.25 + iTrebAtt * 0.4);

    float grain = hash(fragCoord + fract(iTime) * 733.0) - 0.5;
    col += grain * 0.032;

    vec2 d = uv - 0.5;
    col *= 1.0 - smoothstep(0.22, 0.85, dot(d, d) * 2.0);

    fragColor = vec4(max(col, 0.0), 1.0);
}
