import { assemble } from '../src/asm.js';
import { CPU, R, S } from '../src/cpu.js';
import { disasm } from '../src/disasm.js';
import { SAMPLES } from '../src/samples.js';

function run(code, input = '') {
  const res = assemble(code);
  if (!res.ok) return { error: JSON.stringify(res.errors) };
  const out = [];
  let inPos = 0;
  const cpu = new CPU({
    onOutput: (c) => { if (c >= 0) out.push(String.fromCharCode(c)); },
    onInput: () => (inPos < input.length ? input.charCodeAt(inPos++) : -1),
  });
  cpu.s[S.CS] = cpu.s[S.DS] = cpu.s[S.ES] = cpu.s[S.SS] = 0x0100;
  cpu.ip = res.origin;
  cpu.r[R.SP] = 0xfffe;
  cpu.mem.set(res.bytes, (0x0100 << 4) + res.origin);
  let n = 0;
  while (!cpu.halted && n++ < 2_000_000) cpu.step();
  return { out: out.join(''), cpu, bytes: res.bytes, error: cpu.error, steps: n };
}

let fail = 0;
const check = (name, got, want) => {
  const ok = got === want;
  if (!ok) fail++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : `\n   got:  ${JSON.stringify(got)}\n   want: ${JSON.stringify(want)}`}`);
};

// sample programs
const s = Object.fromEntries(SAMPLES.map((x) => [x.name, x.code]));
check('hello', run(s['Hello, world']).out, 'Hello, world!\r\n');
check('counter', run(s['Counter loop']).out, '0123456789\r\n');
check('fib', run(s['Fibonacci (16-bit)']).out, '1 1 2 3 5 8 13 21 34 55 89 144 233 377 610 987 ');
check('strrev', run(s['String reverse (string ops)']).out, '8086 rotalume\r\n');
check('echo', run(s['Echo typed keys'], 'hi\r\x1b').out, 'Type something (ESC to quit):\r\nhi\r\n\x1b\r\nbye!\r\n');
{
  const r = run(s['Direct video memory']);
  const vram = r.cpu.mem;
  let txt = '';
  for (let i = 0; i < 13; i++) txt += String.fromCharCode(vram[0xb8000 + (12 * 80 + 32) * 2 + i * 2]);
  check('vram', txt, '8086 EMULATOR');
}

// arithmetic / flags
check('mul-div', run(`org 100h
  mov ax, 300
  mov bx, 7
  mul bx
  mov bx, 4
  div bx
  mov cx, ax
  mov ax, 4C00h
  int 21h`).cpu.r[R.CX], 525);

check('neg-idiv', run(`org 100h
  mov ax, -100
  cwd
  mov bx, 7
  idiv bx
  mov cx, ax
  int 20h`).cpu.r[R.CX] << 16 >> 16, -14);

check('shifts', run(`org 100h
  mov al, 0F0h
  shr al, 1
  shl al, 1
  mov cl, 3
  shr al, cl
  mov ah, 0
  mov bx, ax
  int 20h`).cpu.r[R.AX], 0x001e);

check('stack/call', run(`org 100h
  mov ax, 5
  push ax
  call f
  pop bx
  int 20h
f: mov cx, 7
  ret`).cpu.r[R.CX], 7);

check('rep movsb', run(`org 100h
  mov si, a
  mov di, b
  mov cx, 4
  rep movsb
  mov ah, 09h
  mov dx, b
  int 21h
  int 20h
a: db 'abcd'
b: db '....$'`).out, 'abcd');

check('rep scasb + jcc far', run(`org 100h
  mov di, hay
  mov al, 'x'
  mov cx, 8
  cld
  repne scasb
  mov bx, di
  sub bx, hay
  mov ax, bx
  int 20h
hay: db 'abcxdefg'`).cpu.r[R.AX], 4);

check('signed compare', run(`org 100h
  mov ax, -5
  cmp ax, 3
  jl  less
  mov cx, 0
  jmp e
less: mov cx, 1
e: int 20h`).cpu.r[R.CX], 1);

check('memory addressing', run(`org 100h
  mov bx, arr
  mov si, 4
  mov word [bx+si], 1234h
  mov ax, [arr+4]
  int 20h
arr: dw 0,0,0,0`).cpu.r[R.AX], 0x1234);

check('long jump synthesis', run(`org 100h
  xor ax, ax
  jz  far_target
  mov ax, 1
  db 200 dup(90h)
far_target:
  mov cx, 42
  int 20h`).cpu.r[R.CX], 42);

// disassembler round trip of the hello program
{
  const r = assemble(s['Hello, world']);
  const lines = [];
  let p = 0;
  while (p < 13) {
    const d = disasm((i) => r.bytes[i], p);
    lines.push(d.text);
    p += d.len;
  }
  check('disasm', lines.join(' | '), 'mov ah, 09h | mov dx, 010Dh | int 21h | mov ah, 4Ch | mov al, 00h | int 21h');
}

console.log(fail ? `\n${fail} failing` : '\nall green');
process.exit(fail ? 1 : 0);
