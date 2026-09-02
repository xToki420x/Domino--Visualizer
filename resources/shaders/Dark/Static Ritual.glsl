// Static Ritual - a sigil on a failing VHS tape.
//
// Everything here is a tape artefact: horizontal tracking tears, head-switching
// noise at the bottom, chroma that does not line up with luma, and a shutter
// that rolls when the bass hits. The sigil underneath is nearly monochrome so
// the artefacts are what you actually read.

float hash(vec2 p) {
    p = fract(p * vec2(443.897, 441.423));
    p += dot(p, p + 19.19);
    return fract(p.x * p.y);
}

float hash1(float x) { return fract(sin(x * 127.1) * 43758.5453); }

// Signed distance to a ring, used for every element of the sigil.
float ring(vec2 p, float r, float thickness) {
    return smoothstep(thickness, 0.0, abs(length(p) - r));
}

// Distance to an n-pointed star polygon, drawn as overlapping mirrored wedges.
float star(vec2 p, float points, float r, float thickness) {
    float a = atan(p.y, p.x);
    float wedge = 6.28318 / points;
    a = mod(a, wedge) - wedge * 0.5;
    float d = abs(cos(a * 0.5)) * length(p);
    return smoothstep(thickness, 0.0, abs(d - r));
}

float sigil(vec2 p, float t, float energy) {
    float s = 0.0;
    s += ring(p, 0.42, 0.006);
    s += ring(p, 0.38, 0.003);
    s += ring(p, 0.15 + energy * 0.02, 0.004);

    // Two counter-rotating stars: the interference between them is what makes
    // a static shape feel like a mechanism.
    float c1 = cos(t * 0.11), s1 = sin(t * 0.11);
    float c2 = cos(-t * 0.07), s2 = sin(-t * 0.07);
    s += star(mat2(c1, -s1, s1, c1) * p, 5.0, 0.30, 0.005);
    s += star(mat2(c2, -s2, s2, c2) * p, 7.0, 0.24, 0.004);

    // Tick marks around the outer ring.
    float a = atan(p.y, p.x);
    float ticks = step(0.82, abs(sin(a * 24.0)));
    s += ticks * ring(p, 0.40, 0.014) * 0.7;

    return s;
}

void mainImage(out vec4 fragColor, in vec2 fragCoord) {
    vec2 uv = fragCoord / iResolution.xy;

    // --- tape transport ---------------------------------------------------
    // Tearing happens in horizontal bands that jump discretely, so quantise
    // the row before offsetting it.
    float rowBand = floor(uv.y * 34.0);
    float tearGate = step(0.965 - iBassAtt * 0.05, hash1(rowBand + floor(iTime * 11.0)));
    float tear = (hash1(rowBand * 3.7 + floor(iTime * 11.0)) - 0.5) * tearGate;
    uv.x += tear * (0.05 + iBassAtt * 0.10);

    // Vertical roll on heavy bass, like the vertical hold giving up.
    float roll = iBeatPulse * 0.055 * step(0.55, iBassAtt);
    uv.y = fract(uv.y + roll);

    vec2 p = (uv * 2.0 - 1.0);
    p.x *= iResolution.x / iResolution.y;

    float energy = iBassAtt * 0.6 + iMidAtt * 0.4;

    // --- chroma separation ------------------------------------------------
    // Sample the sigil three times at slightly different scales; on tape the
    // colour carrier drifts away from luma, which is what this imitates.
    float sep = 0.004 + iBassAtt * 0.012;
    float sr = sigil(p * (1.0 + sep), iTime, energy);
    float sg = sigil(p, iTime, energy);
    float sb = sigil(p * (1.0 - sep), iTime, energy);

    // Bone-white sigil with the red channel running hot.
    vec3 col = vec3(sr * 0.95, sg * 0.62, sb * 0.60) * (0.35 + energy * 0.55);

    // --- tape surface -----------------------------------------------------
    float scan = 0.72 + 0.28 * sin(fragCoord.y * 2.6 + iTime * 14.0);
    col *= scan;

    // Head-switching noise: a band of pure static along the bottom edge.
    float switchBand = smoothstep(0.055, 0.0, uv.y);
    col += vec3(0.55, 0.50, 0.50) * hash(fragCoord + fract(iTime) * 917.0) * switchBand * 0.5;

    // Dropouts - short bright dashes where the tape lost contact.
    float dropout = step(0.9975, hash(vec2(floor(fragCoord.y * 0.7), floor(iTime * 24.0))));
    col += vec3(0.35) * dropout * step(0.5, hash(fragCoord * 0.02));

    float grain = hash(fragCoord + fract(iTime) * 311.0) - 0.5;
    col += grain * (0.055 + iTrebAtt * 0.035);

    // Dull red bloom behind the sigil so the frame is never pure black.
    float r = length(p);
    col += vec3(0.20, 0.020, 0.015) * exp(-r * 2.4) * (0.25 + iBassAtt * 0.8);

    vec2 d = uv - 0.5;
    col *= 1.0 - smoothstep(0.20, 0.80, dot(d, d) * 2.1);

    fragColor = vec4(max(col, 0.0), 1.0);
}
