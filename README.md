# 8086 emulator (web)

An Intel 8086 emulator, assembler and debugger that runs entirely in the browser.
No backend: assemble DOS `.COM`-style programs in the editor and watch them execute
against a simulated 1 MiB address space and an 80×25 CGA text display.

```
npm run dev     # dev server on 0.0.0.0:8080
npm test        # CPU + assembler + disassembler smoke tests (node)
npm run build   # static production build into dist/
```

## Layout

| file | what it is |
| --- | --- |
| `src/cpu.js` | the CPU: ModR/M decoding, full flag semantics, ALU, string ops, interrupts |
| `src/asm.js` | two-pass (fixpoint) assembler with labels, `equ`, `db/dw`, `dup`, expressions |
| `src/disasm.js` | disassembler used by the debugger view |
| `src/machine.js` | CPU + text screen + keyboard + `.COM` loader (loads at `0100:0100`) |
| `src/samples.js` | the example programs in the dropdown |
| `src/main.js` | UI: editor, screen, registers/flags, disassembly, hex dump, run loop |

## Emulated

* All 8086 integer instructions: the ALU group, `mov`/`xchg`/`lea`/`les`/`lds`,
  `push`/`pop`, `inc`/`dec`, `mul`/`imul`/`div`/`idiv`, `neg`/`not`, shifts and
  rotates, `jmp`/`jcc`/`loop`/`jcxz`, `call`/`ret`/`retf`, `int`/`iret`,
  string ops (`movs`, `stos`, `lods`, `scas`, `cmps`) with `rep`/`repe`/`repne`,
  BCD helpers (`daa`, `das`, `aaa`, `aas`, `aam`, `aad`), flag ops, `xlat`, `hlt`.
* Segmented addressing with `es:`/`cs:`/`ss:`/`ds:` overrides, real 16-bit wrapping,
  and a real stack in `SS`.
* BIOS/DOS services used by ordinary `.COM` code: `INT 21h` AH=01/02/06/07/08/09/0Ah/2Ch/4Ch,
  `INT 10h` teletype, `INT 16h` keyboard, `INT 20h`. Anything else vectors through the IVT.
* Text video RAM at `B800:0000` — writing there directly works, colours included.

## Debugger

* **Step** (F10) executes one instruction; **Run**/**Pause** free-runs at a chosen
  speed (4 Hz … max).
* Click any disassembly row to set a breakpoint.
* Registers and flags highlight on change; the hex dump follows `CS:IP`, `SS:SP`
  or `B800`, or any address you type.
* Click the display to give it the keyboard — programs blocking on DOS input
  resume as soon as you type.

## Assembler syntax

NASM-ish, case-insensitive:

```asm
        org 100h              ; default origin for .COM
count   equ 10
start:  mov cx, count
        mov dx, msg
        mov word [buf+2], 1234h
        rep movsb
        jz  short start
msg:    db 'text', 0Dh, 0Ah, '$'
buf:    db 8 dup(0)
```

* numbers: `42`, `2Ah`, `0x2a`, `1010b`, `'A'`
* expressions with `+ - * / % & | ~ ( )` over labels and `equ` constants; `$` is the current address
* explicit sizes where needed: `mov byte [bx], 1`, `inc word [si]`
* local-ish labels such as `.loop` are ordinary labels (names may contain `.`)
* out-of-range `jcc` is auto-expanded into an inverted branch plus a near `jmp`;
  `shl ax, 3` (not an 8086 encoding) expands into repeated shift-by-1
