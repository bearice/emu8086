/**
 * BIOS standard suite — black-box tests for the firmware interrupt surface
 * (INT 08h/0Bh/0Ch/10h/11h/12h/13h/14h/15h/16h/17h/19h/1Ah/70h-77h) against the
 * IBM PC/AT BIOS + Microsoft MS-DOS 5 conventions the DOS boot sector relies on.
 *
 * Programs are hand-assembled: `int Nn` + `hlt`, with registers/segments set up
 * front. Assertions look at registers, flags, the BIOS Data Area (0040:xxxx),
 * the interrupt vector table (0000:0000) and text video memory (B800:0000) —
 * never at firmware internals.
 *
 * Expected results are written from the published BIOS interface, not from this
 * implementation's behaviour, so a failure is a standards finding.
 */
import {
  Suite, newMachine, runOn, wantRegs, want8, wantFlags, wantMem, wantBda, wantNoError,
  h2, h4, GPR, HLT, CF, w16,
} from './harness.js';
import { DiskImage, SECTOR_BYTES, HARD_DISK_GEOMETRY } from '../src/disk.js';
import { VRAM } from '../src/machine.js';

const COLS = 80;
const ROWS = 25;
// The current display model is intentionally 80x25 text-only. Other BIOS
// video modes are outside this suite's supported hardware surface.
// BIOS text pages use a 4 KiB stride in B800 memory; the 80x25 visible cells
// occupy 4000 bytes within each page.
const PAGE_BYTES = 0x1000;
/** A text-mode blank cell is space (0x20) or NUL (0x00); both render blank. */
const isBlank = (ch) => ch === 0x00 || ch === 0x20;
const FLOPPY_GEOMETRY = Object.freeze({ cylinders: 40, heads: 2, sectorsPerTrack: 9, totalSectors: 720 });

/** Text-mode cell [char, attribute] for a page/row/column. */
const cellAt = (m, page, row, col) => {
  const a = VRAM + page * PAGE_BYTES + (row * COLS + col) * 2;
  return [m.cpu.mem[a], m.cpu.mem[a + 1]];
};
const setCell = (m, page, row, col, ch, attr) => {
  const a = VRAM + page * PAGE_BYTES + (row * COLS + col) * 2;
  m.cpu.mem[a] = ch;
  m.cpu.mem[a + 1] = attr;
};
const cursorOf = (m, page = 0) => m.cpu.rd16(0x450 + page * 2);
const setCursor = (m, page, row, col) => m.cpu.wr16(0x450 + page * 2, ((row & 0xff) << 8) | (col & 0xff));
const bda8 = (m, off) => m.cpu.mem[0x400 + off];
const bda16 = (m, off) => m.cpu.rd16(0x400 + off);
const bda32 = (m, off) => (bda16(m, off) | (bda16(m, off + 2) << 16)) >>> 0;

/** Machine with BIOS state installed; optional synthetic floppy / hard disk. */
function machine(opts = {}) {
  const m = newMachine({
    bios: true,
    input: opts.input,
    ports: opts.ports,
    floppy: opts.floppy ? { read: opts.floppy.read, write: opts.floppy.write } : undefined,
    hardDisk: opts.hardDisk ? { read: opts.hardDisk.read, write: opts.hardDisk.write } : undefined,
  });
  if (opts.floppy) {
    m.floppyDisk = new DiskImage(opts.floppy, FLOPPY_GEOMETRY, { copy: false });
    m.floppy = FLOPPY_GEOMETRY;
    m.floppyImage = m.floppyDisk.bytes;
    m.cpu.setFloppyGeometry(FLOPPY_GEOMETRY.cylinders, FLOPPY_GEOMETRY.heads, FLOPPY_GEOMETRY.sectorsPerTrack);
  }
  if (opts.hardDisk) m.attachHardDisk(opts.hardDisk);
  return m;
}

/** Issue `int Nn` with the given registers, then hlt. */
function call(m, n, regs = {}, opts = {}) {
  return runOn(m, [0xcd, n, HLT], { regs, ...opts });
}

const lba = (geometry, c, h, s) => (c * geometry.heads + h) * geometry.sectorsPerTrack + (s - 1);

/** Floppy image where every byte of a sector is its LBA (mod 256). */
function markerFloppy() {
  const bytes = new Uint8Array(FLOPPY_GEOMETRY.totalSectors * SECTOR_BYTES);
  for (let sector = 0; sector < FLOPPY_GEOMETRY.totalSectors; sector++) {
    bytes.fill(sector & 0xff, sector * SECTOR_BYTES, (sector + 1) * SECTOR_BYTES);
  }
  return bytes;
}
const sectorMarker = (sector) => new Uint8Array(SECTOR_BYTES).fill(sector & 0xff);

