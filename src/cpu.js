// 8086 CPU core — interpreter over a 1 MiB address space.

export const R = { AX: 0, CX: 1, DX: 2, BX: 3, SP: 4, BP: 5, SI: 6, DI: 7 };
export const S = { ES: 0, CS: 1, SS: 2, DS: 3 };
const PARITY = (() => {
  const t = new Uint8Array(256);
  for (let i = 0; i < 256; i++) {
    let c = 0, v = i;
    while (v) { c ^= v & 1; v >>= 1; }
    t[i] = c ? 0 : 1;
  }
  return t;
})();

export class CPU {
  constructor(opts = {}) {
    this.mem = new Uint8Array(1024 * 1024);
    this.r = new Uint16Array(8);
    this.s = new Uint16Array(4);
    this.ip = 0;
    this.f = { cf: 0, pf: 0, af: 0, zf: 0, sf: 0, tf: 0, if: 1, df: 0, of: 0 };
    this.halted = false;
    this.exited = false;
    this.exitCode = 0;
    this.cycles = 0;
    this.onOutput = opts.onOutput || (() => {});   // char code -> screen
    this.onInput = opts.onInput || (() => -1);     // returns char code or -1
    this.error = null;
    this.waiting = false; // blocked on input
  }

  reset() {
    this.r.fill(0); this.s.fill(0); this.ip = 0;
    this.f = { cf: 0, pf: 0, af: 0, zf: 0, sf: 0, tf: 0, if: 1, df: 0, of: 0 };
    this.halted = false; this.exited = false; this.exitCode = 0;
    this.cycles = 0; this.error = null; this.waiting = false;
  }

  // ---- memory ----
  phys(seg, off) { return ((seg << 4) + (off & 0xffff)) & 0xfffff; }
  rd8(a) { return this.mem[a & 0xfffff]; }
  wr8(a, v) { this.mem[a & 0xfffff] = v & 0xff; }
  rd16(a) { return this.mem[a & 0xfffff] | (this.mem[(a + 1) & 0xfffff] << 8); }
  wr16(a, v) { this.mem[a & 0xfffff] = v & 0xff; this.mem[(a + 1) & 0xfffff] = (v >> 8) & 0xff; }
  rdSeg8(seg, off) { return this.rd8(this.phys(seg, off)); }
  rdSeg16(seg, off) { return this.rd16(this.phys(seg, off)); }

  // ---- register access ----
  getR8(i) { return i < 4 ? this.r[i] & 0xff : (this.r[i - 4] >> 8) & 0xff; }
  setR8(i, v) {
    v &= 0xff;
    if (i < 4) this.r[i] = (this.r[i] & 0xff00) | v;
    else this.r[i - 4] = (this.r[i - 4] & 0x00ff) | (v << 8);
  }

  get flags() {
    const f = this.f;
    return (f.cf) | (f.pf << 2) | (f.af << 4) | (f.zf << 6) |
      (f.sf << 7) | (f.tf << 8) | (f.if << 9) | (f.df << 10) | (f.of << 11) | 0x0002;
  }
  set flags(v) {
    const f = this.f;
    f.cf = v & 1; f.pf = (v >> 2) & 1; f.af = (v >> 4) & 1; f.zf = (v >> 6) & 1;
    f.sf = (v >> 7) & 1; f.tf = (v >> 8) & 1; f.if = (v >> 9) & 1;
    f.df = (v >> 10) & 1; f.of = (v >> 11) & 1;
  }

  // ---- fetch ----
  fetch8() { const v = this.rdSeg8(this.s[S.CS], this.ip); this.ip = (this.ip + 1) & 0xffff; return v; }
  fetch16() { const v = this.rdSeg16(this.s[S.CS], this.ip); this.ip = (this.ip + 2) & 0xffff; return v; }
  fetchS8() { const v = this.fetch8(); return v < 0x80 ? v : v - 256; }

  // ---- stack ----
  push(v) { this.r[R.SP] = (this.r[R.SP] - 2) & 0xffff; this.wr16(this.phys(this.s[S.SS], this.r[R.SP]), v); }
  pop() { const v = this.rd16(this.phys(this.s[S.SS], this.r[R.SP])); this.r[R.SP] = (this.r[R.SP] + 2) & 0xffff; return v; }

