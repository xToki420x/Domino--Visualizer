// Neon Grid - a retro perspective grid running to a horizon, with a sun.

float gridLine(float coord, float thickness) {
    // Distance to the nearest integer, made resolution-aware with fwidth so the
    // lines stay one pixel wide however far away they are.
    float d = abs(fract(coord) - 0.5);
    float w = fwidth(coord) * thickness;
    return 1.0 - smoothstep(0.0, w, d - w);
}

void mainImage(out vec4 fragColor, in vec2 fragCoord) {
    vec2 uv = (fragCoord * 2.0 - iResolution.xy) / iResolution.y;

    vec3 color = vec3(0.0);
    float horizon = -0.18;

    if (uv.y < horizon) {
        // Perspective divide: a plane below the camera projects to 1/y.
        float depth = 1.0 / (horizon - uv.y);
        vec2 plane = vec2(uv.x * depth, depth + iTime * (1.4 + iBassAtt * 2.0));

        float g = max(gridLine(plane.x * 1.4, 1.2), gridLine(plane.y * 0.55, 1.2));

        // Colour by distance, fading out before the horizon so it doesn't alias.
        vec3 near = vec3(1.00, 0.25, 0.62);
        vec3 far  = vec3(0.25, 0.55, 1.00);
        vec3 tint = mix(near, far, clamp(depth * 0.06, 0.0, 1.0));

        float fade = exp(-depth * 0.05);
        color += tint * g * fade * (0.6 + iMidAtt * 0.7);

        // Reflection of the sun on the "floor".
        float refl = exp(-abs(uv.x) * 3.0) * exp(-depth * 0.09);
        color += vec3(1.0, 0.35, 0.5) * refl * 0.16 * (0.5 + iBassAtt);
    } else {
        // Sun: banded disc above the horizon.
        vec2 sunUv = uv - vec2(0.0, horizon + 0.42);
        float d = length(vec2(sunUv.x, sunUv.y * 1.15));
        float sun = smoothstep(0.36, 0.34, d);

        // Horizontal slots cut through the lower half of the disc.
        float slots = step(0.5, fract((sunUv.y - iTime * 0.05) * 14.0));
        slots = mix(1.0, slots, smoothstep(0.02, -0.16, sunUv.y));

        vec3 sunColor = mix(vec3(1.0, 0.85, 0.35), vec3(1.0, 0.20, 0.55),
                            clamp(-sunUv.y * 1.6 + 0.5, 0.0, 1.0));
        color += sunColor * sun * slots * (0.75 + iBeatPulse * 0.5);

        // Glow around the sun, and a few stars.
        color += sunColor * exp(-d * 5.0) * 0.20;
        float star = step(0.9992, fract(sin(dot(floor(uv * 90.0), vec2(12.9898, 78.233))) * 43758.5));
        color += vec3(0.8, 0.9, 1.0) * star * (0.3 + iTrebAtt * 0.5);
    }

    // Horizon haze.
    color += vec3(0.55, 0.20, 0.70) * exp(-abs(uv.y - horizon) * 22.0) * 0.35;

    fragColor = vec4(color, 1.0);
}
