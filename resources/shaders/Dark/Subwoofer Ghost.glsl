// Subwoofer Ghost - a speaker cone seen through smoke, throwing shockwaves.
//
// Built around the 808: each kick launches a ring that expands and thins as it
// travels. Rings are kept in a feedback buffer so several are in flight at
// once, which is what makes a rolling bassline read as rhythm rather than a
// single pulsing blob.

//! common

float hash(vec2 p) {
    p = fract(p * vec2(443.897, 441.423));
    p += dot(p, p + 19.19);
    return fract(p.x * p.y);
}

//! pass BufferA
//! channel0 = bufferA

void mainImage(out vec4 fragColor, in vec2 fragCoord) {
    vec2 uv = fragCoord / iResolution.xy;
    vec2 p = (fragCoord * 2.0 - iResolution.xy) / min(iResolution.x, iResolution.y);
    float r = length(p);

    // Expand outward by pushing the sample point inward, so what was at radius
    // r last frame is read from slightly closer to the centre this frame.
    vec2 dir = r > 0.0001 ? p / r : vec2(0.0);
    float speed = 0.0042 + iBassAtt * 0.0022;
    vec2 prev = uv - dir * speed * vec2(iResolution.y / iResolution.x, 1.0);

    vec3 rings = texture(iChannel0, prev).rgb;

    // Thin as they travel: a shockwave loses amplitude with distance.
    rings *= 0.972 - r * 0.012;

    // Launch a new ring on the beat. Gated on the pulse rather than the level
    // so sustained bass does not smear into a continuous glow.
    float launch = smoothstep(0.45, 1.0, iBeatPulse);
    float cone = smoothstep(0.16, 0.06, r);
    rings += vec3(0.85, 0.16, 0.11) * cone * launch * 0.16;

    // The cone itself, breathing with the low end.
    float breathe = 0.10 + iBassAtt * 0.045;
    rings += vec3(0.30, 0.05, 0.04) * smoothstep(breathe, breathe - 0.03, r) * 0.045;

    fragColor = vec4(max(rings, 0.0), 1.0);
}

//! pass Image
//! channel0 = bufferA

void mainImage(out vec4 fragColor, in vec2 fragCoord) {
    vec2 uv = fragCoord / iResolution.xy;
    vec2 p = (fragCoord * 2.0 - iResolution.xy) / min(iResolution.x, iResolution.y);
    float r = length(p);

    vec3 col = texture(iChannel0, uv).rgb;

    // Concentric grille over the cone, so it reads as hardware.
    float grille = 0.55 + 0.45 * sin(r * 90.0);
    col *= mix(1.0, grille, smoothstep(0.30, 0.05, r));

    // Dust caught in the light, drifting slowly upward.
    vec2 dustCell = floor(fragCoord * 0.35 + vec2(0.0, -iTime * 6.0));
    float dust = step(0.9965, hash(dustCell));
    col += vec3(0.30, 0.22, 0.20) * dust * (0.25 + iTrebAtt * 0.5) * smoothstep(1.1, 0.2, r);

    // Desaturate hard, then put the red back only where it is already bright.
    float luma = dot(col, vec3(0.2126, 0.7152, 0.0722));
    col = mix(vec3(luma), col, 0.75);
    col += vec3(0.30, 0.03, 0.02) * pow(luma, 1.5);

    float grain = hash(fragCoord + fract(iTime) * 641.0) - 0.5;
    col += grain * 0.04;

    vec2 d = uv - 0.5;
    col *= 1.0 - smoothstep(0.22, 0.82, dot(d, d) * 2.0);

    fragColor = vec4(max(col, 0.0), 1.0);
}
