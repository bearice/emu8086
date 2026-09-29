// Machine: CPU + 80x25 text screen + keyboard, with .COM loading.
import { CPU, R, S } from './cpu.js';
import { DiskImage, HARD_DISK_GEOMETRY, parseFloppyGeometry, SECTOR_BYTES } from './disk.js';
import {
  BIOS_SEG, BIOS_DPT_OFFSET, KEYBOARD_CONTROLLER_COMMAND_PORT,
  KEYBOARD_CONTROLLER_RESET_COMMAND, installFirmwareVectors,
} from './firmware.js';

export const VRAM = 0xb8000;
export const COLS = 80, ROWS = 25;
export const LOAD_SEG = 0x0100;
const FLOPPY_BOOT_ADDR = 0x7c00;
const BIOS_SHIFT_FLAGS_ADDRESS = 0x417;
const BIOS_MODIFIER_FLAGS_MASK = 0x0f;
const BIOS_MODIFIER_FLAGS = {
  ShiftRight: 0x01,
  ShiftLeft: 0x02,
  ControlLeft: 0x04,
  ControlRight: 0x04,
  AltLeft: 0x08,
  AltRight: 0x08,
};

export class Machine {
  constructor() {
    this.kbd = [];
    this.port61Latch = 0;
    this.refreshToggle = false;
    this.vgaRetraceToggle = false;
    this.resetRequested = false;
    this.pressedModifiers = new Set();
    this.floppyImage = null;
    this.floppy = null;
    this.floppyDisk = null;
    this.bootDrive = null;
    this.hardDisk = null;
    this.hardDiskAttached = false;
    this.hardDiskName = 'harddisk.img';
    this.cursor = 0;
    this.attr = 0x07;
    this.cpu = new CPU({
      onOutput: (c) => (c < 0 ? this.clear() : this.putChar(c)),
      onInput: (peek) => (this.kbd.length ? (peek ? this.kbd[0] : this.kbd.shift()) : -1),
      onDiskRead: (...args) => this.readDisk(...args),
      onDiskWrite: (...args) => this.writeDisk(...args),
      onPortRead: (port) => this.readPort(port),
      onPortWrite: (port, value) => this.writePort(port, value),
    });
    this.breakpoints = new Set();
    this.syncedBreakpoints = new Set();
    this.clear();
    this.loaded = null;
    this.installBiosState();
  }

  clear() {
    const m = this.cpu.mem;
    const page = m[0x462] & 7;
    const base = VRAM + page * 0x1000;
    for (let i = 0; i < COLS * ROWS; i++) { m[base + i * 2] = 0x20; m[base + i * 2 + 1] = this.attr; }
    this.cursor = 0;
    this.cpu.wr16(0x450 + page * 2, 0);
  }

  scroll() {
    const m = this.cpu.mem;
    const page = m[0x462] & 7;
    const base = VRAM + page * 0x1000;
    m.copyWithin(base, base + COLS * 2, base + COLS * ROWS * 2);
    for (let i = 0; i < COLS; i++) {
      m[base + (COLS * (ROWS - 1) + i) * 2] = 0x20;
      m[base + (COLS * (ROWS - 1) + i) * 2 + 1] = this.attr;
    }
    this.cursor -= COLS;
    this.cpu.wr16(0x450 + page * 2, (((this.cursor / COLS) & 0xff) << 8) | (this.cursor % COLS));
  }

  putChar(c) {
    const m = this.cpu.mem;
    const page = m[0x462] & 7;
    const base = VRAM + page * 0x1000;
    const position = this.cpu.rd16(0x450 + page * 2);
    this.cursor = (position >> 8) * COLS + (position & 0xff);
    if (c === 13) { this.cursor -= this.cursor % COLS; }
    else if (c === 10) { this.cursor += COLS; }
    else if (c === 8) { if (this.cursor > 0) { this.cursor--; m[base + this.cursor * 2] = 0x20; } }
    else if (c === 9) { this.cursor = (Math.floor(this.cursor / 8) + 1) * 8; }
    else if (c === 7) { /* bell */ }
    else {
      if (this.cursor >= 0 && this.cursor < COLS * ROWS) {
        m[base + this.cursor * 2] = c & 0xff;
        m[base + this.cursor * 2 + 1] = this.attr;
      }
      this.cursor++;
    }
    while (this.cursor >= COLS * ROWS) this.scroll();
    this.cpu.wr16(0x450 + page * 2, (((this.cursor / COLS) & 0xff) << 8) | (this.cursor % COLS));
  }

  keyPress(code, scan = 0) { this.kbd.push(((scan & 0xff) << 8) | (code & 0xff)); }

  setModifierPressed(code, pressed) {
    const flag = BIOS_MODIFIER_FLAGS[code];
    if (flag === undefined) return false;
    if (pressed) this.pressedModifiers.add(code);
    else this.pressedModifiers.delete(code);

    let modifierFlags = 0;
    for (const pressedCode of this.pressedModifiers) {
      modifierFlags |= BIOS_MODIFIER_FLAGS[pressedCode];
    }
    const shiftFlags = this.cpu.rd8(BIOS_SHIFT_FLAGS_ADDRESS);
    this.cpu.wr8(BIOS_SHIFT_FLAGS_ADDRESS,
      (shiftFlags & ~BIOS_MODIFIER_FLAGS_MASK) | modifierFlags);
    return true;
  }