// ============================================================= INT 10h ======
function video(check, s) {
  const run = (regs, opts) => call(machine(), 0x10, regs, opts);

  s.run('10:00 sets mode 3 and initialises the text BDA', () => {
    const r = run({ ax: 0x0003 });
    const errs = wantNoError(r);
    errs.push(...wantBda(r.cpu, 0x49, [3]));
    errs.push(...wantBda(r.cpu, 0x4a, [COLS, 0]));
    errs.push(...wantBda(r.cpu, 0x4c, w16(COLS * ROWS * 2))); // page size = 0x0FA0
    errs.push(...wantBda(r.cpu, 0x4e, [0, 0]));         // current page offset
    errs.push(...wantBda(r.cpu, 0x62, [0]));            // active page
    errs.push(...wantBda(r.cpu, 0x50, [0, 0]));         // page 0 cursor
    return errs;
  });

  s.run('10:00 clears the active page to NUL with attribute 07h', () => {
    const m = machine();
    for (let i = 0; i < COLS * ROWS; i++) setCell(m, 0, (i / COLS) | 0, i % COLS, 0x41, 0x1f);
    const r = call(m, 0x10, { ax: 0x0003 });
    const errs = wantNoError(r);
    for (let row = 0; row < ROWS; row++) {
      for (const col of [0, 39, 79]) {
        const [ch, attr] = cellAt(r.m, 0, row, col);
        if (!isBlank(ch) || attr !== 0x07) errs.push(`cell(${row},${col})=${h2(ch)} ${h2(attr)} want blank 07`);
      }
    }
    return errs;
  });

  s.run('10:01 sets the cursor shape stored in the BDA', () => {
    const r = run({ ax: 0x0106, cx: 0x0607 });
    const errs = wantNoError(r);
    errs.push(...wantBda(r.cpu, 0x60, [0x07, 0x06]));
    return errs;
  });

  s.run('10:02 sets the cursor position for a page', () => {
    const r = run({ ax: 0x0200, dx: (5 << 8) | 10, bx: 1 << 8 });
    const errs = wantNoError(r);
    if (cursorOf(r.m, 1) !== ((5 << 8) | 10)) errs.push(`page1 cursor=${h4(cursorOf(r.m, 1))} want 050A`);
    return errs;
  });

  s.run('10:03 reads cursor position and shape', () => {
    const m = machine();
    setCursor(m, 2, 7, 9);
    m.cpu.wr16(0x460, 0x0b0c);
    const r = call(m, 0x10, { ax: 0x0300, bx: 2 << 8 });
    const errs = wantNoError(r);
    errs.push(...want8(r.cpu, { dh: 7, dl: 9, bh: 2 }));
    errs.push(...wantRegs(r.cpu, { cx: 0x0b0c }));
    return errs;
  });

  s.run('10:05 selects the active page from AL', () => {
    const r = run({ ax: 0x0501 });
    const errs = wantNoError(r);
    // IBM: AH=05h takes the page in AL, not BH.
    errs.push(...wantBda(r.cpu, 0x62, [1]));
    return errs;
  });

  s.run('10:06 scrolls the whole screen up by one line', () => {
    const m = machine();
    setCell(m, 0, 0, 0, 0x41, 0x07);
    setCell(m, 0, 1, 0, 0x42, 0x07);
    setCell(m, 0, 24, 79, 0x43, 0x07);
    const r = call(m, 0x10, { ax: 0x0601, cx: 0, dx: ((ROWS - 1) << 8) | (COLS - 1), bx: 0x0700 });
    const errs = wantNoError(r);
    const moved = cellAt(r.m, 0, 0, 0);
    if (moved[0] !== 0x42) errs.push(`row0 col0=${h2(moved[0])} want 42 (old row 1)`);
    const blank = cellAt(r.m, 0, ROWS - 1, 0);
    if (!isBlank(blank[0]) || blank[1] !== 0x07) errs.push(`blank row=${h2(blank[0])} ${h2(blank[1])} want blank 07`);
    return errs;
  });

  s.run('10:06 with AL=0 blanks the whole window', () => {
    const m = machine();
    setCell(m, 0, 3, 4, 0x5a, 0x1f);
    const r = call(m, 0x10, { ax: 0x0600, cx: 0, dx: ((ROWS - 1) << 8) | (COLS - 1), bx: 0x0700 });
    const errs = wantNoError(r);
    const [ch, attr] = cellAt(r.m, 0, 3, 4);
    if (!isBlank(ch) || attr !== 0x07) errs.push(`(3,4)=${h2(ch)} ${h2(attr)} want blank 07`);
    return errs;
  });

  s.run('10:06 scrolls only the requested sub-window', () => {
    const m = machine();
    setCell(m, 0, 1, 0, 0x41, 0x07);
    setCell(m, 0, 2, 0, 0x42, 0x07);
    setCell(m, 0, 3, 0, 0x43, 0x07);
    setCell(m, 0, 4, 0, 0x44, 0x07);
    const r = call(m, 0x10, { ax: 0x0601, cx: 2 << 8, dx: (4 << 8) | 79, bx: 0x0700 });
    const errs = wantNoError(r);
    const outside = cellAt(r.m, 0, 1, 0)[0];
    const top = cellAt(r.m, 0, 2, 0)[0];
    const blank = cellAt(r.m, 0, 4, 0);
    if (outside !== 0x41) errs.push(`row1=${h2(outside)} want 41 (outside window)`);
    if (top !== 0x43) errs.push(`row2=${h2(top)} want 43 (old row 3)`);
    if (blank[0] !== 0 && !isBlank(blank[0])) errs.push(`row4=${h2(blank[0])} want blank`);
    return errs;
  });

  s.run('10:07 scrolls the whole screen down by one line', () => {
    const m = machine();
    setCell(m, 0, 24, 0, 0x41, 0x07);
    setCell(m, 0, 23, 0, 0x42, 0x07);
    const r = call(m, 0x10, { ax: 0x0701, cx: 0, dx: ((ROWS - 1) << 8) | (COLS - 1), bx: 0x0700 });
    const errs = wantNoError(r);
    const bottom = cellAt(r.m, 0, 24, 0)[0];
    const top = cellAt(r.m, 0, 0, 0);
    if (bottom !== 0x42) errs.push(`row24=${h2(bottom)} want 42 (old row 23)`);
    if (!isBlank(top[0]) || top[1] !== 0x07) errs.push(`row0=${h2(top[0])} ${h2(top[1])} want blank 07`);
    return errs;
  });

  s.run('10:08 reads the character and attribute at the cursor', () => {
    const m = machine();
    setCell(m, 0, 3, 5, 0x5a, 0x2e);
    setCursor(m, 0, 3, 5);
    const r = call(m, 0x10, { ax: 0x0800, bx: 0 });
    const errs = wantNoError(r);
    errs.push(...want8(r.cpu, { al: 0x5a, ah: 0x2e }));
    return errs;
  });

  s.run('10:09 writes CX copies of a character with attribute, cursor stays', () => {
    const m = machine();
    setCursor(m, 0, 0, 0);
    setCell(m, 0, 0, 3, 0x58, 0x2e);
    const r = call(m, 0x10, { ax: 0x0941, bx: 0x001c, cx: 3 });
    const errs = wantNoError(r);
    for (let col = 0; col < 3; col++) {
      const [ch, attr] = cellAt(r.m, 0, 0, col);
      if (ch !== 0x41 || attr !== 0x1c) errs.push(`(0,${col})=${h2(ch)} ${h2(attr)} want 41 1C`);
    }
    const [extraChar, extraAttr] = cellAt(r.m, 0, 0, 3);
    if (extraChar !== 0x58 || extraAttr !== 0x2e) errs.push('wrote past the requested count');
    if (cursorOf(r.m, 0) !== 0) errs.push(`cursor moved to ${h4(cursorOf(r.m, 0))}, AH=09h must not move it`);
    return errs;
  });

  s.run('10:09 with CX=0 writes nothing', () => {
    const m = machine();
    setCursor(m, 0, 0, 0);
    setCell(m, 0, 0, 0, 0x58, 0x2e);
    const r = call(m, 0x10, { ax: 0x0959, bx: 0x001c, cx: 0 });
    const errs = wantNoError(r);
    const [ch, attr] = cellAt(r.m, 0, 0, 0);
    if (ch !== 0x58 || attr !== 0x2e) errs.push(`(0,0)=${h2(ch)} ${h2(attr)} want untouched 58 2E`);
    return errs;
  });

  s.run('10:0A writes a character and keeps the attribute', () => {
    const m = machine();
    setCell(m, 0, 1, 2, 0x20, 0x30);
    setCell(m, 0, 1, 3, 0x20, 0x30);
    setCursor(m, 0, 1, 2);
    const r = call(m, 0x10, { ax: 0x0a42, bx: 0, cx: 2 });
    const errs = wantNoError(r);
    for (const col of [2, 3]) {
      const [ch, attr] = cellAt(r.m, 0, 1, col);
      if (ch !== 0x42 || attr !== 0x30) errs.push(`(1,${col})=${h2(ch)} ${h2(attr)} want 42 30`);
    }
    if (cursorOf(r.m, 0) !== ((1 << 8) | 2)) errs.push(`cursor=${h4(cursorOf(r.m, 0))} want 0102`);
    return errs;
  });

  s.run('10:0E teletype writes at the cursor and advances it', () => {
    const m = machine();
    setCursor(m, 0, 0, 0);
    const r = call(m, 0x10, { ax: 0x0e41, bx: 0 });
    const errs = wantNoError(r);
    const [ch, attr] = cellAt(r.m, 0, 0, 0);
    if (ch !== 0x41) errs.push(`(0,0)=${h2(ch)} want 41`);
    if (attr !== 0x07) errs.push(`attribute=${h2(attr)} want 07`);
    if (cursorOf(r.m, 0) !== 1) errs.push(`cursor=${h4(cursorOf(r.m, 0))} want 0001`);
    return errs;
  });

  s.run('10:0E wraps at the right margin', () => {
    const m = machine();
    setCursor(m, 0, 0, 79);
    const r = call(m, 0x10, { ax: 0x0e58, bx: 0 });
    const errs = wantNoError(r);
    if (cellAt(r.m, 0, 0, 79)[0] !== 0x58) errs.push('character did not land in the last column');
    if (cursorOf(r.m, 0) !== (1 << 8)) errs.push(`cursor=${h4(cursorOf(r.m, 0))} want 0100`);
    return errs;
  });

  s.run('10:0E carriage return zeroes the column only', () => {
    const m = machine();
    setCursor(m, 0, 4, 33);
    const r = call(m, 0x10, { ax: 0x0e0d, bx: 0 });
    const errs = wantNoError(r);
    if (cursorOf(r.m, 0) !== (4 << 8)) errs.push(`cursor=${h4(cursorOf(r.m, 0))} want 0400`);
    return errs;
  });

  s.run('10:0E line feed advances the row only', () => {
    const m = machine();
    setCursor(m, 0, 4, 33);
    const r = call(m, 0x10, { ax: 0x0e0a, bx: 0 });
    const errs = wantNoError(r);
    if (cursorOf(r.m, 0) !== ((5 << 8) | 33)) errs.push(`cursor=${h4(cursorOf(r.m, 0))} want 0521`);
    return errs;
  });

  s.run('10:0E backspace moves the cursor back without erasing', () => {
    const m = machine();
    setCell(m, 0, 2, 10, 0x41, 0x07);
    setCursor(m, 0, 2, 11);
    const r = call(m, 0x10, { ax: 0x0e08, bx: 0 });
    const errs = wantNoError(r);
    if (cursorOf(r.m, 0) !== ((2 << 8) | 10)) errs.push(`cursor=${h4(cursorOf(r.m, 0))} want 020A`);
    if (cellAt(r.m, 0, 2, 10)[0] !== 0x41) errs.push('backspace erased the character');
    return errs;
  });

  s.run('10:0E scrolls the page when the cursor passes the bottom line', () => {
    const m = machine();
    setCell(m, 0, 23, 0, 0x41, 0x07);
    setCell(m, 0, 24, 0, 0x42, 0x07);
    setCursor(m, 0, 24, 0);
    const r = call(m, 0x10, { ax: 0x0e0a, bx: 0 });
    const errs = wantNoError(r);
    if (cellAt(r.m, 0, 22, 0)[0] !== 0x41) errs.push('old row 23 did not move to row 22');
    if (cellAt(r.m, 0, 23, 0)[0] !== 0x42) errs.push('old row 24 did not move to row 23');
    const bottom = cellAt(r.m, 0, 24, 0);
    if (!isBlank(bottom[0])) errs.push(`bottom line=${h2(bottom[0])} want blank`);
    if (cursorOf(r.m, 0) !== ((ROWS - 1) << 8)) errs.push(`cursor=${h4(cursorOf(r.m, 0))} want 1800`);
    return errs;
  });

  s.run('10:0E writes to the page in BH', () => {
    const m = machine();
    setCursor(m, 1, 0, 0);
    const r = call(m, 0x10, { ax: 0x0e43, bx: 0x0100 });
    const errs = wantNoError(r);
    if (cellAt(r.m, 1, 0, 0)[0] !== 0x43) errs.push('page 1 was not written');
    if (!isBlank(cellAt(r.m, 0, 0, 0)[0])) errs.push('page 0 was written as well');
    return errs;
  });

  s.run('10:0F reports mode, columns and active page', () => {
    const m = machine();
    m.cpu.wr8(0x449, 3);
    m.cpu.wr16(0x44a, COLS);
    m.cpu.wr8(0x462, 2);
    const r = call(m, 0x10, { ax: 0x0f00 });
    const errs = wantNoError(r);
    errs.push(...want8(r.cpu, { al: 3, ah: COLS, bh: 2 }));
    return errs;
  });
}

