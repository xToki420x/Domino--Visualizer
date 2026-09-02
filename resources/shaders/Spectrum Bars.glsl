// Spectrum Bars - a clean analyser with a peak cap and a glow under the bars.

void mainImage(out vec4 fragColor, in vec2 fragCoord) {
    vec2 uv = fragCoord / iResolution.xy;

    const float BARS = 64.0;
    float slot = floor(uv.x * BARS);
    float within = fract(uv.x * BARS);

    // Log-ish frequency mapping: linear bins would spend most of the width on
    // treble, where there is rarely much to look at.
    float f = pow(slot / BARS, 1.7);
    float level = dominoSpectrum(f) * iSensitivity;
    level = pow(level, 0.8) * 0.9;

    // Mirror around the middle so bars grow in both directions.
    float d = abs(uv.y - 0.5) * 2.0;
    float bar = step(d, level) * step(0.08, within) * step(within, 0.92);

    vec3 low  = vec3(0.20, 0.95, 1.00);
    vec3 high = vec3(0.75, 0.45, 1.00);
    vec3 color = mix(low, high, slot / BARS) * bar;

    // Bright cap line sitting exactly at the current level.
    color += vec3(1.0) * smoothstep(0.012, 0.0, abs(d - level)) * 0.7 * step(0.08, within);

    color += mix(low, high, uv.x) * exp(-d * 4.0) * level * 0.35;
    color += vec3(0.15, 0.25, 0.4) * iBeatPulse * 0.4;

    fragColor = vec4(color, 1.0);
}