  clearKeyboardModifiers() {
    this.pressedModifiers.clear();
    const shiftFlags = this.cpu.rd8(BIOS_SHIFT_FLAGS_ADDRESS);
    this.cpu.wr8(BIOS_SHIFT_FLAGS_ADDRESS, shiftFlags & ~BIOS_MODIFIER_FLAGS_MASK);
  }

  readPort(port) {
    if (port === 0x61) {
      this.refreshToggle = !this.refreshToggle;
      return (this.port61Latch & 0xef) | (this.refreshToggle ? 0x10 : 0);
    }
    if (port === 0x64) return 0; // keyboard controller input buffer is empty
    if (port === 0x3ba || port === 0x3da) {
      this.vgaRetraceToggle = !this.vgaRetraceToggle;
      return this.vgaRetraceToggle ? (port === 0x3ba ? 0x80 : 0x08) : 0;
    }
    return 0;
  }

  writePort(port, value) {
    if (port === 0x61) this.port61Latch = value & 0xef;
    if (port === KEYBOARD_CONTROLLER_COMMAND_PORT && value === KEYBOARD_CONTROLLER_RESET_COMMAND
        && this.bootDrive !== null) this.resetRequested = true;
  }

  get diskDirty() { return this.floppyDisk?.dirty ?? false; }
  get hardDiskDirty() { return this.hardDiskAttached && (this.hardDisk?.dirty ?? false); }

  markDiskSaved(drive) {
    const disk = drive === 0 ? this.floppyDisk : drive === 0x80 ? this.hardDisk : null;
    disk?.markSaved();
  }

  attachHardDisk(image, name = 'harddisk.img') {
    this.hardDisk = new DiskImage(image, HARD_DISK_GEOMETRY);
    this.hardDiskAttached = true;
    this.hardDiskName = name;
    if (this.floppyDisk) {
      this.cpu.setHardDiskGeometry(
        HARD_DISK_GEOMETRY.cylinders,
        HARD_DISK_GEOMETRY.heads,
        HARD_DISK_GEOMETRY.sectorsPerTrack,
      );
      this.cpu.wr8(0x475, 1);
    }
    return this.hardDisk.geometry;
  }

  bootFloppy(image) {
    const bytes = image instanceof Uint8Array ? image : new Uint8Array(image);
    const geometry = parseFloppyGeometry(bytes);
    this.floppyDisk = new DiskImage(bytes, geometry);
    this.floppyImage = this.floppyDisk.bytes;
    this.floppy = geometry;
    this.loaded = null;
    if (!this.hardDisk) this.hardDisk = DiskImage.blank(HARD_DISK_GEOMETRY);
    this.hardDiskAttached = true;
    this.bootFromFloppy();
    return geometry;
  }

  bootFromFloppy() {
    this.bootFromDisk(0);
  }

  ejectFloppy() {
    this.floppyImage = null;
    this.floppyDisk = null;
  }

  bootHardDisk() {
    if (!this.hardDisk) throw new Error('no hard disk image is attached');
    this.hardDiskAttached = true;
    this.bootFromDisk(0x80);
    return this.hardDisk.geometry;
  }

  bootFromDisk(drive) {
    const disk = this.diskFor(drive);
    if (!disk) throw new Error('no boot image is inserted');
    if (disk.bytes[510] !== 0x55 || disk.bytes[511] !== 0xaa) {
      throw new Error('disk has no boot signature');
    }
    const cpu = this.cpu;
    const geometry = this.floppy;
    cpu.reset();
    cpu.mem.fill(0);
    cpu.setDosCompatMode(false);
    cpu.setFloppyGeometry(geometry?.cylinders ?? 0, geometry?.heads ?? 0, geometry?.sectorsPerTrack ?? 0);
    cpu.setHardDiskGeometry(
      HARD_DISK_GEOMETRY.cylinders,
      HARD_DISK_GEOMETRY.heads,
      HARD_DISK_GEOMETRY.sectorsPerTrack,
    );
    this.port61Latch = 0;
    this.refreshToggle = false;
    this.vgaRetraceToggle = false;
    this.resetRequested = false;
    this.bootDrive = drive;
    this.loaded = null;
    this.installBiosState();
    cpu.mem.set(disk.bytes.subarray(0, SECTOR_BYTES), FLOPPY_BOOT_ADDR);
    cpu.s[S.CS] = cpu.s[S.DS] = cpu.s[S.ES] = cpu.s[S.SS] = 0;
    cpu.r[R.SP] = FLOPPY_BOOT_ADDR;
    cpu.r[R.DX] = drive;
    cpu.ip = FLOPPY_BOOT_ADDR;
    this.kbd.length = 0;
    this.clear();
  }

