// 8086 CPU spec suite, part 1: data movement, ALU, flags, shifts/rotates,
// multiply/divide, and the ASCII/BCD adjust instructions.
//
// Every expectation is produced by the oracle in harness.js, which encodes the
// Intel 8086 manual's flag definitions. Programs are hand-assembled.
import {
  CF, PF, AF, ZF, SF, TF, IF, DF, OF,
  GPR, Suite, alu, exec, h2, h4, hi, lin, lo, modrm, neg, newMachine, pfOf,
  put, shift, execWithDivideHandler, want8, wantDivideError, wantFlags, wantMem,
  wantNoError, wantRegs, w16,
} from './harness.js';

const AX = 0, CX = 1, DX = 2, BX = 3, SP = 4, BP = 5, SI = 6, DI = 7;
const AL = 0, CL = 1, DL = 2, BL = 3, AH = 4, CH = 5, DH = 6, BH = 7;
const HLT = 0xf4;
const MEM = 0x8000; // DS:[MEM] scratch operand for r/m forms

// The r/m field of a ModRM byte encodes an effective address, NOT a register index:
// 000=BX+SI 001=BX+DI 010=BP+SI 011=BP+DI 100=SI 101=DI 110=BP (mod!=0) / disp16 (mod=0) 111=BX
const EA_BX_SI = 0, EA_BX_DI = 1, EA_BP_SI = 2, EA_BP_DI = 3, EA_SI = 4, EA_DI = 5, EA_BP = 6, EA_BX = 7;

// ALU group index -> manual opcode family
const GROUPS = { ADD: 0, OR: 1, ADC: 2, SBB: 3, AND: 4, SUB: 5, XOR: 6, CMP: 7 };

// Flags the manual defines for each op. AF is undefined after logical ops.
const FLAGS_FOR = {
  ADD: 'cf,pf,af,zf,sf,of', ADC: 'cf,pf,af,zf,sf,of',
  SUB: 'cf,pf,af,zf,sf,of', SBB: 'cf,pf,af,zf,sf,of', CMP: 'cf,pf,af,zf,sf,of',
  AND: 'cf,pf,zf,sf,of', OR: 'cf,pf,zf,sf,of', XOR: 'cf,pf,zf,sf,of', TEST: 'cf,pf,zf,sf,of',
  INC: 'pf,af,zf,sf,of', DEC: 'pf,af,zf,sf,of',
};

const PAIRS8 = [
  [0x00, 0x00], [0x01, 0x00], [0x00, 0x01], [0x01, 0x01], [0x7f, 0x01], [0x7f, 0x00],
  [0x80, 0x00], [0x80, 0x01], [0x7f, 0x7f], [0x80, 0x80], [0xff, 0x01], [0xff, 0xff],
  [0x00, 0xff], [0x0f, 0x01], [0x10, 0x0f], [0x0f, 0x0f], [0x08, 0x08], [0x55, 0x55],
  [0x7e, 0x02], [0x81, 0x7f], [0xa0, 0x20], [0xf0, 0x0f], [0x02, 0x7e], [0xc0, 0x40],
  [0x01, 0x80], [0x7f, 0x80], [0xff, 0x80], [0x80, 0xff], [0x0a, 0x06], [0x06, 0x0a],
];
const PAIRS16 = [
  [0x0000, 0x0000], [0x0001, 0x0000], [0x0000, 0x0001], [0x7fff, 0x0001], [0x8000, 0x0001],
  [0xffff, 0x0001], [0x8000, 0x8000], [0x7fff, 0x7fff], [0xffff, 0xffff], [0x0000, 0xffff],
  [0x1234, 0x5678], [0x000f, 0x0001], [0x0010, 0x000f], [0x00ff, 0x0001], [0x00f0, 0x000f],
  [0x0f00, 0x00ff], [0xff00, 0x0100], [0x0080, 0x0080], [0x0100, 0x0080], [0x8001, 0x7fff],
  [0x5555, 0x5555], [0xaaaa, 0xaaaa], [0x1000, 0x1000], [0x2000, 0x3fff], [0x4000, 0x4000],
  [0xffff, 0x8000], [0x000a, 0x0006], [0x0006, 0x000a],
];

const flagNames = (op) => FLAGS_FOR[op].split(',');

/** Build a program for one ALU op in one encoding form. */
function aluProgram(op, size, form, a, b, cfIn) {
  const g = GROUPS[op];
  const p = [];
  // Seed CF (and clear the rest) with POPF so ADC/SBB/INC/DEC see a known CF.
  p.push(0xb8, lo(cfIn), hi(cfIn), 0x50, 0x9d);
  const data = [];
  let dst = null;      // register holding the result, or null for a memory dst
  let dstSeg = null, dstOff = 0;

  const movA16 = [0xb8, ...w16(a)];
  const movB16 = [0xba, ...w16(b)];
  const movA8 = [0xb0, lo(a)];
  const movB8 = [0xb3, lo(b)];

  switch (form) {
    // ---- 16-bit ----
    case 'ax_imm16': p.push(...movA16, g * 8 + 5, ...w16(b)); dst = 'ax'; break;
    case 'ax_imm8sx': p.push(...movA16, 0x83, modrm(3, g, AX), lo(b)); dst = 'ax'; break;
    case 'ax_dx': p.push(...movA16, ...movB16, g * 8 + 1, modrm(3, DX, AX)); dst = 'ax'; break;
    case 'dx_ax': p.push(...movB16, ...movA16, g * 8 + 3, modrm(3, AX, DX)); dst = 'ax'; break;
    case 'bx_ax': // ADD [BX], AX -> the register operand is AX
      p.push(0xbb, ...w16(MEM), 0xb8, ...w16(b), g * 8 + 1, modrm(0, 0, EA_BX));
      data.push({ off: MEM, bytes: w16(a) }); dst = 'mem'; dstOff = MEM; break;
    case 'ax_bx':
      p.push(0xbb, ...w16(MEM), ...movA16, g * 8 + 3, modrm(0, 0, EA_BX));
      data.push({ off: MEM, bytes: w16(b) }); dst = 'ax'; break;
    case 'bx_imm16':
      p.push(0xbb, ...w16(MEM), 0x81, modrm(0, g, EA_BX), ...w16(b));
      data.push({ off: MEM, bytes: w16(a) }); dst = 'mem'; dstOff = MEM; break;
    case 'bx_imm8sx':
      p.push(0xbb, ...w16(MEM), 0x83, modrm(0, g, EA_BX), lo(b));
      data.push({ off: MEM, bytes: w16(a) }); dst = 'mem'; dstOff = MEM; break;
    case 'bx_di_disp8': // effective-address arithmetic: [BX+DI+disp8], register operand is DX
      p.push(0xbb, ...w16(0x7000), 0xbf, ...w16(0x2000), ...movB16,
        g * 8 + 1, modrm(1, DX, EA_BX_DI), 0x10);
      data.push({ off: 0x9010, bytes: w16(a) }); dst = 'mem'; dstOff = 0x9010; break;
    // ---- 8-bit ----
    case 'al_imm8': p.push(...movA8, g * 8 + 4, lo(b)); dst = 'al'; break;
    case 'al_bl': p.push(...movA8, ...movB8, g * 8 + 0, modrm(3, BL, AL)); dst = 'al'; break;
    case 'bl_al': p.push(...movB8, ...movA8, g * 8 + 2, modrm(3, AL, BL)); dst = 'al'; break;
    case 'bx_al': // ADD [BX], AL -> the register operand is AL
      p.push(0xbb, ...w16(MEM), 0xb0, lo(b), g * 8 + 0, modrm(0, 0, EA_BX));
      data.push({ off: MEM, bytes: [lo(a)] }); dst = 'mem'; dstOff = MEM; break;
    case 'al_bx':
      p.push(0xbb, ...w16(MEM), ...movA8, g * 8 + 2, modrm(0, 0, EA_BX));
      data.push({ off: MEM, bytes: [lo(b)] }); dst = 'al'; break;
    case 'bx_imm8':
      p.push(0xbb, ...w16(MEM), 0x80, modrm(0, g, EA_BX), lo(b));
      data.push({ off: MEM, bytes: [lo(a)] }); dst = 'mem'; dstOff = MEM; break;
    default: throw new Error(`unknown form ${form}`);
  }
  p.push(HLT);
  return { bytes: p, data, dst, dstOff, size };
}

