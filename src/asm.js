// Minimal 8086 assembler: enough of the language for real DOS .COM programs.

const R8 = { al: 0, cl: 1, dl: 2, bl: 3, ah: 4, ch: 5, dh: 6, bh: 7 };
const R16 = { ax: 0, cx: 1, dx: 2, bx: 3, sp: 4, bp: 5, si: 6, di: 7 };
const SREG = { es: 0, cs: 1, ss: 2, ds: 3 };
const ALU = { add: 0, or: 1, adc: 2, sbb: 3, and: 4, sub: 5, xor: 6, cmp: 7 };
const SHIFT = { rol: 0, ror: 1, rcl: 2, rcr: 3, shl: 4, sal: 4, shr: 5, sar: 7 };
const CC = {
  o: 0, no: 1, b: 2, c: 2, nae: 2, nb: 3, nc: 3, ae: 3, z: 4, e: 4, nz: 5, ne: 5,
  be: 6, na: 6, a: 7, nbe: 7, s: 8, ns: 9, p: 10, pe: 10, np: 11, po: 11,
  l: 12, nge: 12, ge: 13, nl: 13, le: 14, ng: 14, g: 15, nle: 15,
};
const MEMBASE = { 'bx+si': 0, 'si+bx': 0, 'bx+di': 1, 'di+bx': 1, 'bp+si': 2, 'si+bp': 2, 'bp+di': 3, 'di+bp': 3, si: 4, di: 5, bp: 6, bx: 7 };
const NOARG = {
  nop: [0x90], hlt: [0xf4], cbw: [0x98], cwd: [0x99], lahf: [0x9f], sahf: [0x9e],
  pushf: [0x9c], popf: [0x9d], clc: [0xf8], stc: [0xf9], cmc: [0xf5], cli: [0xfa],
  sti: [0xfb], cld: [0xfc], std: [0xfd], iret: [0xcf], into: [0xce], int3: [0xcc],
  xlat: [0xd7], xlatb: [0xd7], aaa: [0x37], aas: [0x3f], daa: [0x27], das: [0x2f],
  aam: [0xd4, 0x0a], aad: [0xd5, 0x0a], ret: [0xc3], retn: [0xc3], retf: [0xcb],
  movsb: [0xa4], movsw: [0xa5], cmpsb: [0xa6], cmpsw: [0xa7], stosb: [0xaa],
  stosw: [0xab], lodsb: [0xac], lodsw: [0xad], scasb: [0xae], scasw: [0xaf],
  wait: [0x9b], leave: [0xc9],
};
const PREFIX = { rep: 0xf3, repe: 0xf3, repz: 0xf3, repne: 0xf2, repnz: 0xf2, lock: 0xf0 };

class AsmError extends Error {
  constructor(msg, line) { super(msg); this.line = line; }
}

function splitOperands(str) {
  const out = [];
  let depth = 0, cur = '', q = null;
  for (const ch of str) {
    if (q) { cur += ch; if (ch === q) q = null; continue; }
    if (ch === "'" || ch === '"') { q = ch; cur += ch; continue; }
    if (ch === '[') depth++;
    if (ch === ']') depth--;
    if (ch === ',' && depth === 0) { out.push(cur.trim()); cur = ''; continue; }
    cur += ch;
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
}

function tokenizeExpr(s) {
  const toks = [];
  const re = /\s*(?:(0x[0-9a-f]+|[0-9][0-9a-f]*h|[01]+b|[0-9]+d?|'(?:[^']|\\')'|"(?:[^"])")|([A-Za-z_$?.@][\w$?.@]*)|([-+*/()<>&|~%]))/giy;
  let m;
  while ((m = re.exec(s))) {
    if (m[1] !== undefined) toks.push({ t: 'num', v: parseNum(m[1]) });
    else if (m[2] !== undefined) toks.push({ t: 'id', v: m[2] });
    else toks.push({ t: 'op', v: m[3] });
  }
  if (re.lastIndex < s.trim().length && s.trim()) {
    // leftover junk check (loose)
  }
  return toks;
}

