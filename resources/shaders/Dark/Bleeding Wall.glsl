// Bleeding Wall - blood wells up along the top and runs down a dark wall.
//
// Multipass, because a drip is entirely a memory effect: the buffer holds how
// much fluid is at each pixel, and every frame that fluid moves down a little.
//
// The thing that makes drips look like drips rather than a red curtain is
// surface tension. Fluid only flows once it exceeds a threshold, and columns
// run at different speeds, so the sheet breaks into discrete runners that race
// each other down the wall and leave thinning tails behind them.

//! common

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
    float a = 0.5;
    for (int i = 0; i < 4; i++) { v += vnoise(p) * a; p = p * 2.11 + 13.0; a *= 0.5; }
    return v;
}

// Per-column identity: how fast this runner falls and how fat it is.
// Quantising to columns is what keeps a runner coherent instead of smearing.
const float COLUMNS = 160.0;

//! pass BufferA
//! channel0 = bufferA

void mainImage(out vec4 fragColor, in vec2 fragCoord) {
    vec2 uv = fragCoord / iResolution.xy;

    float col = floor(uv.x * COLUMNS);
    float colSeed = hash1(col);
    float colSeed2 = hash1(col + 91.7);

    // Fall speed varies per column and rises with the low end, so a drop makes
    // the whole wall start running.
    float speed = (0.0016 + colSeed * 0.0042) * (0.55 + iBassAtt * 1.35);

    // Read from above (GL uv has y increasing upward, so "above" is +y).
    vec2 src = uv + vec2(0.0, speed);

    // Slight lateral wander so runners are not perfectly vertical.
    src.x += (fbm(vec2(col * 0.13, uv.y * 3.0 + iTime * 0.05)) - 0.5) * 0.0016;

    float above = texture(iChannel0, src).r;
    float here = texture(iChannel0, uv).r;

    /*
     * Surface tension.
     *
     * Fluid only moves down once there is enough of it to overcome the
     * threshold. Below that it stays put and slowly dries. This is the whole
     * trick - without it the buffer just translates downward as a solid block.
     */
    float threshold = 0.16 + colSeed2 * 0.20;
    float flowing = smoothstep(threshold, threshold + 0.22, above);

    float amount = mix(here * 0.955, max(above, here * 0.90), flowing);

    // Fresh blood wells up along the very top, gated on bass hits.
    float topBand = smoothstep(0.055, 0.0, 1.0 - uv.y);
    float wellSeed = hash1(col + floor(iTime * 1.7) * 31.0);
    float well = step(0.55 - iBassAtt * 0.30, wellSeed);
    float surge = pow(max(iBassAtt - 0.30, 0.0), 1.4) + iBeatPulse * 0.55;
    amount += topBand * well * surge * 0.055;

    // A pooling lip right at the top edge so the source never looks like a
    // hard line of pixels appearing from nowhere.
    amount += smoothstep(0.018, 0.0, 1.0 - uv.y) * 0.010;

    fragColor = vec4(clamp(amount, 0.0, 1.6), 0.0, 0.0, 1.0);
}

//! pass Image
//! channel0 = bufferA

void mainImage(out vec4 fragColor, in vec2 fragCoord) {
    vec2 uv = fragCoord / iResolution.xy;
    float texel = 1.0 / iResolution.y;

    float amount = texture(iChannel0, uv).r;

    // --- the wall ---------------------------------------------------------
    // Coarse plaster, almost black, with a faint downward gradient so the top
    // of the frame is not uniformly dead.
    float plaster = fbm(uv * vec2(9.0, 6.0)) * 0.5 + fbm(uv * 34.0) * 0.28;
    vec3 wall = vec3(0.030, 0.026, 0.027) * (0.55 + plaster * 0.9);
    wall *= 0.75 + uv.y * 0.35;

    vec3 col = wall;

    // --- the blood --------------------------------------------------------
    float mask = smoothstep(0.06, 0.30, amount);
    float thickness = clamp(amount, 0.0, 1.0);

    // Thin blood is brown-black, thick blood is a deep arterial red. Real
    // blood darkens as it pools rather than getting brighter.
    vec3 thin = vec3(0.075, 0.012, 0.010);
    vec3 thick = vec3(0.42, 0.020, 0.022);
    vec3 blood = mix(thin, thick, smoothstep(0.10, 0.75, thickness));

    // Wet highlight along the leading edge. The vertical gradient of the
    // amount field is where the meniscus is, and that is what catches light.
    float below = texture(iChannel0, uv - vec2(0.0, texel * 2.0)).r;
    float lead = clamp((amount - below) * 3.2, 0.0, 1.0);
    blood += vec3(0.55, 0.16, 0.14) * pow(lead, 1.6) * 0.55;

    // A narrow specular running down the middle of each runner, so the drips
    // read as rounded and wet rather than flat paint.
    float lateral = texture(iChannel0, uv + vec2(1.5 / iResolution.x, 0.0)).r
                  - texture(iChannel0, uv - vec2(1.5 / iResolution.x, 0.0)).r;
    blood += vec3(0.40, 0.10, 0.09) * smoothstep(0.10, 0.0, abs(lateral)) * mask * 0.22;

    col = mix(col, blood, mask);

    // Darkening where blood has soaked into the wall around each runner.
    col *= 1.0 - smoothstep(0.0, 0.10, amount) * 0.30 * (1.0 - mask);

    // --- room -------------------------------------------------------------
    // One dim source high and to the left, so the wall has a direction.
    float key = exp(-length((uv - vec2(0.28, 0.92)) * vec2(1.4, 1.0)) * 2.1);
    col += vec3(0.055, 0.016, 0.014) * key * (0.5 + iMidAtt * 0.5);

    float grain = hash(fragCoord + fract(iTime) * 823.0) - 0.5;
    col += grain * 0.030;

    vec2 d = uv - 0.5;
    col *= 1.0 - smoothstep(0.16, 0.80, dot(d, d) * 2.1);

    fragColor = vec4(max(col, 0.0), 1.0);
}
