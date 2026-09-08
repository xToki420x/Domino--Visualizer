# Changelog

## 0.4.1

**Fixes the camera producing no output.** Two separate causes, both of which
left the camera listed and silent.

The first was mine, in 0.4.0. That release made the camera device persistent so
it would stay in the list when Domino was closed, on the reasoning that call
apps read the camera list once at startup. The device did stay in the list, and
delivered *zero frames* to anything that opened it while Domino was actually
publishing. It also outlived its creator, so a crash left a dead camera behind
that nothing could remove. Reverted, and this release also clears an orphan
left by 0.4.0 - use **Unregister camera driver**, or just turn the camera on
once and off again.

The second was older and worse. Domino refused to publish whenever the shared
frame buffer already existed, on the assumption that meant a second copy of
Domino was running. But every *consumer* holds that buffer open too, so once
Discord or Zoom had opened the camera even briefly, Domino would report
"another copy is already publishing" and produce nothing until a reboot.
Whether another copy is publishing is now tracked with a lock that Windows
releases automatically when its owner dies, so a crashed Domino no longer locks
the camera out either.

**Also**

- The camera is now created and owned on a dedicated thread in the
  multithreaded apartment. Publishing from the main thread let Windows drive
  the camera through the application's UI thread, which is a freeze waiting to
  happen the moment something streams from it.
- A camera service that is still tearing down a previous session (a Domino that
  was killed rather than closed) is retried rather than reported as a failure.
- Sustained streaming is now a test. Everything here passed a
  read-one-frame check and still failed in a real call, because the failures
  only appear once something holds the camera open - so the suite now streams
  for ten seconds and asserts that frames keep arriving and the app stays
  responsive while they do.

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
