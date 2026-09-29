// Synthetic PC BIOS ROM. INT always enters through the guest-visible IVT.
export const BIOS_SEG = 0xf000;
export const BIOS_DPT_OFFSET = 0x0200;
export const BIOS_RESET_VECTOR_ADDR = 0xffff0;
export const KEYBOARD_CONTROLLER_COMMAND_PORT = 0x64;
export const KEYBOARD_CONTROLLER_RESET_COMMAND = 0xfe;
export const FIRMWARE_TRAP = 0xf1;
export const SERVICE_STUB_BASE = 0x0100;
export const SERVICE_STUB_BYTES = 4;
const DEFAULT_HANDLER_OFFSET = SERVICE_STUB_BASE;
const IVT_ENTRIES = 256;
const IVT_ENTRY_BYTES = 4;
const BIOS_VECTORS = [0x08, 0x10, 0x11, 0x12, 0x13, 0x14, 0x15, 0x16, 0x17, 0x19, 0x1a];
const DOS_COMPAT_VECTORS = [0x20, 0x21];

export function serviceStubOffset(vector) {
  return SERVICE_STUB_BASE + vector * SERVICE_STUB_BYTES;
}

export function isFirmwareTrapAddress(address, vector) {
  return (BIOS_VECTORS.includes(vector) || DOS_COMPAT_VECTORS.includes(vector))
    && address === (BIOS_SEG << 4) + serviceStubOffset(vector);
}

export function installFirmwareVectors(cpu, { dosCompat = false } = {}) {
  const romBase = BIOS_SEG << 4;
  cpu.mem[romBase + DEFAULT_HANDLER_OFFSET] = 0xcf; // Default IRET handler.
  for (let vector = 0; vector < IVT_ENTRIES; vector++) {
    cpu.wr16(vector * IVT_ENTRY_BYTES, DEFAULT_HANDLER_OFFSET);
    cpu.wr16(vector * IVT_ENTRY_BYTES + 2, BIOS_SEG);
  }
  const vectors = dosCompat ? [...BIOS_VECTORS, ...DOS_COMPAT_VECTORS] : BIOS_VECTORS;
  for (const vector of vectors) {
    const offset = serviceStubOffset(vector);
    cpu.mem.set([FIRMWARE_TRAP, vector, 0xcf, 0x90], romBase + offset); // Trap; IRET; NOP.
    cpu.wr16(vector * IVT_ENTRY_BYTES, offset);
    cpu.wr16(vector * IVT_ENTRY_BYTES + 2, BIOS_SEG);
  }
  cpu.mem.set([
    0xb0, KEYBOARD_CONTROLLER_RESET_COMMAND, // MOV AL, FEh
    0xe6, KEYBOARD_CONTROLLER_COMMAND_PORT,  // OUT 64h, AL
    0xf4,                                 // HLT if no Machine handles the reset.
  ], BIOS_RESET_VECTOR_ADDR);
}
