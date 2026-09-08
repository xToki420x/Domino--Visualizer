/**
 * Virtual camera, end to end, through Windows.
 *
 * Run with: npm run test:vcam   (requires `npm run build`, `npm run build:native`
 * and a registered camera driver)
 *
 * Everything else in the suite stops at the edge of the operating system. This
 * one goes all the way: it boots the real app, turns the camera on by clicking
 * the same checkbox a user would, and then opens that camera from a *separate
 * process* - which is the only way to exercise the hop through the Windows
 * Frame Server, since Windows hosts the media source in its own service.
 *
 * It cannot run in CI: publishing a camera needs the driver registered
 * machine-wide, which needs administrator rights once. It skips cleanly when
 * that has not been done.
 */
const { app, BrowserWindow } = require('electron');
const { execFileSync } = require('node:child_process');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const ADDON = path.join(ROOT, 'native/build/Release/domino_vcam.node');

const failures = [];
function check(label, condition, detail) {
  if (condition) {
    console.log(`  ok    ${label}`);
  } else {
    console.log(`  FAIL  ${label}${detail ? `\n        ${detail}` : ''}`);
    failures.push(label);
  }
}
function info(label, detail) {
  console.log(`  info  ${label}${detail !== undefined ? `: ${detail}` : ''}`);
}

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Poll `probe` until it returns truthy, or give up. */
async function until(probe, timeoutMs, everyMs = 250) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await probe();
    if (value) return value;
    if (Date.now() > deadline) return null;
    await wait(everyMs);
  }
}

/**
 * Open the camera from another process and bring one frame back.
 *
 * Deliberately a child process: opening a virtual camera from inside the
 * process that publishes it is not the case anyone actually runs, and Media
 * Foundation behaves differently when it can shortcut the Frame Server.
 */
function captureFromAnotherProcess(name, timeoutMs) {
  const script = `
    const addon = require(${JSON.stringify(ADDON)});
    const shot = addon.captureFrameForTest(${JSON.stringify(name)}, ${timeoutMs});
    if (!shot.ok) { console.log(JSON.stringify({ ok: false, error: shot.error })); }
    else {
      const luma = shot.data.subarray(0, shot.width * shot.height);
      let min = 255, max = 0, sum = 0;
      for (let i = 0; i < luma.length; i++) {
        const v = luma[i];
        if (v < min) min = v;
        if (v > max) max = v;
        sum += v;
      }
      const mean = sum / luma.length;
      let varsum = 0;
      for (let i = 0; i < luma.length; i++) varsum += (luma[i] - mean) ** 2;
      console.log(JSON.stringify({
        ok: true, device: shot.device, width: shot.width, height: shot.height,
        bytes: shot.data.length, min, max, mean,
        stdev: Math.sqrt(varsum / luma.length),
      }));
    }
  `;
  const out = execFileSync(process.execPath, ['-e', script], {
    encoding: 'utf8',
    timeout: timeoutMs + 20000,
    // ELECTRON_RUN_AS_NODE: this test runs under Electron, and the child must
    // behave as plain Node rather than trying to start a second app.
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
  });
  return JSON.parse(out.trim().split('\n').pop());
}

const ENABLE_CAMERA = `
  (() => {
    const rows = Array.from(document.querySelectorAll('.param-toggle'));
    const row = rows.find((r) => r.textContent.includes('Publish as Webcam'));
    if (!row) return { found: false };
    const box = row.querySelector('input[type=checkbox]');
    if (!box) return { found: false };
    if (box.disabled) return { found: true, disabled: true };
    box.checked = true;
    box.dispatchEvent(new Event('change'));
    return { found: true, disabled: false };
  })()
`;

require(path.join(ROOT, 'out/main/index.js'));