function checkAlu(op, size, form, a, b, cfIn) {
  const { bytes, data, dst, dstOff } = aluProgram(op, size, form, a, b, cfIn);
  // Immediate r/m forms carry only the low byte, sign-extended for 16-bit operands:
  // the expected result must be computed from that truncated operand, not from b.
  let operand = b;
  if (form === 'ax_imm8sx' || form === 'bx_imm8sx') operand = lo(b) | (lo(b) & 0x80 ? 0xff00 : 0);
  else if (form === 'al_imm8' || form === 'bx_imm8') operand = lo(b);
  const exp = alu(op, a, operand, size, cfIn);
  const r = exec(bytes, { data, maxSteps: 200 });
  const errs = wantNoError(r);
  // CMP compares and writes only the flags — the operands must survive untouched.
  const writes = op !== 'CMP';
  if (dst === 'mem') errs.push(...wantMem(r.cpu, 0x1000, dstOff, size === 8 ? [lo(writes ? exp.r : a)] : w16(writes ? exp.r : a)));
  else if (dst === 'ax') errs.push(...wantRegs(r.cpu, { ax: writes ? exp.r : a }));
  else errs.push(...want8(r.cpu, { al: writes ? exp.r : a }));
  const want = {};
  for (const f of flagNames(op)) want[f] = exp[f];
  errs.push(...wantFlags(r.cpu, want));
  return errs;
}

// TEST has no immediate r/m forms: A8 ib, A9 iw, 84 /r, 85 /r.
function checkTest(size, form, a, b) {
  const p = [0xb8, lo(0), hi(0), 0x50, 0x9d];
  if (size === 16) {
    p.push(0xb8, ...w16(a), 0xba, ...w16(b));
    if (form === 'imm16') p.push(0xa9, ...w16(b));
    else p.push(0x85, modrm(3, DX, AX));
    p.push(HLT);
    const r = exec(p, { maxSteps: 200 });
    const exp = alu('TEST', a, b, 16);
    const errs = wantNoError(r);
    errs.push(...wantRegs(r.cpu, { ax: a, dx: b })); // TEST never writes a register
    errs.push(...wantFlags(r.cpu, { cf: exp.cf, pf: exp.pf, zf: exp.zf, sf: exp.sf, of: exp.of }));
    return errs;
  }
  p.push(0xb0, lo(a), 0xb3, lo(b));
  if (form === 'imm8') p.push(0xa8, lo(b));
  else p.push(0x84, modrm(3, BL, AL));
  p.push(HLT);
  const r = exec(p, { maxSteps: 200 });
  const exp = alu('TEST', a, b, 8);
  const errs = wantNoError(r);
  errs.push(...want8(r.cpu, { al: a, bl: b }));
  errs.push(...wantFlags(r.cpu, { cf: exp.cf, pf: exp.pf, zf: exp.zf, sf: exp.sf, of: exp.of }));
  return errs;
}

// ------------------------------------------------------------- sections -----
function aluSection(s) {
  const forms16 = ['ax_imm16', 'ax_imm8sx', 'ax_dx', 'dx_ax', 'bx_ax', 'ax_bx', 'bx_imm16', 'bx_imm8sx', 'bx_di_disp8'];
  const forms8 = ['al_imm8', 'al_bl', 'bl_al', 'bx_al', 'al_bx', 'bx_imm8'];
  for (const [op, g] of Object.entries(GROUPS)) {
    for (const [a, b] of PAIRS16) {
      for (const form of forms16) {
        const cfIns = (op === 'ADC' || op === 'SBB') ? [0, 1] : [0];
        for (const cfIn of cfIns) {
          s.run(`${op}16 ${form} ${h4(a)}${op === 'ADC' || op === 'SBB' ? (cfIn ? ' cf=1' : ' cf=0') : ''},${h4(b)}`,
            () => checkAlu(op, 16, form, a, b, cfIn));
        }
      }
    }
    for (const [a, b] of PAIRS8) {
      for (const form of forms8) {
        const cfIns = (op === 'ADC' || op === 'SBB') ? [0, 1] : [0];
        for (const cfIn of cfIns) {
          s.run(`${op}8 ${form} ${h2(a)}${op === 'ADC' || op === 'SBB' ? (cfIn ? ' cf=1' : ' cf=0') : ''},${h2(b)}`,
            () => checkAlu(op, 8, form, a, b, cfIn));
        }
      }
    }
  }
  for (const [a, b] of PAIRS16) {
    for (const form of ['imm16', 'reg']) {
      s.run(`TEST16 ${form} ${h4(a)},${h4(b)}`, () => checkTest(16, form, a, b));
    }
  }
  for (const [a, b] of PAIRS8) {
    for (const form of ['imm8', 'reg']) {
      s.run(`TEST8 ${form} ${h2(a)},${h2(b)}`, () => checkTest(8, form, a, b));
    }
  }
}

