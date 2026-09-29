// Black-box test harness for the 8086 CPU core and the PC BIOS.
//
// Design rules:
//   * Tests drive the emulator through the public adapter API only
//     (registers, linear memory, host port/disk/keyboard callbacks).
//   * Expected values come from the Intel 8086 manual and the IBM PC BIOS
//     specification, computed by the independent oracle below. The oracle is
//     deliberately written from the specification text, not from wasm/src, so
//     that agreement between the two is evidence rather than a tautology.
//   * Programs are hand-assembled here. CPU tests must not depend on asm.js,
//     otherwise an assembler bug can mask (or fake) a core bug.
import { R, S } from '../src/cpu.js';
import { Machine, VRAM, COLS, ROWS } from '../src/machine.js';

export { R, S, Machine, VRAM, COLS, ROWS };

export const GPR = { ax: 0, cx: 1, dx: 2, bx: 3, sp: 4, bp: 5, si: 6, di: 7 };
export const SEG = { es: 0, cs: 1, ss: 2, ds: 3 };
const R8 = {
  al: ['ax', 0], ah: ['ax', 1], cl: ['cx', 0], ch: ['cx', 1],
  dl: ['dx', 0], dh: ['dx', 1], bl: ['bx', 0], bh: ['bx', 1],
};

export const FLAG_BIT = {
  cf: 0x0001, pf: 0x0004, af: 0x0010, zf: 0x0040, sf: 0x0080,
  tf: 0x0100, if: 0x0200, df: 0x0400, of: 0x0800,
};

export const CF = 0x0001, PF = 0x0004, AF = 0x0010, ZF = 0x0040, SF = 0x0080;
export const TF = 0x0100, IF = 0x0200, DF = 0x0400, OF = 0x0800;

export const h2 = (v) => (v & 0xff).toString(16).toUpperCase().padStart(2, '0');
export const h4 = (v) => (v & 0xffff).toString(16).toUpperCase().padStart(4, '0');
export const lin = (seg, off) => ((seg << 4) + off) & 0xfffff;

// ---------------------------------------------------------------- oracle ----
// The 8086 flag definitions, straight from the manual:
//   CF carry/borrow out of the most significant bit
//   OF signed overflow: carry into the sign bit != carry out of the sign bit
//   AF auxiliary carry: carry into/out of bit 3 (BCD adjust)
//   ZF zero, SF sign (bit 7 of the result), PF even parity of the low byte
export function parity8(v) {
  let p = 0;
  for (let x = v & 0xff; x; x >>= 1) p ^= x & 1;
  return p;
}
export const pfOf = (v) => (parity8(v) ? 0 : 1);

const maskOf = (size) => (size === 8 ? 0xff : 0xffff);
const signOf = (size) => (size === 8 ? 0x80 : 0x8000);

export function alu(op, a, b, size, cfIn = 0) {
  const m = maskOf(size), sb = signOf(size);
  const carryIn = op === 'ADC' || op === 'SBB' || op === 'CMPSBB' ? cfIn : 0;
  let r, cf = 0, af = 0, of = 0;
  switch (op) {
    case 'ADD': case 'ADC': {
      const t = a + b + carryIn;
      r = t & m;
      cf = t > m ? 1 : 0;
      af = ((a & 0xf) + (b & 0xf) + carryIn) > 0xf ? 1 : 0;
      of = ((a & sb) === (b & sb) && (r & sb) !== (a & sb)) ? 1 : 0;
      break;
    }
    case 'SUB': case 'SBB': case 'CMP': {
      const t = a - b - carryIn;
      r = t & m;
      cf = t < 0 ? 1 : 0;
      af = ((a & 0xf) - (b & 0xf) - carryIn) < 0 ? 1 : 0;
      of = ((a & sb) !== (b & sb) && (r & sb) !== (a & sb)) ? 1 : 0;
      break;
    }
    case 'AND': case 'OR': case 'XOR': case 'TEST': {
      // TEST performs a bitwise AND and sets flags only — it never writes a result.
      r = (op === 'AND' || op === 'TEST' ? (a & b) : op === 'OR' ? (a | b) : (a ^ b)) & m;
      cf = 0; of = 0; af = 0; // manual: CF and OF cleared (0 on the 8086)
      break;
    }
    case 'INC': {
      const t = a + 1;
      r = t & m;
      cf = cfIn; // manual: INC/DEC leave CF unchanged, all other flags update
      af = ((a & 0xf) + 1) > 0xf ? 1 : 0;
      // Manual: OF is set only on SIGNED overflow — max positive wraps to min negative.
      of = a === (sb - 1) ? 1 : 0;
      break;
    }
    case 'DEC': {
      const t = a - 1;
      r = t & m;
      cf = cfIn;
      af = (a & 0xf) === 0 ? 1 : 0;
      // Manual: OF is set only on SIGNED overflow — min negative wraps to max positive.
      of = a === sb ? 1 : 0;
      break;
    }
    default: throw new Error(`oracle: unknown alu op ${op}`);
  }
  return { r, cf, pf: pfOf(r), af, zf: r === 0 ? 1 : 0, sf: (r & sb) ? 1 : 0, of };
}