// ============================================================= INT 13h ======
function disk(check, s) {
  const hdMachine = (extra = {}) => {
    const m = machine(extra);
    m.hardDisk = DiskImage.blank(HARD_DISK_GEOMETRY);
    m.hardDiskAttached = true;
    m.cpu.setHardDiskGeometry(HARD_DISK_GEOMETRY.cylinders, HARD_DISK_GEOMETRY.heads, HARD_DISK_GEOMETRY.sectorsPerTrack);
    m.cpu.wr8(0x475, 1);
    return m;
  };
  // CX packs the cylinder (CH = low 8 bits, CL bits 6-7 = high 2 bits) with the
  // 1-based sector in CL bits 0-5; the head travels in DH, the drive in DL.
  const chs = (cylinder, head, sector) =>
    (((cylinder & 0xff) << 8) | ((sector & 0x3f) | (((cylinder >> 8) & 3) << 6))) & 0xffff;
  const dhdl = (head, drive) => ((head & 0xff) << 8) | (drive & 0xff);

  s.run('13:02 reads one sector into ES:BX', () => {
    const m = machine({ floppy: markerFloppy() });
    const r = call(m, 0x13, { ax: 0x0201, cx: chs(0, 0, 1), dx: 0, bx: 0x0100 }, { es: 0x2000 });
    const errs = wantNoError(r);
    errs.push(...wantFlags(r.cpu, { cf: 0 }));
    errs.push(...want8(r.cpu, { ah: 0, al: 1 }));
    errs.push(...wantMem(r.cpu, 0x2000, 0x0100, Array.from(sectorMarker(0))));
    return errs;
  });

  s.run('13:02 decodes the 10-bit cylinder from CH and CL bits 6-7', () => {
    const m = machine({ floppy: markerFloppy() });
    // cylinder 17, head 1, sector 3 -> LBA (17*2+1)*9+2 = 317
    const r = call(m, 0x13, { ax: 0x0201, cx: chs(17, 1, 3), dx: dhdl(1, 0), bx: 0x0100 }, { es: 0x2000 });
    const errs = wantNoError(r);
    errs.push(...wantFlags(r.cpu, { cf: 0 }));
    errs.push(...wantMem(r.cpu, 0x2000, 0x0100, Array.from(sectorMarker(317))));
    return errs;
  });

  s.run('13:02 multi-sector reads wrap to the next head', () => {
    const m = machine({ floppy: markerFloppy() });
    // 9 sectors per track: sector 8, count 4 -> LBA 7,8,9,10 = (0,0,8),(0,0,9),(0,1,1),(0,1,2)
    const r = call(m, 0x13, { ax: 0x0204, cx: chs(0, 0, 8), dx: 0, bx: 0x0100 }, { es: 0x2000 });
    const errs = wantNoError(r);
    errs.push(...want8(r.cpu, { al: 4 }));
    const want = [7, 8, 9, 10].flatMap((n) => Array.from(sectorMarker(n)));
    errs.push(...wantMem(r.cpu, 0x2000, 0x0100, want));
    return errs;
  });

  s.run('13:02 rejects sector 0 (CHS sectors are 1-based)', () => {
    const r = call(machine({ floppy: markerFloppy() }), 0x13, { ax: 0x0201, cx: 0, dx: 0, bx: 0x0100 }, { es: 0x2000 });
    const errs = wantNoError(r);
    errs.push(...wantFlags(r.cpu, { cf: 1 }));
    return errs;
  });

  s.run('13:02 rejects a zero sector count', () => {
    const r = call(machine({ floppy: markerFloppy() }), 0x13, { ax: 0x0200, cx: chs(0, 0, 1), dx: 0, bx: 0x0100 }, { es: 0x2000 });
    return wantNoError(r).concat(wantFlags(r.cpu, { cf: 1 }));
  });

  s.run('13:02 reports an unattached drive', () => {
    const r = call(machine(), 0x13, { ax: 0x0201, cx: chs(0, 0, 1), dx: 0x81, bx: 0x0100 }, { es: 0x2000 });
    const errs = wantNoError(r);
    errs.push(...wantFlags(r.cpu, { cf: 1 }));
    return errs;
  });

  s.run('13:03 writes sectors from ES:BX', () => {
    const m = machine({ floppy: markerFloppy() });
    const data = new Uint8Array(SECTOR_BYTES).fill(0xc7);
    const r = call(m, 0x13, { ax: 0x0301, cx: chs(2, 1, 4), dx: dhdl(1, 0), bx: 0x0100 }, {
      es: 0x2000,
      data: [{ seg: 0x2000, off: 0x0100, bytes: Array.from(data) }],
    });
    const errs = wantNoError(r);
    errs.push(...wantFlags(r.cpu, { cf: 0 }));
    errs.push(...want8(r.cpu, { ah: 0, al: 1 }));
    const lbaOf = lba(FLOPPY_GEOMETRY, 2, 1, 4);
    const written = r.m.floppyDisk.bytes.slice(lbaOf * SECTOR_BYTES, (lbaOf + 1) * SECTOR_BYTES);
    if (written[0] !== 0xc7 || written[511] !== 0xc7) errs.push('sector was not written to the disk image');
    return errs;
  });

  s.run('13:04 verifies sectors without transferring data', () => {
    const r = call(machine({ floppy: markerFloppy() }), 0x13, { ax: 0x0402, cx: chs(0, 0, 1), dx: 0, bx: 0x0100 }, { es: 0x2000 });
    const errs = wantNoError(r);
    errs.push(...wantFlags(r.cpu, { cf: 0 }));
    errs.push(...want8(r.cpu, { ah: 0 }));
    return errs;
  });

  s.run('13:00 resets the controller', () => {
    const r = call(machine({ floppy: markerFloppy() }), 0x13, { ax: 0x0000, dx: 0 });
    const errs = wantNoError(r);
    errs.push(...wantFlags(r.cpu, { cf: 0 }));
    errs.push(...want8(r.cpu, { ah: 0 }));
    return errs;
  });

  s.run('13:01 returns the last drive status', () => {
    const m = machine({ floppy: markerFloppy() });
    call(m, 0x13, { ax: 0x0201, cx: 0, dx: 0, bx: 0x0100 }, { es: 0x2000 });   // failing read (sector 0)
    const r = call(m, 0x13, { ax: 0x0100, dx: 0 });
    const errs = wantNoError(r);
    const ah = (r.cpu.r[GPR.ax] >> 8) & 0xff;
    if (ah === 0) errs.push('AH=01h reported success after a failed operation');
    return errs;
  });

  s.run('13:08 reports floppy geometry and the drive count', () => {
    const r = call(machine({ floppy: markerFloppy() }), 0x13, { ax: 0x0800, dx: 0, di: 0 }, { es: 0x2000 });
    const errs = wantNoError(r);
    errs.push(...wantFlags(r.cpu, { cf: 0 }));
    errs.push(...want8(r.cpu, { ah: 0, dh: FLOPPY_GEOMETRY.heads - 1, bh: 0 }));
    const ch = (r.cpu.r[GPR.cx] >> 8) & 0xff;
    const cl = r.cpu.r[GPR.cx] & 0xff;
    if (ch !== FLOPPY_GEOMETRY.cylinders - 1) errs.push(`CH=${h2(ch)} want ${h2(FLOPPY_GEOMETRY.cylinders - 1)}`);
    if (cl !== FLOPPY_GEOMETRY.sectorsPerTrack) errs.push(`CL=${h2(cl)} want ${h2(FLOPPY_GEOMETRY.sectorsPerTrack)}`);
    const dl = r.cpu.r[GPR.dx] & 0xff;
    if (dl !== 1) errs.push(`DL=${h2(dl)} want 01 (drive count)`);
    return errs;
  });

  s.run('13:08 encodes the high cylinder bits in CL bits 6-7', () => {
    const m = hdMachine();
    const r = call(m, 0x13, { ax: 0x0800, dx: 0x80, di: 0 }, { es: 0x2000 });
    const errs = wantNoError(r);
    errs.push(...wantFlags(r.cpu, { cf: 0 }));
    const max = HARD_DISK_GEOMETRY.cylinders - 1;   // 614 = 0x266 -> high bits 2
    const ch = (r.cpu.r[GPR.cx] >> 8) & 0xff;
    const cl = r.cpu.r[GPR.cx] & 0xff;
    if (ch !== (max & 0xff)) errs.push(`CH=${h2(ch)} want ${h2(max & 0xff)}`);
    if (cl !== ((HARD_DISK_GEOMETRY.sectorsPerTrack & 0x3f) | (((max >> 8) & 3) << 6))) {
      errs.push(`CL=${h2(cl)} want ${h2((HARD_DISK_GEOMETRY.sectorsPerTrack & 0x3f) | (((max >> 8) & 3) << 6))}`);
    }
    if (((r.cpu.r[GPR.dx] >> 8) & 0xff) !== HARD_DISK_GEOMETRY.heads - 1) {
      errs.push(`DH=${h2((r.cpu.r[GPR.dx] >> 8) & 0xff)} want ${h2(HARD_DISK_GEOMETRY.heads - 1)}`);
    }
    return errs;
  });

  s.run('13:08 points ES:DI at the disk parameter table', () => {
    const r = call(machine({ floppy: markerFloppy() }), 0x13, { ax: 0x0800, dx: 0, di: 0 }, { es: 0x2000 });
    const errs = wantNoError(r);
    if (r.cpu.s[0] === 0x2000 && r.cpu.r[GPR.di] === 0) errs.push('ES:DI was left unchanged');
    return errs;
  });

  s.run('13:15 reports a diskette drive as type 1', () => {
    const r = call(machine({ floppy: markerFloppy() }), 0x13, { ax: 0x1500, dx: 0, cx: 0 });
    const errs = wantNoError(r);
    errs.push(...wantFlags(r.cpu, { cf: 0 }));
    errs.push(...want8(r.cpu, { ah: 1 }));
    return errs;
  });

  s.run('13:15 reports a fixed disk as type 3 with its sector count', () => {
    const m = hdMachine();
    const r = call(m, 0x13, { ax: 0x1500, dx: 0x80, cx: 0 });
    const errs = wantNoError(r);
    errs.push(...wantFlags(r.cpu, { cf: 0 }));
    errs.push(...want8(r.cpu, { ah: 3 }));
    const total = (r.cpu.r[GPR.cx] << 16) | r.cpu.r[GPR.dx];
    if (total !== HARD_DISK_GEOMETRY.totalSectors) errs.push(`CX:DX=${total} want ${HARD_DISK_GEOMETRY.totalSectors}`);
    return errs;
  });

  s.run('13:15 reports no installed drive with CF=0 and AH=00', () => {
    const r = call(machine(), 0x13, { ax: 0x1500, dx: 0x81, cx: 0 });
    const errs = wantNoError(r);
    errs.push(...wantFlags(r.cpu, { cf: 0 }));
    // AH=00 is the no-drive result; CF is reserved for an invalid drive number.
    errs.push(...want8(r.cpu, { ah: 0 }));
    return errs;
  });

  s.run('13:02 reads a hard disk sector through the 10-bit cylinder', () => {
    const m = hdMachine();
    const lbaOf = lba(HARD_DISK_GEOMETRY, 300, 2, 5);
    m.hardDisk.bytes.fill(0x3c, lbaOf * SECTOR_BYTES, (lbaOf + 1) * SECTOR_BYTES);
    const r = call(m, 0x13, { ax: 0x0201, cx: chs(300, 2, 5), dx: dhdl(2, 0x80), bx: 0x0100 }, { es: 0x2000 });
    const errs = wantNoError(r);
    errs.push(...wantFlags(r.cpu, { cf: 0 }));
    errs.push(...wantMem(r.cpu, 0x2000, 0x0100, new Array(SECTOR_BYTES).fill(0x3c)));
    return errs;
  });
}