// INC/DEC: CF must be preserved, every other flag updates.
function incDecSection(s) {
  const values16 = [0x0000, 0x0001, 0x00ff, 0x0100, 0x7fff, 0x8000, 0xffff, 0x8001, 0x000f, 0x0010];
  const values8 = [0x00, 0x01, 0x0f, 0x10, 0x7f, 0x80, 0xff, 0x81, 0x09, 0x0a];
  for (const op of ['INC', 'DEC']) {
    const g = op === 'INC' ? 0 : 1;
    for (const v of values16) {
      for (const cfIn of [0, 1]) {
        // Register form: FF /0 = INC r/m16, FF /1 = DEC r/m16. Each case is registered
        // once, with the group its own opcode needs (the op loop must not drive the group).
        if (op === 'INC') {
          s.run(`INC16 AX ${h4(v)} cf=${cfIn}`, () => {
            const exp = alu('INC', v, 0, 16, cfIn);
            const r = exec([0xb8, lo(cfIn), hi(cfIn), 0x50, 0x9d, 0xb8, ...w16(v), 0xff, modrm(3, 0, AX), HLT], { maxSteps: 200 });
            const errs = wantNoError(r);
            errs.push(...wantRegs(r.cpu, { ax: exp.r }));
            errs.push(...wantFlags(r.cpu, { cf: cfIn, pf: exp.pf, af: exp.af, zf: exp.zf, sf: exp.sf, of: exp.of }));
            return errs;
          });
          s.run(`INC16 DX ${h4(v)} cf=${cfIn}`, () => {
            const exp = alu('INC', v, 0, 16, cfIn);
            const r = exec([0xb8, lo(cfIn), hi(cfIn), 0x50, 0x9d, 0xba, ...w16(v), 0xff, modrm(3, 0, DX), HLT], { maxSteps: 200 });
            const errs = wantNoError(r);
            errs.push(...wantRegs(r.cpu, { dx: exp.r }));
            errs.push(...wantFlags(r.cpu, { cf: cfIn, pf: exp.pf, af: exp.af, zf: exp.zf, sf: exp.sf, of: exp.of }));
            return errs;
          });
        } else {
          s.run(`DEC16 AX ${h4(v)} cf=${cfIn}`, () => {
            const exp = alu('DEC', v, 0, 16, cfIn);
            const r = exec([0xb8, lo(cfIn), hi(cfIn), 0x50, 0x9d, 0xb8, ...w16(v), 0xff, modrm(3, 1, AX), HLT], { maxSteps: 200 });
            const errs = wantNoError(r);
            errs.push(...wantRegs(r.cpu, { ax: exp.r }));
            errs.push(...wantFlags(r.cpu, { cf: cfIn, pf: exp.pf, af: exp.af, zf: exp.zf, sf: exp.sf, of: exp.of }));
            return errs;
          });
          s.run(`DEC16 DX ${h4(v)} cf=${cfIn}`, () => {
            const exp = alu('DEC', v, 0, 16, cfIn);
            const r = exec([0xb8, lo(cfIn), hi(cfIn), 0x50, 0x9d, 0xba, ...w16(v), 0xff, modrm(3, 1, DX), HLT], { maxSteps: 200 });
            const errs = wantNoError(r);
            errs.push(...wantRegs(r.cpu, { dx: exp.r }));
            errs.push(...wantFlags(r.cpu, { cf: cfIn, pf: exp.pf, af: exp.af, zf: exp.zf, sf: exp.sf, of: exp.of }));
            return errs;
          });
        }
      }
    }
    for (const v of values8) {
      for (const cfIn of [0, 1]) {
        // FE /0 and FE /1 are the byte forms; word INC/DEC use FF /0 and FF /1.
        if (op === 'INC') {
          s.run(`INC8 AL ${h2(v)} cf=${cfIn}`, () => {
            const exp = alu('INC', v, 0, 8, cfIn);
            const r = exec([0xb8, lo(cfIn), hi(cfIn), 0x50, 0x9d, 0xb0, lo(v), 0xfe, modrm(3, 0, AL), HLT], { maxSteps: 200 });
            const errs = wantNoError(r);
            errs.push(...want8(r.cpu, { al: exp.r }));
            errs.push(...wantFlags(r.cpu, { cf: cfIn, pf: exp.pf, af: exp.af, zf: exp.zf, sf: exp.sf, of: exp.of }));
            return errs;
          });
          s.run(`INC8 BL ${h2(v)} cf=${cfIn}`, () => {
            const exp = alu('INC', v, 0, 8, cfIn);
            const r = exec([0xb8, lo(cfIn), hi(cfIn), 0x50, 0x9d, 0xb3, lo(v), 0xfe, modrm(3, 0, BL), HLT], { maxSteps: 200 });
            const errs = wantNoError(r);
            errs.push(...want8(r.cpu, { bl: exp.r }));
            errs.push(...wantFlags(r.cpu, { cf: cfIn, pf: exp.pf, af: exp.af, zf: exp.zf, sf: exp.sf, of: exp.of }));
            return errs;
          });
        } else {
          s.run(`DEC8 AL ${h2(v)} cf=${cfIn}`, () => {
            const exp = alu('DEC', v, 0, 8, cfIn);
            const r = exec([0xb8, lo(cfIn), hi(cfIn), 0x50, 0x9d, 0xb0, lo(v), 0xfe, modrm(3, 1, AL), HLT], { maxSteps: 200 });
            const errs = wantNoError(r);
            errs.push(...want8(r.cpu, { al: exp.r }));
            errs.push(...wantFlags(r.cpu, { cf: cfIn, pf: exp.pf, af: exp.af, zf: exp.zf, sf: exp.sf, of: exp.of }));
            return errs;
          });
          s.run(`DEC8 BL ${h2(v)} cf=${cfIn}`, () => {
            const exp = alu('DEC', v, 0, 8, cfIn);
            const r = exec([0xb8, lo(cfIn), hi(cfIn), 0x50, 0x9d, 0xb3, lo(v), 0xfe, modrm(3, 1, BL), HLT], { maxSteps: 200 });
            const errs = wantNoError(r);
            errs.push(...want8(r.cpu, { bl: exp.r }));
            errs.push(...wantFlags(r.cpu, { cf: cfIn, pf: exp.pf, af: exp.af, zf: exp.zf, sf: exp.sf, of: exp.of }));
            return errs;
          });
        }
      }
    }
    // memory forms
    for (const v of values16) {
      s.run(`${op}16 [bx] ${h4(v)}`, () => {
        const exp = alu(op, v, 0, 16, 0);
        const opc = 0xff;
        const r = exec([0xbb, ...w16(MEM), opc, modrm(0, g, EA_BX), HLT],
          { data: [{ off: MEM, bytes: w16(v) }], maxSteps: 200 });
        const errs = wantNoError(r);
        errs.push(...wantMem(r.cpu, 0x1000, MEM, w16(exp.r)));
        errs.push(...wantFlags(r.cpu, { pf: exp.pf, af: exp.af, zf: exp.zf, sf: exp.sf, of: exp.of }));
        return errs;
      });
    }
  }
}

