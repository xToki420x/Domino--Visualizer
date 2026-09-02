// Julia Drift - a Julia set whose constant is steered by the music.
//
// The interesting part is that c traces a path near the Mandelbrot boundary:
// that is where Julia sets are structurally unstable, so small audio-driven
// nudges cause large, satisfying changes in shape.

void mainImage(out vec4 fragColor, in vec2 fragCoord) {
    vec2 uv = (fragCoord * 2.0 - iResolution.xy) / min(iResolution.x, iResolution.y);

    float zoom = 1.35 - iBassAtt * 0.18;
    vec2 z = uv * zoom;

    float t = iTime * 0.11;
    vec2 c = vec2(
        0.7885 * cos(t) - 0.10 + iMidAtt * 0.035,
        0.7885 * sin(t) + iTrebAtt * 0.030
    );

    const int MAX_ITER = 96;
    float iter = 0.0;
    float dz = 1.0;

    for (int i = 0; i < MAX_ITER; i++) {
        // Track the derivative alongside z so we can compute a distance
        // estimate; that is what gives clean, thin filaments instead of the
        // banded blobs plain escape-time produces.
        dz = 2.0 * length(z) * dz + 1.0;
        z = vec2(z.x * z.x - z.y * z.y, 2.0 * z.x * z.y) + c;

        if (dot(z, z) > 256.0) break;
        iter += 1.0;
    }

    float r = length(z);
    vec3 color;

    if (iter >= float(MAX_ITER) - 0.5) {
        // Interior: nearly black, with a faint pulse so it is not a dead void.
        color = vec3(0.02, 0.01, 0.05) * (1.0 + iBeatPulse * 2.5);
    } else {
        // Smooth iteration count removes the visible integer banding.
        float smoothIter = iter - log2(max(log2(r), 1.0)) + 4.0;
        float shade = smoothIter / float(MAX_ITER);

        color = 0.5 + 0.5 * cos(vec3(0.0, 0.6, 1.1) * 6.28318 + shade * 14.0 + iTime * 0.3);
        color *= pow(1.0 - shade, 0.55);

        // Distance estimate lights the filaments.
        float dist = r * log(r) / max(dz, 1e-6);
        color += vec3(0.7, 0.9, 1.0) * smoothstep(0.012, 0.0, dist) * (0.25 + iTrebAtt * 0.55);
    }

    color *= 0.6 + iVolumeAtt * 0.6;
    fragColor = vec4(color, 1.0);
}
