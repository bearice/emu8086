import { readFile } from 'node:fs/promises';
import { initializeCPU } from '../src/cpu.js';
import { newMachine, runOn, lin, h4, h2 } from './harness.js';

await initializeCPU(await readFile(new URL('../src/wasm/kernel.wasm', import.meta.url)));

// Program: AX = flags snapshot, then INT n, then BX = flags after the IRET.
//   B8 0000        MOV AX,0
//   9C             PUSHF
//   9D             POP AX      -> AX = flags before INT
//   A3 0002        MOV [0200],AX -> preserve the pre-interrupt FLAGS value
//   CD n           INT n
//   9C             PUSHF
//   9D             POP BX      -> BX = flags after IRET
//   F4             HLT
function probe(vector) {
  const m = newMachine();
  const r = runOn(m, [0x9c, 0x58, 0xa3, 0x00, 0x02, 0xcd, vector, 0x9c, 0x5b, 0xf4], {
    cs: 0x1000, ds: 0x1000, ss: 0x1000, ip: 0x100,
    regs: { sp: 0xffe0 }, flags: 0x0201, maxSteps: 60,
  });
  return { before: h4(m.cpu.rd16(lin(0x1000, 0x0200))), after: h4(m.cpu.r[3]), error: r.error };
}

for (const v of [0x05, 0x08, 0x0b, 0x0c, 0x70, 0x76, 0x10, 0x21]) {
  const r = probe(v);
  console.log(`int ${h2(v)}: before=${r.before} after=${r.after} ${r.before === r.after ? 'OK' : 'DIFFERS'} error=${r.error ?? ''}`);
}