  // ---- modrm ----
  modrm() {
    const b = this.fetch8();
    const mod = b >> 6, reg = (b >> 3) & 7, rm = b & 7;
    const m = { mod, reg, rm, isReg: mod === 3, seg: 0, off: 0 };
    if (mod === 3) return m;
    let base = 0, defSeg = S.DS;
    switch (rm) {
      case 0: base = this.r[R.BX] + this.r[R.SI]; break;
      case 1: base = this.r[R.BX] + this.r[R.DI]; break;
      case 2: base = this.r[R.BP] + this.r[R.SI]; defSeg = S.SS; break;
      case 3: base = this.r[R.BP] + this.r[R.DI]; defSeg = S.SS; break;
      case 4: base = this.r[R.SI]; break;
      case 5: base = this.r[R.DI]; break;
      case 6: if (mod === 0) { base = this.fetch16(); } else { base = this.r[R.BP]; defSeg = S.SS; } break;
      case 7: base = this.r[R.BX]; break;
    }
    if (mod === 1) base += this.fetchS8();
    else if (mod === 2) base += this.fetch16();
    m.off = base & 0xffff;
    m.seg = this.segOverride === null ? this.s[defSeg] : this.segOverride;
    m.addr = this.phys(m.seg, m.off);
    return m;
  }

  readRM8(m) { return m.isReg ? this.getR8(m.rm) : this.rd8(m.addr); }
  readRM16(m) { return m.isReg ? this.r[m.rm] : this.rd16(m.addr); }
  writeRM8(m, v) { if (m.isReg) this.setR8(m.rm, v); else this.wr8(m.addr, v); }
  writeRM16(m, v) { if (m.isReg) this.r[m.rm] = v & 0xffff; else this.wr16(m.addr, v); }

  // ---- flag helpers ----
  szp8(v) { const f = this.f; f.zf = (v & 0xff) === 0 ? 1 : 0; f.sf = (v >> 7) & 1; f.pf = PARITY[v & 0xff]; }
  szp16(v) { const f = this.f; f.zf = (v & 0xffff) === 0 ? 1 : 0; f.sf = (v >> 15) & 1; f.pf = PARITY[v & 0xff]; }

  alu(op, a, b, w, carryIn = 0) {
    const mask = w ? 0xffff : 0xff, sbit = w ? 0x8000 : 0x80;
    const f = this.f;
    let res;
    switch (op) {
      case 0: // add
      case 2: { // adc
        const c = op === 2 ? carryIn : 0;
        res = a + b + c;
        f.cf = res > mask ? 1 : 0;
        f.af = (((a ^ b ^ res) & 0x10) !== 0) ? 1 : 0;
        f.of = ((~(a ^ b) & (a ^ res)) & sbit) ? 1 : 0;
        res &= mask; break;
      }
      case 5: // sub
      case 3: // sbb
      case 7: { // cmp
        const c = op === 3 ? carryIn : 0;
        res = a - b - c;
        f.cf = res < 0 ? 1 : 0;
        f.af = (((a ^ b ^ res) & 0x10) !== 0) ? 1 : 0;
        f.of = (((a ^ b) & (a ^ res)) & sbit) ? 1 : 0;
        res &= mask; break;
      }
      case 1: res = (a | b) & mask; f.cf = 0; f.of = 0; f.af = 0; break;
      case 4: res = (a & b) & mask; f.cf = 0; f.of = 0; f.af = 0; break;
      case 6: res = (a ^ b) & mask; f.cf = 0; f.of = 0; f.af = 0; break;
    }
    if (w) this.szp16(res); else this.szp8(res);
    return res;
  }

  inc(v, w) {
    const f = this.f, cf = f.cf;
    const res = this.alu(0, v, 1, w);
    f.cf = cf; return res;
  }
  dec(v, w) {
    const f = this.f, cf = f.cf;
    const res = this.alu(5, v, 1, w);
    f.cf = cf; return res;
  }

  cond(c) {
    const f = this.f;
    switch (c) {
      case 0x0: return f.of;
      case 0x1: return !f.of;
      case 0x2: return f.cf;
      case 0x3: return !f.cf;
      case 0x4: return f.zf;
      case 0x5: return !f.zf;
      case 0x6: return f.cf || f.zf;
      case 0x7: return !(f.cf || f.zf);
      case 0x8: return f.sf;
      case 0x9: return !f.sf;
      case 0xa: return f.pf;
      case 0xb: return !f.pf;
      case 0xc: return f.sf !== f.of;
      case 0xd: return f.sf === f.of;
      case 0xe: return f.zf || f.sf !== f.of;
      case 0xf: return !f.zf && f.sf === f.of;
    }
  }

