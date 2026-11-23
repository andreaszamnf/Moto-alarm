// TPU grommet for the cable hole in the box's end wall: it replaces a cable gland.
//
// From the outside in:
// - a boot, 12 mm long, tapering towards the cable, with three V grooves, so that the cable
//   bends gradually there instead of at the wall (like the boot on a charger cable);
// - a flange that stays outside, with a raised ring on its face that is squeezed against the
//   wall and seals it;
// - a core through the wall, a little wider than the hole;
// - a 45-degree lip that squeezes through the hole and catches on the inside.
// The cable hole is a little wider than the cable, with three thin rings narrower than the
// cable that grip it and seal it, like the lips of an oil seal; both its ends are flared.
//
// Printed in TPU standing on the boot's tip (every overhang is 45 degrees or less), with a
// brim. Writes cad/lastixo-kalodiou-<d>mm.stl for cables of 3.5, 4.5 and 5.5 mm; each takes
// about half a millimetre either way. HOLE and WALL must match GLAND_D and WALL in
// cad/kouti.py. Usage: node cad/lastixo-kalodiou.mjs
import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HOLE = 12.5;                   // the hole in the box
const WALL = 2.6;                    // the wall it goes through
const CABLES = [3.5, 4.5, 5.5];      // cable diameters, mm
const FLANGE = 16.5;                 // outside flange diameter
const LIP = 15.0;                    // widest point of the lip inside
const TIP = 11.2;                    // its narrow end, smaller than the hole, to start it in
const BOOT = 12.0;                   // boot length outside
const BOOT_BASE = 6.0;               // boot radius where it meets the flange
const GROOVES = [3.5, 6.5, 9.5];     // boot grooves (height from the boot's tip)
const SEGMENTS = 96;

// half-section (radius, height), counter-clockwise, from the boot's tip at the bottom
function profile(cable) {
  const bore = (cable + 0.4) / 2;        // cable hole
  const rib = (cable - 0.8) / 2;         // the sealing rings grip 0.4 mm deep
  const tip = bore + 2.0;                // boot radius at its tip
  const boot = (z) => tip + ((BOOT_BASE - tip) * z) / BOOT;
  const core = HOLE / 2 + 0.15;
  const f = FLANGE / 2;
  const p = [[bore + 0.6, 0], [tip, 0]];
  // the upper side of each groove is a little longer, so that with the boot's taper it stays
  // under 45 degrees
  for (const g of GROOVES) p.push([boot(g - 0.8), g - 0.8], [boot(g) - 0.8, g], [boot(g + 1.0), g + 1.0]);
  const zf = BOOT + (f - BOOT_BASE) + 1.0;          // the flange's face towards the wall
  p.push([BOOT_BASE, BOOT], [f, BOOT + (f - BOOT_BASE)], [f, zf]);
  p.push([7.8, zf], [7.4, zf + 0.4], [7.0, zf]);   // raised sealing ring
  const zc = zf + WALL;                             // the wall's inside face
  const z3 = zc + (LIP / 2 - core), z4 = z3 + (LIP / 2 - TIP / 2);
  p.push([core, zf], [core, zc], [LIP / 2, z3], [TIP / 2, z4]);
  p.push([bore + 0.6, z4], [bore, z4 - 0.6]);       // flared inner end
  for (const r of [zf + WALL / 2, 8.0, 1.6]) p.push([bore, r + 0.6], [rib, r], [bore, r - 0.6]);
  p.push([bore, 0.6]);                              // flared outer end, back to the start
  return p;
}

function revolve(prof) {
  const at = (p, j) => {
    const t = (2 * Math.PI * (j % SEGMENTS)) / SEGMENTS;   // the last column is the first one
    return [p[0] * Math.cos(t), p[0] * Math.sin(t), p[1]];
  };
  const tris = [];
  for (let k = 0; k < prof.length; k++) {
    const p = prof[k], q = prof[(k + 1) % prof.length];
    for (let j = 0; j < SEGMENTS; j++) {
      const a = at(p, j), b = at(q, j), c = at(q, j + 1), d = at(p, j + 1);
      tris.push([a, b, c], [a, c, d]);
    }
  }
  // outward normals: the enclosed volume must come out positive
  const vol = tris.reduce((s, [a, b, c]) => s + (a[0] * (b[1] * c[2] - b[2] * c[1])
    - a[1] * (b[0] * c[2] - b[2] * c[0]) + a[2] * (b[0] * c[1] - b[1] * c[0])) / 6, 0);
  return vol > 0 ? { tris, vol } : { tris: tris.map(([a, b, c]) => [a, c, b]), vol: -vol };
}

function closed(tris) {
  const edges = new Map();
  const key = (p) => p.map((v) => v.toFixed(5)).join(',');
  for (const t of tris)
    for (let k = 0; k < 3; k++) {
      const e = key(t[k]) + '>' + key(t[(k + 1) % 3]);
      edges.set(e, (edges.get(e) || 0) + 1);
    }
  for (const [e, n] of edges) {
    const [p, q] = e.split('>');
    if (n !== 1 || edges.get(q + '>' + p) !== 1) return false;
  }
  return true;
}

// no overhang steeper than 45 degrees when printed standing on the boot's tip
function printable(prof) {
  for (let k = 0; k < prof.length; k++) {
    const [r0, z0] = prof[k], [r1, z1] = prof[(k + 1) % prof.length];
    const outside = k < prof.findIndex(([r]) => r === TIP / 2);     // outer contour first
    const dz = z1 - z0, dr = r1 - r0;
    if (outside && dz > 0 && dr > dz + 1e-9) return false;          // grows out faster than up
    if (!outside && dz < 0 && dr > -dz + 1e-9) return false;        // bore narrows faster than up
  }
  return true;
}

function stl(tris, title) {
  const buf = Buffer.alloc(84 + tris.length * 50);
  buf.write(title.slice(0, 80), 0, 'ascii');
  buf.writeUInt32LE(tris.length, 80);
  tris.forEach((t, i) => {
    const u = [0, 1, 2].map((k) => t[1][k] - t[0][k]), w = [0, 1, 2].map((k) => t[2][k] - t[0][k]);
    const n = [u[1] * w[2] - u[2] * w[1], u[2] * w[0] - u[0] * w[2], u[0] * w[1] - u[1] * w[0]];
    const l = Math.hypot(...n) || 1;
    [...n.map((v) => v / l), ...t.flat()].forEach((v, k) => buf.writeFloatLE(v, 84 + i * 50 + k * 4));
  });
  return buf;
}

const here = dirname(fileURLToPath(import.meta.url));
for (const cable of CABLES) {
  const prof = profile(cable);
  const { tris, vol } = revolve(prof);
  if (!closed(tris)) throw new Error(`grommet for ${cable} mm is not a closed solid`);
  if (!printable(prof)) throw new Error(`grommet for ${cable} mm has an overhang over 45 degrees`);
  const file = join(here, `lastixo-kalodiou-${cable}mm.stl`);
  writeFileSync(file, stl(tris, `hornet-alarm cable grommet for a ${cable} mm cable, TPU, mm`));
  const height = Math.max(...prof.map(([, z]) => z));
  console.log(`${file}: ${FLANGE} mm wide, ${height.toFixed(1)} mm long, ${(vol / 1000).toFixed(2)} cm3`);
}
