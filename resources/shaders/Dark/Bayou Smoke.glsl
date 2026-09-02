// Bayou Smoke - slow black smoke lit from below by a dull red ember.
//
// Southern-gothic, near-monochrome, and deliberately low-key: the whole frame
// sits in the bottom third of the range so the 808 hits read as actual light
// arriving rather than as the picture getting brighter.
//
// Multipass, because smoke has to remember where it was.

//! common

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
    for (int i = 0; i < 5; i++) { v += vnoise(p) * a; p = p * 2.03 + 17.0; a *= 0.5; }
    return v;
}

//! pass BufferA
//! channel0 = bufferA

void mainImage(out vec4 fragColor, in vec2 fragCoord) {
    vec2 uv = fragCoord / iResolution.xy;
    vec2 asp = vec2(iResolution.x / iResolution.y, 1.0);

    // Smoke rises and shears sideways. Advecting by a slowly-turning field
    // rather than straight up is what keeps it from looking like a curtain.
    float turn = fbm(uv * 2.2 + vec2(0.0, iTime * 0.05)) - 0.5;
    vec2 flow = vec2(turn * 0.55, -1.0);
    vec2 prev = uv - flow * (0.0011 + iBassAtt * 0.0016);

    vec3 smoke = texture(iChannel0, prev).rgb;
    smoke *= 0.976;

    // Emitter along the bottom edge, gated hard by bass so quiet passages go
    // almost black and hits push a real plume up.
    float ember = pow(max(iBassAtt - 0.35, 0.0), 1.6);
    float band = smoothstep(0.22, 0.0, uv.y);
    float turbulence = fbm(uv * asp * 5.0 - vec2(0.0, iTime * 0.35));

    smoke += vec3(0.055, 0.030, 0.026) * band * turbulence * (0.25 + ember * 2.4);
    smoke += vec3(0.075, 0.012, 0.010) * band * pow(turbulence, 3.0) * iBeatPulse * 1.1;

    fragColor = vec4(max(smoke, 0.0), 1.0);
}

//! pass Image
//! channel0 = bufferA

void mainImage(out vec4 fragColor, in vec2 fragCoord) {
    vec2 uv = fragCoord / iResolution.xy;

    vec3 smoke = texture(iChannel0, uv).rgb;

    // Density drives a dull red glow rather than colouring the smoke itself,
    // so the smoke stays grey and only the lit parts go warm.
    float density = dot(smoke, vec3(0.33));
    vec3 col = vec3(density) * 0.55;
    col += vec3(0.55, 0.10, 0.07) * pow(density, 1.7) * (0.8 + iBassAtt * 1.4);

    // Ember pool at the base.
    float base = smoothstep(0.30, 0.0, uv.y);
    col += vec3(0.32, 0.05, 0.03) * base * (0.10 + iBassAtt * 0.30);

    // Grain, then a heavy vignette. Both are doing the same job: keeping the
    // image dirty and stopping it reading as clean digital gradient.
    float grain = hash(fragCoord + fract(iTime) * 431.0) - 0.5;
    col += grain * 0.035;

    vec2 d = uv - 0.5;
    col *= 1.0 - smoothstep(0.25, 0.85, dot(d, d) * 2.0);

    fragColor = vec4(max(col, 0.0), 1.0);
}
