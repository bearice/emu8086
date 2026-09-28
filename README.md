# 8086 emulator (web)

An Intel 8086 emulator, assembler and debugger that runs entirely in the browser.
No backend: assemble DOS `.COM`-style programs in the editor and watch them execute
against a simulated 1 MiB address space and an 80×25 CGA text display.

The CPU interpreter is implemented in Rust and compiled to WebAssembly. The JavaScript
`Machine` remains responsible for loading `.COM` programs, keyboard input, and the text
screen; the assembler, disassembler, and debugger UI remain JavaScript modules.

Build requirements: Node.js/npm, Rust/Cargo, and the Rust target `wasm32v1-none`
(`rustup target add wasm32v1-none`). The dev, build, and test scripts compile the WASM
kernel automatically.

```
npm run dev     # dev server on 0.0.0.0:8080
npm test        # CPU + assembler + disassembler smoke tests (node)
npm run build   # static production build into dist/
```

## Layout

| file | what it is |
| --- | --- |
| `wasm/src/lib.rs` | Rust CPU kernel: ModR/M decoding, flag semantics, ALU, string ops, interrupts |
| `src/cpu.js` | JavaScript adapter for WASM registers, memory, stepping, and host I/O |
| `src/asm.js` | two-pass (fixpoint) assembler with labels, `equ`, `db/dw`, `dup`, expressions |
| `src/disasm.js` | disassembler used by the debugger view |
| `src/machine.js` | CPU + text screen + keyboard + PC BIOS + floppy/hard-disk host I/O |
| `src/disk.js` | Raw disk images, CHS geometry, bounded sector reads/writes |
| `src/samples.js` | the example programs in the dropdown |
| `src/main.js` | UI: editor, screen, registers/flags, disassembly, hex dump, run loop |
| `test/run.js` | Headless CPU, DOS command, and BIOS disk regression checks |

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

## Booting a floppy image

Choose **Boot MS-DOS 5.0** to start the bundled `msdos5.img` asset, or choose **Open floppy image**
to select another bootable raw image with a valid BIOS Parameter Block and `55AAh` boot signature.
The machine loads sector 0 at `0000:7C00`, supplies a PC-style BIOS Data Area and diskette
parameter table, and provides BIOS CHS disk read/write, video text, keyboard, memory-size, and
equipment services. The supplied MS-DOS 5.0 image is a 1.44 MB FAT12 floppy (80 cylinders,
2 heads, 18 sectors per track). A blank fixed disk is attached as drive `80h` (C:) using
615 cylinders, 4 heads, and 17 sectors per track (41,820 sectors; 21,411,840 bytes). DOS `FDISK`
is verified to reach its fixed-disk menu and report drive 1 with no partitions on a fresh disk.
MS-DOS Setup is also verified to create an active FAT16 partition, reboot, format C:, and
install the supplied disk's files. For a command-line startup, choose **Do not run MS-DOS Shell
on startup** in Setup. At the completion screen, choose **Eject floppy** and press Enter;
the machine restarts from the installed hard disk and reaches `C:\>`.

Use **Open hard disk image** to attach a raw image with exactly that size and geometry. Disk writes
stay in memory until **Save floppy image** or **Save hard disk image** downloads the changed image;
the bundled floppy asset is cloned before guest writes. Choose **Boot hard disk** to boot an
attached installed image directly. The headless checks cover C: directory listing, file writing,
read-back, and booting the saved image with the written file intact. In this boot mode, `INT 20h` and `INT 21h`
are dispatched through the guest's interrupt vector table so DOS provides those services itself.
The machine also models the PPI/keyboard status ports (`61h`/`64h`) and VGA retrace status ports
(`3BAh`/`3DAh`) used during this image's startup checks. Floppy and hard-disk data currently go
through BIOS services; FDC/DMA port emulation is not included.

Most BIOS software interrupts are currently dispatched directly by the Rust core before the
IVT lookup. The ROM entry stubs support calls that chain to the original BIOS, including the
default INT 15h keyboard-intercept handler and the warm-reset entry at `FFFF:0000`.
This is a synthetic BIOS; general guest hooks on intercepted BIOS interrupts are not fully
honored yet. BIOS disk services include CHS read/write and verify, geometry, and disk type;
verify checks image bounds without transferring data into guest memory.

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