// NEG / NOT / group TEST (F6/F7)
function negNotSection(s) {
  const v8 = [0x00, 0x01, 0x02, 0x7f, 0x80, 0x81, 0xff, 0x0a, 0xf6, 0x10];
  const v16 = [0x0000, 0x0001, 0x00ff, 0x7fff, 0x8000, 0x8001, 0xffff, 0x000a, 0xfff6, 0x0100];
  for (const v of v8) {
    s.run(`NEG8 ${h2(v)}`, () => {
      const exp = neg(v, 8);
      const r = exec([0xb0, lo(v), 0xf6, modrm(3, 3, AL), HLT], { maxSteps: 200 });
      const errs = wantNoError(r);
      errs.push(...want8(r.cpu, { al: exp.r }));
      errs.push(...wantFlags(r.cpu, { cf: exp.cf, pf: exp.pf, af: exp.af, zf: exp.zf, sf: exp.sf, of: exp.of }));
      return errs;
    });
    s.run(`NOT8 ${h2(v)}`, () => {
      const r = exec([0xb0, lo(v), 0xf6, modrm(3, 2, AL), HLT], { maxSteps: 200 });
      const errs = wantNoError(r);
      errs.push(...want8(r.cpu, { al: (~v) & 0xff }));
      // NOT leaves flags unchanged. Check both initial OF states instead of
      // deriving flag expectations from the operand result.
      for (const flags of [0x00d5, 0x08d5]) {
        const f = exec([0xb0, lo(v), 0xf6, modrm(3, 2, AL), HLT], { flags, maxSteps: 200 });
        errs.push(...wantFlags(f.cpu, {
          cf: flags & 1 ? 1 : 0, pf: flags & 4 ? 1 : 0, af: flags & 0x10 ? 1 : 0,
          zf: flags & 0x40 ? 1 : 0, sf: flags & 0x80 ? 1 : 0, of: flags & 0x800 ? 1 : 0,
        }));
      }
      return errs;
    });
    s.run(`TEST8 group ${h2(v)}`, () => {
      const exp = alu('TEST', v, 0x0f, 8);
      const r = exec([0xb0, lo(v), 0xf6, modrm(3, 0, AL), 0x0f, HLT], { maxSteps: 200 });
      const errs = wantNoError(r);
      errs.push(...want8(r.cpu, { al: v }));
      errs.push(...wantFlags(r.cpu, { cf: 0, pf: exp.pf, zf: exp.zf, sf: exp.sf, of: 0 }));
      return errs;
    });
  }
  for (const v of v16) {
    s.run(`NEG16 ${h4(v)}`, () => {
      const exp = neg(v, 16);
      const r = exec([0xb8, ...w16(v), 0xf7, modrm(3, 3, AX), HLT], { maxSteps: 200 });
      const errs = wantNoError(r);
      errs.push(...wantRegs(r.cpu, { ax: exp.r }));
      errs.push(...wantFlags(r.cpu, { cf: exp.cf, pf: exp.pf, af: exp.af, zf: exp.zf, sf: exp.sf, of: exp.of }));
      return errs;
    });
    s.run(`NOT16 ${h4(v)}`, () => {
      const r = exec([0xb8, ...w16(v), 0xf7, modrm(3, 2, AX), HLT], { maxSteps: 200 });
      const errs = wantNoError(r);
      errs.push(...wantRegs(r.cpu, { ax: (~v) & 0xffff }));
      return errs;
    });
    s.run(`TEST16 group ${h4(v)}`, () => {
      const exp = alu('TEST', v, 0x00ff, 16);
      const r = exec([0xb8, ...w16(v), 0xf7, modrm(3, 0, AX), ...w16(0x00ff), HLT], { maxSteps: 200 });
      const errs = wantNoError(r);
      errs.push(...wantRegs(r.cpu, { ax: v }));
      errs.push(...wantFlags(r.cpu, { cf: 0, pf: exp.pf, zf: exp.zf, sf: exp.sf, of: 0 }));
      return errs;
    });
  }
}

// MUL / IMUL / DIV / IDIV (F6/F7 /4../7)
function s8(v) { return v > 0x7f ? v - 0x100 : v; }
function s16(v) { return v > 0x7fff ? v - 0x10000 : v; }