// Shift and rotate one 8086 count step at a time. The 8086 consumes the full
// 8-bit CL count; later processors' 5-bit count mask must not leak into oracle.
export function shift(op, v, count, size, cfIn = 0) {
  const m = maskOf(size), sb = signOf(size);
  if (count === 0) return null; // flags are explicitly unchanged
  let r = v & m, cf = cfIn;
  for (let i = 0; i < count; i++) {
    if (op === 'ROL' || op === 'RCL') {
      const nextCf = (r >> (size - 1)) & 1;
      r = ((r << 1) | (op === 'RCL' ? cf : nextCf)) & m;
      cf = nextCf;
    } else if (op === 'ROR' || op === 'RCR') {
      const nextCf = r & 1;
      r = (r >>> 1) | ((op === 'RCR' ? cf : nextCf) << (size - 1));
      cf = nextCf;
    } else if (op === 'SHL' || op === 'SAL') {
      cf = (r >> (size - 1)) & 1;
      r = (r << 1) & m;
    } else if (op === 'SHR') {
      cf = r & 1;
      r >>>= 1;
    } else if (op === 'SAR') {
      cf = r & 1;
      // Sign extend at the operand width before each arithmetic shift.
      const signed = size === 8 ? (r << 24) >> 24 : (r << 16) >> 16;
      r = (signed >> 1) & m;
    } else throw new Error(`oracle: unknown shift op ${op}`);
  }
  let of = null; // OF is only defined for a count of 1
  if (count === 1) {
    if (op === 'SHL' || op === 'SAL' || op === 'ROL' || op === 'RCL') {
      of = ((r >> (size - 1)) & 1) ^ cf;
    }
    else if (op === 'ROR') of = ((v >> (size - 1)) & 1) ^ (v & 1);
    else if (op === 'RCR') of = ((v >> (size - 1)) & 1) ^ cfIn;
    else if (op === 'SHR') of = (v >> (size - 1)) & 1; // manual: original MSB
    else if (op === 'SAR') of = 0;
  }
  return { r, cf, pf: pfOf(r), af: null, zf: r === 0 ? 1 : 0, sf: (r & sb) ? 1 : 0, of };
}

// Negate per the manual: NEG 0 leaves CF clear, every other result sets CF.
export function neg(v, size) {
  const m = maskOf(size), sb = signOf(size);
  const r = (-v) & m;
  return { r, cf: r === 0 ? 0 : 1, pf: pfOf(r), af: ((v & 0xf) !== 0) ? 1 : 0,
    zf: r === 0 ? 1 : 0, sf: (r & sb) ? 1 : 0, of: (v === (sb << (size - 8)) && size === 8) ? 1 : (v === 0x8000 && size === 16) ? 1 : 0 };
}