// ============================================================= INT 16h ======
function keyboard(check, s) {
  const withKey = (value) => ({ input: () => value });

  s.run('16:01 reports no key available with ZF=1', () => {
    const r = call(machine(withKey(-1)), 0x16, { ax: 0x0100 });
    const errs = wantNoError(r);
    errs.push(...wantFlags(r.cpu, { zf: 1 }));
    return errs;
  });

  s.run('16:01 returns the key with ZF=0 and leaves it in the buffer', () => {
    const r = call(machine(withKey(0x1e61)), 0x16, { ax: 0x0100 });
    const errs = wantNoError(r);
    errs.push(...wantFlags(r.cpu, { zf: 0 }));
    errs.push(...wantRegs(r.cpu, { ax: 0x1e61 }));
    return errs;
  });

  s.run('16:00 returns the key and clears the wait flag', () => {
    const r = call(machine(withKey(0x1e61)), 0x16, { ax: 0x0000 });
    const errs = wantNoError(r);
    errs.push(...wantRegs(r.cpu, { ax: 0x1e61 }));
    if (r.waiting) errs.push('AH=00h with a key available still blocked on input');
    return errs;
  });

  s.run('16:00 blocks when the buffer is empty', () => {
    const r = call(machine(withKey(-1)), 0x16, { ax: 0x0000 });
    return r.waiting ? [] : ['AH=00h with no key must block, it returned immediately'];
  });

  s.run('16:02 returns the shift state from the BDA', () => {
    const m = machine(withKey(-1));
    m.cpu.wr8(0x417, 0x42);
    const r = call(m, 0x16, { ax: 0x0200 });
    const errs = wantNoError(r);
    // IBM: AH=02h returns the keyboard flags byte (0040:0017) in AL.
    errs.push(...want8(r.cpu, { al: 0x42 }));
    return errs;
  });
}