  shiftOp(op, val, cnt, w) {
    const f = this.f, bits = w ? 16 : 8, mask = w ? 0xffff : 0xff, sbit = w ? 0x8000 : 0x80;
    cnt &= 0x1f;
    if (cnt === 0) return val;
    let v = val & mask;
    for (let i = 0; i < cnt; i++) {
      switch (op) {
        case 0: { const c = (v & sbit) ? 1 : 0; v = ((v << 1) | c) & mask; f.cf = c; break; } // rol
        case 1: { const c = v & 1; v = ((v >> 1) | (c ? sbit : 0)) & mask; f.cf = c; break; } // ror
        case 2: { const c = (v & sbit) ? 1 : 0; v = ((v << 1) | f.cf) & mask; f.cf = c; break; } // rcl
        case 3: { const c = v & 1; v = ((v >> 1) | (f.cf ? sbit : 0)) & mask; f.cf = c; break; } // rcr
        case 4: case 6: { f.cf = (v & sbit) ? 1 : 0; v = (v << 1) & mask; break; } // shl/sal
        case 5: { f.cf = v & 1; v = (v >> 1) & mask; break; } // shr
        case 7: { f.cf = v & 1; v = ((v & sbit) ? ((v >> 1) | sbit) : (v >> 1)) & mask; break; } // sar
      }
    }
    if (op <= 3) {
      f.of = (((v & sbit) ? 1 : 0) ^ f.cf) ? 1 : 0;
    } else {
      f.of = op === 7 ? 0 : (((v & sbit) ? 1 : 0) ^ f.cf) ? 1 : 0;
      if (w) this.szp16(v); else this.szp8(v);
      f.af = 0;
    }
    return v;
  }

  // ---- interrupts ----
  interrupt(n) {
    if (this.handleBios(n)) return;
    const vec = this.rd16(n * 4), seg = this.rd16(n * 4 + 2);
    if (vec === 0 && seg === 0) { // unhandled
      this.error = `unhandled INT ${n.toString(16).toUpperCase()}h`;
      this.halted = true;
      return;
    }
    this.push(this.flags);
    this.push(this.s[S.CS]);
    this.push(this.ip);
    this.f.if = 0; this.f.tf = 0;
    this.s[S.CS] = seg; this.ip = vec;
  }

  putChar(c) { this.onOutput(c); }

  handleBios(n) {
    const ah = (this.r[R.AX] >> 8) & 0xff, al = this.r[R.AX] & 0xff;
    if (n === 0x10) { // video
      if (ah === 0x0e || ah === 0x0a || ah === 0x09) { this.putChar(al); return true; }
      if (ah === 0x00) { this.onOutput(-1); return true; } // set mode == clear
      if (ah === 0x02 || ah === 0x01 || ah === 0x03 || ah === 0x06) return true;
      return true;
    }
    if (n === 0x21) { // DOS
      switch (ah) {
        case 0x01: { // read char with echo
          const c = this.onInput();
          if (c < 0) { this.waiting = true; return true; }
          this.waiting = false;
          this.r[R.AX] = (this.r[R.AX] & 0xff00) | (c & 0xff);
          this.putChar(c); return true;
        }
        case 0x02: case 0x06: {
          if (ah === 0x06 && (this.r[R.DX] & 0xff) === 0xff) {
            const c = this.onInput();
            if (c < 0) { this.f.zf = 1; return true; }
            this.f.zf = 0; this.r[R.AX] = (this.r[R.AX] & 0xff00) | (c & 0xff); return true;
          }
          this.putChar(this.r[R.DX] & 0xff); return true;
        }
        case 0x07: case 0x08: { // read char no echo
          const c = this.onInput();
          if (c < 0) { this.waiting = true; return true; }
          this.waiting = false;
          this.r[R.AX] = (this.r[R.AX] & 0xff00) | (c & 0xff); return true;
        }
        case 0x09: { // print $-terminated string at DS:DX
          let off = this.r[R.DX];
          for (let i = 0; i < 65536; i++) {
            const c = this.rdSeg8(this.s[S.DS], off);
            if (c === 0x24) break;
            this.putChar(c);
            off = (off + 1) & 0xffff;
          }
          return true;
        }
        case 0x0a: { // buffered input
          const base = this.r[R.DX];
          const max = this.rdSeg8(this.s[S.DS], base);
          let buf = this._lineBuf || (this._lineBuf = []);
          for (;;) {
            const c = this.onInput();
            if (c < 0) { this.waiting = true; return true; }
            if (c === 13) {
              this.putChar(13); this.putChar(10);
              this.wr8(this.phys(this.s[S.DS], base + 1), buf.length);
              for (let i = 0; i < buf.length; i++) this.wr8(this.phys(this.s[S.DS], base + 2 + i), buf[i]);
              this.wr8(this.phys(this.s[S.DS], base + 2 + buf.length), 13);
              this._lineBuf = null; this.waiting = false; return true;
            }
            if (c === 8) { if (buf.length) { buf.pop(); this.putChar(8); } continue; }
            if (buf.length < max - 1) { buf.push(c); this.putChar(c); }
          }
        }
        case 0x4c: this.exited = true; this.halted = true; this.exitCode = al; return true;
        case 0x2c: { // get time
          const d = new Date();
          this.r[R.CX] = (d.getHours() << 8) | d.getMinutes();
          this.r[R.DX] = (d.getSeconds() << 8) | Math.floor(d.getMilliseconds() / 10);
          return true;
        }
        default: return true;
      }
    }
    if (n === 0x16) { // keyboard
      if (ah === 0x00 || ah === 0x10) {
        const c = this.onInput();
        if (c < 0) { this.waiting = true; return true; }
        this.waiting = false;
        this.r[R.AX] = (c & 0xff) | ((c << 8) & 0xff00); return true;
      }
      if (ah === 0x01 || ah === 0x11) {
        const c = this.onInput(true);
        if (c < 0) { this.f.zf = 1; } else { this.f.zf = 0; this.r[R.AX] = (c & 0xff) | ((c << 8) & 0xff00); }
        return true;
      }
      return true;
    }
    if (n === 0x20) { this.exited = true; this.halted = true; return true; }
    return false;
  }

