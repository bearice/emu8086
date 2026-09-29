import { readFile } from 'node:fs/promises';
import { initializeCPU } from '../src/cpu.js';
import { newMachine, put, lin, w16, lo, hi, h4, h2, modrm } from './harness.js';

await initializeCPU(await readFile(new URL('../src/wasm/kernel.wasm', import.meta.url)));

// ADD [addr], AX  (opcode 01 / modrm reg=0) and ADD AX, [addr] (opcode 03 / modrm reg=0)
// for a range of effective-address forms. Seed memory with 0x0001, AX = 0x0002 -> 0x0003.
const cases = [
  { name: '[BX]        mod00 rm111', bx: 0x8000, si: 0, di: 0, bp: 0, mod: 0, rm: 7, disp: [] },
  { name: '[SI]        mod00 rm100', bx: 0, si: 0x8000, di: 0, bp: 0, mod: 0, rm: 4, disp: [] },
  { name: '[DI]        mod00 rm101', bx: 0, si: 0, di: 0x8000, bp: 0, mod: 0, rm: 5, disp: [] },
  { name: '[BP]        mod01 rm110 disp=0', bx: 0, si: 0, di: 0, bp: 0x8000, mod: 1, rm: 6, disp: [0x00] },
  { name: '[disp16]    mod00 rm110', bx: 0, si: 0, di: 0, bp: 0, mod: 0, rm: 6, disp: w16(0x8000) },
  { name: '[BX+SI]     mod00 rm000', bx: 0x4000, si: 0x4000, di: 0, bp: 0, mod: 0, rm: 0, disp: [] },
  { name: '[BX+DI+16]  mod01 rm001', bx: 0x7000, si: 0, di: 0x2000, bp: 0, mod: 1, rm: 1, disp: [0x10] },
  { name: '[BP+DI+16]  mod01 rm011', bx: 0, si: 0, di: 0x2000, bp: 0x7000, mod: 1, rm: 3, disp: [0x10] },
];

for (const c of cases) {
  for (const dir of ['dst_mem', 'dst_reg']) {
    const m = newMachine();
    m.cpu.s[1] = 0x1000; m.cpu.s[2] = 0x1000; m.cpu.s[3] = 0x1000; m.cpu.ip = 0x100; m.cpu.r[4] = 0xffe0;
    const ea = ((c.bx + c.si + c.di + c.bp + (c.disp.length === 2 ? c.disp[0] | (c.disp[1] << 8) : (c.disp[0] ?? 0))) & 0xffff);
    const p = [];
    p.push(0xbb, ...w16(c.bx), 0xbe, ...w16(c.si), 0xbf, ...w16(c.di), 0xbd, ...w16(c.bp), 0xb8, ...w16(0x0002));
    const mr = modrm(c.mod, 0, c.rm);
    if (dir === 'dst_mem') p.push(0x01, mr, ...c.disp);      // ADD [ea], AX
    else p.push(0x03, mr, ...c.disp);                        // ADD AX, [ea]
    p.push(0xf4);
    put(m, 0x1000, 0x100, p);
    put(m, 0x1000, ea, w16(0x0001));
    m.cpu.flags = 0x8000;
    for (let i = 0; i < 40 && !m.cpu.halted && !m.cpu.error; i++) m.cpu.step();
    const mem = h4(m.cpu.rd16(lin(0x1000, ea)));
    const ax = h4(m.cpu.r[0]);
    const got = dir === 'dst_mem' ? `[ea=${h4(ea)}]=${mem}` : `ax=${ax}`;
    const want = dir === 'dst_mem' ? `[ea=${h4(ea)}]=0003` : 'ax=0003';
    console.log(`${got === want ? 'ok  ' : 'FAIL'} ${c.name} ${dir}: ${got} want ${want} zf=${(m.cpu.flags >> 6) & 1} ip=${h4(m.cpu.ip)} err=${m.cpu.error ?? ''}`);
  }
}
