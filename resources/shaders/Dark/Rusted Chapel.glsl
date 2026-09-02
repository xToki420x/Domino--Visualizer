// Rusted Chapel - gothic arches with something red burning behind them.
//
// Pure silhouette work: the arches are black cut-outs, and everything you see
// is the light coming through them. Dust in the shafts is what gives the space
// volume, and the bass drives the fire rather than the exposure.

float hash(vec2 p) {
    p = fract(p * vec2(443.897, 441.423));
    p += dot(p, p + 19.19);
    return fract(p.x * p.y);
}

float hash1(float x) { return fract(sin(x * 127.1) * 43758.5453); }

float vnoise(vec2 p) {
    vec2 i = floor(p);
    vec2 f = fract(p);
    f = f * f * (3.0 - 2.0 * f);
    return mix(mix(hash(i), hash(i + vec2(1, 0)), f.x),
               mix(hash(i + vec2(0, 1)), hash(i + vec2(1, 1)), f.x), f.y);
}

float fbm(vec2 p) {
    float v = 0.0;
    float amp = 0.5;
    for (int i = 0; i < 4; i++) { v += vnoise(p) * amp; p = p * 2.13 + 3.0; amp *= 0.5; }
    return v;
}

/*
 * A lancet arch: a vertical shaft capped by a pointed top.
 *
 * The point comes from intersecting two circles struck from opposite sides,
 * which is how the shape is actually constructed in masonry. Returns 1 inside
 * the opening.
 */
float arch(vec2 p, float halfWidth, float shaftTop) {
    float inShaft = step(abs(p.x), halfWidth) * step(p.y, shaftTop) * step(-0.75, p.y);

    // Above the shaft, two arcs meet at a point.
    float rad = halfWidth * 1.9;
    float d1 = length(p - vec2(-halfWidth * 0.9, shaftTop));
    float d2 = length(p - vec2(halfWidth * 0.9, shaftTop));
    float inCap = step(d1, rad) * step(d2, rad) * step(shaftTop, p.y);

    return clamp(inShaft + inCap, 0.0, 1.0);
}

void mainImage(out vec4 fragColor, in vec2 fragCoord) {
    vec2 uv = fragCoord / iResolution.xy;
    vec2 p = (fragCoord * 2.0 - iResolution.xy) / iResolution.y;

    // Very slow drift, as if handheld.
    p.x += sin(iTime * 0.07) * 0.012;
    p.y += cos(iTime * 0.05) * 0.008;

    float fire = 0.35 + iBassAtt * 0.85 + iBeatPulse * 0.35;

    // --- what is behind the wall -------------------------------------------
    // Rolling fire, hottest low and centre.
    float flames = fbm(vec2(p.x * 2.2, p.y * 1.6 - iTime * 0.30));
    flames += fbm(vec2(p.x * 6.0 + 11.0, p.y * 4.0 - iTime * 0.55)) * 0.4;

    float height = smoothstep(0.85, -0.65, p.y);
    float glow = flames * height * fire;

    vec3 behind = vec3(0.55, 0.075, 0.045) * glow;
    behind += vec3(0.85, 0.30, 0.10) * pow(max(glow - 0.55, 0.0), 1.8) * 1.1;
    behind += vec3(0.10, 0.014, 0.010) * height;

    // --- the wall ----------------------------------------------------------
    float opening = 0.0;
    for (int i = 0; i < 3; i++) {
        float fi = float(i) - 1.0;
        float halfWidth = 0.115 - abs(fi) * 0.022;
        float shaftTop = 0.10 - abs(fi) * 0.10;
        opening = max(opening, arch(p - vec2(fi * 0.42, 0.0), halfWidth, shaftTop));
    }

    // A rose window above the centre arch.
    vec2 rp = p - vec2(0.0, 0.52);
    float rr = length(rp);
    float ra = atan(rp.y, rp.x);
    float rose = step(rr, 0.115) * step(0.30, abs(sin(ra * 6.0)));
    rose *= step(0.045, rr);
    opening = max(opening, rose);

    vec3 col = mix(vec3(0.0), behind, opening);

    // --- volume -------------------------------------------------------------
    // Shafts of light spilling forward out of each opening. Approximated by
    // smearing the opening mask downward and outward.
    float shaft = 0.0;
    for (int i = 1; i <= 10; i++) {
        float t = float(i) / 10.0;
        vec2 q = p * (1.0 + t * 0.55) + vec2(0.0, t * 0.30);
        float o = 0.0;
        for (int j = 0; j < 3; j++) {
            float fj = float(j) - 1.0;
            o = max(o, arch(q - vec2(fj * 0.42, 0.0), 0.115 - abs(fj) * 0.022,
                            0.10 - abs(fj) * 0.10));
        }
        shaft += o * (1.0 - t);
    }
    shaft /= 10.0;

    // Dust makes the shafts visible; without it they read as flat gradients.
    float dust = 0.55 + 0.45 * fbm(p * 7.0 + vec2(iTime * 0.09, -iTime * 0.05));
    col += vec3(0.34, 0.070, 0.040) * shaft * dust * (0.55 + fire * 0.55);

    // Stone edge catching the light where it meets an opening.
    float edge = fwidth(opening);
    col += vec3(0.24, 0.070, 0.045) * edge * 6.0 * fire * 0.30;

    // Motes drifting in the shafts.
    vec2 moteCell = floor(fragCoord * 0.30 + vec2(iTime * 1.5, -iTime * 3.0));
    float mote = step(0.9975, hash(moteCell));
    col += vec3(0.42, 0.22, 0.14) * mote * shaft * 3.0 * (0.3 + iTrebAtt * 0.6);

    // Rust and damp on the stone.
    col += vec3(0.045, 0.016, 0.010) * (1.0 - opening) * fbm(p * 14.0) * 0.7;

    float grain = hash(fragCoord + fract(iTime) * 691.0) - 0.5;
    col += grain * 0.030;

    vec2 d = uv - 0.5;
    col *= 1.0 - smoothstep(0.15, 0.80, dot(d, d) * 2.2);

    fragColor = vec4(max(col, 0.0), 1.0);
}
