import { readFile } from 'node:fs/promises';
import { initializeCPU } from '../src/cpu.js';
import { newMachine, put, get, lin, w16, lo, hi, h4 } from './harness.js';

await initializeCPU(await readFile(new URL('../src/wasm/kernel.wasm', import.meta.url)));

const m = newMachine();
m.cpu.s[1] = 0x1000; // CS
m.cpu.s[3] = 0x1000; // DS
m.cpu.ip = 0x100;
m.cpu.r[4] = 0xffe0;
put(m, 0x1000, 0x8000, w16(0x0001));
// MOV AX,0002 ; MOV BX,8000 ; ADD [BX],AX (01 07) ; HLT
put(m, 0x1000, 0x100, [0xb8, 0x02, 0x00, 0xbb, 0x00, 0x80, 0x01, 0x07, 0xf4]);
m.cpu.flags = 0x8000;
for (let i = 0; i < 40 && !m.cpu.halted && !m.cpu.error; i++) m.cpu.step();
console.log('error:', m.cpu.error, 'ip:', h4(m.cpu.ip));
console.log('[1000:8000] =', h4(m.cpu.rd16(lin(0x1000, 0x8000))), 'want 0003');
console.log('[0000:8000] =', h4(m.cpu.rd16(0x8000)));
console.log('[1000:8002] =', h4(m.cpu.rd16(lin(0x1000, 0x8002))));
console.log('ax =', h4(m.cpu.r[0]), 'bx =', h4(m.cpu.r[3]));

// Same op, register form, to confirm the ALU itself is fine.
const m2 = newMachine();
m2.cpu.s[1] = 0x1000; m2.cpu.s[3] = 0x1000; m2.cpu.ip = 0x100; m2.cpu.r[4] = 0xffe0;
// MOV AX,0001 ; MOV BX,0002 ; ADD AX,BX (01 D8) ; HLT
put(m2, 0x1000, 0x100, [0xb8, 0x01, 0x00, 0xbb, 0x02, 0x00, 0x01, 0xd8, 0xf4]);
m2.cpu.flags = 0x8000;
for (let i = 0; i < 40 && !m2.cpu.halted && !m2.cpu.error; i++) m2.cpu.step();
console.log('reg form: ax =', h4(m2.cpu.r[0]), 'want 0003, error:', m2.cpu.error);

// 8-bit memory form: ADD [BX],AL (00 07)
const m3 = newMachine();
m3.cpu.s[1] = 0x1000; m3.cpu.s[3] = 0x1000; m3.cpu.ip = 0x100; m3.cpu.r[4] = 0xffe0;
put(m3, 0x1000, 0x8000, [0x01]);
put(m3, 0x1000, 0x100, [0xb0, 0x02, 0xbb, 0x00, 0x80, 0x00, 0x07, 0xf4]);
m3.cpu.flags = 0x8000;
for (let i = 0; i < 40 && !m3.cpu.halted && !m3.cpu.error; i++) m3.cpu.step();
console.log('8-bit [1000:8000] =', h4(m3.cpu.rd16(lin(0x1000, 0x8000))), 'want low byte 03');
