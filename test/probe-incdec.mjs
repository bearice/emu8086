import { readFile } from 'node:fs/promises';
import { initializeCPU } from '../src/cpu.js';
import { newMachine, put, w16, h4, modrm, h2 } from './harness.js';

await initializeCPU(await readFile(new URL('../src/wasm/kernel.wasm', import.meta.url)));

function trace(name, bytes) {
  const m = newMachine();
  m.cpu.s[1] = 0x1000; m.cpu.s[3] = 0x1000; m.cpu.ip = 0x100; m.cpu.r[4] = 0xffe0;
  put(m, 0x1000, 0x100, bytes);
  m.cpu.flags = 0x8000;
  console.log(`--- ${name}: ${bytes.map(h2).join(' ')}`);
  for (let i = 0; i < 8; i++) {
    const before = `ip=${h4(m.cpu.ip)} ax=${h4(m.cpu.r[0])} dx=${h4(m.cpu.r[2])} flags=${h4(m.cpu.flags)}`;
    m.cpu.step();
    console.log(`  step${i}: ${before} -> halted=${m.cpu.halted} err=${m.cpu.error ?? ''} ip=${h4(m.cpu.ip)} ax=${h4(m.cpu.r[0])} dx=${h4(m.cpu.r[2])} flags=${h4(m.cpu.flags)}`);
    if (m.cpu.halted || m.cpu.error) break;
  }
}

// MOV AX,0000 ; INC AX (FF C0) ; HLT
trace('INC AX from 0', [0xb8, 0x00, 0x00, 0xff, modrm(3, 0, 0), 0xf4]);
// MOV AX,0001 ; DEC AX (FF D8 -> mod=3 reg=1 rm=0) ; HLT
trace('DEC AX from 1', [0xb8, 0x01, 0x00, 0xff, modrm(3, 1, 0), 0xf4]);
// MOV DX,0000 ; DEC DX (FF C2) ; HLT
trace('DEC DX from 0', [0xba, 0x00, 0x00, 0xff, modrm(3, 1, 2), 0xf4]);
// flag seeding prefix, exactly as the suite emits it
trace('suite INC16 v=0 cf=0', [0xb8, 0x00, 0x00, 0x50, 0x9d, 0xb8, 0x00, 0x00, 0xff, modrm(3, 0, 0), 0xf4]);
trace('suite DEC16 v=0 cf=0', [0xb8, 0x00, 0x00, 0x50, 0x9d, 0xba, 0x00, 0x00, 0xff, modrm(3, 1, 2), 0xf4]);