  installBiosState() {
    const cpu = this.cpu;
    const mem = cpu.mem;
    const write16 = (addr, value) => cpu.wr16(addr, value);
    installFirmwareVectors(cpu, { dosCompat: this.bootDrive === null });

    // BIOS Data Area values used by DOS and text-mode programs.
    write16(0x410, this.floppy ? 0x0021 : 0x0020); // 80-column color display, optional floppy drive
    write16(0x413, 640);
    mem[0x449] = 3;
    write16(0x44a, COLS);
    write16(0x44c, COLS * ROWS * 2);
    write16(0x44e, 0);
    write16(0x450, 0);
    write16(0x460, 0x0607);
    mem[0x462] = 0;
    write16(0x463, 0x03d4);
    mem[0x475] = this.hardDiskAttached ? 1 : 0;
    mem[0x484] = ROWS - 1;
    mem[0x485] = 16;
    write16(0x41a, 0x001e);
    write16(0x41c, 0x001e);

    // INT 1Eh points to the diskette parameter table copied by the MS-DOS 5 boot sector.
    const dptAddress = (BIOS_SEG << 4) + BIOS_DPT_OFFSET;
    mem.set([0xdf, 0x02, 0x25, 0x02, 0x12, 0x1b, 0xff, 0x6c, 0xf6, 0x0f, 0x08], dptAddress);
    write16(0x1e * 4, BIOS_DPT_OFFSET);
    write16(0x1e * 4 + 2, BIOS_SEG);

  }

  diskFor(drive) {
    if (drive === 0) return this.floppyDisk;
    if (drive === 0x80 && this.hardDiskAttached) return this.hardDisk;
    return null;
  }

  readDisk(drive, cylinder, head, sector, count, destination) {
    const data = this.diskFor(drive)?.readSectors(cylinder, head, sector, count);
    if (!data) return 0;
    for (let i = 0; i < data.length; i++) this.cpu.wr8(destination + i, data[i]);
    return 1;
  }

  writeDisk(drive, cylinder, head, sector, count, source) {
    const disk = this.diskFor(drive);
    if (!disk || !Number.isInteger(count) || count < 1) return 0;
    const data = new Uint8Array(count * SECTOR_BYTES);
    for (let i = 0; i < data.length; i++) data[i] = this.cpu.rd8(source + i);
    return disk.writeSectors(cylinder, head, sector, data) ? 1 : 0;
  }

  load(bytes, origin) {
    const cpu = this.cpu;
    cpu.reset();
    cpu.setDosCompatMode(true);
    cpu.setFloppyGeometry(0, 0, 0);
    cpu.setHardDiskGeometry(0, 0, 0);
    cpu.mem.fill(0, 0, 0xb8000);
    cpu.mem.fill(0, 0xb8000 + COLS * ROWS * 2);
    cpu.s[S.CS] = cpu.s[S.DS] = cpu.s[S.ES] = cpu.s[S.SS] = LOAD_SEG;
    cpu.ip = origin;
    cpu.r[R.SP] = 0xfffe;
    cpu.mem.set(bytes, (LOAD_SEG << 4) + origin);
    // PSP INT 20h at offset 0 so "ret" from a .COM exits
    cpu.wr16((LOAD_SEG << 4), 0x20cd);
    cpu.wr16(0xfffe + (LOAD_SEG << 4), 0x0000);
    this.kbd.length = 0;
    this.clear();
    this.floppyImage = null;
    this.floppy = null;
    this.floppyDisk = null;
    this.bootDrive = null;
    this.hardDiskAttached = false;
    this.loaded = { bytes, origin };
    this.installBiosState();
  }

  reload() {
    if (this.bootDrive === 0x80 || (this.bootDrive === 0 && !this.floppyDisk)) this.bootHardDisk();
    else if (this.floppyImage) this.bootFromFloppy();
    else if (this.loaded) this.load(this.loaded.bytes, this.loaded.origin);
  }

  step() {
    const ok = this.cpu.step();
    if (this.resetRequested) {
      this.bootFromDisk(this.floppyDisk ? 0 : 0x80);
      return true;
    }
    return ok;
  }

  // run up to n instructions; stops at breakpoint / halt / waiting-on-input
  run(n) {
    const cpu = this.cpu;
    for (const ip of this.breakpoints) {
      if (!this.syncedBreakpoints.has(ip)) cpu.setBreakpoint(ip, true);
    }
    for (const ip of this.syncedBreakpoints) {
      if (!this.breakpoints.has(ip)) cpu.setBreakpoint(ip, false);
    }
    this.syncedBreakpoints = new Set(this.breakpoints);

    let remaining = n;
    while (remaining > 0) {
      if (cpu.halted) return 'halted';
      const status = cpu.run(remaining);
      remaining -= cpu.lastRunCount;
      if (this.resetRequested) {
        this.bootFromDisk(this.floppyDisk ? 0 : 0x80);
        continue;
      }
      if (status === 1) return 'halted';
      if (status === 2) return 'input';
      if (status === 3) return 'breakpoint';
      if (status === 0 || cpu.lastRunCount === 0) break;
    }
    return cpu.halted ? 'halted' : 'running';
  }
}
