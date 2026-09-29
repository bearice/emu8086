import { readFile } from 'node:fs/promises';
import { initializeCPU } from '../src/cpu.js';
import { newMachine, put, h4, h2, lin } from './harness.js';

await initializeCPU(await readFile(new URL('../src/wasm/kernel.wasm', import.meta.url)));

const m = newMachine();
m.cpu.s[1] = 0x1000; m.cpu.s[3] = 0x1000; m.cpu.ip = 0x100; m.cpu.r[4] = 0xffe0;
// PUSHF ; POP AX ; INT 08 ; PUSHF ; POP BX ; HLT
put(m, 0x1000, 0x100, [0x9c, 0x58, 0xcd, 0x08, 0x9c, 0x5b, 0xf4]);
m.cpu.flags = 0x8201;
console.log('flags after set  =', h4(m.cpu.flags));
for (let i = 0; i < 12 && !m.cpu.halted && !m.cpu.error; i++) {
  const ipBefore = m.cpu.ip;
  const op = m.cpu.rd8(lin(0x1000, m.cpu.ip));
  m.cpu.step();
  console.log(`step ${i}: ip=${h4(ipBefore)} op=${h2(op)} -> ip=${h4(m.cpu.ip)} flags=${h4(m.cpu.flags)} ax=${h4(m.cpu.r[0])} bx=${h4(m.cpu.r[3])} sp=${h4(m.cpu.r[4])} halted=${m.cpu.halted} error=${m.cpu.error ?? ''}`);
}
