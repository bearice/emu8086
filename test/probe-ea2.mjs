import { readFile } from 'node:fs/promises';
import { initializeCPU } from '../src/cpu.js';
import { newMachine, put, lin, w16, lo, hi, h4, h2, modrm } from './harness.js';

await initializeCPU(await readFile(new URL('../src/wasm/kernel.wasm', import.meta.url)));

// Every opcode group that takes a memory operand, exercised through [BX].
// Memory starts at 0x1000:0x8000 = 0x0001 (AX = 0x0002 unless noted).
const MR_BX = modrm(0, 0, 7);   // mod=00 rm=111 -> [BX]
const cases = [
  { name: 'MOV AX,[BX]      8B /0', pre: [], bytes: [0x8b, MR_BX], check: (c) => `ax=${h4(c.r[0])}`, want: 'ax=0001' },
  { name: 'MOV [BX],AX      89 /0', pre: [[0xb8, 0x02, 0x00]], bytes: [0x89, MR_BX], check: (c, m) => `[8000]=${h4(c.rd16(lin(0x1000, 0x8000)))}`, want: '[8000]=0002' },
  { name: 'ADD AX,[BX]      03 /0', pre: [[0xb8, 0x02, 0x00]], bytes: [0x03, MR_BX], check: (c) => `ax=${h4(c.r[0])}`, want: 'ax=0003' },
  { name: 'ADD [BX],AX      01 /0', pre: [[0xb8, 0x02, 0x00]], bytes: [0x01, MR_BX], check: (c, m) => `[8000]=${h4(c.rd16(lin(0x1000, 0x8000)))}`, want: '[8000]=0003' },
  { name: 'ADD AL,[BX]      00 /0', pre: [[0xb0, 0x02]], bytes: [0x00, MR_BX], check: (c, m) => `[8000]=${h2(c.rd8(lin(0x1000, 0x8000)))}`, want: '[8000]=03' },
  { name: 'ADC AX,[BX]      13 /0', pre: [[0xb8, 0x02, 0x00]], bytes: [0x13, MR_BX], check: (c) => `ax=${h4(c.r[0])}`, want: 'ax=0003' },
  { name: 'SUB AX,[BX]      2B /0', pre: [[0xb8, 0x02, 0x00]], bytes: [0x2b, MR_BX], check: (c) => `ax=${h4(c.r[0])}`, want: 'ax=0001' },
  { name: 'SBB AX,[BX]      1B /0', pre: [[0xb8, 0x02, 0x00]], bytes: [0x1b, MR_BX], check: (c) => `ax=${h4(c.r[0])}`, want: 'ax=0001' },
  { name: 'AND AX,[BX]      23 /0', pre: [[0xb8, 0x03, 0x00]], bytes: [0x23, MR_BX], check: (c) => `ax=${h4(c.r[0])}`, want: 'ax=0001' },
  { name: 'OR AX,[BX]       0B /0', pre: [[0xb8, 0x02, 0x00]], bytes: [0x0b, MR_BX], check: (c) => `ax=${h4(c.r[0])}`, want: 'ax=0003' },
  { name: 'XOR AX,[BX]      33 /0', pre: [[0xb8, 0x02, 0x00]], bytes: [0x33, MR_BX], check: (c) => `ax=${h4(c.r[0])}`, want: 'ax=0003' },
  { name: 'CMP [BX],AX      39 /0', pre: [], bytes: [0x39, MR_BX], check: (c, m) => `[8000]=${h4(c.rd16(lin(0x1000, 0x8000)))} zf=${(c.flags >> 6) & 1}`, want: '[8000]=0001 zf=0' },
  { name: 'XCHG AX,[BX]     87 /0', pre: [[0xb8, 0x02, 0x00]], bytes: [0x87, MR_BX], check: (c, m) => `ax=${h4(c.r[0])} [8000]=${h4(c.rd16(lin(0x1000, 0x8000)))}`, want: 'ax=0001 [8000]=0002' },
  { name: 'INC WORD [BX]    FF /0', pre: [], bytes: [0xff, MR_BX], check: (c, m) => `[8000]=${h4(c.rd16(lin(0x1000, 0x8000)))}`, want: '[8000]=0002' },
  { name: 'DEC WORD [BX]    FF /1', pre: [], bytes: [0xff, modrm(0, 1, 7)], check: (c, m) => `[8000]=${h4(c.rd16(lin(0x1000, 0x8000)))}`, want: '[8000]=0000' },
  { name: 'NOT WORD [BX]    F7 /2', pre: [], bytes: [0xf7, modrm(0, 2, 7)], check: (c, m) => `[8000]=${h4(c.rd16(lin(0x1000, 0x8000)))}`, want: '[8000]=FFFE' },
  { name: 'NEG WORD [BX]    F7 /3', pre: [], bytes: [0xf7, modrm(0, 3, 7)], check: (c, m) => `[8000]=${h4(c.rd16(lin(0x1000, 0x8000)))}`, want: '[8000]=FFFF' },
  { name: 'MUL WORD [BX]    F7 /4', pre: [[0xb8, 0x02, 0x00]], bytes: [0xf7, modrm(0, 4, 7)], check: (c) => `dx:ax=${h4(c.r[2])}:${h4(c.r[0])}`, want: 'dx:ax=0000:0002' },
  { name: 'DIV WORD [BX]    F7 /6', pre: [[0xb8, 0x02, 0x00]], bytes: [0xf7, modrm(0, 6, 7)], check: (c) => `ax=${h4(c.r[0])}`, want: 'ax=0002' },
  { name: 'SHL WORD [BX],1  D1 /4', pre: [], bytes: [0xd1, modrm(0, 4, 7)], check: (c, m) => `[8000]=${h4(c.rd16(lin(0x1000, 0x8000)))}`, want: '[8000]=0002' },
  { name: 'TEST WORD[BX],2  F7 /0', pre: [], bytes: [0xf7, MR_BX, 0x02, 0x00], check: (c, m) => `zf=${(c.flags >> 6) & 1} [8000]=${h4(c.rd16(lin(0x1000, 0x8000)))}`, want: 'zf=1 [8000]=0001' },
  { name: 'MOV [BX],AL      88 /0', pre: [[0xb0, 0x02]], bytes: [0x88, MR_BX], check: (c, m) => `[8000]=${h2(c.rd8(lin(0x1000, 0x8000)))}`, want: '[8000]=02' },
];

let bad = 0;
for (const c of cases) {
  const m = newMachine();
  m.cpu.s[1] = 0x1000; m.cpu.s[3] = 0x1000; m.cpu.ip = 0x100; m.cpu.r[4] = 0xffe0;
  const p = [0xbb, ...w16(0x8000)];
  for (const pre of c.pre) {
    if (Array.isArray(pre)) p.push(...pre);
    else p.push(pre);
  }
  p.push(...c.bytes, 0xf4);
  put(m, 0x1000, 0x100, p);
  put(m, 0x1000, 0x8000, w16(0x0001));
  m.cpu.flags = 0x8000;
  for (let i = 0; i < 40 && !m.cpu.halted && !m.cpu.error; i++) m.cpu.step();
  const got = c.check(m.cpu, m);
  const ok = got === c.want;
  if (!ok) bad++;
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${c.name}: ${got} want ${c.want}${m.cpu.error ? ' err=' + m.cpu.error : ''}`);
}
console.log(`\n${bad}/${cases.length} memory-operand forms through [BX] are wrong`);
