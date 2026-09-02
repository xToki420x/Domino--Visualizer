// Distortion Pedal - the waveform itself, clipped, smeared and torn.
//
// The trace is drawn from the actual audio and then abused: hard-clipped like
// an overdriven signal, split into three colour channels that disagree, and
// sliced into horizontal bands that jump on transients.

float hash(vec2 p) {
    p = fract(p * vec2(443.897, 441.423));
    p += dot(p, p + 19.19);
    return fract(p.x * p.y);
}

float hash1(float x) { return fract(sin(x * 127.1) * 43758.5453); }

// Soft-knee clipper. Below the threshold it is linear; above it compresses
// toward 1.0, which is what a driven amp does to a waveform.
float clipSoft(float x, float drive) {
    float d = x * drive;
    return d / (1.0 + abs(d));
}

// One trace, drawn with inverse-distance falloff so it glows.
float trace(vec2 p, float offset, float drive, float thickness) {
    float w = dominoWave(p.x * 0.5 + 0.5 + offset);
    w = clipSoft(w, drive);
    float d = abs(p.y - w * 0.55);
    return thickness / (d + thickness);
}

void mainImage(out vec4 fragColor, in vec2 fragCoord) {
    vec2 uv = fragCoord / iResolution.xy;

    // Band slicing: quantise rows and jump whole bands sideways on transients.
    float band = floor(uv.y * 22.0);
    float jump = (hash1(band + floor(iTime * 8.0)) - 0.5);
    float gate = step(0.80 - iBassAtt * 0.25, hash1(band * 5.1 + floor(iTime * 8.0)));
    uv.x += jump * gate * (0.02 + iBassAtt * 0.07);

    vec2 p = (uv * 2.0 - 1.0);
    p.x *= iResolution.x / iResolution.y;

    float drive = 1.2 + iBassAtt * 5.5;
    float thickness = 0.004 + iVolumeAtt * 0.006;

    // Three traces at slightly different read offsets and drives. They are the
    // same signal, disagreeing - which is the whole look.
    float r = trace(p, 0.000, drive, thickness);
    float g = trace(p, 0.004 + iBassAtt * 0.010, drive * 0.85, thickness * 0.9);
    float b = trace(p, 0.008 + iBassAtt * 0.020, drive * 0.70, thickness * 0.8);

    vec3 col = vec3(r * 0.95, g * 0.30, b * 0.26);

    // Clip rails: where the signal is pinned, mark the ceiling.
    float railed = step(0.92, abs(clipSoft(dominoWave(uv.x), drive)));
    col += vec3(0.55, 0.06, 0.05) * railed * 0.35;

    // Ghost of the spectrum along the bottom, barely visible.
    float spec = dominoSpectrum(pow(uv.x, 1.6));
    col += vec3(0.20, 0.045, 0.04) * step(uv.y, spec * 0.16) * 0.55;

    // Scanlines and grain.
    col *= 0.78 + 0.22 * sin(fragCoord.y * 2.2);
    col += (hash(fragCoord + fract(iTime) * 509.0) - 0.5) * 0.045;

    // Dull red floor so black areas still have some presence.
    col += vec3(0.030, 0.008, 0.008);

    vec2 d = uv - 0.5;
    col *= 1.0 - smoothstep(0.20, 0.82, dot(d, d) * 2.1);

    fragColor = vec4(max(col, 0.0), 1.0);
}