function parseNum(tok) {
  const t = tok.toLowerCase();
  if (t[0] === "'" || t[0] === '"') {
    const inner = tok.slice(1, -1).replace(/\\n/g, '\n').replace(/\\r/g, '\r').replace(/\\t/g, '\t').replace(/\\0/g, '\0');
    let v = 0;
    for (let i = 0; i < inner.length; i++) v = (v << 8) | inner.charCodeAt(i);
    return v;
  }
  if (t.startsWith('0x')) return parseInt(t.slice(2), 16);
  if (/^[0-9][0-9a-f]*h$/.test(t)) return parseInt(t.slice(0, -1), 16);
  if (/^[01]+b$/.test(t)) return parseInt(t.slice(0, -1), 2);
  if (/^[0-9]+d$/.test(t)) return parseInt(t.slice(0, -1), 10);
  return parseInt(t, 10);
}

// Recursive-descent expression evaluator over labels/constants.
function evalExpr(str, symbols, line, allowUnknown) {
  const toks = tokenizeExpr(str);
  let i = 0;
  let unknown = false;
  const peek = () => toks[i];
  const expr = () => {
    let v = term();
    while (peek() && peek().t === 'op' && '+-|&'.includes(peek().v)) {
      const o = toks[i++].v;
      const r = term();
      v = o === '+' ? v + r : o === '-' ? v - r : o === '|' ? (v | r) : (v & r);
    }
    return v;
  };
  const term = () => {
    let v = unary();
    while (peek() && peek().t === 'op' && '*/%'.includes(peek().v)) {
      const o = toks[i++].v;
      const r = unary();
      v = o === '*' ? v * r : o === '/' ? Math.trunc(v / r) : v % r;
    }
    return v;
  };
  const unary = () => {
    const t = peek();
    if (!t) throw new AsmError(`bad expression: "${str}"`, line);
    if (t.t === 'op' && t.v === '-') { i++; return -unary(); }
    if (t.t === 'op' && t.v === '+') { i++; return unary(); }
    if (t.t === 'op' && t.v === '~') { i++; return ~unary(); }
    if (t.t === 'op' && t.v === '(') { i++; const v = expr(); if (peek() && peek().v === ')') i++; return v; }
    if (t.t === 'num') { i++; return t.v; }
    if (t.t === 'id') {
      i++;
      const name = t.v.toLowerCase();
      if (name === 'offset' || name === 'near' || name === 'short' || name === 'ptr') return unary();
      if (name === '$') return symbols.__here ?? 0;
      if (name in symbols) return symbols[name];
      unknown = true;
      if (allowUnknown) return 0;
      throw new AsmError(`unknown symbol "${t.v}"`, line);
    }
    throw new AsmError(`bad expression: "${str}"`, line);
  };
  const v = expr();
  return { value: v | 0, unknown };
}

