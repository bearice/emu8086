import { readFile } from 'node:fs/promises';
import { initializeCPU } from '../src/cpu.js';
import { runCpuArith } from './spec-cpu-arith.js';

await initializeCPU(await readFile(new URL('../src/wasm/kernel.wasm', import.meta.url)));

runCpuArith((name, got, want) => {
  if (name.startsWith('cpu:incdec/DEC16 0000') || name.startsWith('cpu:incdec/INC16 0000')) {
    console.log(`[${name}] got=${JSON.stringify(got)} want=${JSON.stringify(want)}`);
  }
});