function mulDivSection(s) {
  const vals8 = [0x00, 0x01, 0x02, 0x03, 0x0a, 0x10, 0x7f, 0x80, 0xff, 0x0f, 0x64];
  const vals16 = [0x0000, 0x0001, 0x0002, 0x0003, 0x000a, 0x0100, 0x7fff, 0x8000, 0xffff, 0x00ff, 0x1000];
  for (const a of vals8) {
    for (const b of vals8) {
      s.run(`MUL8 ${h2(a)}*${h2(b)}`, () => {
        const p = a * b;
        const r = exec([0xb0, lo(a), 0xb3, lo(b), 0xf6, modrm(3, 4, BL), HLT], { maxSteps: 200 });
        const errs = wantNoError(r);
        errs.push(...wantRegs(r.cpu, { ax: p & 0xffff }));
        errs.push(...wantFlags(r.cpu, { cf: p > 0xff ? 1 : 0, of: p > 0xff ? 1 : 0 }));
        return errs;
      });
      s.run(`IMUL8 ${h2(a)}*${h2(b)}`, () => {
        const p = s8(a) * s8(b);
        const lo8 = p & 0xff;
        const fits = p >= -128 && p <= 127;
        const r = exec([0xb0, lo(a), 0xb3, lo(b), 0xf6, modrm(3, 5, BL), HLT], { maxSteps: 200 });
        const errs = wantNoError(r);
        errs.push(...wantRegs(r.cpu, { ax: (p & 0xffff) }));
        errs.push(...wantFlags(r.cpu, { cf: fits ? 0 : 1, of: fits ? 0 : 1 }));
        return errs;
      });
      if (b === 0) {
        s.run(`DIV8 by zero ${h2(a)}`, () => {
          const bytes = [0xb8, ...w16(a), 0xb3, 0, 0xf6, modrm(3, 6, BL), HLT];
          const r = execWithDivideHandler(bytes, { maxSteps: 200 });
          return wantDivideError(r, bytes.length);
        });
        s.run(`IDIV8 by zero ${h2(a)}`, () => {
          const dividend = s8(a) & 0xffff;
          const bytes = [0xb8, ...w16(dividend), 0xb3, 0, 0xf6, modrm(3, 7, BL), HLT];
          const r = execWithDivideHandler(bytes, { maxSteps: 200 });
          return wantDivideError(r, bytes.length);
        });
        continue;
      }
      s.run(`DIV8 ${h2(a)}/${h2(b)}`, () => {
        const q = Math.trunc(a / b), rem = a % b;
        const overflow = q > 0xff;
        const bytes = [0xb8, ...w16(a), 0xb3, lo(b), 0xf6, modrm(3, 6, BL), HLT];
        const r = overflow
          ? execWithDivideHandler(bytes, { maxSteps: 200 })
          : exec(bytes, { maxSteps: 200 });
        if (overflow) return wantDivideError(r, bytes.length);
        const errs = wantNoError(r);
        errs.push(...want8(r.cpu, { al: q, ah: rem }));
        return errs;
      });
      s.run(`IDIV8 ${s8(a)}/${s8(b)}`, () => {
        const q = Math.trunc(s8(a) / s8(b));
        const rem = s8(a) - q * s8(b);
        const overflow = q < -128 || q > 127;
        const dividend = s8(a) & 0xffff;
        const bytes = [0xb8, ...w16(dividend), 0xb3, lo(b), 0xf6, modrm(3, 7, BL), HLT];
        const r = overflow
          ? execWithDivideHandler(bytes, { maxSteps: 200 })
          : exec(bytes, { maxSteps: 200 });
        if (overflow) return wantDivideError(r, bytes.length);
        const errs = wantNoError(r);
        errs.push(...want8(r.cpu, { al: q & 0xff, ah: rem & 0xff }));
        return errs;
      });
    }
  }
  for (const a of vals16) {
    for (const b of vals16) {
      s.run(`MUL16 ${h4(a)}*${h4(b)}`, () => {
        const p = a * b;
        const r = exec([0xb8, ...w16(a), 0xba, ...w16(b), 0xf7, modrm(3, 4, DX), HLT], { maxSteps: 200 });
        const errs = wantNoError(r);
        errs.push(...wantRegs(r.cpu, { ax: p & 0xffff, dx: (p >>> 16) & 0xffff }));
        errs.push(...wantFlags(r.cpu, { cf: (p >>> 16) !== 0 ? 1 : 0, of: (p >>> 16) !== 0 ? 1 : 0 }));
        return errs;
      });
      s.run(`IMUL16 ${h4(a)}*${h4(b)}`, () => {
        const p = s16(a) * s16(b);
        const fits = p >= -32768 && p <= 32767;
        const r = exec([0xb8, ...w16(a), 0xba, ...w16(b), 0xf7, modrm(3, 5, DX), HLT], { maxSteps: 200 });
        const errs = wantNoError(r);
        const u = p < 0 ? p + 0x100000000 : p;
        errs.push(...wantRegs(r.cpu, { ax: u & 0xffff, dx: (u >>> 16) & 0xffff }));
        errs.push(...wantFlags(r.cpu, { cf: fits ? 0 : 1, of: fits ? 0 : 1 }));
        return errs;
      });
      if (b === 0) {
        s.run(`DIV16 by zero ${h4(a)}`, () => {
          const bytes = [0xb8, ...w16(a), 0xbb, 0, 0, 0xf7, modrm(3, 6, BX), HLT];
          const r = execWithDivideHandler(bytes, { maxSteps: 200 });
          return wantDivideError(r, bytes.length);
        });
        s.run(`IDIV16 by zero ${h4(a)}`, () => {
          const dividend = a & 0x8000 ? 0xffff : 0;
          const bytes = [0xba, ...w16(dividend), 0xb8, ...w16(a), 0xbb, 0, 0, 0xf7, modrm(3, 7, BX), HLT];
          const r = execWithDivideHandler(bytes, { maxSteps: 200 });
          return wantDivideError(r, bytes.length);
        });
        continue;
      }
      s.run(`DIV16 ${h4(a)}/${h4(b)}`, () => {
        const q = Math.trunc(a / b), rem = a % b;
        const bytes = [0xba, 0, 0, 0xb8, ...w16(a), 0xbb, ...w16(b), 0xf7, modrm(3, 6, BX), HLT];
        const r = exec(bytes, { maxSteps: 200 });
        const errs = wantNoError(r);
        errs.push(...wantRegs(r.cpu, { ax: q & 0xffff, dx: rem & 0xffff }));
        return errs;
      });
      s.run(`IDIV16 ${s16(a)}/${s16(b)}`, () => {
        const q = Math.trunc(s16(a) / s16(b));
        const rem = s16(a) - q * s16(b);
        const overflow = q < -32768 || q > 32767;
        const dividend = a & 0x8000 ? 0xffff : 0;
        const bytes = [0xba, ...w16(dividend), 0xb8, ...w16(a), 0xbb, ...w16(b), 0xf7, modrm(3, 7, BX), HLT];
        const r = overflow
          ? execWithDivideHandler(bytes, { maxSteps: 200 })
          : exec(bytes, { maxSteps: 200 });
        if (overflow) return wantDivideError(r, bytes.length);
        const errs = wantNoError(r);
        errs.push(...wantRegs(r.cpu, { ax: q & 0xffff, dx: rem & 0xffff }));
        return errs;
      });
    }
  }
  // 8-bit DIV uses the full AX dividend. Exercise wider values and quotient
  // overflow with a real vector-0 handler.
  for (const [ax, divisor] of [[0x0100, 2], [0x1234, 0x20], [0xfeff, 0xff]]) {
    s.run(`DIV8 AX ${h4(ax)}/${h2(divisor)}`, () => {
      const q = Math.trunc(ax / divisor), rem = ax % divisor;
      const bytes = [0xb8, ...w16(ax), 0xb3, divisor, 0xf6, modrm(3, 6, BL), HLT];
      const r = exec(bytes, { maxSteps: 200 });
      const errs = wantNoError(r);
      errs.push(...want8(r.cpu, { al: q, ah: rem }));
      return errs;
    });
  }
  s.run('DIV8 quotient overflow raises vector 0', () => {
    const bytes = [0xb8, 0x00, 0x01, 0xb3, 0x01, 0xf6, modrm(3, 6, BL), HLT];
    const r = execWithDivideHandler(bytes, { maxSteps: 200 });
    return wantDivideError(r, bytes.length);
  });
  s.run('DIV16 quotient overflow raises vector 0', () => {
    const bytes = [0xba, 0x00, 0x01, 0xb8, 0x00, 0x00, 0xbb, 0x01, 0x00, 0xf7, modrm(3, 6, BX), HLT];
    const r = execWithDivideHandler(bytes, { maxSteps: 200 });
    return wantDivideError(r, bytes.length);
  });
  s.run('IDIV16 -32768/-1 quotient overflow raises vector 0', () => {
    const bytes = [0xba, 0xff, 0xff, 0xb8, 0x00, 0x80, 0xbb, 0xff, 0xff, 0xf7, modrm(3, 7, BX), HLT];
    const r = execWithDivideHandler(bytes, { maxSteps: 200 });
    return wantDivideError(r, bytes.length);
  });
}