// Parse one operand into a descriptor.
function parseOperand(raw, symbols, line, allowUnknown) {
  let s = raw.trim();
  let size = null;
  const sm = /^(byte|word)\s+(?:ptr\s+)?/i.exec(s);
  if (sm) { size = sm[1].toLowerCase(); s = s.slice(sm[0].length).trim(); }
  const low = s.toLowerCase();
  if (low in R8) return { kind: 'r8', reg: R8[low], size: 'byte', text: low };
  if (low in R16) return { kind: 'r16', reg: R16[low], size: 'word', text: low };
  if (low in SREG) return { kind: 'sreg', reg: SREG[low], size: 'word', text: low };

  let seg = null;
  let body = s;
  const segm = /^(es|cs|ss|ds)\s*:\s*/i.exec(body);
  if (segm) { seg = segm[1].toLowerCase(); body = body.slice(segm[0].length).trim(); }

  if (body.startsWith('[') && body.endsWith(']')) {
    const inner = body.slice(1, -1).trim();
    const innerSeg = /^(es|cs|ss|ds)\s*:\s*/i.exec(inner);
    let expr2 = inner;
    if (innerSeg) { seg = innerSeg[1].toLowerCase(); expr2 = inner.slice(innerSeg[0].length).trim(); }
    // separate base/index registers from displacement
    const parts = expr2.split('+').map((x) => x.trim()).filter(Boolean);
    const regs = [];
    const rest = [];
    let signFix = '';
    for (const part of parts) {
      const pl = part.toLowerCase();
      if (pl in R16 && ['bx', 'bp', 'si', 'di'].includes(pl)) regs.push(pl);
      else rest.push(part);
    }
    const key = regs.join('+');
    let rm;
    if (regs.length === 0) rm = 6;
    else if (key in MEMBASE) rm = MEMBASE[key];
    else throw new AsmError(`invalid memory operand "${raw}"`, line);
    let disp = 0, unknown = false;
    if (rest.length) {
      const e = evalExpr(rest.join('+') + signFix, symbols, line, allowUnknown);
      disp = e.value; unknown = e.unknown;
    }
    return { kind: 'mem', rm, regs: key, disp, size, seg, unknown, noReg: regs.length === 0, text: raw };
  }
  const e = evalExpr(s, symbols, line, allowUnknown);
  return { kind: 'imm', value: e.value, unknown: e.unknown, size, text: raw };
}

function memBytes(op, regField) {
  // returns [modrm, ...disp]
  if (op.kind !== 'mem') {
    const rmv = op.kind === 'r8' ? op.reg : op.reg;
    return [0xc0 | (regField << 3) | rmv];
  }
  if (op.noReg) return [0x06 | (regField << 3), op.disp & 0xff, (op.disp >> 8) & 0xff];
  const d = op.disp | 0;
  const needsDisp = d !== 0 || op.rm === 6; // [bp] must use disp8
  if (!needsDisp) return [(regField << 3) | op.rm];
  if (d >= -128 && d <= 127) return [0x40 | (regField << 3) | op.rm, d & 0xff];
  return [0x80 | (regField << 3) | op.rm, d & 0xff, (d >> 8) & 0xff];
}

const SEGPFX = { es: 0x26, cs: 0x2e, ss: 0x36, ds: 0x3e };

export function assemble(source) {
  const lines = source.split(/\r?\n/);
  const symbols = Object.create(null);
  let origin = 0x100;
  const parsed = [];

  // Pre-parse: strip comments, pull out labels, directives.
  lines.forEach((rawLine, idx) => {
    let line = rawLine;
    // strip comments (respect quotes)
    let out = '', q = null;
    for (let i = 0; i < line.length; i++) {
      const ch = line[i];
      if (q) { out += ch; if (ch === q) q = null; continue; }
      if (ch === "'" || ch === '"') { q = ch; out += ch; continue; }
      if (ch === ';') break;
      out += ch;
    }
    line = out.trim();
    if (!line) return;
    let labels = [];
    for (;;) {
      const m = /^([A-Za-z_$?.@][\w$?.@]*)\s*:/.exec(line);
      if (!m) break;
      labels.push(m[1].toLowerCase());
      line = line.slice(m[0].length).trim();
    }
    const equ = /^([A-Za-z_$?.@][\w$?.@]*)\s+equ\s+(.+)$/i.exec(line);
    parsed.push({ labels, text: line, lineNo: idx + 1, equ });
  });

  const emitAll = (final) => {
    const out = [];
    let pc = origin;
    const errors = [];
    const lineMap = [];
    for (const item of parsed) {
      for (const l of item.labels) symbols[l] = pc;
      let text = item.text;
      if (!text) continue;
      if (item.equ) {
        try { symbols[item.equ[1].toLowerCase()] = evalExpr(item.equ[2], symbols, item.lineNo, !final).value; }
        catch (e) { if (final) errors.push(e); }
        continue;
      }
      symbols.__here = pc;
      let bytes;
      try {
        bytes = encodeLine(text, symbols, item.lineNo, pc, !final);
      } catch (e) {
        if (final) errors.push(e instanceof AsmError ? e : new AsmError(e.message, item.lineNo));
        bytes = [];
      }
      if (bytes === 'ORG') continue;
      if (bytes && bytes.__org !== undefined) { pc = bytes.__org; origin = origin; continue; }
      if (bytes.length) lineMap.push({ addr: pc, lineNo: item.lineNo, len: bytes.length });
      for (const b of bytes) out.push(b & 0xff);
      pc += bytes.length;
    }
    return { out, errors, lineMap };
  };

  // Handle a leading "org" directive up front so labels are right.
  for (const item of parsed) {
    const m = /^org\s+(.+)$/i.exec(item.text);
    if (m) { origin = evalExpr(m[1], symbols, item.lineNo, true).value; item.text = ''; break; }
  }

  let res;
  for (let pass = 0; pass < 4; pass++) res = emitAll(false);
  res = emitAll(true);
  if (res.errors.length) {
    return { ok: false, errors: res.errors.map((e) => ({ line: e.line, message: e.message })) };
  }
  return { ok: true, bytes: Uint8Array.from(res.out), origin, symbols: { ...symbols, __here: undefined }, lineMap: res.lineMap };
}