  // ---- main step ----
  step() {
    if (this.halted) return false;
    this.segOverride = null;
    this.waiting = false;
    let rep = 0; // 0 none, 1 repz/rep, 2 repnz
    let op;
    const startIp = this.ip;
    for (;;) {
      op = this.fetch8();
      if (op === 0x26) { this.segOverride = this.s[S.ES]; continue; }
      if (op === 0x2e) { this.segOverride = this.s[S.CS]; continue; }
      if (op === 0x36) { this.segOverride = this.s[S.SS]; continue; }
      if (op === 0x3e) { this.segOverride = this.s[S.DS]; continue; }
      if (op === 0xf2) { rep = 2; continue; }
      if (op === 0xf3) { rep = 1; continue; }
      if (op === 0xf0) continue; // lock
      break;
    }
    this.repStart = startIp;
    try {
      this.exec(op, rep);
    } catch (e) {
      this.error = e.message; this.halted = true; return false;
    }
    this.cycles++;
    if (this.waiting) this.ip = startIp; // re-execute whole instruction incl. prefixes
    return !this.halted;
  }

  strSrc() { return this.segOverride === null ? this.s[S.DS] : this.segOverride; }

  exec(op, rep) {
    const r = this.r, f = this.f;
    // ALU r/m,reg family: 00-3F
    if (op < 0x40 && (op & 7) < 6) {
      const aluop = (op >> 3) & 7, form = op & 7, w = form & 1;
      if (form < 2) { // r/m, reg
        const m = this.modrm();
        if (w) {
          const res = this.alu(aluop, this.readRM16(m), r[m.reg], 1, f.cf);
          if (aluop !== 7) this.writeRM16(m, res);
        } else {
          const res = this.alu(aluop, this.readRM8(m), this.getR8(m.reg), 0, f.cf);
          if (aluop !== 7) this.writeRM8(m, res);
        }
      } else if (form < 4) { // reg, r/m
        const m = this.modrm();
        if (w) {
          const res = this.alu(aluop, r[m.reg], this.readRM16(m), 1, f.cf);
          if (aluop !== 7) r[m.reg] = res;
        } else {
          const res = this.alu(aluop, this.getR8(m.reg), this.readRM8(m), 0, f.cf);
          if (aluop !== 7) this.setR8(m.reg, res);
        }
      } else { // acc, imm
        if (w) {
          const res = this.alu(aluop, r[R.AX], this.fetch16(), 1, f.cf);
          if (aluop !== 7) r[R.AX] = res;
        } else {
          const res = this.alu(aluop, r[R.AX] & 0xff, this.fetch8(), 0, f.cf);
          if (aluop !== 7) this.setR8(0, res);
        }
      }
      return;
    }

    switch (op) {
      // segment push/pop
      case 0x06: this.push(this.s[S.ES]); return;
      case 0x07: this.s[S.ES] = this.pop(); return;
      case 0x0e: this.push(this.s[S.CS]); return;
      case 0x0f: this.s[S.CS] = this.pop(); return;
      case 0x16: this.push(this.s[S.SS]); return;
      case 0x17: this.s[S.SS] = this.pop(); return;
      case 0x1e: this.push(this.s[S.DS]); return;
      case 0x1f: this.s[S.DS] = this.pop(); return;

      case 0x27: { // daa
        const al = r[R.AX] & 0xff;
        let v = al;
        if ((al & 0xf) > 9 || f.af) { v += 6; f.af = 1; } else f.af = 0;
        if (al > 0x99 || f.cf) { v += 0x60; f.cf = 1; } else f.cf = 0;
        this.setR8(0, v); this.szp8(v & 0xff); return;
      }
      case 0x2f: { // das
        const al = r[R.AX] & 0xff; let v = al;
        if ((al & 0xf) > 9 || f.af) { v -= 6; f.af = 1; } else f.af = 0;
        if (al > 0x99 || f.cf) { v -= 0x60; f.cf = 1; } else f.cf = 0;
        this.setR8(0, v); this.szp8(v & 0xff); return;
      }
      case 0x37: { // aaa
        if (((r[R.AX] & 0xf) > 9) || f.af) {
          r[R.AX] = (r[R.AX] + 0x106) & 0xffff; f.af = 1; f.cf = 1;
        } else { f.af = 0; f.cf = 0; }
        r[R.AX] &= 0xff0f; return;
      }
      case 0x3f: { // aas
        if (((r[R.AX] & 0xf) > 9) || f.af) {
          r[R.AX] = (r[R.AX] - 6) & 0xffff;
          r[R.AX] = (r[R.AX] & 0xff) | (((r[R.AX] >> 8) - 1) << 8 & 0xff00);
          f.af = 1; f.cf = 1;
        } else { f.af = 0; f.cf = 0; }
        r[R.AX] &= 0xff0f; return;
      }
      case 0xd4: { const b = this.fetch8() || 10; const al = r[R.AX] & 0xff; r[R.AX] = ((Math.floor(al / b) << 8) | (al % b)) & 0xffff; this.szp8(r[R.AX] & 0xff); return; } // aam
      case 0xd5: { const b = this.fetch8() || 10; const al = (r[R.AX] & 0xff) + ((r[R.AX] >> 8) * b); r[R.AX] = al & 0xff; this.szp8(r[R.AX] & 0xff); return; } // aad

      case 0x84: { const m = this.modrm(); this.alu(4, this.readRM8(m), this.getR8(m.reg), 0); return; } // test
      case 0x85: { const m = this.modrm(); this.alu(4, this.readRM16(m), r[m.reg], 1); return; }
      case 0x86: { const m = this.modrm(); const a = this.readRM8(m), b = this.getR8(m.reg); this.writeRM8(m, b); this.setR8(m.reg, a); return; }
      case 0x87: { const m = this.modrm(); const a = this.readRM16(m), b = r[m.reg]; this.writeRM16(m, b); r[m.reg] = a; return; }
      case 0x88: { const m = this.modrm(); this.writeRM8(m, this.getR8(m.reg)); return; }
      case 0x89: { const m = this.modrm(); this.writeRM16(m, r[m.reg]); return; }
      case 0x8a: { const m = this.modrm(); this.setR8(m.reg, this.readRM8(m)); return; }
      case 0x8b: { const m = this.modrm(); r[m.reg] = this.readRM16(m); return; }
      case 0x8c: { const m = this.modrm(); this.writeRM16(m, this.s[m.reg & 3]); return; }
      case 0x8d: { const m = this.modrm(); r[m.reg] = m.off; return; } // lea
      case 0x8e: { const m = this.modrm(); this.s[m.reg & 3] = this.readRM16(m); return; }
      case 0x8f: { const m = this.modrm(); this.writeRM16(m, this.pop()); return; }

      case 0x98: { const al = r[R.AX] & 0xff; r[R.AX] = al < 0x80 ? al : (al | 0xff00); return; } // cbw
      case 0x99: { r[R.DX] = (r[R.AX] & 0x8000) ? 0xffff : 0; return; } // cwd
      case 0x9a: { const off = this.fetch16(), seg = this.fetch16(); this.push(this.s[S.CS]); this.push(this.ip); this.s[S.CS] = seg; this.ip = off; return; }
      case 0x9b: return; // wait
      case 0x9c: this.push(this.flags); return;
      case 0x9d: this.flags = this.pop(); return;
      case 0x9e: { const ah = (r[R.AX] >> 8) & 0xff; f.sf = (ah >> 7) & 1; f.zf = (ah >> 6) & 1; f.af = (ah >> 4) & 1; f.pf = (ah >> 2) & 1; f.cf = ah & 1; return; } // sahf
      case 0x9f: { const ah = f.cf | 2 | (f.pf << 2) | (f.af << 4) | (f.zf << 6) | (f.sf << 7); r[R.AX] = (r[R.AX] & 0xff) | (ah << 8); return; } // lahf

      case 0xa0: { const off = this.fetch16(); this.setR8(0, this.rd8(this.phys(this.segOverride ?? this.s[S.DS], off))); return; }
      case 0xa1: { const off = this.fetch16(); r[R.AX] = this.rd16(this.phys(this.segOverride ?? this.s[S.DS], off)); return; }
      case 0xa2: { const off = this.fetch16(); this.wr8(this.phys(this.segOverride ?? this.s[S.DS], off), r[R.AX] & 0xff); return; }
      case 0xa3: { const off = this.fetch16(); this.wr16(this.phys(this.segOverride ?? this.s[S.DS], off), r[R.AX]); return; }
      case 0xa8: this.alu(4, r[R.AX] & 0xff, this.fetch8(), 0); return;
      case 0xa9: this.alu(4, r[R.AX], this.fetch16(), 1); return;

      case 0xc2: { const n = this.fetch16(); this.ip = this.pop(); r[R.SP] = (r[R.SP] + n) & 0xffff; return; }
      case 0xc3: this.ip = this.pop(); return;
      case 0xc4: { const m = this.modrm(); r[m.reg] = this.rd16(m.addr); this.s[S.ES] = this.rd16(m.addr + 2); return; } // les
      case 0xc5: { const m = this.modrm(); r[m.reg] = this.rd16(m.addr); this.s[S.DS] = this.rd16(m.addr + 2); return; } // lds
      case 0xc6: { const m = this.modrm(); this.writeRM8(m, this.fetch8()); return; }
      case 0xc7: { const m = this.modrm(); this.writeRM16(m, this.fetch16()); return; }
      case 0xca: { const n = this.fetch16(); this.ip = this.pop(); this.s[S.CS] = this.pop(); r[R.SP] = (r[R.SP] + n) & 0xffff; return; }
      case 0xcb: { this.ip = this.pop(); this.s[S.CS] = this.pop(); return; }
      case 0xcc: this.interrupt(3); return;
      case 0xcd: { const n = this.fetch8(); this.interrupt(n); return; }
      case 0xce: if (f.of) this.interrupt(4); return;
      case 0xcf: { this.ip = this.pop(); this.s[S.CS] = this.pop(); this.flags = this.pop(); return; }

      case 0xd7: { this.setR8(0, this.rd8(this.phys(this.segOverride ?? this.s[S.DS], (r[R.BX] + (r[R.AX] & 0xff)) & 0xffff))); return; } // xlat

      case 0xe0: case 0xe1: case 0xe2: { // loopnz/loopz/loop
        const d = this.fetchS8();
        r[R.CX] = (r[R.CX] - 1) & 0xffff;
        const take = op === 0xe2 ? r[R.CX] !== 0
          : op === 0xe1 ? (r[R.CX] !== 0 && f.zf)
            : (r[R.CX] !== 0 && !f.zf);
        if (take) this.ip = (this.ip + d) & 0xffff;
        return;
      }
      case 0xe3: { const d = this.fetchS8(); if (r[R.CX] === 0) this.ip = (this.ip + d) & 0xffff; return; }
      case 0xe4: { this.fetch8(); this.setR8(0, 0); return; }
      case 0xe5: { this.fetch8(); r[R.AX] = 0; return; }
      case 0xe6: case 0xe7: this.fetch8(); return;
      case 0xec: this.setR8(0, 0); return;
      case 0xed: r[R.AX] = 0; return;
      case 0xee: case 0xef: return;

      case 0xe8: { const d = this.fetch16(); this.push(this.ip); this.ip = (this.ip + (d < 0x8000 ? d : d - 65536)) & 0xffff; return; }
      case 0xe9: { const d = this.fetch16(); this.ip = (this.ip + (d < 0x8000 ? d : d - 65536)) & 0xffff; return; }
      case 0xea: { const off = this.fetch16(), seg = this.fetch16(); this.ip = off; this.s[S.CS] = seg; return; }
      case 0xeb: { const d = this.fetchS8(); this.ip = (this.ip + d) & 0xffff; return; }

      case 0xf4: this.halted = true; return;
      case 0xf5: f.cf ^= 1; return;
      case 0xf8: f.cf = 0; return;
      case 0xf9: f.cf = 1; return;
      case 0xfa: f.if = 0; return;
      case 0xfb: f.if = 1; return;
      case 0xfc: f.df = 0; return;
      case 0xfd: f.df = 1; return;
      case 0x90: return; // nop
    }

    // 0x40-0x4F inc/dec reg16
    if (op >= 0x40 && op <= 0x47) { r[op & 7] = this.inc(r[op & 7], 1); return; }
    if (op >= 0x48 && op <= 0x4f) { r[op & 7] = this.dec(r[op & 7], 1); return; }
    // push/pop reg
    if (op >= 0x50 && op <= 0x57) { this.push(r[op & 7]); return; }
    if (op >= 0x58 && op <= 0x5f) { r[op & 7] = this.pop(); return; }
    // Jcc
    if (op >= 0x70 && op <= 0x7f) {
      const d = this.fetchS8();
      if (this.cond(op & 0xf)) this.ip = (this.ip + d) & 0xffff;
      return;
    }
    // group 1: 80-83
    if (op >= 0x80 && op <= 0x83) {
      const m = this.modrm();
      const w = op & 1;
      let imm;
      if (op === 0x81) imm = this.fetch16();
      else if (op === 0x83) { const v = this.fetchS8(); imm = v & 0xffff; }
      else imm = this.fetch8();
      const aluop = m.reg;
      if (w) {
        const res = this.alu(aluop, this.readRM16(m), imm, 1, f.cf);
        if (aluop !== 7) this.writeRM16(m, res);
      } else {
        const res = this.alu(aluop, this.readRM8(m), imm & 0xff, 0, f.cf);
        if (aluop !== 7) this.writeRM8(m, res);
      }
      return;
    }
    // xchg ax,reg
    if (op >= 0x91 && op <= 0x97) { const i = op & 7; const t = r[R.AX]; r[R.AX] = r[i]; r[i] = t; return; }
    // string ops
    if ((op >= 0xa4 && op <= 0xa7) || (op >= 0xaa && op <= 0xaf)) { this.stringOp(op, rep); return; }
    // mov reg,imm
    if (op >= 0xb0 && op <= 0xb7) { this.setR8(op & 7, this.fetch8()); return; }
    if (op >= 0xb8 && op <= 0xbf) { r[op & 7] = this.fetch16(); return; }
    // shift group
    if (op >= 0xd0 && op <= 0xd3) {
      const m = this.modrm();
      const w = op & 1;
      const cnt = (op & 2) ? (r[R.CX] & 0xff) : 1;
      if (w) this.writeRM16(m, this.shiftOp(m.reg, this.readRM16(m), cnt, 1));
      else this.writeRM8(m, this.shiftOp(m.reg, this.readRM8(m), cnt, 0));
      return;
    }
    if (op >= 0xd8 && op <= 0xdf) { this.modrm(); return; } // esc/fpu — ignore
    // group 3: F6/F7
    if (op === 0xf6 || op === 0xf7) {
      const w = op & 1;
      const m = this.modrm();
      const val = w ? this.readRM16(m) : this.readRM8(m);
      switch (m.reg) {
        case 0: case 1: { const imm = w ? this.fetch16() : this.fetch8(); this.alu(4, val, imm, w); return; }
        case 2: { if (w) this.writeRM16(m, ~val & 0xffff); else this.writeRM8(m, ~val & 0xff); return; }
        case 3: { const res = this.alu(5, 0, val, w); if (w) this.writeRM16(m, res); else this.writeRM8(m, res); f.cf = val !== 0 ? 1 : 0; return; }
        case 4: { // mul
          if (w) { const p = (r[R.AX] * val) >>> 0; r[R.AX] = p & 0xffff; r[R.DX] = (p >>> 16) & 0xffff; f.cf = f.of = r[R.DX] ? 1 : 0; }
          else { const p = (r[R.AX] & 0xff) * val; r[R.AX] = p & 0xffff; f.cf = f.of = (p & 0xff00) ? 1 : 0; }
          return;
        }
        case 5: { // imul
          const sx = (v, bits) => v & (1 << (bits - 1)) ? v - (1 << bits) : v;
          if (w) {
            const p = sx(r[R.AX], 16) * sx(val, 16);
            r[R.AX] = p & 0xffff; r[R.DX] = (p >> 16) & 0xffff;
            f.cf = f.of = (p < -32768 || p > 32767) ? 1 : 0;
          } else {
            const p = sx(r[R.AX] & 0xff, 8) * sx(val, 8);
            r[R.AX] = p & 0xffff;
            f.cf = f.of = (p < -128 || p > 127) ? 1 : 0;
          }
          return;
        }
        case 6: { // div
          if (val === 0) { this.interrupt(0); return; }
          if (w) {
            const num = ((r[R.DX] << 16) >>> 0) + r[R.AX];
            const q = Math.floor(num / val);
            if (q > 0xffff) { this.interrupt(0); return; }
            r[R.AX] = q & 0xffff; r[R.DX] = num % val;
          } else {
            const num = r[R.AX];
            const q = Math.floor(num / val);
            if (q > 0xff) { this.interrupt(0); return; }
            r[R.AX] = (q & 0xff) | ((num % val) << 8);
          }
          return;
        }
        case 7: { // idiv
          const sx = (v, bits) => v & (1 << (bits - 1)) ? v - (1 << bits) : v;
          const d = w ? sx(val, 16) : sx(val, 8);
          if (d === 0) { this.interrupt(0); return; }
          if (w) {
            let num = (r[R.DX] << 16) | r[R.AX];
            const q = Math.trunc(num / d), rem = num % d;
            r[R.AX] = q & 0xffff; r[R.DX] = rem & 0xffff;
          } else {
            const num = sx(r[R.AX], 16);
            const q = Math.trunc(num / d), rem = num % d;
            r[R.AX] = (q & 0xff) | ((rem & 0xff) << 8);
          }
          return;
        }
      }
    }
    // group 4/5: FE/FF
    if (op === 0xfe || op === 0xff) {
      const w = op & 1;
      const m = this.modrm();
      switch (m.reg) {
        case 0: { if (w) this.writeRM16(m, this.inc(this.readRM16(m), 1)); else this.writeRM8(m, this.inc(this.readRM8(m), 0)); return; }
        case 1: { if (w) this.writeRM16(m, this.dec(this.readRM16(m), 1)); else this.writeRM8(m, this.dec(this.readRM8(m), 0)); return; }
        case 2: { const t = this.readRM16(m); this.push(this.ip); this.ip = t; return; }
        case 3: { const off = this.rd16(m.addr), seg = this.rd16(m.addr + 2); this.push(this.s[S.CS]); this.push(this.ip); this.ip = off; this.s[S.CS] = seg; return; }
        case 4: { this.ip = this.readRM16(m); return; }
        case 5: { const off = this.rd16(m.addr), seg = this.rd16(m.addr + 2); this.ip = off; this.s[S.CS] = seg; return; }
        case 6: { this.push(this.readRM16(m)); return; }
      }
      return;
    }
    throw new Error(`invalid opcode ${op.toString(16).padStart(2, '0').toUpperCase()}h at ${this.hexAddr()}`);
  }

