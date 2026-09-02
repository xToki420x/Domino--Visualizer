// Voronoi Cells - a cellular field whose seeds pulse with the spectrum.

vec2 cellPoint(vec2 cell, float t) {
    // Deterministic per-cell jitter, animated so cells drift rather than sit.
    float n = fract(sin(dot(cell, vec2(127.1, 311.7))) * 43758.5453);
    float m = fract(sin(dot(cell, vec2(269.5, 183.3))) * 43758.5453);
    return vec2(0.5) + 0.42 * vec2(sin(t * (0.5 + n) + n * 6.28),
                                   cos(t * (0.5 + m) + m * 6.28));
}

void mainImage(out vec4 fragColor, in vec2 fragCoord) {
    vec2 uv = (fragCoord * 2.0 - iResolution.xy) / min(iResolution.x, iResolution.y);

    float scale = 4.0 + iBassAtt * 1.5;
    vec2 p = uv * scale;
    vec2 base = floor(p);
    vec2 f = fract(p);

    float nearest = 8.0;
    float second = 8.0;
    vec2 nearestCell = vec2(0.0);

    // 3x3 neighbourhood is enough because jitter is bounded to within a cell.
    for (int y = -1; y <= 1; y++) {
        for (int x = -1; x <= 1; x++) {
            vec2 offset = vec2(float(x), float(y));
            vec2 point = offset + cellPoint(base + offset, iTime * 0.6);
            float d = length(point - f);
            if (d < nearest) {
                second = nearest;
                nearest = d;
                nearestCell = base + offset;
            } else if (d < second) {
                second = d;
            }
        }
    }

    // The gap between the two nearest seeds is the distance to the cell wall.
    float edge = second - nearest;

    float seed = fract(sin(dot(nearestCell, vec2(12.9898, 78.233))) * 43758.5453);
    float spec = dominoSpectrum(seed * 0.8);

    vec3 fill = 0.5 + 0.5 * cos(vec3(0.0, 2.1, 4.2) + seed * 12.0 + iTime * 0.3);
    vec3 color = fill * (0.06 + spec * 1.3) * (1.0 - smoothstep(0.0, 0.55, nearest));

    // Bright walls between cells.
    color += vec3(0.6, 0.9, 1.0) * smoothstep(0.09, 0.0, edge) * (0.25 + iTrebAtt * 0.6);

    // Beat lights up every cell centre at once.
    color += fill * exp(-nearest * 9.0) * iBeatPulse * 0.7;

    color *= 1.0 - smoothstep(0.9, 1.5, length(uv)) * 0.7;
    fragColor = vec4(color, 1.0);
}
