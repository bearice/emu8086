// 8086 disassembler. disasm(read, addrOff) -> { text, len, bytes }

const R8 = ['al', 'cl', 'dl', 'bl', 'ah', 'ch', 'dh', 'bh'];
const R16 = ['ax', 'cx', 'dx', 'bx', 'sp', 'bp', 'si', 'di'];
const SREG = ['es', 'cs', 'ss', 'ds'];
const RM = ['bx+si', 'bx+di', 'bp+si', 'bp+di', 'si', 'di', 'bp', 'bx'];
const ALU = ['add', 'or', 'adc', 'sbb', 'and', 'sub', 'xor', 'cmp'];
const SHIFT = ['rol', 'ror', 'rcl', 'rcr', 'shl', 'shr', 'shl', 'sar'];
const CC = ['o', 'no', 'b', 'nb', 'z', 'nz', 'be', 'a', 's', 'ns', 'p', 'np', 'l', 'ge', 'le', 'g'];

const h = (v, n = 2) => v.toString(16).toUpperCase().padStart(n, '0') + 'h';
const hx = (v) => (v > 9 ? '0' : '') + v.toString(16).toUpperCase() + 'h';

export function disasm(readByte, start) {
  let p = start;
  const bytes = [];
  const b = () => { const v = readByte(p++) & 0xff; bytes.push(v); return v; };
  const w = () => { const lo = b(), hi = b(); return lo | (hi << 8); };
  const sb = () => { const v = b(); return v < 0x80 ? v : v - 256; };

  let segpfx = '', rep = '';
  let op;
  for (;;) {
    op = b();
    if (op === 0x26) { segpfx = 'es:'; continue; }
    if (op === 0x2e) { segpfx = 'cs:'; continue; }
    if (op === 0x36) { segpfx = 'ss:'; continue; }
    if (op === 0x3e) { segpfx = 'ds:'; continue; }
    if (op === 0xf2) { rep = 'repne '; continue; }
    if (op === 0xf3) { rep = 'rep '; continue; }
    if (op === 0xf0) { rep = 'lock '; continue; }
    break;
  }

  let modrm = null;
  const getModrm = () => {
    if (modrm) return modrm;
    const m = b();
    const mod = m >> 6, reg = (m >> 3) & 7, rm = m & 7;
    let str;
    if (mod === 3) str = null;
    else if (mod === 0 && rm === 6) str = `[${segpfx}${h(w(), 4)}]`;
    else {
      let disp = '';
      if (mod === 1) { const d = sb(); disp = d < 0 ? `-${hx(-d)}` : `+${hx(d)}`; }
      else if (mod === 2) { const d = w(); disp = `+${h(d, 4)}`; }
      str = `[${segpfx}${RM[rm]}${disp}]`;
    }
    modrm = { mod, reg, rm, str };
    return modrm;
  };
  const rm8 = () => { const m = getModrm(); return m.mod === 3 ? R8[m.rm] : m.str; };
  const rm16 = () => { const m = getModrm(); return m.mod === 3 ? R16[m.rm] : m.str; };
  const sizeRM = (s, wide) => (s[0] === '[' ? (wide ? 'word ' : 'byte ') + s : s);

  let text = '(bad)';
  const rel8 = () => { const d = sb(); return h((p - start + start + d) & 0xffff, 4); };
  const rel16 = () => { const d = w(); const dd = d < 0x8000 ? d : d - 65536; return h((p + dd) & 0xffff, 4); };

  const finish = (t) => { text = t; };

  if (op < 0x40 && (op & 7) < 6) {
    const name = ALU[(op >> 3) & 7], form = op & 7;
    if (form === 0) { const m = getModrm(); finish(`${name} ${rm8()}, ${R8[m.reg]}`); }
    else if (form === 1) { const m = getModrm(); finish(`${name} ${rm16()}, ${R16[m.reg]}`); }
    else if (form === 2) { const m = getModrm(); finish(`${name} ${R8[m.reg]}, ${rm8()}`); }
    else if (form === 3) { const m = getModrm(); finish(`${name} ${R16[m.reg]}, ${rm16()}`); }
    else if (form === 4) finish(`${name} al, ${h(b())}`);
    else finish(`${name} ax, ${h(w(), 4)}`);
  } else if (op >= 0x40 && op <= 0x47) finish(`inc ${R16[op & 7]}`);
  else if (op >= 0x48 && op <= 0x4f) finish(`dec ${R16[op & 7]}`);
  else if (op >= 0x50 && op <= 0x57) finish(`push ${R16[op & 7]}`);
  else if (op >= 0x58 && op <= 0x5f) finish(`pop ${R16[op & 7]}`);
  else if (op >= 0x70 && op <= 0x7f) finish(`j${CC[op & 0xf]} ${rel8()}`);
  else if (op >= 0x80 && op <= 0x83) {
    const m = getModrm();
    const wide = op & 1;
    const dst = sizeRM(wide ? rm16() : rm8(), wide);
    const imm = op === 0x81 ? h(w(), 4) : h(b());
    finish(`${ALU[m.reg]} ${dst}, ${imm}`);
  }
  else if (op >= 0xb0 && op <= 0xb7) finish(`mov ${R8[op & 7]}, ${h(b())}`);
  else if (op >= 0xb8 && op <= 0xbf) finish(`mov ${R16[op & 7]}, ${h(w(), 4)}`);
  else if (op >= 0x91 && op <= 0x97) finish(`xchg ax, ${R16[op & 7]}`);
  else if (op >= 0xd0 && op <= 0xd3) {
    const m = getModrm();
    const wide = op & 1;
    const dst = sizeRM(wide ? rm16() : rm8(), wide);
    finish(`${SHIFT[m.reg]} ${dst}, ${(op & 2) ? 'cl' : '1'}`);
  }
  else switch (op) {
    case 0x06: case 0x0e: case 0x16: case 0x1e: finish(`push ${SREG[(op >> 3) & 3]}`); break;
    case 0x07: case 0x0f: case 0x17: case 0x1f: finish(`pop ${SREG[(op >> 3) & 3]}`); break;
    case 0x27: finish('daa'); break;
    case 0x2f: finish('das'); break;
    case 0x37: finish('aaa'); break;
    case 0x3f: finish('aas'); break;
    case 0x84: { const m = getModrm(); finish(`test ${rm8()}, ${R8[m.reg]}`); break; }
    case 0x85: { const m = getModrm(); finish(`test ${rm16()}, ${R16[m.reg]}`); break; }
    case 0x86: { const m = getModrm(); finish(`xchg ${rm8()}, ${R8[m.reg]}`); break; }
    case 0x87: { const m = getModrm(); finish(`xchg ${rm16()}, ${R16[m.reg]}`); break; }
    case 0x88: { const m = getModrm(); finish(`mov ${rm8()}, ${R8[m.reg]}`); break; }
    case 0x89: { const m = getModrm(); finish(`mov ${rm16()}, ${R16[m.reg]}`); break; }
    case 0x8a: { const m = getModrm(); finish(`mov ${R8[m.reg]}, ${rm8()}`); break; }
    case 0x8b: { const m = getModrm(); finish(`mov ${R16[m.reg]}, ${rm16()}`); break; }
    case 0x8c: { const m = getModrm(); finish(`mov ${rm16()}, ${SREG[m.reg & 3]}`); break; }
    case 0x8d: { const m = getModrm(); finish(`lea ${R16[m.reg]}, ${rm16()}`); break; }
    case 0x8e: { const m = getModrm(); finish(`mov ${SREG[m.reg & 3]}, ${rm16()}`); break; }
    case 0x8f: finish(`pop ${sizeRM(rm16(), 1)}`); break;
    case 0x90: finish('nop'); break;
    case 0x98: finish('cbw'); break;
    case 0x99: finish('cwd'); break;
    case 0x9a: { const o = w(), s = w(); finish(`call far ${h(s, 4)}:${h(o, 4)}`); break; }
    case 0x9c: finish('pushf'); break;
    case 0x9d: finish('popf'); break;
    case 0x9e: finish('sahf'); break;
    case 0x9f: finish('lahf'); break;
    case 0xa0: finish(`mov al, [${segpfx}${h(w(), 4)}]`); break;
    case 0xa1: finish(`mov ax, [${segpfx}${h(w(), 4)}]`); break;
    case 0xa2: finish(`mov [${segpfx}${h(w(), 4)}], al`); break;
    case 0xa3: finish(`mov [${segpfx}${h(w(), 4)}], ax`); break;
    case 0xa4: finish(`${rep}movsb`); break;
    case 0xa5: finish(`${rep}movsw`); break;
    case 0xa6: finish(`${rep}cmpsb`); break;
    case 0xa7: finish(`${rep}cmpsw`); break;
    case 0xa8: finish(`test al, ${h(b())}`); break;
    case 0xa9: finish(`test ax, ${h(w(), 4)}`); break;
    case 0xaa: finish(`${rep}stosb`); break;
    case 0xab: finish(`${rep}stosw`); break;
    case 0xac: finish(`${rep}lodsb`); break;
    case 0xad: finish(`${rep}lodsw`); break;
    case 0xae: finish(`${rep}scasb`); break;
    case 0xaf: finish(`${rep}scasw`); break;
    case 0xc2: finish(`ret ${h(w(), 4)}`); break;
    case 0xc3: finish('ret'); break;
    case 0xc4: { const m = getModrm(); finish(`les ${R16[m.reg]}, ${rm16()}`); break; }
    case 0xc5: { const m = getModrm(); finish(`lds ${R16[m.reg]}, ${rm16()}`); break; }
    case 0xc6: { const d = sizeRM(rm8(), 0); finish(`mov ${d}, ${h(b())}`); break; }
    case 0xc7: { const d = sizeRM(rm16(), 1); finish(`mov ${d}, ${h(w(), 4)}`); break; }
    case 0xca: finish(`retf ${h(w(), 4)}`); break;
    case 0xcb: finish('retf'); break;
    case 0xcc: finish('int3'); break;
    case 0xcd: finish(`int ${h(b())}`); break;
    case 0xce: finish('into'); break;
    case 0xcf: finish('iret'); break;
    case 0xd4: { b(); finish('aam'); break; }
    case 0xd5: { b(); finish('aad'); break; }
    case 0xd7: finish('xlat'); break;
    case 0xe0: finish(`loopnz ${rel8()}`); break;
    case 0xe1: finish(`loopz ${rel8()}`); break;
    case 0xe2: finish(`loop ${rel8()}`); break;
    case 0xe3: finish(`jcxz ${rel8()}`); break;
    case 0xe4: finish(`in al, ${h(b())}`); break;
    case 0xe5: finish(`in ax, ${h(b())}`); break;
    case 0xe6: finish(`out ${h(b())}, al`); break;
    case 0xe7: finish(`out ${h(b())}, ax`); break;
    case 0xe8: finish(`call ${rel16()}`); break;
    case 0xe9: finish(`jmp ${rel16()}`); break;
    case 0xea: { const o = w(), s = w(); finish(`jmp far ${h(s, 4)}:${h(o, 4)}`); break; }
    case 0xeb: finish(`jmp ${rel8()}`); break;
    case 0xec: finish('in al, dx'); break;
    case 0xed: finish('in ax, dx'); break;
    case 0xee: finish('out dx, al'); break;
    case 0xef: finish('out dx, ax'); break;
    case 0xf4: finish('hlt'); break;
    case 0xf5: finish('cmc'); break;
    case 0xf8: finish('clc'); break;
    case 0xf9: finish('stc'); break;
    case 0xfa: finish('cli'); break;
    case 0xfb: finish('sti'); break;
    case 0xfc: finish('cld'); break;
    case 0xfd: finish('std'); break;
    case 0xf6: case 0xf7: {
      const wide = op & 1;
      const m = getModrm();
      const d = sizeRM(wide ? rm16() : rm8(), wide);
      const names = ['test', 'test', 'not', 'neg', 'mul', 'imul', 'div', 'idiv'];
      if (m.reg < 2) finish(`test ${d}, ${wide ? h(w(), 4) : h(b())}`);
      else finish(`${names[m.reg]} ${d}`);
      break;
    }
    case 0xfe: case 0xff: {
      const wide = op & 1;
      const m = getModrm();
      const d = sizeRM(wide ? rm16() : rm8(), wide);
      const names = ['inc', 'dec', 'call', 'call far', 'jmp', 'jmp far', 'push', '(bad)'];
      finish(`${names[m.reg]} ${d}`);
      break;
    }
    default: finish(`db ${h(op)}`);
  }

  return { text, len: p - start, bytes };
}