// 8086 shifts and rotates use D0-D3 (by 1 / by CL). C0/C1 immediate-count
// forms were introduced later; C6/C7 are MOV-immediate instructions here.
const SHIFT_OPS = { ROL: 0, ROR: 1, RCL: 2, RCR: 3, SHL: 4, SHR: 5, SAL: 4, SAR: 7 };
function shiftSection(s) {
  const vals8 = [0x00, 0x01, 0x80, 0x81, 0xff, 0x7f, 0x55, 0xaa, 0x0f, 0xf0, 0x12];
  const vals16 = [0x0000, 0x0001, 0x8000, 0x8001, 0xffff, 0x7fff, 0x5555, 0xaaaa, 0x000f, 0xf0f0, 0x1234];
  const counts8 = [1, 2, 3, 7];
  const counts16 = [1, 2, 3, 7, 8, 15];
  for (const [op, g] of Object.entries(SHIFT_OPS)) {
    for (const v of vals8) {
      for (const c of counts8) {
        for (const cfIn of [0, 1]) {
          s.run(`${op}8 ${h2(v)}<<${c} cf=${cfIn}`, () => {
            const exp = shift(op, v, c, 8, cfIn);
            const useCl = c > 1;
            const bytes = [0xb8, lo(cfIn), hi(cfIn), 0x50, 0x9d, 0xb0, lo(v)];
            if (useCl) bytes.push(0xb1, lo(c), 0xd2, modrm(3, g, AL));
            else bytes.push(0xd0, modrm(3, g, AL));
            bytes.push(HLT);
            const r = exec(bytes, { maxSteps: 200 });
            const errs = wantNoError(r);
            errs.push(...want8(r.cpu, { al: exp.r }));
            // Manual: rotates (ROL/ROR/RCL/RCR) affect CF and, for count 1, OF only —
            // SF, ZF, PF and AF are explicitly left alone. OF is undefined for count > 1.
            const rot = op === 'ROL' || op === 'ROR' || op === 'RCL' || op === 'RCR';
            const want = { cf: exp.cf };
            if (!rot) { want.pf = exp.pf; want.zf = exp.zf; want.sf = exp.sf; }
            if (c === 1) want.of = exp.of;
            errs.push(...wantFlags(r.cpu, want));
            return errs;
          });
        }
      }
    }
    for (const v of vals16) {
      for (const c of counts16) {
        for (const cfIn of [0, 1]) {
          s.run(`${op}16 ${h4(v)}<<${c} cf=${cfIn}`, () => {
            const exp = shift(op, v, c, 16, cfIn);
            const bytes = [0xb8, lo(cfIn), hi(cfIn), 0x50, 0x9d, 0xb8, ...w16(v)];
            if (c === 1) bytes.push(0xd1, modrm(3, g, AX));
            else bytes.push(0xb1, lo(c), 0xd3, modrm(3, g, AX));
            bytes.push(HLT);
            const r = exec(bytes, { maxSteps: 200 });
            const errs = wantNoError(r);
            errs.push(...wantRegs(r.cpu, { ax: exp.r }));
            // Rotates leave SF/ZF/PF/AF alone; OF is defined only for a count of 1.
            const rot = op === 'ROL' || op === 'ROR' || op === 'RCL' || op === 'RCR';
            const want = { cf: exp.cf };
            if (!rot) { want.pf = exp.pf; want.zf = exp.zf; want.sf = exp.sf; }
            if (c === 1) want.of = exp.of;
            errs.push(...wantFlags(r.cpu, want));
            return errs;
          });
        }
      }
    }
    // Count zero through CL preserves the byte/word operand and all flags.
    for (const size of [8, 16]) s.run(`${op}${size} count 0 preserves flags`, () => {
      const bytes = size === 8
        ? [0xb1, 0x00, 0xb0, 0x34, 0xd2, modrm(3, g, AL), HLT]
        : [0xb1, 0x00, 0xb8, 0x34, 0x12, 0xd3, modrm(3, g, AX), HLT];
      const r = exec(bytes, { flags: 0x0ed5, maxSteps: 200 });
      const errs = wantNoError(r);
      if (size === 8) errs.push(...want8(r.cpu, { al: 0x34 }));
      else errs.push(...wantRegs(r.cpu, { ax: 0x1234 }));
      errs.push(...wantFlags(r.cpu, { cf: 1, pf: 1, af: 1, zf: 1, sf: 1, of: 1, df: 1, if: 1 }));
      return errs;
    });
  }

  // The 8086 uses the full CL byte. Counts whose low five bits are 0 or 1
  // distinguish it from 286+ masking. For over-width shifts, assert the
  // defined result only; for rotates, result and CF remain defined.
  const longRotateCases = [
    ['ROL', 0x01, 0], ['ROR', 0x80, 0],
    ['RCL', 0x01, 0], ['RCR', 0x80, 0],
  ];
  for (const size of [8, 16]) {
    for (const count of [32, 33, 255]) {
      for (const [op, value8, cfIn] of longRotateCases) {
        const g = SHIFT_OPS[op];
        const value = size === 8 ? value8 : value8 === 0x80 ? 0x8000 : value8;
        s.run(`${op}${size} uses full CL count ${count}`, () => {
          const exp = shift(op, value, count, size, cfIn);
          const flags = (0x0ed4 | cfIn);
          const bytes = [0xb8, ...w16(flags), 0x50, 0x9d];
          if (size === 8) bytes.push(0xb0, lo(value));
          else bytes.push(0xb8, ...w16(value));
          bytes.push(0xb1, lo(count), size === 8 ? 0xd2 : 0xd3, modrm(3, g, size === 8 ? AL : AX), HLT);
          const r = exec(bytes, { maxSteps: 200 });
          const errs = wantNoError(r);
          if (size === 8) errs.push(...want8(r.cpu, { al: exp.r }));
          else errs.push(...wantRegs(r.cpu, { ax: exp.r }));
          errs.push(...wantFlags(r.cpu, { cf: exp.cf, pf: 1, af: 1, zf: 1, sf: 1, df: 1, if: 1 }));
          return errs;
        });
      }
    }
  }

  for (const size of [8, 16]) {
    const register = size === 8 ? AL : AX;
    const opcode = size === 8 ? 0xd2 : 0xd3;
    for (const [op, group, input, expected] of [
      ['SHL', 4, 1, 0], ['SHR', 5, size === 8 ? 0x80 : 0x8000, 0],
      ['SAR', 7, size === 8 ? 0x80 : 0x8000, size === 8 ? 0xff : 0xffff],
    ]) {
      s.run(`${op}${size} uses full CL count 32`, () => {
        const bytes = size === 8
          ? [0xb0, lo(input), 0xb1, 32, opcode, modrm(3, group, register), HLT]
          : [0xb8, ...w16(input), 0xb1, 32, opcode, modrm(3, group, register), HLT];
        const r = exec(bytes, { maxSteps: 200 });
        const errs = wantNoError(r);
        if (size === 8) errs.push(...want8(r.cpu, { al: expected }));
        else errs.push(...wantRegs(r.cpu, { ax: expected }));
        return errs;
      });
    }
  }
}

// BCD / ASCII adjust: DAA, DAS, AAA, AAS, AAM, AAD
function daaRef(al, cf, af, manual) {
  // Primary reference = the 8086 hardware form: the low-nibble adjust fires on
  // (AL & 0x0f) > 9 OR AF, and the high-nibble adjust sees AL as it entered the
  // instruction (the two adjusts are not chained).
  // manual = the Intel programmer's-reference pseudocode literal, which uses
  // "AL > 9 AND AF" and "AL > 15" and chains the second adjust on the
  // first-adjusted value. That literal form mis-adjusts valid packed BCD such
  // as 10h, so it is kept only as the documented alternative.
  if (!manual) {
    let r = al, c = cf, a = af;
    if ((al & 0x0f) > 9 || af) { r = (al + 6) & 0xff; a = 1; if (al + 6 > 0xff) c = 1; }
    else a = 0;
    if (al > 0x9f || cf) { r = (r + 0x60) & 0xff; c = 1; }
    return { r, cf: c, af: a };
  }
  let r = al, c = cf, a = af;
  if ((r > 9 && af) || r > 0x0f) {
    const t = r + 6;
    r = t & 0xff;
    a = 1;
    if (t > 0xff) c = 1;
  } else a = 0;
  if (r > 0x9f || c) { r = (r + 0x60) & 0xff; c = 1; }
  return { r, cf: c, af: a };
}
function dasRef(al, cf, af, manual) {
  // Primary reference = the 8086 hardware form (low-nibble adjust on
  // (AL & 0x0f) > 9 OR AF, borrow only when the incoming CF is set, and the
  // high-nibble adjust firing at AL >= 9Ah — the documented 8086 asymmetry, as
  // DAA uses > 9Fh). manual = the programmer's-reference pseudocode literal,
  // kept as the documented alternative.
  if (!manual) {
    let r = al, c = cf, a = af;
    if ((al & 0x0f) > 9 || af) {
      r = (al - 6) & 0xff;
      a = 1;
      if (al >= 0x9a || cf) { r = (r - 0x60) & 0xff; c = 1; }
      else c = cf && al < 6;
    } else {
      a = 0;
      if (al >= 0x9a || cf) { r = (al - 0x60) & 0xff; c = 1; }
    }
    return { r, cf: c, af: a };
  }
  let r = al, c = cf, a = af;
  if ((r > 9 && af) || r > 0x0f) {
    a = 1;
    const borrow = cf && r < 6;
    r = (r - 6) & 0xff;
    if (borrow) c = 1;
  } else a = 0;
  if (r > 0x9f || c) { r = (r - 0x60) & 0xff; c = 1; }
  return { r, cf: c, af: a };
}
function aaaRef(al, ah, cf, af, manual) {
  // Primary reference = the 8086 hardware form: the adjust fires when the low
  // nibble is > 9 OR AF is set (AF is the carry-out of the low nibble from the
  // preceding ADD), then AL is masked to its low nibble.
  // manual = the programmer's-reference pseudocode literal ("AL > 9 AND AF" /
  // "AL > 15"), kept as the documented alternative.
  if (!manual) {
    if ((al & 0x0f) > 9 || af) return { r: (al + 6) & 0x0f, h: (ah + 1) & 0xff, cf: 1, af: 1 };
    return { r: al & 0x0f, h: ah, cf: 0, af: 0 };
  }
  let r = al, h = ah, c = cf, a = cf;
  if ((r > 9 && af) || r > 0x0f) {
    r = (r + 6) & 0xff; h = (h + 1) & 0xff; a = 1; c = 1;
  } else { a = 0; c = 0; }
  r &= 0x0f;
  return { r, h, cf: c, af: a };
}
function aasRef(al, ah, cf, af, manual) {
  if (!manual) {
    if ((al & 0x0f) > 9 || af) return { r: (al - 6) & 0x0f, h: (ah - 1) & 0xff, cf: 1, af: 1 };
    return { r: al & 0x0f, h: ah, cf: 0, af: 0 };
  }
  let r = al, h = ah, c = cf, a = cf;
  if ((r > 9 && af) || r > 0x0f) {
    r = (r - 6) & 0xff; h = (h - 1) & 0xff; a = 1; c = 1;
  } else { a = 0; c = 0; }
  r &= 0x0f;
  return { r, h, cf: c, af: a };
}