// ============================================================= INT 19h ======
function bootstrap(check, s) {
  const bootableFloppy = () => {
    const bytes = new Uint8Array(FLOPPY_GEOMETRY.totalSectors * SECTOR_BYTES);
    bytes[0x00] = HLT;                       // stop as soon as the loader jumps there
    bytes[0x01] = 0xcd;
    bytes[0x1fe] = 0x55;
    bytes[0x1ff] = 0xaa;
    return bytes;
  };

  s.run('19:00 loads the boot sector at 0000:7C00 and jumps to it', () => {
    const r = call(machine({ floppy: bootableFloppy() }), 0x19, {});
    const errs = wantNoError(r);
    if (r.cpu.ip !== 0x7c01) errs.push(`ip=${h4(r.cpu.ip)} want 7C01 (the loaded sector starts with hlt)`);
    if (r.cpu.s[1] !== 0) errs.push(`cs=${h4(r.cpu.s[1])} want 0000`);
    if (r.cpu.s[3] !== 0) errs.push(`ds=${h4(r.cpu.s[3])} want 0000`);
    if (r.cpu.s[0] !== 0) errs.push(`es=${h4(r.cpu.s[0])} want 0000`);
    if (r.cpu.s[2] !== 0) errs.push(`ss=${h4(r.cpu.s[2])} want 0000`);
    if (r.cpu.mem[0x7c00] !== HLT) errs.push(`boot byte=${h2(r.cpu.mem[0x7c00])} want ${h2(HLT)}`);
    if (r.cpu.mem[0x7c01] !== 0xcd) errs.push('sector 1 was not loaded at 0000:7C00');
    return errs;
  });

  s.run('19:00 reports a non-bootable diskette with CF=1', () => {
    const r = call(machine({ floppy: markerFloppy() }), 0x19, {});
    const errs = wantNoError(r);
    errs.push(...wantFlags(r.cpu, { cf: 1 }));
    if (!r.halted) errs.push('a failed bootstrap must stop the machine');
    return errs;
  });

  s.run('19:00 reports CF=1 when no drive is attached', () => {
    const r = call(machine(), 0x19, {});
    const errs = wantNoError(r);
    errs.push(...wantFlags(r.cpu, { cf: 1 }));
    return errs;
  });
}

