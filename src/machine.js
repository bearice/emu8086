// Machine: CPU + 80x25 text screen + keyboard, with .COM loading.
import { CPU, R, S } from './cpu.js';

export const VRAM = 0xb8000;
export const COLS = 80, ROWS = 25;
export const LOAD_SEG = 0x0100;

export class Machine {
  constructor() {
    this.kbd = [];
    this.cursor = 0;
    this.attr = 0x07;
    this.cpu = new CPU({
      onOutput: (c) => (c < 0 ? this.clear() : this.putChar(c)),
      onInput: (peek) => (this.kbd.length ? (peek ? this.kbd[0] : this.kbd.shift()) : -1),
    });
    this.breakpoints = new Set();
    this.clear();
    this.loaded = null;
  }

  clear() {
    const m = this.cpu.mem;
    for (let i = 0; i < COLS * ROWS; i++) { m[VRAM + i * 2] = 0x20; m[VRAM + i * 2 + 1] = this.attr; }
    this.cursor = 0;
  }

  scroll() {
    const m = this.cpu.mem;
    m.copyWithin(VRAM, VRAM + COLS * 2, VRAM + COLS * ROWS * 2);
    for (let i = 0; i < COLS; i++) {
      m[VRAM + (COLS * (ROWS - 1) + i) * 2] = 0x20;
      m[VRAM + (COLS * (ROWS - 1) + i) * 2 + 1] = this.attr;
    }
    this.cursor -= COLS;
  }

  putChar(c) {
    const m = this.cpu.mem;
    if (c === 13) { this.cursor -= this.cursor % COLS; }
    else if (c === 10) { this.cursor += COLS; }
    else if (c === 8) { if (this.cursor > 0) { this.cursor--; m[VRAM + this.cursor * 2] = 0x20; } }
    else if (c === 9) { this.cursor = (Math.floor(this.cursor / 8) + 1) * 8; }
    else if (c === 7) { /* bell */ }
    else {
      m[VRAM + this.cursor * 2] = c & 0xff;
      m[VRAM + this.cursor * 2 + 1] = this.attr;
      this.cursor++;
    }
    while (this.cursor >= COLS * ROWS) this.scroll();
  }

  keyPress(code) { this.kbd.push(code & 0xff); }

  load(bytes, origin) {
    const cpu = this.cpu;
    cpu.reset();
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
    this.loaded = { bytes, origin };
  }

  reload() { if (this.loaded) this.load(this.loaded.bytes, this.loaded.origin); }

  step() {
    const ok = this.cpu.step();
    return ok;
  }

  // run up to n instructions; stops at breakpoint / halt / waiting-on-input
  run(n) {
    const cpu = this.cpu;
    for (let i = 0; i < n; i++) {
      if (cpu.halted) return 'halted';
      cpu.step();
      if (cpu.waiting) return 'input';
      if (this.breakpoints.has(cpu.ip)) return 'breakpoint';
    }
    return cpu.halted ? 'halted' : 'running';
  }
}
