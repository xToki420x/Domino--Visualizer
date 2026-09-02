/**
 * Generates the app icon.
 *
 * Run with: npm run gen:icon
 *
 * Draws the mark in an offscreen page (Electron already ships a full canvas
 * implementation, so this needs no image dependencies), then packs the PNGs
 * into a Windows .ico.
 *
 * Modern .ico files may embed PNG data directly rather than the old BMP-with-
 * AND-mask format, which is why this can be a few dozen lines instead of a
 * bitmap encoder.
 */
const { app, BrowserWindow } = require('electron');
const path = require('node:path');
const fs = require('node:fs');

const OUT_DIR = path.join(__dirname, '..', 'build');
const SIZES = [16, 24, 32, 48, 64, 128, 256];

const PAGE = `<!doctype html><html><body style="margin:0;background:transparent">
<canvas id="c"></canvas>
<script>
window.draw = (size) => {
  const c = document.getElementById('c');
  c.width = size; c.height = size;
  const g = c.getContext('2d');
  const s = size / 256;
  g.clearRect(0, 0, size, size);

  // Rounded dark tile.
  const r = 56 * s;
  g.beginPath();
  g.moveTo(r, 0);
  g.arcTo(size, 0, size, size, r);
  g.arcTo(size, size, 0, size, r);
  g.arcTo(0, size, 0, 0, r);
  g.arcTo(0, 0, size, 0, r);
  g.closePath();
  const bg = g.createLinearGradient(0, 0, size, size);
  bg.addColorStop(0, '#12141d');
  bg.addColorStop(1, '#05060a');
  g.fillStyle = bg;
  g.fill();

  // The mark: a domino's two pips, rendered as the spectrum-coloured discs the
  // app uses for its accent ramp.
  const cx = size / 2;
  const divider = g.createLinearGradient(0, 0, size, 0);
  divider.addColorStop(0, 'rgba(110,231,255,0)');
  divider.addColorStop(0.5, 'rgba(179,136,255,0.85)');
  divider.addColorStop(1, 'rgba(255,157,226,0)');
  g.fillStyle = divider;
  g.fillRect(38 * s, cx - 3 * s, size - 76 * s, 6 * s);

  const pip = (y, inner, outer) => {
    const grad = g.createRadialGradient(cx, y, 2 * s, cx, y, 40 * s);
    grad.addColorStop(0, inner);
    grad.addColorStop(1, outer);
    g.fillStyle = grad;
    g.beginPath();
    g.arc(cx, y, 38 * s, 0, Math.PI * 2);
    g.fill();
  };
  pip(size * 0.29, '#9ef2ff', '#1f7f9c');
  pip(size * 0.71, '#ffc2ee', '#8a3fb0');

  return c.toDataURL('image/png');
};
</script></body></html>`;

/** Pack PNG buffers into an .ico. */
function buildIco(images) {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0); // reserved
  header.writeUInt16LE(1, 2); // type 1 = icon
  header.writeUInt16LE(images.length, 4);

  const entries = [];
  let offset = 6 + images.length * 16;

  for (const { size, data } of images) {
    const entry = Buffer.alloc(16);
    // 256 is stored as 0 - the field is a single byte.
    entry.writeUInt8(size >= 256 ? 0 : size, 0);
    entry.writeUInt8(size >= 256 ? 0 : size, 1);
    entry.writeUInt8(0, 2); // palette count
    entry.writeUInt8(0, 3); // reserved
    entry.writeUInt16LE(1, 4); // colour planes
    entry.writeUInt16LE(32, 6); // bits per pixel
    entry.writeUInt32LE(data.length, 8);
    entry.writeUInt32LE(offset, 12);
    entries.push(entry);
    offset += data.length;
  }

  return Buffer.concat([header, ...entries, ...images.map((i) => i.data)]);
}

app.whenReady().then(async () => {
  fs.mkdirSync(OUT_DIR, { recursive: true });

  const win = new BrowserWindow({
    show: false,
    width: 300,
    height: 300,
    webPreferences: { offscreen: true },
  });
  await win.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(PAGE)}`);

  const images = [];
  for (const size of SIZES) {
    const dataUrl = await win.webContents.executeJavaScript(`window.draw(${size})`);
    const data = Buffer.from(dataUrl.split(',')[1], 'base64');
    images.push({ size, data });
    if (size === 256) {
      fs.writeFileSync(path.join(OUT_DIR, 'icon.png'), data);
    }
  }

  fs.writeFileSync(path.join(OUT_DIR, 'icon.ico'), buildIco(images));
  console.log(`Wrote build/icon.ico (${SIZES.join(', ')}) and build/icon.png`);
  app.exit(0);
});
