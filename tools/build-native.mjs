/**
 * Builds the virtual-camera native modules, on the one platform that has them.
 *
 * Both are Media Foundation and Win32 from top to bottom, so there is nothing
 * to compile anywhere else. This exists rather than a bare `node-gyp` call in
 * package.json so that the skip is explicit: expressing "no targets on this
 * platform" inside binding.gyp makes gyp itself fail on Linux, which would
 * break the build for every contributor who is not on Windows over a feature
 * their platform does not have.
 *
 * Exits 0 when it skips. A build that has nothing to do has succeeded.
 */
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

if (process.platform !== 'win32') {
  console.log(
    `build:native: skipped on ${process.platform} - the virtual camera is Windows-only.`,
  );
  process.exit(0);
}

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');

/*
 * node-gyp is run through its own JavaScript entry point rather than the `npx`
 * shim. Node 22 refuses to spawn a .cmd file without a shell, and going
 * through a shell would mean worrying about quoting paths that contain spaces.
 */
let gyp = path.join(root, 'node_modules', 'node-gyp', 'bin', 'node-gyp.js');
if (!existsSync(gyp)) {
  try {
    gyp = createRequire(import.meta.url).resolve('node-gyp/bin/node-gyp.js');
  } catch {
    console.error('build:native: node-gyp is not installed. Run npm install.');
    process.exit(1);
  }
}

const result = spawnSync(
  process.execPath,
  [gyp, 'configure', 'build', '--directory=native'],
  { stdio: 'inherit', cwd: root },
);

if (result.error) {
  console.error(`build:native: could not run node-gyp - ${result.error.message}`);
  process.exit(1);
}
process.exit(result.status ?? 1);