function bcdSection(s) {
  const alVals = [];
  for (let i = 0; i <= 0xff; i++) alVals.push(i);
  for (const al of alVals) {
    for (const cf of [0, 1]) {
      for (const af of [0, 1]) {
        s.run(`DAA ${h2(al)} cf=${cf} af=${af}`, () => {
          const strict = daaRef(al, cf, af, true);
          const loose = daaRef(al, cf, af, false);          const r = exec([0xb8, lo(cf | (af << 4)), hi(0), 0x50, 0x9d, 0xb0, lo(al), 0x27, HLT], { maxSteps: 200 });
          const errs = wantNoError(r);
          const gotAl = r.cpu.r[GPR.ax] & 0xff;
          const gotCf = (r.cpu.flags & CF) ? 1 : 0;
          const gotAf = (r.cpu.flags & AF) ? 1 : 0;
          const flagsOk = (r.cpu.flags & ZF) === (gotAl === 0 ? ZF : 0)
            && (r.cpu.flags & SF) === ((gotAl & 0x80) ? SF : 0)
            && (r.cpu.flags & PF) === (pfOf(gotAl) ? PF : 0);
          const matchStrict = gotAl === strict.r && gotCf === strict.cf && gotAf === strict.af;
          const matchLoose = gotAl === loose.r && gotCf === loose.cf && gotAf === loose.af;
          if ((!matchStrict && !matchLoose) || !flagsOk) {
            errs.push(`al=${h2(gotAl)} cf=${gotCf} af=${gotAf} want hw al=${h2(loose.r)} cf=${loose.cf} af=${loose.af} (alt manual al=${h2(strict.r)} cf=${strict.cf} af=${strict.af})${flagsOk ? '' : ' sf/zf/pf mismatch'}`);
          }
          return errs;
        });
        s.run(`DAS ${h2(al)} cf=${cf} af=${af}`, () => {
          const strict = dasRef(al, cf, af, true);
          const loose = dasRef(al, cf, af, false);
          const r = exec([0xb8, lo(cf | (af << 4)), hi(0), 0x50, 0x9d, 0xb0, lo(al), 0x2f, HLT], { maxSteps: 200 });
          const errs = wantNoError(r);
          const gotAl = r.cpu.r[GPR.ax] & 0xff;
          const gotCf = (r.cpu.flags & CF) ? 1 : 0;
          const gotAf = (r.cpu.flags & AF) ? 1 : 0;
          const matchStrict = gotAl === strict.r && gotCf === strict.cf && gotAf === strict.af;
          const matchLoose = gotAl === loose.r && gotCf === loose.cf && gotAf === loose.af;
          if (!matchStrict && !matchLoose) {
            errs.push(`al=${h2(gotAl)} cf=${gotCf} af=${gotAf} want hw al=${h2(loose.r)} cf=${loose.cf} af=${loose.af} (alt manual al=${h2(strict.r)} cf=${strict.cf} af=${strict.af})`);
          }
          return errs;
        });
      }
    }
  }
  // AAA/AAS are defined for unpacked decimal digits. Build the flags with the
  // preceding ADD/SUB instruction, as real callers do; invalid BCD operands
  // have unpredictable results on the 8086 and are not conformance cases.
  for (let left = 0; left <= 9; left++) {
    for (let right = 0; right <= 9; right++) {
      const leftAscii = 0x30 + left, rightAscii = 0x30 + right;
      const addedAl = (leftAscii + rightAscii) & 0xff;
      const addAf = ((leftAscii & 0xf) + (rightAscii & 0xf)) > 0xf ? 1 : 0;
      s.run(`AAA ${leftAscii.toString(16)}+${rightAscii.toString(16)}`, () => {
        const exp = aaaRef(addedAl, 0x20, 0, addAf, false);
        const r = exec([0xb4, 0x20, 0xb0, leftAscii, 0x04, rightAscii, 0x37, HLT], { maxSteps: 200 });
        const errs = wantNoError(r);
        errs.push(...want8(r.cpu, { al: exp.r, ah: exp.h }));
        errs.push(...wantFlags(r.cpu, { cf: exp.cf, af: exp.af }));
        return errs;
      });

      const subtractedAl = (leftAscii - rightAscii) & 0xff;
      const subAf = left < right ? 1 : 0;
      s.run(`AAS ${leftAscii.toString(16)}-${rightAscii.toString(16)}`, () => {
        const exp = aasRef(subtractedAl, 0x20, subAf, subAf, false);
        const r = exec([0xb4, 0x20, 0xb0, leftAscii, 0x2c, rightAscii, 0x3f, HLT], { maxSteps: 200 });
        const errs = wantNoError(r);
        errs.push(...want8(r.cpu, { al: exp.r, ah: exp.h }));
        errs.push(...wantFlags(r.cpu, { cf: exp.cf, af: exp.af }));
        return errs;
      });
    }
  }
  // AAM / AAD decimal forms use the documented 0Ah base byte.
  for (const al of [0x00, 0x01, 0x09, 0x0a, 0x0f, 0x10, 0x63, 0x7f, 0x80, 0x99, 0xa0, 0xff]) {
    for (const ah of [0x00, 0x01, 0x10, 0xff]) {
      s.run(`AAM ${h2(ah)}${h2(al)}`, () => {
        const r = exec([0xb0, lo(al), 0xb4, lo(ah), 0xd4, 0x0a, HLT], { maxSteps: 200 });
        const errs = wantNoError(r);
        errs.push(...want8(r.cpu, { ah: Math.floor(al / 10), al: al % 10 }));
        errs.push(...wantFlags(r.cpu, { zf: al % 10 === 0 ? 1 : 0, sf: (al % 10) & 0x80 ? 1 : 0, pf: pfOf(al % 10) }));
        return errs;
      });
      s.run(`AAD ${h2(ah)}${h2(al)}`, () => {
        const v = ((ah * 10) + al) & 0xff;
        const r = exec([0xb0, lo(al), 0xb4, lo(ah), 0xd5, 0x0a, HLT], { maxSteps: 200 });
        const errs = wantNoError(r);
        errs.push(...want8(r.cpu, { al: v, ah: 0 }));
        errs.push(...wantFlags(r.cpu, { zf: v === 0 ? 1 : 0, sf: v & 0x80 ? 1 : 0, pf: pfOf(v) }));
        return errs;
      });
    }
  }
}