// ==================================================== INT 11h/12h/15h/1Ah ==
function systems(check, s) {
  s.run('11:00 equipment word reports the diskette drive in bit 0', () => {
    const withDisk = call(machine({ floppy: markerFloppy() }), 0x11, {});
    const without = call(machine(), 0x11, {});
    const errs = wantNoError(withDisk).concat(wantNoError(without));
    if (!(withDisk.cpu.r[GPR.ax] & 1)) errs.push('bit 0 must be set with a diskette drive');
    if (without.cpu.r[GPR.ax] & 1) errs.push('bit 0 must be clear with no diskette drive');
    return errs;
  });

  s.run('11:00 equipment word encodes the 80-column colour console in bits 4-5', () => {
    const r = call(machine(), 0x11, {});
    const errs = wantNoError(r);
    const video = (r.cpu.r[GPR.ax] >> 4) & 3;
    // IBM: equipment-list video mode 10b selects the 80-column colour display.
    if (video !== 2) errs.push(`bits 4-5=${video.toString(2)} want 10 (80-column colour)`);
    return errs;
  });

  s.run('12:00 memory size returns 640 KB', () => {
    const r = call(machine(), 0x12, {});
    const errs = wantNoError(r);
    errs.push(...wantRegs(r.cpu, { ax: 640 }));
    return errs;
  });

  s.run('15:C0 returns the configuration table at F000:0210', () => {
    const r = call(machine(), 0x15, { ax: 0xc000, bx: 0 }, { es: 0 });
    const errs = wantNoError(r);
    errs.push(...wantFlags(r.cpu, { cf: 0 }));
    if (r.cpu.r[GPR.bx] !== 0x0210) errs.push(`bx=${h4(r.cpu.r[GPR.bx])} want 0210`);
    if (r.cpu.s[0] !== 0xf000) errs.push(`es=${h4(r.cpu.s[0])} want F000`);
    if (r.cpu.mem[0xf000 * 16 + 0x210] !== 8) errs.push('table length byte must be 8');
    if (r.cpu.mem[0xf000 * 16 + 0x211] !== 0xfc) errs.push('model byte must be FCh (PC AT)');
    return errs;
  });

  s.run('15:88 reports extended memory size', () => {
    const r = call(machine(), 0x15, { ax: 0x8800 });
    const errs = wantNoError(r);
    errs.push(...wantFlags(r.cpu, { cf: 0 }));
    errs.push(...wantRegs(r.cpu, { ax: 0 }));
    return errs;
  });

  s.run('15: unsupported functions return AH=86h with CF=1', () => {
    const r = call(machine(), 0x15, { ax: 0x4900 });
    const errs = wantNoError(r);
    errs.push(...wantFlags(r.cpu, { cf: 1 }));
    errs.push(...want8(r.cpu, { ah: 0x86 }));
    return errs;
  });

  s.run('1A:00 reads the timer tick and mirrors it in the BDA', () => {
    const r = call(machine(), 0x1a, { ax: 0x0000, cx: 0, dx: 0 });
    const errs = wantNoError(r);
    errs.push(...wantFlags(r.cpu, { cf: 0 }));
    const cx = r.cpu.r[GPR.cx], dx = r.cpu.r[GPR.dx];
    if (r.cpu.rd16(0x46c) !== dx) errs.push(`BDA low=${h4(r.cpu.rd16(0x46c))} want DX=${h4(dx)}`);
    if (r.cpu.mem[0x46e] !== (cx & 0xff)) errs.push(`BDA 0040:006E=${h2(r.cpu.mem[0x46e])} want CH=${h2(cx & 0xff)}`);
    if (cx > 0x18) errs.push(`CH=${h2(cx)} exceeds the 24-bit tick counter`);
    return errs;
  });

  s.run('1A:00 clears the midnight flag', () => {
    const m = machine();
    m.cpu.wr8(0x470, 1);
    const r = call(m, 0x1a, { ax: 0x0000 });
    const errs = wantNoError(r);
    errs.push(...wantBda(r.cpu, 0x70, [0]));
    return errs;
  });

  const isBcd = (v) => (v & 0x0f) <= 9 && ((v >> 4) & 0x0f) <= 9;
  s.run('1A:02 returns the real-time clock as BCD', () => {
    const r = call(machine(), 0x1a, { ax: 0x0200 });
    const errs = wantNoError(r);
    errs.push(...wantFlags(r.cpu, { cf: 0 }));
    const cx = r.cpu.r[GPR.cx], dx = r.cpu.r[GPR.dx];
    for (const [name, v] of [['CH', (cx >> 8) & 0xff], ['CL', cx & 0xff], ['DH', (dx >> 8) & 0xff]]) {
      if (!isBcd(v)) errs.push(`${name}=${h2(v)} is not BCD`);
    }
    if ((dx & 0xff) > 1) errs.push(`DL=${h2(dx & 0xff)} daylight-saving flag must be 0 or 1`);
    return errs;
  });

  s.run('1A:04 returns the real-time date as BCD', () => {
    const r = call(machine(), 0x1a, { ax: 0x0400 });
    const errs = wantNoError(r);
    errs.push(...wantFlags(r.cpu, { cf: 0 }));
    const cx = r.cpu.r[GPR.cx], dx = r.cpu.r[GPR.dx];
    for (const [name, v] of [['CH', (cx >> 8) & 0xff], ['CL', cx & 0xff], ['DH', (dx >> 8) & 0xff], ['DL', dx & 0xff]]) {
      if (!isBcd(v)) errs.push(`${name}=${h2(v)} is not BCD`);
    }
    return errs;
  });

  s.run('1A:01 sets the timer tick', () => {
    const m = machine();
    m.cpu.wr8(0x470, 1);
    const r = call(m, 0x1a, { ax: 0x0100, cx: 0x0001, dx: 0x8000 });
    const errs = wantNoError(r);
    errs.push(...wantFlags(r.cpu, { cf: 0 }));
    errs.push(...wantBda(r.cpu, 0x6c, [0x00, 0x80, 0x01, 0x00]));
    errs.push(...wantBda(r.cpu, 0x70, [0]));
    return errs;
  });
}

