// Candle Vigil - a row of guttering candles in a black room.
//
// The flames are the only light. Everything else is what that light happens to
// reach, so the frame is mostly darkness with a warm pool at the bottom. Treble
// makes the flames gutter; bass makes them surge and throw the room open.

float hash(vec2 p) {
    p = fract(p * vec2(443.897, 441.423));
    p += dot(p, p + 19.19);
    return fract(p.x * p.y);
}

float hash1(float x) { return fract(sin(x * 127.1) * 43758.5453); }

float vnoise(vec2 p) {
    vec2 i = floor(p);
    vec2 f = fract(p);
    f = f * f * (3.0 - 2.0 * f);
    return mix(mix(hash(i), hash(i + vec2(1, 0)), f.x),
               mix(hash(i + vec2(0, 1)), hash(i + vec2(1, 1)), f.x), f.y);
}

float fbm(vec2 p) {
    float v = 0.0;
    float a = 0.5;
    for (int i = 0; i < 4; i++) { v += vnoise(p) * a; p = p * 2.05 + 7.0; a *= 0.5; }
    return v;
}

/*
 * One flame.
 *
 * A teardrop built from a stretched, offset distance field, then bent by noise
 * that scrolls upward. The noise amplitude grows with height, which is what
 * makes the tip whip around while the base stays anchored to the wick - the
 * single most important detail for a flame reading as alive.
 */
float flame(vec2 p, float seed, float gutter, float surge, out float core) {
    float h = clamp(p.y / (0.20 + surge * 0.06), 0.0, 1.6);

    float sway = (fbm(vec2(seed * 31.0, p.y * 7.0 - iTime * 2.4)) - 0.5);
    p.x += sway * h * h * (0.055 + gutter * 0.075);

    // Teardrop: narrow at the top, rounded at the base.
    float width = (0.030 + surge * 0.010) * (1.0 - h * 0.72);
    width = max(width, 0.0008);

    float d = length(vec2(p.x / width, (p.y - 0.055) / (0.12 + surge * 0.05)));

    float body = smoothstep(1.35, 0.35, d);
    core = smoothstep(0.85, 0.0, d) * step(0.0, p.y);
    return body * step(-0.02, p.y);
}

void mainImage(out vec4 fragColor, in vec2 fragCoord) {
    vec2 uv = fragCoord / iResolution.xy;
    vec2 p = (fragCoord * 2.0 - iResolution.xy) / iResolution.y;

    float gutter = iTrebAtt;
    float surge = iBassAtt;

    vec3 col = vec3(0.008, 0.006, 0.007);

    const int CANDLES = 5;
    for (int i = 0; i < CANDLES; i++) {
        float fi = float(i);
        float seed = hash1(fi * 17.0);

        // Uneven spacing and height; a straight even row looks manufactured.
        float x = (fi - 2.0) * 0.30 + (seed - 0.5) * 0.07;
        float baseY = -0.34 + (hash1(fi * 5.0) - 0.5) * 0.10;

        vec2 fp = p - vec2(x, baseY);

        // Each candle flickers on its own clock.
        float ownGutter = gutter * (0.6 + seed * 0.8);
        float ownSurge = surge * (0.7 + hash1(fi * 3.3) * 0.6);
        // Occasional deep gutter, as if caught by a draught.
        float draught = step(0.982, hash1(floor(iTime * 6.0) + fi * 13.0));
        ownGutter += draught * 0.9;

        float core;
        float body = flame(fp, seed, ownGutter, ownSurge, core);

        // Flame colour: deep orange body, near-white core, blue at the base.
        vec3 flameCol = mix(vec3(0.85, 0.22, 0.04), vec3(1.00, 0.72, 0.30), core);
        flameCol = mix(flameCol, vec3(0.30, 0.42, 0.85), smoothstep(0.03, -0.01, fp.y) * 0.5);

        col += flameCol * body * (0.55 + ownSurge * 0.55);

        // Light this flame throws into the room.
        float toFlame = length((p - vec2(x, baseY + 0.10)) * vec2(1.0, 0.85));
        col += vec3(0.34, 0.11, 0.030) * exp(-toFlame * 2.6) * (0.30 + ownSurge * 0.7);

        // The candle body, lit only from directly above.
        float candleX = smoothstep(0.030, 0.020, abs(fp.x));
        float candleY = smoothstep(0.0, -0.30, fp.y);
        float wax = candleX * candleY;
        col = mix(col, vec3(0.10, 0.075, 0.062) * (0.25 + exp(fp.y * 5.0) * 0.9), wax * 0.9);

        // Thin smoke ribbon above each flame.
        float smokeH = fp.y - 0.20;
        if (smokeH > 0.0) {
            float wob = (fbm(vec2(seed * 19.0, fp.y * 4.0 - iTime * 0.9)) - 0.5) * 0.20;
            float smoke = smoothstep(0.035, 0.0, abs(fp.x - wob * smokeH * 3.0));
            col += vec3(0.055, 0.048, 0.046) * smoke * exp(-smokeH * 3.2) * (0.3 + gutter * 0.5);
        }
    }

    // Floor pooling: the surfaces nearest the candles pick up the most light.
    float floorMask = smoothstep(-0.30, -0.55, p.y);
    col += vec3(0.10, 0.032, 0.014) * floorMask * (0.20 + surge * 0.45)
           * (0.5 + fbm(p * 6.0) * 0.7);

    float grain = hash(fragCoord + fract(iTime) * 397.0) - 0.5;
    col += grain * 0.028;

    vec2 d = uv - 0.5;
    col *= 1.0 - smoothstep(0.14, 0.78, dot(d, d) * 2.2);

    fragColor = vec4(max(col, 0.0), 1.0);
}
