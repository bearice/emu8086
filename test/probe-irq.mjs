import { readFile } from 'node:fs/promises';
import { initializeCPU } from '../src/cpu.js';
import { newMachine, runOn, h4, h2, FLAG_BIT } from './harness.js';

await initializeCPU(await readFile(new URL('../src/wasm/kernel.wasm', import.meta.url)));

console.log('FLAG_BIT map:', JSON.stringify(FLAG_BIT));

// These are software INT instructions, not hardware IRQ delivery.
for (const n of [0x08, 0x0b, 0x0c, 0x70, 0x71, 0x76, 0x77]) {
  const m = newMachine({ bios: true });
  const r = runOn(m, [0xcd, n, 0xf4], {
    regs: { ax: 0x1234, bx: 0x2345, cx: 0x3456, dx: 0x4567 },
    flags: 0x0202,
  });
  console.log(
    `software int ${h2(n)}: flags=${h4(r.cpu.flags)} if=${(r.cpu.flags >> 9) & 1} ax=${h4(r.cpu.r[0])} sp=${h4(r.cpu.r[4])} steps=${r.steps} halted=${r.halted} waiting=${r.waiting} error=${r.error ?? ''}`,
  );
}
