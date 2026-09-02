/**
 * Renderer smoke test.
 *
 * Run with: npm run test:smoke   (requires `npm run build` first)
 *
 * This boots the *real* main process rather than a stand-in, so the IPC
 * handlers, permission handlers and loopback wiring under test are the ones
 * that ship. It then attaches to the window the app creates, forwards renderer
 * console output, and probes the live page.
 *
 * The probe checks that frames are actually being produced, not just that the
 * app started: a visualizer can initialise perfectly and still be a black
 * rectangle, and only the frame counter and a pixel read can tell the
 * difference.
 */
const { app, BrowserWindow } = require('electron');
const path = require('node:path');
const fs = require('node:fs');

const ROOT = path.join(__dirname, '..');
/** Pass --shots <dir> to also save a PNG of every visual. */
const shotFlag = process.argv.indexOf('--shots');
const SHOT_DIR = shotFlag >= 0 ? path.resolve(process.argv[shotFlag + 1] ?? 'shots') : null;
const failures = [];
const consoleErrors = [];

/**
 * Warnings we expect and do not want to fail on.
 *
 * The CSP warning is unavoidable: compiling MilkDrop's EEL equations to
 * JavaScript uses `new Function`, which requires 'unsafe-eval'. Electron only
 * emits the warning for unpackaged builds.
 */
const IGNORED_WARNINGS = [
  'Insecure Content-Security-Policy',
  'Autofill.enable',
  'Autofill.setAddresses',
  // Graphics-driver chatter, not application defects. These appear on machines
  // without hardware acceleration (VMs, CI runners) where the app still works
  // correctly - treating them as failures would fail a perfectly good build.
  'GL Driver Message',
  'GroupMarkerNotSet',
  'software WebGL has been deprecated',
  'Automatic fallback to software WebGL',
];

/**
 * Mean luminance and spread inside the canvas region of a captured frame.
 *
 * `spread` is the standard deviation, which is what separates "bright and
 * detailed" from "saturated flat wash" - a blown-out preset has a high mean and
 * almost no variance, while a legitimately bright one still has structure.
 */
function measureCanvas(image, rect) {
  const size = image.getSize();
  const bitmap = image.toBitmap(); // BGRA
  // The captured image is the whole window in device pixels, so the CSS->device
  // scale is image width over window width. Deriving it from the canvas rect
  // instead silently samples past the canvas into the side panels.
  const scale = rect.innerWidth > 0 ? size.width / rect.innerWidth : 1;

  const x0 = Math.max(0, Math.floor(rect.x * scale));
  const y0 = Math.max(0, Math.floor(rect.y * scale));
  const x1 = Math.min(size.width, Math.floor((rect.x + rect.w) * scale));
  const y1 = Math.min(size.height, Math.floor((rect.y + rect.h) * scale));

  const values = [];
  let lit = 0;
  let total = 0;
  const step = 7; // Subsample; we want a statistic, not an exact figure.

  for (let y = y0; y < y1; y += step) {
    for (let x = x0; x < x1; x += step) {
      const p = (y * size.width + x) * 4;
      const luma = 0.0722 * bitmap[p] + 0.7152 * bitmap[p + 1] + 0.2126 * bitmap[p + 2];
      values.push(luma);
      if (luma > 12) lit++;
      total++;
    }
  }

  if (total === 0) return { mean: 0, spread: 0, lit: 0 };
  const mean = values.reduce((a, b) => a + b, 0) / total;
  const spread = Math.sqrt(values.reduce((a, b) => a + (b - mean) ** 2, 0) / total);
  return { mean, spread, lit: lit / total };
}

function check(label, condition, detail) {
  if (condition) {
    console.log(`  ok    ${label}`);
  } else {
    console.log(`  FAIL  ${label}${detail ? `\n        ${detail}` : ''}`);
    failures.push(label);
  }
}

