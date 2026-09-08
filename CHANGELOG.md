# Changelog

## 0.4.0

**The camera stays in the list.** Applications build their camera list once,
when they start, so a camera that only existed while Domino happened to be
running was invisible to any call that was already open — the most common way
this feature looked broken. Domino now registers the device persistently, the
way every other virtual camera does. Pick it in Zoom whenever you like; it
shows clean black until you switch publishing on, and **Unregister camera
driver** takes it out of the list for good.

Switching *Publish as Webcam* off now pauses rather than tears down, so nothing
loses its camera mid-call. The frame channel deliberately stays open across a
pause, because closing it would change the frame size a newly opened consumer
negotiates.

**A splash screen.** Domino takes a couple of seconds to scan its preset
library, compile shaders and bring up a GL context, and showing nothing during
that reads as an app that failed to launch. The splash paints in the first
frames of the process, reports what is actually happening, and hands over the
moment the first frame is on screen. It is a shader, naturally.

**Also**

- A stale registration pointing at an older install is detected and reported
  instead of quietly producing a black camera — compared by content, so the
  same build at two paths is not a false alarm.
- Diagnostics for both camera enumeration paths, Media Foundation and
  DirectShow, since apps differ in which one they use.

## 0.3.0

**Domino can be a webcam.** Turn on **Publish as Webcam** in *Display → Virtual
Camera* and it appears as a camera in Zoom, Discord, Meet, OBS or anything else
that takes one. No capture card, no screen share, no OBS virtual-camera plugin
in between — this is an original Media Foundation media source written for
Domino.

Frames leave the GPU already packed as NV12 by a fragment shader and are read
back through pixel buffer objects, so publishing never stalls the visuals. They
cross into the Windows Frame Server through a lock-free shared-memory ring: a
slow conferencing app can drop a frame, but it can never slow the render loop
down.

Windows loads camera drivers inside its own service process, so the driver needs
a one-time machine-wide registration. **Register camera driver** does that with a
single Windows administrator prompt — it runs the standard `regsvr32` against the
shipped DLL — and there is an **Unregister** button beside it.

**Your webcam as a shader input.** Turn it on in *Display → Camera*, or press
**C**, and bind any iChannel to **Webcam**. Shaders get `iCameraResolution`,
`iCameraActive` and `iCameraMirror`, plus a `dominoCamera()` helper that applies
mirroring for you. `Camera Bloom` ships as a worked example. Shadertoy shaders
that used a webcam input now map onto this on import instead of being dropped.

**Also in this release**

- Pasting a Shadertoy `<iframe>` embed snippet imports the shader it points at.
- The packaged build verifies at startup that the camera binaries were shipped.

## 0.2.0

- 100 more presets, bringing the bundled library to 122.
- Dark, bass-driven shaders, and a horror-styled set including Crimson Fog.
- Shadertoy import by link, including multi-tab shaders (Common and Buffer A–D).
- Name your own visuals and save them into the user library.

## 0.1.0

First public build: WASAPI loopback capture, the from-scratch MilkDrop engine,
Shadertoy-compatible shader editing, and the Windows installer and portable exe.
