// Starfield Drive - a beat-reactive flight through layered stars.

float hash21(vec2 p) {
    p = fract(p * vec2(233.34, 851.73));
    p += dot(p, p + 23.45);
    return fract(p.x * p.y);
}

// One layer of stars on a jittered grid. Cheap parallax: each layer just runs
// at a different grid density and speed.
vec3 layer(vec2 uv, float density, float speed, vec3 tint, float time) {
    uv *= density;
    uv.y += time * speed;

    vec2 cell = floor(uv);
    vec2 local = fract(uv) - 0.5;

    float rnd = hash21(cell);
    vec2 offset = (vec2(rnd, fract(rnd * 34.7)) - 0.5) * 0.7;

    float d = length(local - offset);
    float brightness = smoothstep(0.28, 0.0, d) * (0.35 + rnd * 0.65);
    // Narrow horizontally so faster layers read as streaks, not dots.
    brightness *= smoothstep(0.5, 0.0, abs(local.x - offset.x)) * 1.4;

    return tint * brightness;
}

void mainImage(out vec4 fragColor, in vec2 fragCoord) {
    vec2 uv = (fragCoord * 2.0 - iResolution.xy) / min(iResolution.x, iResolution.y);

    float boost = 1.0 + iBassAtt * 1.6 + iBeatPulse * 2.0;

    vec3 color = vec3(0.0);
    color += layer(uv, 4.0,  0.30 * boost, vec3(0.55, 0.75, 1.00), iTime);
    color += layer(uv, 8.0,  0.65 * boost, vec3(0.85, 0.85, 1.00), iTime) * 0.7;
    color += layer(uv, 16.0, 1.30 * boost, vec3(1.00, 0.80, 0.90), iTime) * 0.45;

    float r = length(uv);
    color += vec3(0.3, 0.5, 1.0) * iBeatPulse * 0.4 * exp(-r * 2.2);
    color += vec3(0.02, 0.03, 0.07);

    fragColor = vec4(color, 1.0);
}