// Attach before the app creates its window so no early message is missed.
app.on('browser-window-created', (_event, win) => {
  win.webContents.on('console-message', (...args) => {
    let tag;
    let message;
    let location = '';
    if (args.length >= 2 && args[1] && typeof args[1] === 'object' && 'message' in args[1]) {
      const details = args[1];
      tag = details.level ?? 'log';
      message = details.message;
      location = `${details.sourceId ?? ''}:${details.lineNumber ?? ''}`;
    } else {
      const [, level, msg, line, sourceId] = args;
      tag = ['verbose', 'info', 'warning', 'error'][level] ?? 'log';
      message = msg;
      location = `${sourceId ?? ''}:${line ?? ''}`;
    }
    const ignored = IGNORED_WARNINGS.some((needle) => String(message).includes(needle));
    if ((tag === 'error' || tag === 'warning') && !ignored) {
      consoleErrors.push(`[${tag}] ${message} (${location})`);
    }
    if (!ignored) console.log(`  renderer[${tag}] ${message}`);
  });

  win.webContents.on('render-process-gone', (_e, details) => {
    failures.push(`renderer crashed: ${details.reason}`);
  });
});

// Boot the shipping main process. It registers IPC and creates the window.
require(path.join(ROOT, 'out/main/index.js'));

const PROBE = `
  (() => {
    const canvas = document.getElementById('canvas');
    const gl = canvas && canvas.getContext('webgl2');
    const title = document.getElementById('hud-title');
    const fpsText = document.getElementById('stat-fps');
    let nonBlack = false;
    try {
      if (gl) {
        const px = new Uint8Array(4);
        gl.readPixels(
          Math.floor(canvas.width / 2), Math.floor(canvas.height / 2),
          1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px,
        );
        nonBlack = px[0] + px[1] + px[2] > 0;
      }
    } catch (e) { /* reading the default framebuffer can be restricted */ }
    return {
      hasGl: Boolean(gl),
      width: canvas ? canvas.width : 0,
      height: canvas ? canvas.height : 0,
      title: title ? title.textContent : '',
      fps: fpsText ? fpsText.textContent : '',
      libraryCount: document.querySelectorAll('.lib-item').length,
      editorExists: Boolean(document.getElementById('editor-host')),
      bodyError: document.body.innerHTML.includes('could not start'),
      nonBlack,
    };
  })()
`;

/** Load a preset by clicking its row, then report what the engine reported. */
const LOAD_EACH = `
  (async () => {
    const items = [...document.querySelectorAll('.lib-item')];
    const results = [];
    for (const item of items) {
      item.click();
      await new Promise((r) => setTimeout(r, 700));
      const errors = document.getElementById('editor-errors');
      results.push({
        name: item.textContent.replace('MINE', '').trim(),
        title: document.getElementById('hud-title').textContent,
        problems: errors && !errors.hidden ? errors.textContent.trim().slice(0, 300) : '',
      });
    }
    return results;
  })()
`;

