import { readFile } from 'node:fs/promises';
import { initializeCPU } from '../src/cpu.js';
import { newMachine, put, w16, h4, modrm } from './harness.js';

await initializeCPU(await readFile(new URL('../src/wasm/kernel.wasm', import.meta.url)));

// Seed nothing, then MOV [SI],AX with SI=0x8000, DS=0x1000, AX=0xBEEF.
// Scan linear memory for 0xBEEF to discover the address the CPU actually used.
function scan(cpu, want, limit = 0x20000) {
  const hits = [];
  for (let a = 0; a < limit; a += 2) {
    if (cpu.rd16(a) === want) hits.push(a);
  }
  return hits;
}

for (const [name, mr, regs] of [
  ['[SI] rm100', modrm(0, 0, 4), { si: 0x8000 }],
  ['[DI] rm101', modrm(0, 0, 5), { di: 0x8000 }],
  ['[BX+SI] rm000', modrm(0, 0, 0), { bx: 0x4000, si: 0x4000 }],
  ['[BX] rm111', modrm(0, 0, 7), { bx: 0x8000 }],
]) {
  const m = newMachine();
  m.cpu.s[1] = 0x1000; m.cpu.s[3] = 0x1000; m.cpu.ip = 0x100; m.cpu.r[4] = 0xffe0;
  // MOV SI,8000 / MOV DI,8000 / MOV BX,... / MOV AX,BEEF / MOV [ea],AX / HLT
  const p = [];
  if (regs.si !== undefined) p.push(0xbe, ...w16(regs.si));
  if (regs.di !== undefined) p.push(0xbf, ...w16(regs.di));
  if (regs.bx !== undefined) p.push(0xbb, ...w16(regs.bx));
  p.push(0xb8, 0xef, 0xbe, 0x89, mr, 0xf4);
  put(m, 0x1000, 0x100, p);
  m.cpu.flags = 0x8000;
  for (let i = 0; i < 40 && !m.cpu.halted && !m.cpu.error; i++) m.cpu.step();
  const hits = scan(m.cpu, 0xbeef);
  console.log(`${name}: wrote 0xBEEF at linear ${hits.map((a) => '0x' + a.toString(16)).join(' ')} (expected 0x18000) ip=${h4(m.cpu.ip)} err=${m.cpu.error ?? ''}`);
}
