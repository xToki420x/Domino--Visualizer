// Plasma Tunnel - polar coordinates plus layered value noise.
// Bass drives how fast you fly down it.

float hash(vec2 p) {
    return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453);
}

float noise(vec2 p) {
    vec2 i = floor(p);
    vec2 f = fract(p);
    f = f * f * (3.0 - 2.0 * f);
    return mix(mix(hash(i), hash(i + vec2(1, 0)), f.x),
               mix(hash(i + vec2(0, 1)), hash(i + vec2(1, 1)), f.x), f.y);
}

float fbm(vec2 p) {
    float total = 0.0;
    float amp = 0.5;
    for (int i = 0; i < 5; i++) {
        total += noise(p) * amp;
        p *= 2.03;
        amp *= 0.5;
    }
    return total;
}

void mainImage(out vec4 fragColor, in vec2 fragCoord) {
    vec2 uv = (fragCoord * 2.0 - iResolution.xy) / min(iResolution.x, iResolution.y);

    float r = length(uv);
    float a = atan(uv.y, uv.x);

    // Dividing by r is what turns a flat plane into a tunnel receding to a
    // vanishing point: distance grows without bound as you approach the centre.
    float depth = 0.35 / max(r, 0.04) + iTime * (0.35 + iBassAtt * 0.55);
    vec2 tunnel = vec2(a / 3.14159 * 2.0, depth);

    float pattern = fbm(tunnel * 3.0 + vec2(0.0, iTime * 0.2));
    pattern += fbm(tunnel * 7.0 - vec2(iTime * 0.13, 0.0)) * 0.4;

    vec3 color = 0.5 + 0.5 * cos(vec3(0.0, 1.9, 3.8) + pattern * 5.0 + iTime * 0.3);
    color *= smoothstep(0.0, 0.55, pattern) * (0.4 + iMidAtt * 0.8);

    color *= smoothstep(0.02, 0.35, r);
    color += vec3(1.0, 0.7, 0.4) * iBeatPulse * 0.35 * exp(-r * 4.0);
    color *= 1.0 - smoothstep(0.85, 1.45, r) * 0.85;

    fragColor = vec4(color, 1.0);
}