app.whenReady().then(async () => {
  // Wait for the window the real main process creates.
  const win = await new Promise((resolve) => {
    const existing = BrowserWindow.getAllWindows()[0];
    if (existing) return resolve(existing);
    app.once('browser-window-created', (_e, created) => resolve(created));
  });

  await new Promise((resolve) => {
    if (!win.webContents.isLoading()) return resolve();
    win.webContents.once('did-finish-load', resolve);
  });

  // Give the app time to list the library, compile a preset and render frames.
  await new Promise((resolve) => setTimeout(resolve, 6000));

  const probe = await win.webContents.executeJavaScript(PROBE);
  console.log('\nProbe:', JSON.stringify(probe, null, 2));

  check('app booted without a fatal error', !probe.bodyError);
  check('WebGL2 context created', probe.hasGl);
  check('drawing buffer has a size', probe.width > 0 && probe.height > 0,
    `${probe.width}x${probe.height}`);
  check('library listed presets', probe.libraryCount > 0, `${probe.libraryCount} items`);
  check('a visual is loaded', Boolean(probe.title) && probe.title !== 'No visual loaded',
    probe.title);
  check('render loop is running', /\d/.test(probe.fps) && !probe.fps.startsWith('--'), probe.fps);
  check('editor host mounted', probe.editorExists);

  // Now walk every builtin preset and shader, so a broken one is caught here
  // rather than by the user hitting shuffle.
  console.log('\nLoading every library entry:');
  for (const kind of ['milk', 'shader']) {
    await win.webContents.executeJavaScript(
      `document.querySelector('.tab[data-kind="${kind}"]').click(); true;`,
    );
    await new Promise((resolve) => setTimeout(resolve, 400));
    const results = await win.webContents.executeJavaScript(LOAD_EACH);
    for (const entry of results) {
      const clean = !entry.problems;
      console.log(`  ${clean ? 'ok   ' : 'FAIL '} ${kind}: ${entry.name}`);
      if (!clean) {
        console.log(`         ${entry.problems.replace(/\n/g, '\n         ')}`);
        failures.push(`${kind}/${entry.name}`);
      }
    }
  }

  /*
   * Capture real frames.
   *
   * readPixels on the default framebuffer comes back black once the frame has
   * been presented, so it cannot answer "is anything actually on screen".
   * capturePage composites the window the way the user sees it, which can.
   */
  if (SHOT_DIR) {
    fs.mkdirSync(SHOT_DIR, { recursive: true });

    /*
     * Drive the capture with real audio.
     *
     * Judging a music visualizer in silence is meaningless: an audio-gated
     * preset is *supposed* to be black with no input, so a blank-frame check
     * run dry flags correct behaviour as a defect. Playing a pulsing tone out
     * the system output - which the loopback tap then hears - exercises every
     * preset under the conditions it was written for.
     */
    console.log('\nStarting capture tone...');
    const toneStarted = await win.webContents.executeJavaScript(`
      (async () => {
        document.getElementById('btn-listen').click();
        await new Promise((r) => setTimeout(r, 2000));

        const ctx = new AudioContext();
        await ctx.resume();
        const gain = ctx.createGain();
        gain.gain.value = 0.0;
        gain.connect(ctx.destination);

        /*
         * Broadband, because real music is.
         *
         * A bass tone alone leaves the treble band empty, and presets that key
         * off treble then render black - which looks like a broken preset but
         * is correct behaviour for the signal. Bass fundamental, a mid partial,
         * and filtered noise for the top end together cover all three bands.
         */
        const low = ctx.createOscillator();
        low.type = 'sawtooth';
        low.frequency.value = 70;
        low.connect(gain);
        low.start();

        const mid = ctx.createOscillator();
        mid.type = 'square';
        mid.frequency.value = 520;
        const midGain = ctx.createGain();
        midGain.gain.value = 0.30;
        mid.connect(midGain).connect(gain);
        mid.start();

        // White noise through a high-pass, i.e. hi-hats.
        const noiseLen = ctx.sampleRate * 2;
        const buffer = ctx.createBuffer(1, noiseLen, ctx.sampleRate);
        const data = buffer.getChannelData(0);
        for (let i = 0; i < noiseLen; i++) data[i] = Math.random() * 2 - 1;
        const noise = ctx.createBufferSource();
        noise.buffer = buffer;
        noise.loop = true;
        const hp = ctx.createBiquadFilter();
        hp.type = 'highpass';
        hp.frequency.value = 3000;
        const noiseGain = ctx.createGain();
        noiseGain.gain.value = 0.35;
        noise.connect(hp).connect(noiseGain).connect(gain);
        noise.start();

        // Pulse at 120 BPM for the whole run so beat detection has onsets.
        const beat = 0.5;
        for (let i = 0; i < 1400; i++) {
          const at = ctx.currentTime + i * beat;
          gain.gain.setValueAtTime(0.30, at);
          gain.gain.setValueAtTime(0.03, at + beat * 0.45);
        }

        window.__toneCtx = ctx;
        return document.getElementById('stat-src').textContent;
      })()
    `);
    console.log(`  input: ${toneStarted}`);
    await new Promise((resolve) => setTimeout(resolve, 1500));

    /*
     * Confirm audio is actually flowing before judging any frame.
     *
     * The Windows loopback endpoint does not always hand over on the first
     * request, and capturing with a dead tap makes every audio-reactive preset
     * look broken. Retrying beats reporting a screenful of false failures.
     */
    for (let attempt = 1; attempt <= 3; attempt++) {
      const moving = await win.webContents.executeJavaScript(`
        (async () => {
          const read = () => parseFloat(
            document.getElementById('meter-bass').style.height) || 0;
          let min = 1e9, max = -1e9;
          for (let i = 0; i < 10; i++) {
            await new Promise((r) => setTimeout(r, 120));
            const v = read();
            min = Math.min(min, v); max = Math.max(max, v);
          }
          return max - min;
        })()
      `);
      if (moving > 0.5) {
        console.log(`  audio confirmed flowing (band movement ${moving.toFixed(2)})`);
        break;
      }
      if (attempt === 3) {
        console.log('  WARNING: no audio movement detected; frame checks may be unreliable');
        break;
      }
      console.log(`  no audio movement yet, re-acquiring loopback (attempt ${attempt + 1})...`);
      await win.webContents.executeJavaScript(`
        (async () => {
          document.getElementById('btn-stop').click();
          await new Promise((r) => setTimeout(r, 400));
          document.getElementById('btn-listen').click();
          await new Promise((r) => setTimeout(r, 2000));
        })()
      `);
    }

    console.log(`\nCapturing frames to ${SHOT_DIR}:`);

    // Sample only inside the canvas; the surrounding chrome would dominate any
    // brightness statistic and hide the thing we are looking for.
    const canvasRect = await win.webContents.executeJavaScript(
      `(() => { const r = document.getElementById('canvas').getBoundingClientRect();
                return { x: r.x, y: r.y, w: r.width, h: r.height,
                         innerWidth: window.innerWidth }; })()`,
    );

    for (const kind of ['milk', 'shader']) {
      await win.webContents.executeJavaScript(
        `document.querySelector('.tab[data-kind="${kind}"]').click(); true;`,
      );
      await new Promise((resolve) => setTimeout(resolve, 300));
      const names = await win.webContents.executeJavaScript(
        `[...document.querySelectorAll('.lib-item')].map((n) => n.textContent.replace('MINE','').trim())`,
      );
      for (let i = 0; i < names.length; i++) {
        await win.webContents.executeJavaScript(
          `document.querySelectorAll('.lib-item')[${i}].click(); true;`,
        );
        // Let the feedback buffer build up a few frames of motion. A preset
        // that blows out does so within a second or two, so this is also long
        // enough to catch runaway accumulation.
        await new Promise((resolve) => setTimeout(resolve, 1400));
        const image = await win.capturePage();
        const file = path.join(SHOT_DIR, `${kind}-${names[i].replace(/[^\w -]/g, '')}.png`);
        fs.writeFileSync(file, image.toPNG());

        const stats = measureCanvas(image, canvasRect);
        const label = `${kind}: ${names[i]}`;

        // Two failure modes, both of which "renders something" would miss:
        // a black frame means nothing drew, and a uniformly bright frame means
        // feedback ran away and saturated the buffer.
        // Deliberately dark visuals are legitimate, so "blank" means very
        // nearly nothing on screen, not merely dim.
        if (stats.mean < 1.5 && stats.lit < 0.01) {
          console.log(`  FAIL  ${label} - blank frame`);
          failures.push(`blank frame: ${label}`);
        } else if (stats.mean > 200 && stats.spread < 26) {
          console.log(
            `  FAIL  ${label} - blown out (mean ${stats.mean.toFixed(0)}, spread ${stats.spread.toFixed(0)})`,
          );
          failures.push(`blown out: ${label}`);
        } else {
          console.log(
            `  ok    ${label} (mean ${stats.mean.toFixed(0)}, spread ${stats.spread.toFixed(0)})`,
          );
        }
      }
    }
  }

  /*
   * The headline feature: clicking "Listen to System Audio" must actually
   * produce a live loopback track. This exercises the real path - the renderer
   * calls getDisplayMedia, the main process answers with audio:'loopback', and
   * the engine wires the track into the analyser graph.
   *
   * It only asserts that a track arrives and the graph reports itself live;
   * whether the machine happens to be playing anything is not something a test
   * can control, so the levels themselves are reported but not asserted.
   */
  /*
   * CI runners have no audio endpoint, so loopback capture cannot succeed
   * there. Skipping is honest about what was and was not verified, rather than
   * either failing the build or silently pretending the check passed.
   */
  if (process.env.DOMINO_SMOKE_NO_AUDIO) {
    console.log('\nSystem audio loopback: SKIPPED (DOMINO_SMOKE_NO_AUDIO set)');
    console.log('  note  audio capture is not verified on this machine');
  } else {
  console.log('\nSystem audio loopback:');
  const capture = await win.webContents.executeJavaScript(`
    (async () => {
      document.getElementById('btn-listen').click();
      await new Promise((r) => setTimeout(r, 2500));
      const status = document.getElementById('stat-src').textContent;
      const toast = document.getElementById('toast');
      return {
        status,
        live: status !== 'no input',
        message: toast && !toast.hidden ? toast.textContent : '',
      };
    })()
  `);
  check('system audio capture starts', capture.live,
    `status="${capture.status}" ${capture.message}`);

  if (capture.live) {
    /*
     * End-to-end proof that the loopback really hears the machine.
     *
     * A tone is played out of the default output device. If the loopback tap
     * is working, that tone comes back in through the capture graph and moves
     * the band meters. This deliberately goes through the OS mixer rather than
     * feeding the analyser directly, because the mixer round trip is the part
     * that is actually worth testing.
     *
     * Reported, not asserted: a machine with no output device, a muted mixer,
     * or an exclusive-mode audio app would fail this for reasons that are not
     * the app's fault.
     */
    const reaction = await win.webContents.executeJavaScript(`
      (async () => {
        const read = () => ({
          bass: parseFloat(document.getElementById('meter-bass').style.height) || 0,
          mid: parseFloat(document.getElementById('meter-mid').style.height) || 0,
          treb: parseFloat(document.getElementById('meter-treb').style.height) || 0,
        });

        await new Promise((r) => setTimeout(r, 1200));
        const before = read();

        const ctx = new AudioContext();
        await ctx.resume();
        const gain = ctx.createGain();
        gain.gain.value = 0.30;
        gain.connect(ctx.destination);

        // A sawtooth at 90Hz has strong bass plus harmonics up the spectrum,
        // so every band should register.
        const osc = ctx.createOscillator();
        osc.type = 'sawtooth';
        osc.frequency.value = 90;
        osc.connect(gain);
        osc.start();

        // Pulse the level so the beat detector has onsets to find.
        for (let i = 0; i < 8; i++) {
          gain.gain.setValueAtTime(0.30, ctx.currentTime + i * 0.5);
          gain.gain.setValueAtTime(0.02, ctx.currentTime + i * 0.5 + 0.25);
        }

        // Sample repeatedly while the tone pulses, so we can measure movement.
        const samples = [];
        for (let i = 0; i < 16; i++) {
          await new Promise((r) => setTimeout(r, 250));
          samples.push(read());
        }
        const during = read();
        const bpm = document.getElementById('stat-bpm').textContent;

        osc.stop();
        await ctx.close();

        return { before, during, samples, bpm,
          outputs: (await navigator.mediaDevices.enumerateDevices())
            .filter((d) => d.kind === 'audiooutput').length };
      })()
    `);

    /*
     * Assert on *movement*, not absolute level.
     *
     * Comparing before/after only works on a silent machine; if the host is
     * already playing music the tone is masked and the levels barely shift,
     * which looked like a failure but is actually the loopback working
     * perfectly. Variance across samples proves a live signal either way.
     */
    const values = reaction.samples.flatMap((s) => [s.bass, s.mid, s.treb]);
    const mean = values.reduce((a, b) => a + b, 0) / values.length;
    const spread = Math.sqrt(
      values.reduce((a, b) => a + (b - mean) ** 2, 0) / values.length,
    );

    console.log(`  info  output devices: ${reaction.outputs}`);
    console.log(`  info  meters before: ${JSON.stringify(reaction.before)}`);
    console.log(`  info  meters during: ${JSON.stringify(reaction.during)}  bpm=${reaction.bpm}`);
    console.log(`  info  level spread across samples: ${spread.toFixed(2)}`);

    const responsive = spread > 0.4;
    check(
      'analyser produces a live, varying signal from the loopback',
      responsive,
      responsive ? undefined : 'levels were static - host may be silent and have no output device',
    );
  }
  }

  /*
   * Immersive fullscreen.
   *
   * The failure this guards against is subtle: the window goes fullscreen but
   * the layout still reserves a row for the transport bar, leaving a black band
   * along the bottom. So it checks the canvas actually grew to the full window
   * height, not merely that a class was toggled.
   */
  console.log('\nImmersive fullscreen:');
  const before = await win.webContents.executeJavaScript(
    `({ h: document.getElementById('canvas').getBoundingClientRect().height,
        w: document.getElementById('canvas').getBoundingClientRect().width,
        inner: window.innerHeight })`,
  );

  await win.webContents.executeJavaScript(
    `document.getElementById('btn-fullscreen').click(); true;`,
  );
  await new Promise((resolve) => setTimeout(resolve, 1800));

  const during = await win.webContents.executeJavaScript(
    `({ h: document.getElementById('canvas').getBoundingClientRect().height,
        w: document.getElementById('canvas').getBoundingClientRect().width,
        inner: window.innerHeight,
        chromeHidden: document.body.classList.contains('chrome-hidden'),
        transport: getComputedStyle(document.getElementById('transport')).display,
        sidebar: getComputedStyle(document.querySelector('.sidebar')).visibility })`,
  );

  check('window entered fullscreen', win.isFullScreen());
  check('chrome is hidden', during.chromeHidden === true);
  check('transport bar removed from layout', during.transport === 'none', during.transport);
  check('sidebar hidden', during.sidebar === 'hidden', during.sidebar);
  check('canvas grew wider', during.w > before.w, `${before.w} -> ${during.w}`);
  check(
    'canvas fills the full window height (no reserved transport row)',
    Math.abs(during.h - during.inner) < 2,
    `canvas ${during.h.toFixed(1)} vs window ${during.inner}`,
  );

  await win.webContents.executeJavaScript(`window.dispatchEvent(
    new KeyboardEvent('keydown', { key: 'Escape' })); true;`);
  await new Promise((resolve) => setTimeout(resolve, 1500));

  const after = await win.webContents.executeJavaScript(
    `({ chromeHidden: document.body.classList.contains('chrome-hidden'),
        transport: getComputedStyle(document.getElementById('transport')).display })`,
  );
  check('Escape leaves fullscreen', !win.isFullScreen());
  check('chrome comes back', after.chromeHidden === false && after.transport !== 'none');

  check('no renderer errors', consoleErrors.length === 0, consoleErrors.join('\n        '));

  console.log(
    `\n${failures.length === 0 ? 'SMOKE TEST PASSED' : `SMOKE TEST FAILED (${failures.length}): ${failures.join(', ')}`}`,
  );
  app.exit(failures.length === 0 ? 0 : 1);
});
