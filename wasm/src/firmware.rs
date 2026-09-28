use crate::{
    bios::*,
    constants::*,
    core::Core,
    dos_compat::*,
    opcodes::{OP_FIRMWARE_TRAP, OP_IRET},
};

// Shared ROM layout with src/firmware.js. F1 <vector> is a synthetic BIOS
// trap, accepted only at that service's ROM entry; it is not a guest opcode.
const BIOS_ROM_SEGMENT: u16 = 0xf000;
const SERVICE_STUB_BASE: u16 = 0x0100;
const SERVICE_STUB_BYTES: u16 = 4;
const INTERRUPT_FRAME_FLAGS_OFFSET: u16 = 4;
const BIOS_FUNCTION_UNSUPPORTED_STATUS: u16 = 0x8600;
const KEYBOARD_CHECK: u8 = 0x01;
const KEYBOARD_CHECK_EXTENDED: u8 = 0x11;
const DOS_DIRECT_CONSOLE_IO: u8 = 0x06;

impl Core {
    pub(crate) fn firmware_trap(&mut self) {
        let vector = self.fetch8();
        let expected = Self::phys(
            BIOS_ROM_SEGMENT,
            SERVICE_STUB_BASE + vector as u16 * SERVICE_STUB_BYTES,
        );
        let is_bios = matches!(
            vector,
            INT_BIOS_VIDEO
                | INT_BIOS_EQUIPMENT
                | INT_BIOS_MEMORY_SIZE
                | INT_BIOS_DISK
                | INT_BIOS_SERIAL
                | INT_BIOS_SYSTEM
                | INT_BIOS_KEYBOARD
                | INT_BIOS_PARALLEL
                | INT_BIOS_BOOTSTRAP
                | INT_BIOS_TIME
        );
        let is_dos =
            matches!(vector, INT_DOS_TERMINATE | INT_DOS_SERVICES) && self.dos_compat_mode != 0;
        if Self::phys(self.s[CS], self.rep_start) != expected
            || self.rd8(expected) != OP_FIRMWARE_TRAP
            || self.rd8(expected + 1) != vector
            || self.rd8(expected + 2) != OP_IRET
            || self.rd_seg8(self.s[CS], self.ip) != OP_IRET
            || (!is_bios && !is_dos)
        {
            self.ip = self.rep_start;
            self.set_invalid_opcode(OP_FIRMWARE_TRAP);
            return;
        }

        let function = (self.r[AX] >> BYTE_BITS) as u8;
        let return_flags = match vector {
            INT_BIOS_DISK | INT_BIOS_SYSTEM | INT_BIOS_TIME => CF,
            INT_BIOS_KEYBOARD if matches!(function, KEYBOARD_CHECK | KEYBOARD_CHECK_EXTENDED) => ZF,
            INT_DOS_SERVICES if function == DOS_DIRECT_CONSOLE_IO && self.r[DX] as u8 == 0xff => ZF,
            _ => 0,
        };
        let flags_address = Self::phys(
            self.s[SS],
            self.r[SP].wrapping_add(INTERRUPT_FRAME_FLAGS_OFFSET),
        );
        let saved_flags = self.rd16(flags_address);
        let handled = if is_bios {
            self.bios_service(vector)
        } else {
            self.dos_compat_service(vector)
        };
        if !handled {
            self.r[AX] =
                BIOS_FUNCTION_UNSUPPORTED_STATUS | (self.r[AX] & ACCUMULATOR_LOW_BYTE_MASK);
            self.set_flag(CF, true);
        }
        // Blocking calls retry this trap with the existing frame. INT 19h
        // transfers to the boot sector, and DOS termination never returns.
        if self.waiting != 0 || self.halted != 0 || vector == INT_BIOS_BOOTSTRAP {
            return;
        }
        // The stub executes a real IRET next. Preserve the caller's IF/TF/DF
        // and other flags while copying the BIOS/DOS service's result flags.
        self.wr16(
            flags_address,
            (saved_flags & !return_flags) | (self.flags & return_flags),
        );
    }
}