function encodeLine(text, symbols, line, pc, lenient) {
  let m = /^(\S+)\s*(.*)$/.exec(text);
  let mnem = m[1].toLowerCase();
  let rest = m[2].trim();
  const bytes = [];

  // prefixes
  while (mnem in PREFIX) {
    bytes.push(PREFIX[mnem]);
    if (!rest) return bytes;
    const mm = /^(\S+)\s*(.*)$/.exec(rest);
    mnem = mm[1].toLowerCase(); rest = mm[2].trim();
  }

  if (mnem === 'org') { throw new AsmError('org must be the first directive', line); }
  if (mnem === 'db' || mnem === 'dw' || mnem === 'dd') {
    const wide = mnem === 'dw' ? 2 : mnem === 'dd' ? 4 : 1;
    for (const opnd of splitOperands(rest)) {
      const s = opnd.trim();
      if ((s[0] === "'" || s[0] === '"') && s.length > 2 && s[s.length - 1] === s[0]) {
        const inner = s.slice(1, -1).replace(/\\n/g, '\n').replace(/\\r/g, '\r').replace(/\\t/g, '\t').replace(/\\0/g, '\0').replace(/\\\\/g, '\\');
        for (let i = 0; i < inner.length; i++) {
          bytes.push(inner.charCodeAt(i) & 0xff);
          for (let k = 1; k < wide; k++) bytes.push(0);
        }
        continue;
      }
      const dupm = /^(\S+)\s+dup\s*\((.+)\)$/i.exec(s);
      if (dupm) {
        const n = evalExpr(dupm[1], symbols, line, lenient).value;
        const vraw = dupm[2].trim();
        const v = vraw === '?' ? 0 : evalExpr(vraw, symbols, line, lenient).value;
        for (let i = 0; i < n; i++) for (let k = 0; k < wide; k++) bytes.push((v >> (8 * k)) & 0xff);
        continue;
      }
      const v = s === '?' ? 0 : evalExpr(s, symbols, line, lenient).value;
      for (let k = 0; k < wide; k++) bytes.push((v >> (8 * k)) & 0xff);
    }
    return bytes;
  }
  if (mnem === 'resb') { const n = evalExpr(rest, symbols, line, lenient).value; for (let i = 0; i < n; i++) bytes.push(0); return bytes; }
  if (mnem === 'resw') { const n = evalExpr(rest, symbols, line, lenient).value; for (let i = 0; i < n * 2; i++) bytes.push(0); return bytes; }

  if (mnem in NOARG && !rest) { bytes.push(...NOARG[mnem]); return bytes; }
  if ((mnem === 'ret' || mnem === 'retn' || mnem === 'retf') && rest) {
    const v = evalExpr(rest, symbols, line, lenient).value;
    bytes.push(mnem === 'retf' ? 0xca : 0xc2, v & 0xff, (v >> 8) & 0xff);
    return bytes;
  }

  const ops = splitOperands(rest).map((o) => parseOperand(o, symbols, line, lenient));
  const [a, b] = ops;
  const segPrefix = (o) => { if (o && o.kind === 'mem' && o.seg) bytes.push(SEGPFX[o.seg]); };
  const isMemOrReg = (o) => o && (o.kind === 'mem' || o.kind === 'r8' || o.kind === 'r16');
  const widthOf = (o1, o2) => {
    if (o1.kind === 'r16' || o1.kind === 'sreg') return 1;
    if (o1.kind === 'r8') return 0;
    if (o2 && (o2.kind === 'r16' || o2.kind === 'sreg')) return 1;
    if (o2 && o2.kind === 'r8') return 0;
    if (o1.size === 'word' || (o2 && o2.size === 'word')) return 1;
    if (o1.size === 'byte' || (o2 && o2.size === 'byte')) return 0;
    throw new AsmError(`operand size not specified (use "byte"/"word")`, line);
  };
  const rel = (target, size) => {
    const d = target - (pc + bytes.length + size);
    return d;
  };

  // --- jumps ---
  if (mnem === 'jmp') {
    if (!a) throw new AsmError('jmp needs a target', line);
    if (a.kind === 'mem' || a.kind === 'r16') { segPrefix(a); bytes.push(0xff, ...memBytes(a, 4)); return bytes; }
    const forceNear = /\bnear\b/i.test(a.text);
    const forceShort = /\bshort\b/i.test(a.text);
    const d8 = a.value - (pc + 2);
    if (!forceNear && (forceShort || (!a.unknown && d8 >= -128 && d8 <= 127))) { bytes.push(0xeb, d8 & 0xff); return bytes; }
    const d16 = a.value - (pc + 3);
    bytes.push(0xe9, d16 & 0xff, (d16 >> 8) & 0xff); return bytes;
  }
  if (mnem === 'call') {
    if (!a) throw new AsmError('call needs a target', line);
    if (a.kind === 'mem' || a.kind === 'r16') { segPrefix(a); bytes.push(0xff, ...memBytes(a, 2)); return bytes; }
    const d = a.value - (pc + 3);
    bytes.push(0xe8, d & 0xff, (d >> 8) & 0xff); return bytes;
  }
  if (mnem[0] === 'j' && mnem.slice(1) in CC) {
    const cc = CC[mnem.slice(1)];
    const d = a.value - (pc + 2);
    if (!a.unknown && (d < -128 || d > 127)) {
      // synthesize: j<!cc> +3 ; jmp near
      const dn = a.value - (pc + 5);
      bytes.push(0x70 | (cc ^ 1), 3, 0xe9, dn & 0xff, (dn >> 8) & 0xff);
      return bytes;
    }
    bytes.push(0x70 | cc, d & 0xff); return bytes;
  }
  if (mnem === 'loop' || mnem === 'loope' || mnem === 'loopz' || mnem === 'loopne' || mnem === 'loopnz' || mnem === 'jcxz') {
    const opc = mnem === 'loop' ? 0xe2 : mnem === 'jcxz' ? 0xe3 : (mnem === 'loopz' || mnem === 'loope') ? 0xe1 : 0xe0;
    const d = a.value - (pc + 2);
    if (!a.unknown && (d < -128 || d > 127)) throw new AsmError(`${mnem} target out of range`, line);
    bytes.push(opc, d & 0xff); return bytes;
  }
  if (mnem === 'int') { bytes.push(0xcd, a.value & 0xff); return bytes; }

  // --- mov ---
  if (mnem === 'mov') {
    if (!a || !b) throw new AsmError('mov needs two operands', line);
    if (a.kind === 'sreg') { segPrefix(b); bytes.push(0x8e, ...memBytes(b, a.reg)); return bytes; }
    if (b.kind === 'sreg') { segPrefix(a); bytes.push(0x8c, ...memBytes(a, b.reg)); return bytes; }
    if (b.kind === 'imm') {
      if (a.kind === 'r8') { bytes.push(0xb0 | a.reg, b.value & 0xff); return bytes; }
      if (a.kind === 'r16') { bytes.push(0xb8 | a.reg, b.value & 0xff, (b.value >> 8) & 0xff); return bytes; }
      const w = widthOf(a, b);
      segPrefix(a);
      bytes.push(0xc6 | w, ...memBytes(a, 0), b.value & 0xff);
      if (w) bytes.push((b.value >> 8) & 0xff);
      return bytes;
    }
    // accumulator short forms
    if (a.kind === 'mem' && a.noReg && !a.seg && b.kind === 'r8' && b.reg === 0) { bytes.push(0xa2, a.disp & 0xff, (a.disp >> 8) & 0xff); return bytes; }
    if (a.kind === 'mem' && a.noReg && !a.seg && b.kind === 'r16' && b.reg === 0) { bytes.push(0xa3, a.disp & 0xff, (a.disp >> 8) & 0xff); return bytes; }
    if (b.kind === 'mem' && b.noReg && !b.seg && a.kind === 'r8' && a.reg === 0) { bytes.push(0xa0, b.disp & 0xff, (b.disp >> 8) & 0xff); return bytes; }
    if (b.kind === 'mem' && b.noReg && !b.seg && a.kind === 'r16' && a.reg === 0) { bytes.push(0xa1, b.disp & 0xff, (b.disp >> 8) & 0xff); return bytes; }
    const w = widthOf(a, b);
    if (b.kind === 'r8' || b.kind === 'r16') { segPrefix(a); bytes.push(0x88 | w, ...memBytes(a, b.reg)); return bytes; }
    if (a.kind === 'r8' || a.kind === 'r16') { segPrefix(b); bytes.push(0x8a | w, ...memBytes(b, a.reg)); return bytes; }
    throw new AsmError('invalid mov operands', line);
  }

  if (mnem === 'lea') { segPrefix(b); bytes.push(0x8d, ...memBytes(b, a.reg)); return bytes; }
  if (mnem === 'les' || mnem === 'lds') { segPrefix(b); bytes.push(mnem === 'les' ? 0xc4 : 0xc5, ...memBytes(b, a.reg)); return bytes; }

  if (mnem in ALU) {
    const code = ALU[mnem];
    if (!a || !b) throw new AsmError(`${mnem} needs two operands`, line);
    if (b.kind === 'imm') {
      const w = widthOf(a, b);
      if (a.kind === 'r8' && a.reg === 0) { bytes.push((code << 3) | 0x04, b.value & 0xff); return bytes; }
      if (a.kind === 'r16' && a.reg === 0) { bytes.push((code << 3) | 0x05, b.value & 0xff, (b.value >> 8) & 0xff); return bytes; }
      segPrefix(a);
      const v = b.value;
      if (w && v >= -128 && v <= 127 && !b.unknown) { bytes.push(0x83, ...memBytes(a, code), v & 0xff); return bytes; }
      bytes.push(w ? 0x81 : 0x80, ...memBytes(a, code), v & 0xff);
      if (w) bytes.push((v >> 8) & 0xff);
      return bytes;
    }
    const w = widthOf(a, b);
    if (b.kind === 'r8' || b.kind === 'r16') { segPrefix(a); bytes.push((code << 3) | w, ...memBytes(a, b.reg)); return bytes; }
    segPrefix(b); bytes.push((code << 3) | 0x02 | w, ...memBytes(b, a.reg)); return bytes;
  }

  if (mnem === 'test') {
    if (b.kind === 'imm') {
      const w = widthOf(a, b);
      if (a.kind === 'r8' && a.reg === 0) { bytes.push(0xa8, b.value & 0xff); return bytes; }
      if (a.kind === 'r16' && a.reg === 0) { bytes.push(0xa9, b.value & 0xff, (b.value >> 8) & 0xff); return bytes; }
      segPrefix(a); bytes.push(0xf6 | w, ...memBytes(a, 0), b.value & 0xff);
      if (w) bytes.push((b.value >> 8) & 0xff);
      return bytes;
    }
    const w = widthOf(a, b);
    if (b.kind === 'r8' || b.kind === 'r16') { segPrefix(a); bytes.push(0x84 | w, ...memBytes(a, b.reg)); return bytes; }
    segPrefix(b); bytes.push(0x84 | w, ...memBytes(b, a.reg)); return bytes;
  }

  if (mnem === 'xchg') {
    if (a.kind === 'r16' && b.kind === 'r16' && (a.reg === 0 || b.reg === 0)) {
      bytes.push(0x90 | (a.reg === 0 ? b.reg : a.reg)); return bytes;
    }
    const w = widthOf(a, b);
    if (b.kind === 'r8' || b.kind === 'r16') { segPrefix(a); bytes.push(0x86 | w, ...memBytes(a, b.reg)); return bytes; }
    segPrefix(b); bytes.push(0x86 | w, ...memBytes(b, a.reg)); return bytes;
  }

  if (mnem === 'push' || mnem === 'pop') {
    if (a.kind === 'sreg') { bytes.push((mnem === 'push' ? 0x06 : 0x07) | (a.reg << 3)); return bytes; }
    if (a.kind === 'r16') { bytes.push((mnem === 'push' ? 0x50 : 0x58) | a.reg); return bytes; }
    if (a.kind === 'imm') throw new AsmError('push imm is not an 8086 instruction', line);
    segPrefix(a);
    if (mnem === 'push') bytes.push(0xff, ...memBytes(a, 6));
    else bytes.push(0x8f, ...memBytes(a, 0));
    return bytes;
  }

  if (mnem === 'inc' || mnem === 'dec') {
    if (a.kind === 'r16') { bytes.push((mnem === 'inc' ? 0x40 : 0x48) | a.reg); return bytes; }
    const w = widthOf(a);
    segPrefix(a); bytes.push(0xfe | w, ...memBytes(a, mnem === 'inc' ? 0 : 1)); return bytes;
  }

  const GRP3 = { not: 2, neg: 3, mul: 4, imul: 5, div: 6, idiv: 7 };
  if (mnem in GRP3) {
    const w = widthOf(a);
    segPrefix(a); bytes.push(0xf6 | w, ...memBytes(a, GRP3[mnem])); return bytes;
  }

  if (mnem in SHIFT) {
    const w = widthOf(a, null) ;
    const code = SHIFT[mnem];
    segPrefix(a);
    if (!b || (b.kind === 'imm' && b.value === 1)) { bytes.push(0xd0 | w, ...memBytes(a, code)); return bytes; }
    if (b.kind === 'r8' && b.reg === 1) { bytes.push(0xd2 | w, ...memBytes(a, code)); return bytes; }
    // 8086 has no shift-by-imm8; expand to repeated shift-by-1
    const n = b.value & 0xff;
    for (let i = 0; i < n; i++) bytes.push(0xd0 | w, ...memBytes(a, code));
    return bytes;
  }

  if (mnem === 'in' || mnem === 'out') {
    const port = mnem === 'in' ? b : a;
    const acc = mnem === 'in' ? a : b;
    const w = acc.kind === 'r16' ? 1 : 0;
    if (port.kind === 'r16' && port.reg === 2) { bytes.push((mnem === 'in' ? 0xec : 0xee) | w); return bytes; }
    bytes.push((mnem === 'in' ? 0xe4 : 0xe6) | w, port.value & 0xff); return bytes;
  }

  throw new AsmError(`unknown instruction "${mnem}"`, line);
}