  hexAddr() {
    return `${this.s[S.CS].toString(16).padStart(4, '0')}:${this.ip.toString(16).padStart(4, '0')}`.toUpperCase();
  }

  stringOp(op, rep) {
    const r = this.r, f = this.f;
    const w = op & 1;
    const delta = (f.df ? -1 : 1) * (w ? 2 : 1);
    const src = this.strSrc();
    const doOne = () => {
      switch (op & 0xfe) {
        case 0xa4: { // movs
          if (w) this.wr16(this.phys(this.s[S.ES], r[R.DI]), this.rd16(this.phys(src, r[R.SI])));
          else this.wr8(this.phys(this.s[S.ES], r[R.DI]), this.rd8(this.phys(src, r[R.SI])));
          r[R.SI] = (r[R.SI] + delta) & 0xffff; r[R.DI] = (r[R.DI] + delta) & 0xffff; break;
        }
        case 0xa6: { // cmps
          const a = w ? this.rd16(this.phys(src, r[R.SI])) : this.rd8(this.phys(src, r[R.SI]));
          const b = w ? this.rd16(this.phys(this.s[S.ES], r[R.DI])) : this.rd8(this.phys(this.s[S.ES], r[R.DI]));
          this.alu(7, a, b, w);
          r[R.SI] = (r[R.SI] + delta) & 0xffff; r[R.DI] = (r[R.DI] + delta) & 0xffff; break;
        }
        case 0xaa: { // stos
          if (w) this.wr16(this.phys(this.s[S.ES], r[R.DI]), r[R.AX]);
          else this.wr8(this.phys(this.s[S.ES], r[R.DI]), r[R.AX] & 0xff);
          r[R.DI] = (r[R.DI] + delta) & 0xffff; break;
        }
        case 0xac: { // lods
          if (w) r[R.AX] = this.rd16(this.phys(src, r[R.SI]));
          else this.setR8(0, this.rd8(this.phys(src, r[R.SI])));
          r[R.SI] = (r[R.SI] + delta) & 0xffff; break;
        }
        case 0xae: { // scas
          const b = w ? this.rd16(this.phys(this.s[S.ES], r[R.DI])) : this.rd8(this.phys(this.s[S.ES], r[R.DI]));
          this.alu(7, w ? r[R.AX] : r[R.AX] & 0xff, b, w);
          r[R.DI] = (r[R.DI] + delta) & 0xffff; break;
        }
      }
    };
    if (!rep) { doOne(); return; }
    // execute one repetition per step so the UI stays responsive & single-step works
    if (r[R.CX] === 0) return;
    doOne();
    r[R.CX] = (r[R.CX] - 1) & 0xffff;
    const isCmp = (op & 0xfe) === 0xa6 || (op & 0xfe) === 0xae;
    let again = r[R.CX] !== 0;
    if (isCmp) again = again && (rep === 1 ? f.zf : !f.zf);
    if (again) this.ip = this.repStart ?? this.ip;
  }
}