// ---------------------------------------------------------------- machine ---
export function newMachine(opts = {}) {
  const m = new Machine();
  m.load(new Uint8Array(0), 0x100);
  // load() resets the CPU, so firmware vectors and the BIOS Data Area go in after it.
  if (opts.bios !== false) m.installBiosState();
  if (opts.ports) {
    m.cpu.onPortRead = opts.ports.read ?? (() => 0);
    m.cpu.onPortWrite = opts.ports.write ?? (() => {});
  }
  if (opts.input) m.cpu.onInput = opts.input;
  if (opts.output) m.cpu.onOutput = opts.output;
  return m;
}

export function put(m, seg, off, bytes) {
  for (let i = 0; i < bytes.length; i++) m.cpu.wr8(lin(seg, off + i), bytes[i]);
}

export function get(m, seg, off, n) {
  const out = [];
  for (let i = 0; i < n; i++) out.push(m.cpu.rd8(lin(seg, off + i)));
  return out;
}

/**
 * Run one hand-assembled program in a deterministic machine.
 * bytes  -> code at cs:ip; data -> [{seg, off, bytes}]; regs -> 16-bit GPRs;
 * flags  -> initial low 16 flag bits. Programs end with HLT (f4).
 */
export function exec(bytes, opts = {}) {
  return runOn(newMachine(opts), bytes, opts);
}

/** Run a hand-assembled program on an already-configured machine. */
export function runOn(m, bytes, opts = {}) {
  const cpu = m.cpu;
  const cs = opts.cs ?? 0x1000, ip = opts.ip ?? 0x100;
  cpu.s[S.CS] = cs;
  cpu.s[S.DS] = opts.ds ?? cs;
  cpu.s[S.ES] = opts.es ?? cs;
  cpu.s[S.SS] = opts.ss ?? cs;
  cpu.ip = ip;
  cpu.r[R.SP] = opts.sp ?? 0xffe0;
  put(m, cs, ip, bytes);
  for (const d of opts.data ?? []) put(m, d.seg ?? cpu.s[S.DS], d.off, d.bytes);
  cpu.flags = 0x8000 | (opts.flags ?? 0);
  for (const [k, v] of Object.entries(opts.regs ?? {})) cpu.r[GPR[k]] = v;
  let steps = 0;
  const max = opts.maxSteps ?? 20000;
  while (steps < max && !cpu.halted && !cpu.exited && !cpu.waiting && !cpu.error) {
    cpu.step();
    steps++;
  }
  return {
    m, cpu, steps,
    error: cpu.error,
    halted: cpu.halted,
    exited: cpu.exited,
    waiting: cpu.waiting,
    timedOut: steps >= max,
  };
}

// ------------------------------------------------------------- assertions ---
export function wantRegs(cpu, want) {
  const errs = [];
  for (const [k, v] of Object.entries(want)) {
    const got = cpu.r[GPR[k]];
    if (got !== (v & 0xffff)) errs.push(`${k}=${h4(got)} want ${h4(v)}`);
  }
  return errs;
}

export function want8(cpu, want) {
  const errs = [];
  for (const [k, v] of Object.entries(want)) {
    const [w, hi] = R8[k];
    const word = cpu.r[GPR[w]];
    const got = hi ? (word >> 8) & 0xff : word & 0xff;
    if (got !== (v & 0xff)) errs.push(`${k}=${h2(got)} want ${h2(v)}`);
  }
  return errs;
}

/** want: {cf:1, zf:0, ...}. Pass null (or omit) for flags the manual leaves undefined. */
export function wantFlags(cpu, want) {
  const errs = [];
  for (const [k, v] of Object.entries(want)) {
    if (v === null || v === undefined) continue;
    const got = (cpu.flags & FLAG_BIT[k]) ? 1 : 0;
    if (got !== (v ? 1 : 0)) errs.push(`${k}=${got} want ${v ? 1 : 0}`);
  }
  return errs;
}

export function wantMem(cpu, seg, off, bytes) {
  const errs = [];
  for (let i = 0; i < bytes.length; i++) {
    const got = cpu.rd8(lin(seg, off + i));
    if (got !== (bytes[i] & 0xff)) {
      errs.push(`[${h4(seg)}:${h4(off + i)}]=${h2(got)} want ${h2(bytes[i])}`);
    }
  }
  return errs;
}

