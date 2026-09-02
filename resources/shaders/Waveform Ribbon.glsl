// Waveform Ribbon - the raw waveform drawn as a glowing stereo ribbon.

// Inverse-distance falloff gives a soft glowing line for far less work than
// an actual distance field would cost.
float ribbon(vec2 uv, float offset, float thickness) {
    float w = dominoWave(uv.x * 0.5 + offset);
    float d = abs(uv.y - w * 0.35);
    return thickness / (d + thickness);
}

void mainImage(out vec4 fragColor, in vec2 fragCoord) {
    vec2 uv = (fragCoord * 2.0 - iResolution.xy) / iResolution.y;

    float thickness = 0.006 + iVolumeAtt * 0.01;

    // Three offset traces give the ribbon depth without any extra geometry.
    float a = ribbon(uv, 0.0,  thickness);
    float b = ribbon(uv + vec2(0.0, 0.05), 0.25, thickness * 0.8);
    float c = ribbon(uv - vec2(0.0, 0.05), 0.5,  thickness * 0.8);

    vec3 color = vec3(0.25, 0.85, 1.00) * a
               + vec3(0.70, 0.40, 1.00) * b
               + vec3(1.00, 0.45, 0.80) * c;

    color *= 0.55 + iVolumeAtt * 0.6;

    color += vec3(0.05, 0.10, 0.20) * exp(-abs(uv.y) * 3.0);
    color += vec3(0.4, 0.5, 0.9) * iBeatPulse * 0.18;

    fragColor = vec4(color, 1.0);
}
