// Hex Pulse - a hexagonal tiling where each cell lights from the spectrum.

// Map a point to its hex cell centre and the distance to the cell edge.
// Hex grids are two interleaved rectangular lattices; testing both candidates
// and keeping the nearer one is the standard trick.
vec4 hexCell(vec2 p) {
    vec2 s = vec2(1.0, 1.7320508);
    vec2 a = mod(p, s) - s * 0.5;
    vec2 b = mod(p - s * 0.5, s) - s * 0.5;

    vec2 gv = dot(a, a) < dot(b, b) ? a : b;
    vec2 id = p - gv;
    return vec4(gv, id);
}

// Distance to the hex boundary: max over the edge normals.
float hexEdge(vec2 gv) {
    vec2 q = abs(gv);
    return 0.5 - max(dot(q, normalize(vec2(1.0, 1.7320508))), q.x);
}

void mainImage(out vec4 fragColor, in vec2 fragCoord) {
    vec2 uv = (fragCoord * 2.0 - iResolution.xy) / min(iResolution.x, iResolution.y);

    // Slow rotation and breathing scale keep a static tiling from feeling dead.
    float rot = iTime * 0.05;
    uv = mat2(cos(rot), -sin(rot), sin(rot), cos(rot)) * uv;
    float scale = 6.0 + sin(iTime * 0.2) * 1.2;

    vec4 hex = hexCell(uv * scale);
    vec2 gv = hex.xy;
    vec2 id = hex.zw;

    float radius = length(id) / scale;
    float seed = fract(sin(dot(id, vec2(12.9898, 78.233))) * 43758.5453);

    // Sample the spectrum by radius so energy visibly travels outward.
    float spec = dominoSpectrum(clamp(radius * 0.85, 0.0, 1.0));

    // A ring expanding from the centre on each beat.
    float wave = sin(radius * 7.0 - iTime * 2.4);
    float pulse = smoothstep(0.4, 1.0, wave) * iBeatPulse;

    float level = spec * 1.4 + pulse * 0.9 + seed * 0.05;

    float edge = hexEdge(gv);
    float body = smoothstep(0.03, 0.14, edge);
    float outline = smoothstep(0.10, 0.02, edge);

    vec3 tint = 0.5 + 0.5 * cos(vec3(0.0, 2.1, 4.2) + radius * 3.0 + iTime * 0.25);

    vec3 color = tint * body * level * 0.9;
    color += vec3(0.35, 0.85, 1.0) * outline * (0.06 + level * 0.35);

    color *= 1.0 - smoothstep(0.85, 1.5, length(uv)) * 0.85;
    fragColor = vec4(color, 1.0);
}
