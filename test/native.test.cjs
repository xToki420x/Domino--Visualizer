/**
 * Virtual-camera transport tests.
 *
 * Run with: npm run test:native   (requires npm run build:native first)
 *
 * These cover the shared-memory channel, which is the part that has to be
 * right before the media source DLL is built on top of it. A seqlock bug
 * produces torn frames only under load - far better to catch that here than
 * inside the Windows Frame Server, where it is close to undebuggable.
 */
const path = require('node:path');

let passed = 0, failed = 0;
function check(label, cond, detail) {
  if (cond) { passed++; }
  else { console.log(`FAIL  ${label}${detail ? `\n      ${detail}` : ''}`); failed++; }
}

let vcam;
try {
  vcam = require(path.join(__dirname, '..', 'native', 'build', 'Release', 'domino_vcam.node'));
} catch (err) {
  console.log('SKIPPED: native module not built. Run `npm run build:native`.');
  console.log(`  (${err.message})`);
  process.exit(0);
}

check('module exposes its API',
  ['registerSource','unregisterSource','isRegistered','openChannel','closeChannel',
   'start','stop','isRunning','writeFrame'].every((k) => typeof vcam[k] === 'function'));

check('nothing is running on a cold start', vcam.isRunning() === false);

// Writing with no channel open must fail cleanly rather than crash.
const early = vcam.writeFrame(Buffer.alloc(16));
check('write without a channel fails cleanly', early.ok === false && !!early.error, early.error);

const W = 64, H = 48, BYTES = W * H * 3 / 2;
check('channel opens', vcam.openChannel(W, H, 30).ok === true);

// Odd dimensions have no valid NV12 layout and must be rejected.
const odd = vcam.openChannel(65, 49, 30);
check('odd dimensions are rejected', odd.ok === false, odd.error);
check('channel reopens after a rejected size', vcam.openChannel(W, H, 30).ok === true);

const frame = Buffer.alloc(BYTES);
for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) frame[y * W + x] = (x * 4 + y) & 0xff;
frame.fill(0x80, W * H);

check('frame writes', vcam.writeFrame(frame).ok === true);

const back = vcam.readBackForTest();
check('frame reads back', back !== null);
if (back) {
  check('dimensions survive', back.width === W && back.height === H);
  check('byte count survives', back.data.length === BYTES);
  check('pixels are identical', Buffer.compare(back.data, frame) === 0);
}

// A wrong-sized frame must be refused, not written past the slot.
const wrong = vcam.writeFrame(Buffer.alloc(BYTES + 10));
check('mismatched frame size is refused', wrong.ok === false, wrong.error);

// Slot rotation and the seqlock, repeatedly.
let mismatches = 0;
for (let i = 0; i < 500; i++) {
  frame[0] = i & 0xff;
  frame[BYTES - 1] = (255 - i) & 0xff;
  if (!vcam.writeFrame(frame).ok) { mismatches++; continue; }
  const r = vcam.readBackForTest();
  if (!r || Buffer.compare(r.data, frame) !== 0) mismatches++;
}
check('500 round-trips with no tearing', mismatches === 0, `${mismatches} mismatched`);

const beforeClose = vcam.readBackForTest();
check('heartbeat advances', beforeClose && beforeClose.heartbeat > 1);

vcam.closeChannel();
check('reader detaches after close', vcam.readBackForTest() === null);

// Registration reporting should be honest about a path that does not exist.
const reg = vcam.isRegistered();
check('registration state is reported', typeof reg.registered === 'boolean');

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
