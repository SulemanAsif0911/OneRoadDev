/** Data-driven mask preview: shows drivable / painted / clearance / step-breaks for a crop. */
import fs from 'node:fs';
import { png, newImage, text } from '/home/user/tools/pngutil.mjs';
const meta = JSON.parse(fs.readFileSync('public/arena/meta.json', 'utf8'));
const buf = fs.readFileSync('public/arena/grid.bin');
const { nx, nz, res, x0, z0 } = meta;
const H = new Float32Array(nx * nz), B = new Uint8Array(nx * nz), F = new Uint8Array(nx * nz);
for (let k = 0; k < nx * nz; k++) { H[k] = buf.readInt16LE(k * 4) * meta.quant; B[k] = buf.readUInt8(k * 4 + 2); F[k] = buf.readUInt8(k * 4 + 3); }
const drv = new Uint8Array(nx * nz);
for (let k = 0; k < nx * nz; k++) if (!(H[k] < -900 || B[k] || (F[k] & 2))) drv[k] = 1;
const INF = 1e9; const clr = new Float32Array(nx * nz);
for (let k = 0; k < nx * nz; k++) clr[k] = drv[k] ? INF : 0;
const d1 = 1, d2 = Math.SQRT2;
for (let z = 0; z < nz; z++) for (let x = 0; x < nx; x++) { const k = z * nx + x; if (clr[k] === 0) continue; let v = clr[k];
  if (x > 0) v = Math.min(v, clr[k - 1] + d1); if (z > 0) v = Math.min(v, clr[k - nx] + d1);
  if (x > 0 && z > 0) v = Math.min(v, clr[k - nx - 1] + d2); if (x < nx - 1 && z > 0) v = Math.min(v, clr[k - nx + 1] + d2); clr[k] = v; }
for (let z = nz - 1; z >= 0; z--) for (let x = nx - 1; x >= 0; x--) { const k = z * nx + x; if (clr[k] === 0) continue; let v = clr[k];
  if (x < nx - 1) v = Math.min(v, clr[k + 1] + d1); if (z < nz - 1) v = Math.min(v, clr[k + nx] + d1);
  if (x < nx - 1 && z < nz - 1) v = Math.min(v, clr[k + nx + 1] + d2); if (x > 0 && z < nz - 1) v = Math.min(v, clr[k + nx - 1] + d2); clr[k] = v; }
for (let k = 0; k < nx * nz; k++) clr[k] *= res;
const CL = +(process.env.CL || 1.8), MS = +(process.env.MS || 0.42);
const CROP = (process.env.CROP || `${x0},${z0},${x0 + nx * res},${z0 + nz * res}`).split(',').map(Number);
const SC = +(process.env.PPM || 3);
const X0 = Math.max(0, Math.floor((CROP[0] - x0) / res)), Z0 = Math.max(0, Math.floor((CROP[1] - z0) / res));
const X1 = Math.min(nx - 1, Math.ceil((CROP[2] - x0) / res)), Z1 = Math.min(nz - 1, Math.ceil((CROP[3] - z0) / res));
const W = (X1 - X0 + 1) * SC, Hh = (Z1 - Z0 + 1) * SC;
const img = newImage(W, Hh, [8, 10, 14]);
const setPx = (x, y, c) => { if (x < 0 || y < 0 || x >= img.w || y >= img.h) return; const i = (y * img.w + x) * 4; img.px[i] = c[0]; img.px[i + 1] = c[1]; img.px[i + 2] = c[2]; };
for (let gz = Z0; gz <= Z1; gz++) for (let gx = X0; gx <= X1; gx++) {
  const k = gz * nx + gx; if (H[k] < -900) continue;
  let c = [26, 30, 36];
  if (drv[k]) c = [52, 58, 68];
  if (F[k] & 1) c = [96, 104, 116];
  if (drv[k] && (F[k] & 1)) c = [150, 160, 175];
  if (clr[k] >= CL) c = [c[0] + 10, c[1] + 60, c[2] + 10];
  if (F[k] & 2) c = [80, 40, 40];
  if (B[k]) c = [120, 30, 30];
  if (F[k] & 8 && !B[k]) c = [200, 120, 40];
  const px = (gx - X0) * SC, py = (gz - Z0) * SC;
  for (let dy = 0; dy < SC; dy++) for (let dx = 0; dx < SC; dx++) setPx(px + dx, py + dy, c);
}
// step breaks: red line between cells whose height differs by more than MS
for (let gz = Z0; gz <= Z1; gz++) for (let gx = X0; gx <= X1; gx++) {
  const k = gz * nx + gx; if (!drv[k]) continue;
  const px = (gx - X0) * SC, py = (gz - Z0) * SC;
  for (const [dx, dz] of [[1, 0], [0, 1]]) {
    const a = gx + dx, b = gz + dz; if (a > X1 || b > Z1) continue; const nk = b * nx + a; if (!drv[nk]) continue;
    if (Math.abs(H[nk] - H[k]) > MS) { for (let t = 0; t < SC; t++) { setPx(px + (dx ? SC - 1 : t * 0 + 0) + dx, py + (dz ? SC - 1 : 0) + t, [255, 40, 40]); } }
  }
}
const leg = `CROP x[${(X0 * res + x0).toFixed(0)},${(X1 * res + x0).toFixed(0)}] z[${(Z0 * res + z0).toFixed(0)},${(Z1 * res + z0).toFixed(0)}] CL>=${CL} MS=${MS}`;
text(img, leg, 6, 6, [255, 255, 0], 1);
fs.writeFileSync(process.env.OUT || '/home/user/shots/maskview.png', png(W, Hh, img.px));
console.log('wrote', process.env.OUT, leg);
