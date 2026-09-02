// Ink Fluid - dye advected through a swirling velocity field.
//
// A multipass shader: BufferA holds the dye and reads its own previous frame,
// which is what makes the ink persist and smear instead of resetting each
// frame. The Image pass just colours the result.

//! common

// Cheap curl-noise velocity field. Taking the perpendicular of a noise
// gradient gives a divergence-free field, which is why the flow looks like a
// fluid rather than a drift.
float hash(vec2 p) {
    return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453);
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
    for (int i = 0; i < 4; i++) { v += vnoise(p) * a; p *= 2.02; a *= 0.5; }
    return v;
}

vec2 curl(vec2 p, float t) {
    float e = 0.06;
    float n1 = fbm(p + vec2(0.0, e) + t * 0.08);
    float n2 = fbm(p - vec2(0.0, e) + t * 0.08);
    float n3 = fbm(p + vec2(e, 0.0) + t * 0.08);
    float n4 = fbm(p - vec2(e, 0.0) + t * 0.08);
    return vec2(n1 - n2, n4 - n3) / (2.0 * e);
}

//! pass BufferA
//! channel0 = bufferA
//! channel1 = audio

void mainImage(out vec4 fragColor, in vec2 fragCoord) {
    vec2 uv = fragCoord / iResolution.xy;
    vec2 asp = vec2(iResolution.x / iResolution.y, 1.0);

    // Advect: sample where this pixel's dye came FROM one step ago.
    vec2 vel = curl((uv - 0.5) * asp * 2.4, iTime);
    float speed = 0.0022 * (1.0 + iBassAtt * 2.2);
    vec2 prev = uv - vel * speed;

    vec3 dye = texture(iChannel0, prev).rgb;

    // Slow fade, otherwise the buffer saturates and detail is lost forever.
    dye *= 0.982;

    // Inject new dye from three orbiting emitters, brightness following bands.
    for (int i = 0; i < 3; i++) {
        float fi = float(i);
        float ang = iTime * (0.23 + fi * 0.11) + fi * 2.09;
        vec2 src = vec2(0.5) + vec2(cos(ang), sin(ang * 1.3)) * (0.22 + 0.06 * fi);
        float d = length((uv - src) * asp);

        float band = i == 0 ? iBassAtt : (i == 1 ? iMidAtt : iTrebAtt);
        vec3 tint = 0.5 + 0.5 * cos(vec3(0.0, 2.1, 4.2) + fi * 2.0 + iTime * 0.25);

        dye += tint * exp(-d * 46.0) * (0.020 + band * 0.075);
    }

    // Beat kick from the centre.
    float dc = length((uv - 0.5) * asp);
    dye += vec3(1.0, 0.75, 0.9) * exp(-dc * 12.0) * iBeatPulse * 0.09;

    fragColor = vec4(max(dye, 0.0), 1.0);
}

//! pass Image
//! channel0 = bufferA

void mainImage(out vec4 fragColor, in vec2 fragCoord) {
    vec2 uv = fragCoord / iResolution.xy;
    vec3 dye = texture(iChannel0, uv).rgb;

    // Slight bloom by sampling a few neighbours at increasing radius.
    vec3 glow = vec3(0.0);
    for (int i = 1; i <= 4; i++) {
        float r = float(i) * 0.004;
        glow += texture(iChannel0, uv + vec2(r, 0.0)).rgb;
        glow += texture(iChannel0, uv - vec2(r, 0.0)).rgb;
        glow += texture(iChannel0, uv + vec2(0.0, r)).rgb;
        glow += texture(iChannel0, uv - vec2(0.0, r)).rgb;
    }
    glow /= 16.0;

    vec3 color = dye + glow * 0.45;
    fragColor = vec4(color, 1.0);
}
