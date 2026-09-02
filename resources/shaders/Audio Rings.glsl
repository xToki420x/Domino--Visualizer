// Audio Rings - concentric rings driven by the spectrum.
// A good first read: it shows every audio input Domino offers.

void mainImage(out vec4 fragColor, in vec2 fragCoord) {
    vec2 uv = (fragCoord * 2.0 - iResolution.xy) / min(iResolution.x, iResolution.y);
    float r = length(uv);
    float a = atan(uv.y, uv.x);

    // Sample the spectrum along the radius so low frequencies sit at the centre.
    float spec = dominoSpectrum(pow(r * 0.7, 1.5));

    float rings = sin(r * 26.0 - iTime * 3.0 + spec * 18.0 * iSensitivity);
    rings = smoothstep(0.2, 0.95, rings * 0.5 + 0.5);

    vec3 base = 0.5 + 0.5 * cos(vec3(0.0, 2.1, 4.2) + r * 4.0 + iTime * 0.5);
    vec3 color = base * rings * (0.35 + iBassAtt * 0.7);

    // Angular spokes riding the treble.
    color += vec3(0.4, 0.8, 1.0) * pow(abs(sin(a * 12.0 + iTime)), 8.0) * iTrebAtt * 0.35;

    // Beat flash from the centre outward.
    color += vec3(1.0, 0.85, 0.95) * iBeatPulse * 0.5 * exp(-r * 3.0);

    color *= 1.0 - smoothstep(0.9, 1.5, r);
    fragColor = vec4(color, 1.0);
}
