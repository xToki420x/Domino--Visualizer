// Particle Trails - points orbiting an attractor, smeared through a feedback
// buffer so each one leaves a comet tail.
//
// Multipass: BufferA accumulates and slowly fades, so "trail length" is just
// how fast the buffer decays.

//! common

// Deterministic per-particle position. Keeping particle state as a pure
// function of (index, time) means no state buffer is needed - the trail comes
// entirely from the accumulation pass.
vec2 particlePos(float i, float t, float bass, float mid) {
    float a = i * 2.39996;                 // golden angle, spreads indices evenly
    float radius = 0.18 + 0.30 * fract(sin(i * 12.9898) * 43758.5453);

    float speed = 0.4 + 0.6 * fract(sin(i * 78.233) * 43758.5453);
    float ang = a + t * speed * (0.5 + bass * 0.8);

    // Second, slower orbit modulates the first into a rosette.
    float wobble = sin(t * 0.7 + i * 0.31) * (0.06 + mid * 0.08);

    return vec2(cos(ang), sin(ang)) * (radius + wobble);
}

//! pass BufferA
//! channel0 = bufferA

void mainImage(out vec4 fragColor, in vec2 fragCoord) {
    vec2 uv = fragCoord / iResolution.xy;
    vec2 p = (fragCoord * 2.0 - iResolution.xy) / min(iResolution.x, iResolution.y);

    // Fade previous frame. Slightly pulling toward the centre as we fade makes
    // the tails taper inward instead of sitting as flat streaks.
    vec2 pull = (uv - 0.5) * 0.0016;
    vec3 prev = texture(iChannel0, uv - pull).rgb;
    prev *= 0.935 - iTrebAtt * 0.010;

    vec3 color = prev;

    const int COUNT = 48;
    for (int i = 0; i < COUNT; i++) {
        float fi = float(i);
        vec2 pos = particlePos(fi, iTime, iBassAtt, iMidAtt);

        float d = length(p - pos);
        float spec = dominoSpectrum(fract(fi * 0.0208) * 0.8);

        vec3 tint = 0.5 + 0.5 * cos(vec3(0.0, 2.1, 4.2) + fi * 0.42 + iTime * 0.2);
        color += tint * exp(-d * 170.0) * (0.35 + spec * 2.2);
    }

    // Beat flash at the attractor.
    color += vec3(1.0, 0.8, 0.95) * exp(-length(p) * 7.0) * iBeatPulse * 0.30;

    fragColor = vec4(max(color, 0.0), 1.0);
}

//! pass Image
//! channel0 = bufferA

void mainImage(out vec4 fragColor, in vec2 fragCoord) {
    vec2 uv = fragCoord / iResolution.xy;
    vec3 color = texture(iChannel0, uv).rgb;

    // Radial blur toward the centre adds a sense of speed.
    vec2 dir = (vec2(0.5) - uv) * 0.012;
    vec3 streak = vec3(0.0);
    for (int i = 1; i <= 5; i++) {
        streak += texture(iChannel0, uv + dir * float(i)).rgb;
    }
    color += streak / 5.0 * 0.35;

    fragColor = vec4(color, 1.0);
}
