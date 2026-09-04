// Camera Bloom - your webcam, pushed around by the music.
//
// Turn the camera on in Display > Camera (or press C). iChannel1 below is
// bound to it; iChannel0 stays on audio.
//
// The effects are chosen to survive a webcam's soft, noisy, badly-lit image:
// chromatic split, a bass-driven pinch, scanlines and bloom all read clearly
// on a low-contrast source, where something like edge detection would mostly
// find sensor noise.

//! pass Image
//! channel0 = audio
//! channel1 = webcam

// Separable-ish bloom by sampling a ring. Cheap, and a webcam is soft enough
// that a proper Gaussian would not look meaningfully different.
vec3 bloom(vec2 uv, float radius) {
    vec3 sum = vec3(0.0);
    const int TAPS = 12;
    for (int i = 0; i < TAPS; i++) {
        float a = float(i) / float(TAPS) * 6.28318;
        vec2 offset = vec2(cos(a), sin(a)) * radius;
        sum += dominoCamera(iChannel1, uv + offset);
    }
    return sum / float(TAPS);
}

void mainImage(out vec4 fragColor, in vec2 fragCoord) {
    vec2 uv = fragCoord / iResolution.xy;
    vec2 centred = uv - 0.5;

    // Bass pinches the image toward the centre. Scaling around 0.5 keeps the
    // frame filled rather than revealing edges.
    float pinch = 1.0 - iBassAtt * 0.10 - iBeatPulse * 0.05;
    vec2 warped = centred * pinch + 0.5;

    // A slow swirl on the mids, strongest at the edges so faces stay readable.
    float r = length(centred);
    float swirl = iMidAtt * 0.35 * r * r;
    float cs = cos(swirl), sn = sin(swirl);
    warped = vec2(
        (warped.x - 0.5) * cs - (warped.y - 0.5) * sn,
        (warped.x - 0.5) * sn + (warped.y - 0.5) * cs
    ) + 0.5;

    // Chromatic split along the radius, opening up with treble.
    vec2 dir = r > 0.0001 ? centred / r : vec2(0.0);
    float split = (0.002 + iTrebAtt * 0.008) * (0.3 + r);

    vec3 col;
    col.r = dominoCamera(iChannel1, warped + dir * split).r;
    col.g = dominoCamera(iChannel1, warped).g;
    col.b = dominoCamera(iChannel1, warped - dir * split).b;

    // Bloom, gated on the beat so hits visibly blow the highlights.
    vec3 glow = bloom(warped, 0.006 + iVolumeAtt * 0.010);
    float glowAmount = 0.25 + iBeatPulse * 0.65;
    col += max(glow - 0.45, 0.0) * glowAmount * 2.0;

    // Spectrum bar across the bottom, so it reads as a music visual and not
    // just a webcam filter.
    float bar = dominoSpectrum(pow(uv.x, 1.6));
    float inBar = step(uv.y, bar * 0.12);
    vec3 barColor = 0.5 + 0.5 * cos(vec3(0.0, 2.1, 4.2) + uv.x * 5.0 + iTime * 0.5);
    col = mix(col, barColor, inBar * 0.85);

    // Scanlines and a slight desaturation pull it away from "raw webcam".
    col *= 0.88 + 0.12 * sin(fragCoord.y * 2.0);
    float luma = dot(col, vec3(0.2126, 0.7152, 0.0722));
    col = mix(vec3(luma), col, 0.85 + iVolumeAtt * 0.3);

    // Vignette.
    col *= 1.0 - smoothstep(0.30, 0.85, dot(centred, centred) * 2.0);

    // When no camera is running, say so rather than showing a black rectangle.
    if (iCameraActive < 0.5) {
        vec3 idle = vec3(0.04, 0.05, 0.08);
        idle += vec3(0.15, 0.35, 0.55) * exp(-r * 4.0) * (0.3 + iVolumeAtt * 0.7);
        idle = mix(idle, barColor, inBar * 0.85);
        col = idle;
    }

    fragColor = vec4(col, 1.0);
}