// ============================================================= INT 14h/17h =
function ports(check, s) {
  s.run('14:00 initialises a serial port', () => {
    const r = call(machine(), 0x14, { ax: 0x0000, dx: 0 });
    const errs = wantNoError(r);
    errs.push(...wantFlags(r.cpu, { cf: 0 }));
    return errs;
  });
  s.run('14:01 transmit reports a timeout in AH=80h', () => {
    const r = call(machine(), 0x14, { ax: 0x0100, dx: 0 });
    const errs = wantNoError(r);
    errs.push(...want8(r.cpu, { ah: 0x80 }));
    return errs;
  });
  s.run('14:02 receive reports a timeout in AH=80h', () => {
    const r = call(machine(), 0x14, { ax: 0x0200, dx: 0 });
    const errs = wantNoError(r);
    errs.push(...want8(r.cpu, { ah: 0x80 }));
    return errs;
  });
  s.run('17:00 print reports no device in AH=90h', () => {
    const r = call(machine(), 0x17, { ax: 0x0041, dx: 0 });
    const errs = wantNoError(r);
    errs.push(...want8(r.cpu, { ah: 0x90 }));
    return errs;
  });
  s.run('17:01 init reports no device in AH=90h', () => {
    const r = call(machine(), 0x17, { ax: 0x0100, dx: 0 });
    const errs = wantNoError(r);
    errs.push(...want8(r.cpu, { ah: 0x90 }));
    return errs;
  });
}