// CBW, CWD, XLAT, flag transfer instructions
function miscSection(s) {
  for (const v of [0x00, 0x01, 0x7f, 0x80, 0xff, 0x55, 0xaa]) {
    s.run(`CBW ${h2(v)}`, () => {
      const exp = v & 0x80 ? 0xff00 | v : v;
      const r = exec([0xb0, lo(v), 0x98, HLT], { maxSteps: 200 });
      return wantNoError(r).concat(wantRegs(r.cpu, { ax: exp }));
    });
  }
  for (const v of [0x0000, 0x0001, 0x7fff, 0x8000, 0xffff, 0x0100]) {
    s.run(`CWD ${h4(v)}`, () => {
      const exp = v & 0x8000 ? 0xffff : 0x0000;
      const r = exec([0xb8, ...w16(v), 0x99, HLT], { maxSteps: 200 });
      return wantNoError(r).concat(wantRegs(r.cpu, { dx: exp }));
    });
  }
  // XLAT: AL = DS:[BX + AL]
  for (const [bx, al, want] of [[0x9000, 0x00, 0x41], [0x9000, 0x03, 0x44], [0x9000, 0x07, 0x48]]) {
    s.run(`XLAT bx=${h4(bx)} al=${h2(al)}`, () => {
      const r = exec([0xbb, ...w16(bx), 0xb0, lo(al), 0xd7, HLT],
        { data: [{ off: bx, bytes: [0x41, 0x42, 0x43, 0x44, 0x45, 0x46, 0x47, 0x48] }], maxSteps: 200 });
      return wantNoError(r).concat(want8(r.cpu, { al: want }));
    });
  }
  // Only SF, ZF, AF, PF, and CF in LAHF are defined on the 8086.
  for (const f of [0x00, 0x01, 0xff, 0x82, 0x47, 0xa5, 0x02]) {
    s.run(`LAHF flags=${h2(f)}`, () => {
      const sf = (f & 0x80) ? 1 : 0, zf = (f & 0x40) ? 1 : 0, af = (f & 0x10) ? 1 : 0;
      const pf = (f & 0x04) ? 1 : 0, cf = f & 1;
      const r = exec([0xb8, lo(f), hi(0), 0x50, 0x9d, 0x9f, HLT], { maxSteps: 200 });
      const got = (r.cpu.r[GPR.ax] >> 8) & 0xff;
      const defined = 0xd5;
      const errs = wantNoError(r);
      if ((got & defined) !== (f & defined)) errs.push(`LAHF AH=${h2(got)} defined bits want ${h2(f & defined)}`);
      return errs;
    });
    s.run(`SAHF ${h2(f)}`, () => {
      const r = exec([0xb4, lo(f), 0x9e, HLT], { maxSteps: 200 });
      const errs = wantNoError(r);
      errs.push(...wantFlags(r.cpu, {
        sf: (f & 0x80) ? 1 : 0, zf: (f & 0x40) ? 1 : 0, af: (f & 0x10) ? 1 : 0,
        pf: (f & 0x04) ? 1 : 0, cf: f & 1,
      }));
      // OF/TF/IF/DF must be untouched by SAHF
      const r2 = exec([0xb4, lo(f), 0x9e, HLT], { flags: OF | DF, maxSteps: 200 });
      errs.push(...wantFlags(r2.cpu, { of: 1, df: 1 }));
      return errs;
    });
  }
  // PUSHF / POPF round trip
  for (const f of [0x0000, 0x0001, 0x0800, 0x0d5, 0x0ff, 0x0ff5, 0x0aa5]) {
    s.run(`PUSHF/POPF ${h4(f)}`, () => {
      const r = exec([0xb8, lo(f), hi(f), 0x50, 0x9d, HLT], { maxSteps: 200 });
      const errs = wantNoError(r);
      const want = {};
      for (const bit of ['cf', 'pf', 'af', 'zf', 'sf', 'tf', 'if', 'df', 'of']) {
        want[bit] = (f & { cf: 1, pf: 4, af: 0x10, zf: 0x40, sf: 0x80, tf: 0x100, if: 0x200, df: 0x400, of: 0x800 }[bit]) ? 1 : 0;
      }
      errs.push(...wantFlags(r.cpu, want));
      return errs;
    });
    s.run(`PUSHF reserved bits ${h4(f)}`, () => {
      const sp = 0xffe0;
      const r = exec([0xb8, lo(f), hi(f), 0x50, 0x9d, 0x9c, HLT], { maxSteps: 200, sp });
      const word = r.cpu.rd16(lin(0x1000, sp - 2));
      const errs = [];
      const definedMask = 0x0fd5;
      const defined = word & definedMask;
      if (defined !== (f & definedMask)) errs.push(`pushf defined bits ${h4(defined)} want ${h4(f & definedMask)}`);
      return errs;
    });
  }
  // CLC/STC/CMC, CLD/STD, CLI/STI
  const flagOps = [
    { name: 'CLC', bytes: [0xf8], bit: 'cf', want: 0 },
    { name: 'STC', bytes: [0xf9], bit: 'cf', want: 1 },
    { name: 'CMC', bytes: [0xf5], bit: 'cf', want: 'flip' },
    { name: 'CLD', bytes: [0xfc], bit: 'df', want: 0 },
    { name: 'STD', bytes: [0xfd], bit: 'df', want: 1 },
    { name: 'CLI', bytes: [0xfa], bit: 'if', want: 0 },
    { name: 'STI', bytes: [0xfb], bit: 'if', want: 1 },
  ];
  for (const op of flagOps) {
    for (const init of [0, 1]) {
      s.run(`${op.name} from ${op.bit}=${init}`, () => {
        const bitVal = { cf: 1, df: 0x400, if: 0x200 }[op.bit];
        const r = exec([...op.bytes, HLT], { flags: init ? bitVal : 0, maxSteps: 200 });
        const errs = wantNoError(r);
        const want = op.want === 'flip' ? (init ? 0 : 1) : op.want;
        errs.push(...wantFlags(r.cpu, { [op.bit]: want }));
        return errs;
      });
    }
  }
}

export function runCpuArith(check) {
  const sections = [
    ['alu', aluSection], ['incdec', incDecSection], ['negnot', negNotSection],
    ['muldiv', mulDivSection], ['shift', shiftSection], ['bcd', bcdSection],
    ['misc', miscSection],
  ];
  let failures = 0;
  for (const [name, fn] of sections) {
    const s = new Suite(`cpu:${name}`);
    fn(s);
    failures += s.report(check);
  }
  return failures;
}
