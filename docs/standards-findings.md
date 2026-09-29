# Standards suite status — 8086 CPU and IBM PC BIOS

Last reviewed: 2026-09-29

## Current result

The corrected black-box suites pass. Run `npm test` to rebuild the Rust/WASM core and then run the integration and standards suites. Running `node test/run.js` alone does not rebuild the kernel.

| Suite | Passed |
| --- | ---: |
| `cpu:alu` | 4,436 / 4,436 |
| `cpu:incdec` | 180 / 180 |
| `cpu:negnot` | 60 / 60 |
| `cpu:muldiv` | 974 / 974 |
| `cpu:shift` | 1,806 / 1,806 |
| `cpu:bcd` | 2,344 / 2,344 |
| `cpu:misc` | 58 / 58 |
| `bios:standard` | 86 / 86 |
| **Total** | **9,944 / 9,944** |

There are no confirmed failures in the currently tested scope. This replaces the stale counts and defect claims previously recorded in this document.

## Scope and test method

The CPU tests execute real 8086 instruction bytes. Divide-error checks install an INT 0 handler and verify that control reaches it with the architectural 6-byte FLAGS/CS/IP frame. BIOS checks call real interrupt vectors and inspect guest-visible registers, flags, memory, BDA, video memory, and attached disk images.

The emulator's video model is intentionally a fixed 80×25 text display. This suite covers that supported text mode and does not claim 40-column or graphics-mode emulation. The earlier assertion that INT 10h mode 0 must switch to a 40-column display was removed as out of scope.

The target CPU is the 8086:

- D0–D3 are the shift/rotate encodings. The 8086 consumes the full 8-bit CL count; the later 5-bit count mask is not applied.
- C0/C1 immediate-count shifts are later-processor instructions. C6/C7 encode MOV-immediate, not shifts.
- Count zero leaves the operand and flags unchanged.
- OF is asserted only for count one; the suite does not assign a required value to architecturally undefined OF for larger counts.
- Hardware-interrupt behavior is not inferred from a test that invokes a vector using the software INT instruction.

## Confirmed implementation defects fixed

- **IDIV quotient overflow:** byte and word signed division now raises INT 0 when the quotient cannot fit AL or AX. The regression includes the valid word case DX:AX = -32768 and divisor = -1.
- **8086 shift/rotate count:** the core previously masked CL to five bits. It now executes all eight count bits, including counts 32, 33, and 255. Long-count tests check defined rotate results/CF and defined shift results.
- **Single-bit shift OF:** the result now follows the documented operation-specific rule for ROL/RCL/SHL/SAL, ROR, RCR, SHR, and SAR. For counts above one, the core leaves OF unchanged rather than inventing a defined result.
- **INT 08h timer service:** it advances the BIOS tick counter and sets the midnight flag at the daily rollover.
- **INT 10h services:** AH=01 stores cursor shape, and AH=05 selects the active page from AL.
- **INT 16h/AH=02:** the shift-state byte is returned in AL from the BDA.
- **INT 15h/AH=88:** reports zero KiB of extended memory in the modeled 1 MiB machine.
- **INT 1Ah/AH=01:** sets the BDA tick count and clears the midnight flag.
- **INT 13h/AH=05:** formats a track from validated C/H/R/N descriptors using the diskette parameter table fill byte.
- **INT 13h/AH=15:** an absent drive returns AH=00h and CF=0 per the modeled AT BIOS behavior.

## Test assertions corrected

The prior report treated invalid tests as emulator defects. The suite now uses valid opcodes, registers, initial state, and BIOS arguments:

- Word memory DEC uses opcode FF /1; FE is the byte-width group.
- DIV r/m8 uses AX as its dividend; IDIV r/m8 uses signed AX. Word division uses DX:AX, with the divisor in the selected r/m register.
- Divide errors are detected through INT 0 and the saved interrupt frame, not by expecting the emulator's host-side error field to be set.
- Shift-immediate C6/C7 cases were removed because those bytes encode MOV on an 8086; the suite exercises D0–D3 instead.
- NOT flag tests now require all flags to remain unchanged. LAHF/PUSHF assertions ignore undefined/reserved bits, SAHF preserves TF, and AAA/AAS tests use valid unpacked decimal operands with flags produced by ADD/SUB.
- BIOS register conventions were corrected: INT 10h/AH=09 uses BH for page and BL for attribute; AH=05 takes the page from AL; INT 16h/AH=02 returns shift state in AL.
- BIOS tests use the 4 KiB VRAM page stride, seed cells before checking no-write behavior, and account for the actual rows moved during teletype scrolling.
- INT 1Ah/AH=01 checks the full CX:DX tick value. INT 13h/AH=05 supplies a mounted writable floppy and valid C/H/R/N format descriptors.
- The old INT 19h stack-pointer requirement was removed because the interface does not specify that value. The query-style INT 15h/AH=4F assertion was removed: AH=4F is a keyboard scan-code hook called from INT 09h, and its carry flag describes handling of that scan code rather than feature support.
- Standalone `test/probe-*.mjs` diagnostics remain outside `npm test`; their effective-address fields, BP default segment, byte/word opcode widths, and saved-flags observations were corrected to match the encoded instructions.

## References

- [Intel 8086 Family User's Manual, October 1979](https://www.inf.pucrs.br/~calazans/undergrad/orgcomp_EC/mat_microproc/intel-8086_family_Users_Manual.pdf)
- [Intel Software Developer's Manual, Volume 2](https://cdrdv2-public.intel.com/868137/325462-089-sdm-vol-1-2abcd-3abcd-4.pdf) — documents that 8086 shift and rotate counts are not masked, while 286 and later processors mask to five bits.
- [Phoenix System BIOS for IBM PC/XT/AT Computers and Compatibles](https://www.vtda.org/books/Computing/Programming/SystemBIOSforIBMPC_XT_ATComputersandCompatibles_Phoenix.pdf)
- [IBM PC/AT Technical Reference, March 1986](https://bitsavers.org/pdf/ibm/pc/at/6183355_PC_AT_Technical_Reference_Mar86.pdf) — describes INT 15h/AH=4Fh as the INT 09h keyboard scan-code hook and defines CF as the per-scan-code continuation/ignore result.