// ==================================================== IRQ stubs + vectors ==
function vectors(check, s) {
  for (const n of [0x08, 0x0b, 0x0c, 0x70, 0x71, 0x76, 0x77]) {
    s.run(`software INT ${h2(n)}h returns through IRET without touching registers`, () => {
      const r = call(machine(), n, { ax: 0x1234, bx: 0x2345, cx: 0x3456, dx: 0x4567 }, { flags: 0x0202 });
      const errs = wantNoError(r);
      errs.push(...wantRegs(r.cpu, { ax: 0x1234, bx: 0x2345, cx: 0x3456, dx: 0x4567 }));
      errs.push(...wantFlags(r.cpu, { cf: 0, if: 1 }));
      return errs;
    });
  }

  s.run('08:00 the timer tick advances the full BDA counter', () => {
    const m = machine();
    m.cpu.wr16(0x46c, 0xffff);
    m.cpu.wr16(0x46e, 0x0000);
    const r = call(m, 0x08, {});
    const errs = wantNoError(r);
    // IBM: the timer ISR increments the 32-bit tick count at 0040:006C.
    if (bda32(r.m, 0x6c) !== 0x00010000) errs.push(`tick=${h4(bda16(r.m, 0x6e))}:${h4(bda16(r.m, 0x6c))} want 00010000`);
    return errs;
  });

  s.run('08:00 rolls the daily tick count and sets the midnight flag', () => {
    const m = machine();
    m.cpu.wr16(0x46c, 0x00af);
    m.cpu.wr16(0x46e, 0x0018);
    m.cpu.wr8(0x470, 0);
    const r = call(m, 0x08, {});
    const errs = wantNoError(r);
    if (bda32(r.m, 0x6c) !== 0) errs.push(`tick=${h4(bda16(r.m, 0x6e))}:${h4(bda16(r.m, 0x6c))} want 00000000`);
    errs.push(...wantBda(r.cpu, 0x70, [1]));
    return errs;
  });

  for (const n of [0x10, 0x11, 0x12, 0x13, 0x14, 0x15, 0x16, 0x17, 0x19, 0x1a, 0x08]) {
    s.run(`vector ${h2(n)}h points into the BIOS segment`, () => {
      const m = machine();
      const errs = [];
      if (m.cpu.rd16(n * 4 + 2) !== 0xf000) errs.push(`int${h2(n)} seg=${h4(m.cpu.rd16(n * 4 + 2))} want F000`);
      if (m.cpu.rd16(n * 4) === 0) errs.push(`int${h2(n)} offset is 0`);
      return errs;
    });
  }

  s.run('the BIOS Data Area is initialised for a text-mode DOS machine', () => {
    const m = machine();
    const errs = [];
    if (bda16(m, 0x13) !== 640) errs.push(`memory size=${bda16(m, 0x13)} want 640`);
    if (bda8(m, 0x49) !== 3) errs.push(`video mode=${bda8(m, 0x49)} want 3`);
    if (bda16(m, 0x4a) !== COLS) errs.push(`columns=${bda16(m, 0x4a)} want ${COLS}`);
    if (bda8(m, 0x84) !== ROWS - 1) errs.push(`last row=${bda8(m, 0x84)} want ${ROWS - 1}`);
    // IBM PC keyboard ring-buffer pointers live at 0040:001C (head) and 0040:001E (tail).
    if (bda16(m, 0x1a) !== 0x001e || bda16(m, 0x1c) !== 0x001e) {
      errs.push(`keyboard buffer pointers=${h4(bda16(m, 0x1a))}/${h4(bda16(m, 0x1c))} want 001E/001E at 0040:001A/0040:001C`);
    }
    if (bda16(m, 0x4c) !== COLS * ROWS * 2) errs.push(`page size=${h4(bda16(m, 0x4c))} want ${h4(COLS * ROWS * 2)}`);
    if (bda16(m, 0x4e) !== 0) errs.push(`page 0 offset=${h4(bda16(m, 0x4e))} want 0000`);
    if (bda8(m, 0x85) !== 16) errs.push(`character height=${bda8(m, 0x85)} want 16 scan lines`);
    // INT 1Eh's vector is the address of the diskette parameter table.
    if (m.cpu.rd16(0x1e * 4) === 0 && m.cpu.rd16(0x1e * 4 + 2) === 0) {
      errs.push('INT 1Eh vector must point at the diskette parameter table');
    }
    return errs;
  });
}

/**
 * Standards gaps found by black-box probing: behaviours the IBM PC / PC DOS
 * interface specifies that this BIOS does not implement. Each test asserts the
 * specified behaviour, so it fails until the BIOS matches the standard.
 */
function gaps(check, s) {
  s.run('13:05 formats the sector IDs listed at ES:BX and fills only that track', () => {
    const image = new Uint8Array(FLOPPY_GEOMETRY.totalSectors * SECTOR_BYTES).fill(0xcc);
    const fields = [];
    for (let sector = 1; sector <= FLOPPY_GEOMETRY.sectorsPerTrack; sector++) {
      fields.push(1, 1, sector, 2); // cylinder, head, sector, 512-byte size code
    }
    const m = machine({ floppy: image });
    const r = call(m, 0x13, { ax: 0x0509, cx: 0x0101, dx: 0x0100, bx: 0x0100 }, {
      es: 0x2000,
      data: [{ seg: 0x2000, off: 0x0100, bytes: fields }],
    });
    const errs = wantNoError(r);
    errs.push(...wantFlags(r.cpu, { cf: 0 }));
    errs.push(...want8(r.cpu, { ah: 0 }));
    for (let sector = 1; sector <= FLOPPY_GEOMETRY.sectorsPerTrack; sector++) {
      const start = lba(FLOPPY_GEOMETRY, 1, 1, sector) * SECTOR_BYTES;
      if (!m.floppyDisk.bytes.subarray(start, start + SECTOR_BYTES).every((byte) => byte === 0xf6)) {
        errs.push(`formatted C1/H1/S${sector} does not contain the documented F6h format fill`);
        break;
      }
    }
    if (!m.diskDirty) errs.push('formatted image is not marked dirty');
    if (!m.floppyDisk.bytes.subarray(0, SECTOR_BYTES).every((byte) => byte === 0xcc)) {
      errs.push('format changed a sector outside the selected track');
    }
    return errs;
  });

  s.run('1A:03 reports an unsupported sub-function with CF=1', () => {
    const r = call(machine(), 0x1a, { ax: 0x0300 });
    const errs = [];
    if (!(r.cpu.flags & CF)) errs.push('CF=0: unsupported INT 1Ah sub-function reported as success');
    return errs;
  });
}
export function runBiosStandard(check) {
  const s = new Suite('bios:standard');
  video(check, s);
  disk(check, s);
  keyboard(check, s);
  bootstrap(check, s);
  systems(check, s);
  ports(check, s);
  vectors(check, s);
  gaps(check, s);
  return s.report(check, 'bios:standard');
}
