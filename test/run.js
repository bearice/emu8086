import { assemble } from '../src/asm.js';
import { CPU, initializeCPU, R, S } from '../src/cpu.js';
import { disasm } from '../src/disasm.js';
import { SAMPLES } from '../src/samples.js';
import { Machine, VRAM, COLS, ROWS } from '../src/machine.js';
import { DiskImage, HARD_DISK_GEOMETRY } from '../src/disk.js';
import { readFile } from 'node:fs/promises';

await initializeCPU(await readFile(new URL('../src/wasm/kernel.wasm', import.meta.url)));

function run(code, input = '', cpuOptions = {}) {
  const res = assemble(code);
  if (!res.ok) return { error: JSON.stringify(res.errors) };
  const out = [];
  let inPos = 0;
  const cpu = new CPU({
    onOutput: (c) => { if (c >= 0) out.push(String.fromCharCode(c)); },
    onInput: () => (inPos < input.length ? input.charCodeAt(inPos++) : -1),
    ...cpuOptions,
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

{
  const r = run(`org 100h
  mov di, 0200h
  mov al, 'A'
  stosb
  mov di, 0200h
  xor cx, cx
  mov al, 'X'
  rep stosb
  int 20h`);
  check('rep zero count memory', r.cpu.mem[0x01200], 'A'.charCodeAt(0));
  check('rep zero count index', r.cpu.r[R.DI], 0x0200);
}

{
  const reads = [];
  const writes = [];
  const r = run(`org 100h
  mov dx, 0100h
  in al, dx
  mov bx, ax
  mov dx, 0110h
  in ax, dx
  mov cx, ax
  mov al, 34h
  out 21h, al
  out dx, ax
  in al, 21h
  int 20h`, '', {
    onPortRead: (port, width) => {
      reads.push([port, width]);
      return width === 1 ? 0x5a : 0xabcd;
    },
    onPortWrite: (port, value, width) => writes.push([port, value, width]),
  });
  check('port input register values', `${r.cpu.r[R.BX].toString(16)},${r.cpu.r[R.CX].toString(16)},${r.cpu.r[R.AX].toString(16)}`, '5a,abcd,ab5a');
  check('port input callbacks', JSON.stringify(reads), JSON.stringify([[0x0100, 1], [0x0110, 2], [0x0021, 1]]));
  check('port output callbacks', JSON.stringify(writes), JSON.stringify([[0x0021, 0x34, 1], [0x0110, 0xab34, 2]]));
}

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

// Boot the bundled MS-DOS 5.0 disk through the same Machine and BIOS path as the app.
{
  const image = new Uint8Array(await readFile(new URL('../msdos5.img', import.meta.url)));
  const originalImage = image.slice();

  const diskUnit = DiskImage.blank(HARD_DISK_GEOMETRY);
  const lastSector = new Uint8Array(512).fill(0xa5);
  check('hard disk accepts its final CHS sector', diskUnit.writeSectors(614, 3, 17, lastSector), true);
  check('hard disk reads back the final CHS sector', diskUnit.readSectors(614, 3, 17, 1)?.every((value) => value === 0xa5), true);
  check('hard disk rejects CHS transfers beyond its end', diskUnit.writeSectors(614, 3, 17, new Uint8Array(1024)), false);

  const biosMachine = new Machine();
  biosMachine.bootFloppy(image);
  const biosProgram = assemble(`org 100h
    mov ax, 1000h
    mov es, ax
    mov bx, 0200h
    mov cx, 0001h
    mov dx, 0080h
    mov ax, 0301h
    int 13h
    mov bx, 0400h
    mov ax, 0201h
    int 13h
    mov ax, 0800h
    mov dx, 0080h
    int 13h
    mov [0600h], ax
    mov [0602h], cx
    mov [0604h], dx
    mov ax, 1500h
    mov dx, 0080h
    int 13h
    mov [0606h], ax
    mov [0608h], cx
    mov [060ah], dx
    hlt`);
  const biosCpu = biosMachine.cpu;
  biosCpu.mem.fill(0x5a, 0x10200, 0x10400);
  biosCpu.mem.set(biosProgram.bytes, 0x10100);
  biosCpu.s[S.CS] = biosCpu.s[S.DS] = biosCpu.s[S.ES] = 0x1000;
  biosCpu.ip = biosProgram.origin;
  biosCpu.r[R.SP] = 0xfffe;
  for (let i = 0; i < 100 && !biosCpu.halted && !biosCpu.error; i++) biosCpu.step();
  check('BIOS INT 13h writes to hard disk drive 80h', biosMachine.hardDiskDirty
    && biosMachine.hardDisk.bytes.subarray(0, 512).every((value) => value === 0x5a), true);
  check('BIOS INT 13h reads hard disk sectors back', biosCpu.mem.subarray(0x10400, 0x10600)
    .every((value) => value === 0x5a), true);
  check('BIOS INT 13h AH=08 reports C: geometry', [
    biosCpu.rd16(0x10600), biosCpu.rd16(0x10602), biosCpu.rd16(0x10604),
  ].join(','), [0, 0x6691, 0x0301].join(','));
  check('BIOS INT 13h AH=15 reports a fixed disk', [
    biosCpu.rd16(0x10606), biosCpu.rd16(0x10608), biosCpu.rd16(0x1060a),
  ].join(','), [3, 0, 41820].join(','));

  const machine = new Machine();
  machine.bootFloppy(image);
  const cpu = machine.cpu;
  let steps = 0;
  let dateAccepted = false;
  let timeAccepted = false;
  let setupStage = 0;
  let consumedKeys = 0;
  let keyAfterDrain = null;
  let dirSent = false;
  let typeSent = false;
  let copySent = false;
  let readBackSent = false;
  let fdiskSent = false;
  let sawFdiskMenu = false;
  let fdiskScreen = '';
  let fdiskMenuStep = null;
  let markerCountBeforeReadBack = 0;
  let screen = [];
  let reachedPrompt = false;
  let sawInterpreter = false;
  let sawDirListing = false;
  let sawAutoexecContents = false;
  let sawTestFileReadBack = false;
  const scanCodes = {
    A: 0x1e, B: 0x30, C: 0x2e, D: 0x20, E: 0x12, F: 0x21, G: 0x22, H: 0x23,
    I: 0x17, J: 0x24, K: 0x25, L: 0x26, M: 0x32, N: 0x31, O: 0x18, P: 0x19,
    Q: 0x10, R: 0x13, S: 0x1f, T: 0x14, U: 0x16, V: 0x2f, W: 0x11, X: 0x2d,
    Y: 0x15, Z: 0x2c, '.': 0x34, ' ': 0x39,
    '0': 0x0b, '1': 0x02, '2': 0x03, '3': 0x04, '4': 0x05,
    '5': 0x06, '6': 0x07, '7': 0x08, '8': 0x09, '9': 0x0a,
  };
  const sendLine = (line) => {
    for (const character of line) {
      const scan = scanCodes[character.toUpperCase()];
      if (scan === undefined) throw new Error(`No keyboard scan code for ${character}`);
      machine.keyPress(character.charCodeAt(0), scan);
    }
    machine.keyPress(13, 0x1c);
  };
  const originalInput = cpu.onInput.bind(cpu);
  cpu.onInput = (peek) => {
    const value = originalInput(peek);
    if (value >= 0 && !peek) consumedKeys++;
    if (setupStage === 1 && consumedKeys >= 1 && peek && value < 0) keyAfterDrain = 'F3';
    if (setupStage === 3 && consumedKeys >= 3 && peek && value < 0) keyAfterDrain = 'Y';
    return value;
  };
  const readScreen = () => {
    const lines = [];
    const pageBase = VRAM + (cpu.mem[0x462] & 7) * 0x1000;
    for (let row = 0; row < ROWS; row++) {
      let line = '';
      for (let column = 0; column < COLS; column++) {
        const value = cpu.mem[pageBase + row * COLS * 2 + column * 2];
        line += value >= 32 && value < 127 ? String.fromCharCode(value) : ' ';
      }
      lines.push(line.trimEnd());
    }
    return lines;
  };

  while (!cpu.halted && !cpu.exited && !cpu.error && steps < 8_000_000) {
    cpu.step();
    steps++;
    if (keyAfterDrain === 'F3') {
      machine.keyPress(0, 0x3d);
      setupStage = 2;
      keyAfterDrain = null;
    } else if (keyAfterDrain === 'Y') {
      machine.keyPress('Y'.charCodeAt(0), 0x15);
      setupStage = 4;
      keyAfterDrain = null;
    }
    if (steps % 512 !== 0) continue;

    screen = readScreen();
    const text = screen.join('\n');
    const normalized = text.toUpperCase();
    if (text.includes('Microsoft(R) MS-DOS(R) Version 5.00')) sawInterpreter = true;
    if (text.includes('COMMAND  COM') && text.includes('AUTOEXEC BAT')) sawDirListing = true;
    if (normalized.includes('@ECHO OFF') && normalized.includes('KEYB US')) sawAutoexecContents = true;
    if (normalized.includes('FDISK OPTIONS')
      || normalized.includes('CREATE DOS PARTITION OR LOGICAL DOS DRIVE')) {
      sawFdiskMenu = true;
      fdiskScreen = text;
      fdiskMenuStep ??= steps;
    }
    if (!dateAccepted && text.includes('Enter new date')) {
      machine.keyPress(13, 0x1c);
      dateAccepted = true;
    }
    if (!timeAccepted && text.includes('Enter new time')) {
      machine.keyPress(13, 0x1c);
      timeAccepted = true;
    }
    if (setupStage === 0 && (text.includes('To exit and correct the problem, press F3.')
      || text.includes('F3=Exit'))) {
      machine.keyPress(0, 0x3d);
      setupStage = 1;
    } else if (setupStage === 2 && text.includes('EXITING SETUP') && text.includes('press Y.')) {
      machine.keyPress('Y'.charCodeAt(0), 0x15);
      setupStage = 3;
    }
    if (screen.some((line) => line.trim() === 'A>')) {
      reachedPrompt = true;
      if (!dirSent) {
        sendLine('DIR');
        dirSent = true;
      } else if (!typeSent && text.includes('COMMAND  COM') && text.includes('AUTOEXEC BAT')) {
        sendLine('TYPE AUTOEXEC.BAT');
        typeSent = true;
      } else if (!copySent && typeSent && normalized.includes('@ECHO OFF') && normalized.includes('KEYB US')) {
        sendLine('COPY CON TEST.TXT');
        sendLine('EMU8086 DISK WRITE OK');
        machine.keyPress(0x1a, 0x2c); // Ctrl+Z terminates COPY CON input.
        machine.keyPress(13, 0x1c);
        copySent = true;
      } else if (copySent && !readBackSent && machine.diskDirty) {
        markerCountBeforeReadBack = (normalized.match(/EMU8086 DISK WRITE OK/g) || []).length;
        sendLine('TYPE TEST.TXT');
        readBackSent = true;
      } else if (sawTestFileReadBack && !fdiskSent) {
        sendLine('FDISK');
        fdiskSent = true;
      }
    }
    const markerCount = (normalized.match(/EMU8086 DISK WRITE OK/g) || []).length;
    if (readBackSent && markerCount > markerCountBeforeReadBack && screen.some((line) => line.trim() === 'A>')) {
      sawTestFileReadBack = true;
    }
    if (fdiskMenuStep !== null && steps >= fdiskMenuStep + 200000) break;
  }

  check('msdos5 boot reaches command prompt', reachedPrompt && !cpu.error && !cpu.halted, true);
  check('msdos5 command interpreter starts', sawInterpreter, true);
  check('msdos5 DIR lists COMMAND.COM', sawDirListing && dirSent, true);
  check('msdos5 DIR lists AUTOEXEC.BAT', sawDirListing && dirSent, true);
  check('msdos5 TYPE reads AUTOEXEC.BAT', typeSent && sawAutoexecContents, true);
  check('msdos5 COPY CON writes TEST.TXT', copySent && machine.diskDirty
    && machine.floppyImage.some((value, index) => value !== originalImage[index]), true);
  check('msdos5 TYPE reads back TEST.TXT', readBackSent && sawTestFileReadBack, true);
  check('msdos5 BIOS exposes writable blank C: to FDISK', fdiskSent && sawFdiskMenu
    && !machine.hardDiskDirty, true);
  check('FDISK reaches its fixed-disk menu', fdiskScreen.includes('Fixed Disk Setup Program')
    && fdiskScreen.includes('FDISK Options')
    && fdiskScreen.includes('Current fixed disk drive: 1'), true);
  check('msdos5 disk writes do not mutate source asset', image.every((value, index) => value === originalImage[index]), true);
}

console.log(fail ? `\n${fail} failing` : '\nall green');
process.exit(fail ? 1 : 0);