export function wantBda(cpu, off, bytes) {
  const errs = [];
  for (let i = 0; i < bytes.length; i++) {
    const got = cpu.rd8(0x400 + off + i);
    if (got !== (bytes[i] & 0xff)) {
      errs.push(`0040:${h4(off + i)}=${h2(got)} want ${h2(bytes[i])}`);
    }
  }
  return errs;
}

export function wantNoError(r) {
  return r.error ? [`cpu.error=${r.error}`] : [];
}

/** Assert the interrupt vector table entry points at seg:off. */
export function wantVector(cpu, int, seg, off) {
  const gotOff = cpu.rd16(int * 4);
  const gotSeg = cpu.rd16(int * 4 + 2);
  const errs = [];
  if (gotSeg !== (seg & 0xffff)) errs.push(`int${h2(int)} seg=${h4(gotSeg)} want ${h4(seg)}`);
  if (off !== null && gotOff !== (off & 0xffff)) errs.push(`int${h2(int)} off=${h4(gotOff)} want ${h4(off)}`);
  return errs;
}

/** Run a program with vector 0 pointed at a known HLT handler. */
export function execWithDivideHandler(bytes, opts = {}) {
  const data = [
    ...(opts.data ?? []),
    { seg: 0, off: 0, bytes: [0x00, 0x03, 0x00, 0x10] }, // INT 0 -> 1000:0300
    { seg: 0x1000, off: 0x0300, bytes: [HLT] },
  ];
  return exec(bytes, { ...opts, data });
}

/** Verify divide error arrived through IVT vector 0 with a real 6-byte frame. */
export function wantDivideError(r, programBytes) {
  const errs = [];
  if (r.error) errs.push(`cpu.error=${r.error}`);
  if (!r.halted) errs.push('divide-error handler did not reach HLT');
  if (r.cpu.s[S.CS] !== 0x1000 || r.cpu.ip !== 0x0301) {
    errs.push(`handler=${h4(r.cpu.s[S.CS])}:${h4(r.cpu.ip)} want 1000:0301`);
  }
  const initialSp = 0xffe0;
  const frameSp = (initialSp - 6) & 0xffff;
  if (r.cpu.r[R.SP] !== frameSp) errs.push(`SP=${h4(r.cpu.r[R.SP])} want ${h4(frameSp)} after 3-word interrupt frame`);
  const savedIp = r.cpu.rd16(lin(0x1000, frameSp));
  const savedCs = r.cpu.rd16(lin(0x1000, frameSp + 2));
  if (savedCs !== 0x1000) errs.push(`saved CS=${h4(savedCs)} want 1000`);
  if (savedIp < 0x0100 || savedIp > 0x0100 + programBytes) {
    errs.push(`saved IP=${h4(savedIp)} is outside the caller program`);
  }
  return errs;
}

/** Screen text of a page as printable characters, for video assertions. */
export function screenText(cpu, page = 0) {
  const base = VRAM + page * 0x1000;
  const lines = [];
  for (let row = 0; row < ROWS; row++) {
    let line = '';
    for (let col = 0; col < COLS; col++) {
      const c = cpu.rd8(base + (row * COLS + col) * 2);
      line += c >= 32 && c < 127 ? String.fromCharCode(c) : '.';
    }
    lines.push(line);
  }
  return lines;
}

export function cell(cpu, row, col, page = 0) {
  const addr = VRAM + page * 0x1000 + (row * COLS + col) * 2;
  return { ch: cpu.rd8(addr), attr: cpu.rd8(addr + 1) };
}

