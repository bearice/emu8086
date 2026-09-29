import { readFile } from 'node:fs/promises';
import { initializeCPU } from '../src/cpu.js';
import { newMachine, put, lin, w16, h4, modrm } from './harness.js';

await initializeCPU(await readFile(new URL('../src/wasm/kernel.wasm', import.meta.url)));

// The r/m field is an effective-address code, NOT a register index:
// 000=BX+SI 001=BX+DI 010=BP+SI 011=BP+DI 100=SI 101=DI 110=BP/disp16 111=BX
const cases = [
  { name: '[BX]       rm111', rm: 7, mod: 0, disp: [], bx: 0x8000, si: 0, di: 0, bp: 0, want: 0x8000 },
  { name: '[SI]       rm100', rm: 4, mod: 0, disp: [], bx: 0, si: 0x8000, di: 0, bp: 0, want: 0x8000 },
  { name: '[DI]       rm101', rm: 5, mod: 0, disp: [], bx: 0, si: 0, di: 0x8000, bp: 0, want: 0x8000 },
  { name: '[BP]       rm110 mod01', rm: 6, mod: 1, disp: [0x00], bx: 0, si: 0, di: 0, bp: 0x8000, want: 0x8000 },
  { name: '[disp16]   rm110 mod00', rm: 6, mod: 0, disp: w16(0x8000), bx: 0, si: 0, di: 0, bp: 0, want: 0x8000 },
  { name: '[BX+SI]    rm000', rm: 0, mod: 0, disp: [], bx: 0x4000, si: 0x4000, di: 0, bp: 0, want: 0x8000 },
  { name: '[BX+DI+16] rm001 mod01', rm: 1, mod: 1, disp: [0x10], bx: 0x7000, si: 0, di: 0x2000, bp: 0, want: 0x9010 },
  { name: '[BP+SI+16] rm010 mod01', rm: 2, mod: 1, disp: [0x10], bx: 0, si: 0x2000, di: 0, bp: 0x7000, want: 0x9010 },
  { name: '[BP+DI+16] rm011 mod01', rm: 3, mod: 1, disp: [0x10], bx: 0, si: 0, di: 0x2000, bp: 0x7000, want: 0x9010 },
  { name: '[BX+disp8] rm111 mod01 +16', rm: 7, mod: 1, disp: [0x10], bx: 0x8000, si: 0, di: 0, bp: 0, want: 0x8010 },
];

let bad = 0;
for (const c of cases) {
  for (const dir of ['mov_dst_reg', 'mov_dst_mem', 'add_dst_reg', 'add_dst_mem']) {
    const m = newMachine();
    m.cpu.s[1] = 0x1000; m.cpu.s[2] = 0x1000; m.cpu.s[3] = 0x1000; m.cpu.ip = 0x100; m.cpu.r[4] = 0xffe0;
    const p = [0xbb, ...w16(c.bx), 0xbe, ...w16(c.si), 0xbf, ...w16(c.di), 0xbd, ...w16(c.bp), 0xb8, ...w16(0x0002)];
    const mr = modrm(c.mod, 0, c.rm);
    if (dir === 'mov_dst_reg') p.push(0x8b, mr, ...c.disp);        // MOV AX, [ea]
    else if (dir === 'mov_dst_mem') p.push(0x89, mr, ...c.disp);   // MOV [ea], AX
    else if (dir === 'add_dst_reg') p.push(0x03, mr, ...c.disp);   // ADD AX, [ea]
    else p.push(0x01, mr, ...c.disp);                              // ADD [ea], AX
    p.push(0xf4);
    put(m, 0x1000, 0x100, p);
    put(m, 0x1000, c.want, w16(0x0001));
    m.cpu.flags = 0x8000;
    for (let i = 0; i < 40 && !m.cpu.halted && !m.cpu.error; i++) m.cpu.step();
    const dstMem = dir.endsWith('mem');
    const got = dstMem ? `[${h4(c.want)}]=${h4(m.cpu.rd16(lin(0x1000, c.want)))}` : `ax=${h4(m.cpu.r[0])}`;
    const want = dstMem ? `[${h4(c.want)}]=${dir.startsWith('add') ? '0003' : '0002'}` : `ax=${dir.startsWith('add') ? '0003' : '0001'}`;
    const ok = got === want;
    if (!ok) bad++;
    console.log(`${ok ? 'ok  ' : 'FAIL'} ${c.name} ${dir}: ${got} want ${want}${m.cpu.error ? ' err=' + m.cpu.error : ''}`);
  }
}
console.log(`\n${bad} failures of ${cases.length * 4}`);
