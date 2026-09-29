import { readFile } from 'node:fs/promises';
import { initializeCPU } from '../src/cpu.js';
import { exec, modrm, h4, lo, hi, w16 } from './harness.js';

await initializeCPU(await readFile(new URL('../src/wasm/kernel.wasm', import.meta.url)));

const GPR = { ax: 0, dx: 2 };
for (const [name, g, reg, v, cfIn] of [
  ['INC16 v=0 cf=0', 0, 'ax', 0x0000, 0],
  ['INC16 v=0 cf=1', 0, 'ax', 0x0000, 1],
  ['INC16 v=1 cf=0', 0, 'ax', 0x0001, 0],
  ['DEC16 v=0 cf=0', 1, 'dx', 0x0000, 0],
  ['DEC16 v=1 cf=0', 1, 'dx', 0x0001, 0],
]) {
  const load = reg === 'ax' ? [0xb8, ...w16(v)] : [0xba, ...w16(v)];
  const bytes = [0xb8, lo(cfIn), hi(cfIn), 0x50, 0x9d, ...load, 0xff, modrm(3, g, GPR[reg]), 0xf4];
  const r = exec(bytes, { maxSteps: 200 });
  console.log(`${name}: ${bytes.map((b) => b.toString(16).padStart(2, '0')).join(' ')}`);
  console.log(`   ${reg}=${h4(r.cpu.r[GPR[reg]])} flags=${h4(r.cpu.flags)} halted=${r.cpu.halted} err=${r.cpu.error ?? ''} steps=${r.steps}`);
}