export function wantCell(cpu, row, col, want, page = 0) {
  const got = cell(cpu, row, col, page);
  const errs = [];
  if (want.ch !== undefined && got.ch !== want.ch) {
    errs.push(`cell(${row},${col}) char=${JSON.stringify(String.fromCharCode(got.ch))} want ${JSON.stringify(String.fromCharCode(want.ch))}`);
  }
  if (want.attr !== undefined && got.attr !== want.attr) {
    errs.push(`cell(${row},${col}) attr=${h2(got.attr)} want ${h2(want.attr)}`);
  }
  return errs;
}

/** BIOS cursor position from the BDA (low byte = column, high byte = row). */
export function cursor(cpu, page = 0) {
  const v = cpu.rd16(0x450 + page * 2);
  return { row: (v >> 8) & 0xff, col: v & 0xff };
}

export function wantCursor(cpu, page, row, col) {
  const got = cursor(cpu, page);
  return got.row === row && got.col === col ? []
    : [`cursor(page ${page})=${got.row},${got.col} want ${row},${col}`];
}

// ------------------------------------------------------------- encoders -----
export const MOD_REG = 3, MOD_DISP8 = 1, MOD_DISP16 = 0, MOD_DISP16_SI = 6;
export const modrm = (mod, reg, rm) => ((mod & 3) << 6) | ((reg & 7) << 3) | (rm & 7);
export const lo = (v) => v & 0xff;
export const hi = (v) => (v >> 8) & 0xff;
export const w16 = (v) => [lo(v), hi(v)];
export const HLT = 0xf4, NOP = 0x90, RET = 0xc3, IRET = 0xcf;

export const enc = {
  mov_r16_imm16: (r, v) => [0xb0 + r, ...w16(v)],
  mov_r8_imm8: (r, v) => [0xb0 + r, lo(v)],
  mov_rm16_r16: (op, rmReg, srcReg) => [op, modrm(MOD_REG, srcReg, rmReg)],
  mov_rm8_r8: (op, rmReg, srcReg) => [op, modrm(MOD_REG, srcReg, rmReg)],
  mov_r16_rm16: (op, dstReg, rmReg) => [op, modrm(MOD_REG, dstReg, rmReg)],
  mov_rm16_imm16: (op, rmReg, v) => [op, modrm(MOD_REG, 0, rmReg), ...w16(v)],
  mov_rm8_imm8: (op, rmReg, v) => [op, modrm(MOD_REG, 0, rmReg), lo(v)],
  alu_r16_imm16: (op, r, v) => [op, ...w16(v)], // 05/0d/15/25/2d/35/3d style
  alu_r8_imm8: (op, v) => [op, lo(v)],         // 04/0c/14/24/2c/34/3c/a8 style
  push_r16: (r) => [0x50 + r],
  pop_r16: (r) => [0x58 + r],
  push_imm16: (v) => [0x68, ...w16(v)],
  int: (n) => [0xcd, n],
  jump_rel8: (op, target, at) => [op, target - at],
  jump_rel16: (op, target, at) => [op, ...w16(target - at)],
};

// ------------------------------------------------------------- reporting ----
export class Suite {
  constructor(name) {
    this.name = name;
    this.cases = 0;
    this.failures = [];
  }
  run(name, fn) {
    this.cases++;
    let errs = [];
    try {
      const r = fn();
      if (r) errs = Array.isArray(r) ? r : [String(r)];
    } catch (e) {
      errs = [`threw: ${e && e.message}`];
    }
    if (errs.length) this.failures.push({ name, errs });
    return this;
  }
  /** Run one case per [label, bytes, expectation] triple. */
  each(label, cases, fn) {
    for (const [name, input] of Object.entries(cases)) {
      this.run(`${label} ${name}`, () => fn(input, name));
    }
  }
  report(check) {
    for (const f of this.failures) {
      check(`${this.name}/${f.name}`, f.errs.join(' | '), 'matches specification');
    }
    console.log(`${this.name}: ${this.cases - this.failures.length}/${this.cases} spec cases pass`);
    return this.failures.length;
  }
}

/** Compress a list of ids into a compact run string for table-driven cases. */
export function pairs(...items) {
  const out = [];
  for (let i = 0; i < items.length; i += 2) out.push([items[i], items[i + 1]]);
  return out;
}