app.whenReady().then(async () => {
  console.log('\nVirtual camera, end to end:\n');

  // Skip the startup splash and attach to the app window itself.
  const win = await until(
    async () =>
      BrowserWindow.getAllWindows().find(
        (w) => !w.webContents.getURL().includes('splash'),
      ),
    20000,
  );
  if (!win) {
    console.log('  FAIL  the app never opened a window');
    app.exit(1);
    return;
  }
  if (win.webContents.isLoading()) {
    await new Promise((r) => win.webContents.once('did-finish-load', r));
  }
  // Let the renderer settle and start producing frames.
  await wait(3000);

  const vcam = require(ADDON);
  const registration = vcam.isRegistered();
  if (!registration.registered) {
    console.log('  SKIPPED: the camera driver is not registered on this machine.');
    console.log('  Register it once from the app, or with:');
    console.log('    regsvr32 <install dir>\\resources\\native\\domino_vcam_source.dll');
    app.exit(0);
    return;
  }
  info('driver registered at', registration.path);

  /*
   * The registered driver is a path, and it may well point at an installed
   * copy of Domino rather than this working tree. Publishing would then
   * exercise somebody else's DLL, so this is a skip rather than a failure -
   * and saying so beats a red run that looks like a regression.
   */
  const status0 = await win.webContents.executeJavaScript(
    'window.domino.virtualCamera.status()',
  );
  if (!status0.registeredIsThisBuild) {
    console.log('  SKIPPED: a different build is registered as the camera driver.');
    console.log(`    registered: ${status0.registeredPath}`);
    console.log(`    this build: ${status0.sourcePath}`);
    console.log('  Re-register from the app (or install this build) to test it.');
    app.exit(0);
    return;
  }

  const toggled = await win.webContents.executeJavaScript(ENABLE_CAMERA);
  check('the Publish as Webcam control exists', toggled.found === true);
  check('the control is enabled once the driver is registered', toggled.disabled !== true);
  if (!toggled.found || toggled.disabled) {
    app.exit(1);
    return;
  }

  const status = await until(async () => {
    const s = await win.webContents.executeJavaScript(
      'window.domino.virtualCamera.status()',
    );
    return s.running && s.framesWritten > 30 ? s : null;
  }, 25000);

  check('the app publishes the camera and starts sending frames', status !== null);
  if (!status) {
    const last = await win.webContents.executeJavaScript(
      'window.domino.virtualCamera.status()',
    );
    console.log(`        last status: ${JSON.stringify(last)}`);
    app.exit(1);
    return;
  }
  info('publishing', `${status.width}x${status.height} @ ${status.fps}fps, ${status.framesWritten} frames sent`);

  const cameras = await win.webContents.executeJavaScript(
    'window.domino.virtualCamera.listCameras()',
  );
  check(
    'the camera appears in the Windows device list',
    cameras.some((c) => c.includes(status.width ? 'Domino' : 'Domino')),
    JSON.stringify(cameras),
  );

  let shot;
  try {
    shot = captureFromAnotherProcess('Domino', 15000);
  } catch (err) {
    check('another process can open the camera', false, err.message);
    app.exit(1);
    return;
  }

  check('another process can open the camera and read a frame', shot.ok === true, shot.error);
  if (!shot.ok) {
    app.exit(1);
    return;
  }

  info('received', `${shot.device} ${shot.width}x${shot.height}, ${shot.bytes} bytes`);
  info('luma', `min ${shot.min}, max ${shot.max}, mean ${shot.mean.toFixed(1)}, stdev ${shot.stdev.toFixed(1)}`);

  check(
    'the frame matches the size the app is publishing',
    shot.width === status.width && shot.height === status.height,
    `${shot.width}x${shot.height} vs ${status.width}x${status.height}`,
  );
  check(
    'the frame is the right length for NV12',
    shot.bytes === (shot.width * shot.height * 3) / 2,
    `${shot.bytes} bytes`,
  );

  /*
   * The real assertion. A camera that hands back a uniform frame is indistinguishable
   * from one that is wired up and showing nothing, which is the failure this whole
   * feature is prone to - so structure in the image, not merely a frame arriving, is
   * what counts as working.
   */
  check(
    'the frame carries a real picture, not a flat fill',
    shot.stdev > 6,
    `standard deviation ${shot.stdev.toFixed(2)} across the luma plane`,
  );
  check(
    'the frame is not the black fallback the source emits with no producer',
    shot.max > 32,
    `brightest luma ${shot.max}`,
  );

  await win.webContents.executeJavaScript('window.domino.virtualCamera.stop()');
  const after = await win.webContents.executeJavaScript(
    'window.domino.virtualCamera.status()',
  );
  check('the camera stops on request', after.running === false);

  console.log(
    failures.length === 0
      ? '\nVIRTUAL CAMERA E2E PASSED\n'
      : `\nVIRTUAL CAMERA E2E FAILED (${failures.length})\n`,
  );
  app.exit(failures.length === 0 ? 0 : 1);
});
