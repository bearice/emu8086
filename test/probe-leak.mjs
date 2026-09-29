import { readFile } from 'node:fs/promises';
import { initializeCPU } from '../src/cpu.js';
import { exec, modrm, h4, lo, hi, w16 } from './harness.js';

await initializeCPU(await readFile(new URL('../src/wasm/kernel.wasm', import.meta.url)));

const INC = [0xb8, 0x00, 0x00, 0x50, 0x9d, 0xb8, 0x00, 0x00, 0xff, modrm(3, 0, 0), 0xf4];
const DEC = [0xb8, 0x00, 0x00, 0x50, 0x9d, 0xba, 0x00, 0x00, 0xff, modrm(3, 1, 2), 0xf4];

const run = (bytes, label) => {
  const r = exec(bytes, { maxSteps: 200 });
  console.log(`${label}: ax=${h4(r.cpu.r[0])} dx=${h4(r.cpu.r[2])} flags=${h4(r.cpu.flags)}`);
};

run(INC, 'INC alone (fresh process)');
run(INC, 'INC again');
run(DEC, 'DEC after INC');
run(INC, 'INC after DEC');
run(INC, 'INC third time');

// Does memory leak between machines?
import { newMachine, put, lin } from './harness.js';
const m1 = newMachine();
m1.cpu.s[3] = 0x1000;
put(m1, 0x1000, 0x9000, w16(0xabcd));
const m2 = newMachine();
m2.cpu.s[3] = 0x1000;
console.log('m2 [1000:9000] =', h4(m2.cpu.rd16(lin(0x1000, 0x9000))), '(0000 = isolated, ABCD = shared memory)');
