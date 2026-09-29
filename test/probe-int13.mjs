import { readFile } from 'node:fs/promises';
import { initializeCPU } from '../src/cpu.js';
import { newMachine, runOn, h4, h2 } from './harness.js';
import { DiskImage, SECTOR_BYTES } from '../src/disk.js';

await initializeCPU(await readFile(new URL('../src/wasm/kernel.wasm', import.meta.url)));

const GEO = { cylinders: 40, heads: 2, sectorsPerTrack: 9, totalSectors: 720 };
const bytes = new Uint8Array(GEO.totalSectors * SECTOR_BYTES);
for (let s = 0; s < GEO.totalSectors; s++) bytes.fill(s & 0xff, s * SECTOR_BYTES, (s + 1) * SECTOR_BYTES);

const m = newMachine({ bios: true });
m.floppyDisk = new DiskImage(bytes, GEO, { copy: false });
m.floppy = GEO;
m.cpu.setFloppyGeometry(GEO.cylinders, GEO.heads, GEO.sectorsPerTrack);

// int 13h with AX=0201 CX=0001 DH=0 BX=0100 ES=2000
const r = runOn(m, [0xcd, 0x13, 0xf4], {
  regs: { ax: 0x0201, cx: 0x0001, dx: 0x0000, bx: 0x0100 },
  es: 0x2000,
});
console.log('cf=', (r.cpu.flags & 1), 'ax=', h4(r.cpu.r[0]), 'steps=', r.steps, 'error=', r.error ?? '');
console.log('[2000:0100] =', h2(r.cpu.rd8(0x2000 * 16 + 0x100)), 'want 00 (sector 1 marker = LBA 0)');
console.log('floppyDisk present:', !!m.floppyDisk, 'hardDisk:', !!m.hardDisk, 'attached:', m.hardDiskAttached);

// Drive 0x80 read (no hard disk attached) — expect CF=1.
const m2 = newMachine({ bios: true });
m2.floppyDisk = new DiskImage(bytes, GEO, { copy: false });
m2.cpu.setFloppyGeometry(GEO.cylinders, GEO.heads, GEO.sectorsPerTrack);
const r2 = runOn(m2, [0xcd, 0x13, 0xf4], { regs: { ax: 0x0201, cx: 0x0001, dx: 0x0080, bx: 0x0100 }, es: 0x2000 });
console.log('drive 0x80: cf=', (r2.cpu.flags & 1), 'ah=', h2((r2.cpu.r[0] >> 8) & 0xff));
