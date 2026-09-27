use crate::constants::*;

#[derive(Clone, Copy)]
pub(crate) struct ModRm {
    pub(crate) reg: u8,
    pub(crate) rm: u8,
    pub(crate) is_reg: bool,
    pub(crate) seg: u16,
    pub(crate) off: u16,
    pub(crate) addr: u32,
}

pub(crate) struct Core {
    pub(crate) mem: [u8; MEMORY_BYTES],
    pub(crate) r: [u16; REGISTER_COUNT],
    pub(crate) s: [u16; SEGMENT_REGISTER_COUNT],
    pub(crate) ip: u16,
    pub(crate) flags: u16,
    pub(crate) halted: u32,
    pub(crate) invalid_opcode: u32,
    pub(crate) exited: u32,
    pub(crate) waiting: u32,
    pub(crate) exit_code: u32,
    pub(crate) cycles: u32,
    pub(crate) last_run_count: u32,
    pub(crate) seg_override: i32,
    pub(crate) rep_start: u16,
    pub(crate) error: [u8; ERROR_BUFFER_BYTES],
    pub(crate) error_len: u32,
    pub(crate) line_buf: [u8; INPUT_LINE_BUFFER_BYTES],
    pub(crate) line_len: u32,
    pub(crate) breakpoints: [u8; BREAKPOINT_BYTES],
    pub(crate) output: [i16; OUTPUT_CAPACITY],
    pub(crate) output_len: u32,
}

impl Core {
    pub(crate) const fn new() -> Self {
        Self {
            mem: [0; MEMORY_BYTES],
            r: [0; REGISTER_COUNT],
            s: [0; SEGMENT_REGISTER_COUNT],
            ip: 0,
            flags: IF,
            halted: 0,
            invalid_opcode: 0,
            exited: 0,
            waiting: 0,
            exit_code: 0,
            cycles: 0,
            last_run_count: 0,
            seg_override: SEGMENT_OVERRIDE_NONE,
            rep_start: 0,
            error: [0; ERROR_BUFFER_BYTES],
            error_len: 0,
            line_buf: [0; INPUT_LINE_BUFFER_BYTES],
            line_len: 0,
            breakpoints: [0; BREAKPOINT_BYTES],
            output: [0; OUTPUT_CAPACITY],
            output_len: 0,
        }
    }
}

impl Core {
    pub(crate) fn reset(&mut self) {
        self.r = [0; REGISTER_COUNT];
        self.s = [0; SEGMENT_REGISTER_COUNT];
        self.ip = 0;
        self.flags = IF;
        self.halted = 0;
        self.invalid_opcode = 0;
        self.exited = 0;
        self.waiting = 0;
        self.exit_code = 0;
        self.cycles = 0;
        self.last_run_count = 0;
        self.seg_override = SEGMENT_OVERRIDE_NONE;
        self.rep_start = 0;
        self.error_len = 0;
        self.line_len = 0;
        self.output_len = 0;
    }

    pub(crate) fn phys(seg: u16, off: u16) -> u32 {
        (((seg as u32) << SEGMENT_SHIFT) + off as u32) & PHYSICAL_ADDRESS_MASK
    }

    pub(crate) fn rd8(&self, addr: u32) -> u8 {
        self.mem[(addr as usize) & PHYSICAL_ADDRESS_MASK as usize]
    }

    pub(crate) fn wr8(&mut self, addr: u32, value: u8) {
        self.mem[(addr as usize) & PHYSICAL_ADDRESS_MASK as usize] = value;
    }

    pub(crate) fn rd16(&self, addr: u32) -> u16 {
        let lo = self.rd8(addr) as u16;
        let hi = self.rd8(addr.wrapping_add(1)) as u16;
        lo | (hi << LITTLE_ENDIAN_HIGH_BYTE_SHIFT)
    }

    pub(crate) fn wr16(&mut self, addr: u32, value: u16) {
        self.wr8(addr, value as u8);
        self.wr8(
            addr.wrapping_add(1),
            (value >> LITTLE_ENDIAN_HIGH_BYTE_SHIFT) as u8,
        );
    }

    pub(crate) fn rd_seg8(&self, seg: u16, off: u16) -> u8 {
        self.rd8(Self::phys(seg, off))
    }

    pub(crate) fn rd_seg16(&self, seg: u16, off: u16) -> u16 {
        self.rd16(Self::phys(seg, off))
    }

    pub(crate) fn get_r8(&self, i: u8) -> u8 {
        let i = i as usize;
        if i < BYTE_REGISTER_COUNT {
            self.r[i] as u8
        } else {
            (self.r[i - BYTE_REGISTER_HIGH_OFFSET] >> LITTLE_ENDIAN_HIGH_BYTE_SHIFT) as u8
        }
    }

    pub(crate) fn set_r8(&mut self, i: u8, value: u8) {
        let i = i as usize;
        if i < 4 {
            self.r[i] = (self.r[i] & BYTE_HIGH_MASK) | value as u16;
        } else {
            let reg = i - BYTE_REGISTER_HIGH_OFFSET;
            self.r[reg] =
                (self.r[reg] & BYTE_MASK) | ((value as u16) << LITTLE_ENDIAN_HIGH_BYTE_SHIFT);
        }
    }

    pub(crate) fn flag(&self, mask: u16) -> bool {
        self.flags & mask != 0
    }

    pub(crate) fn set_flag(&mut self, mask: u16, set: bool) {
        if set {
            self.flags |= mask;
        } else {
            self.flags &= !mask;
        }
    }

    pub(crate) fn get_flags(&self) -> u16 {
        self.flags | FLAGS_RESERVED_ONE
    }

    pub(crate) fn set_flags(&mut self, value: u16) {
        self.flags = value & FLAGS_MASK;
    }

    pub(crate) fn fetch8(&mut self) -> u8 {
        let value = self.rd_seg8(self.s[CS], self.ip);
        self.ip = self.ip.wrapping_add(1);
        value
    }

    pub(crate) fn fetch16(&mut self) -> u16 {
        let value = self.rd_seg16(self.s[CS], self.ip);
        self.ip = self.ip.wrapping_add(STACK_SLOT_BYTES);
        value
    }

    pub(crate) fn fetch_s8(&mut self) -> i32 {
        self.fetch8() as i8 as i32
    }

    pub(crate) fn push(&mut self, value: u16) {
        self.r[SP] = self.r[SP].wrapping_sub(STACK_SLOT_BYTES);
        self.wr16(Self::phys(self.s[SS], self.r[SP]), value);
    }

    pub(crate) fn pop(&mut self) -> u16 {
        let value = self.rd16(Self::phys(self.s[SS], self.r[SP]));
        self.r[SP] = self.r[SP].wrapping_add(STACK_SLOT_BYTES);
        value
    }

    pub(crate) fn modrm(&mut self) -> ModRm {
        let b = self.fetch8();
        let mod_ = b >> MODRM_MODE_SHIFT;
        let reg = (b >> MODRM_REG_SHIFT) & MODRM_REG_MASK;
        let rm = b & MODRM_RM_MASK;
        let mut m = ModRm {
            reg,
            rm,
            is_reg: mod_ == MODRM_REGISTER_MODE,
            seg: 0,
            off: 0,
            addr: 0,
        };
        if m.is_reg {
            return m;
        }

        let mut def_seg = DS;
        let mut base = match rm {
            RM_BX_SI => self.r[BX] as i32 + self.r[SI] as i32,
            RM_BX_DI => self.r[BX] as i32 + self.r[DI] as i32,
            RM_BP_SI => {
                def_seg = SS;
                self.r[BP] as i32 + self.r[SI] as i32
            }
            RM_BP_DI => {
                def_seg = SS;
                self.r[BP] as i32 + self.r[DI] as i32
            }
            RM_SI => self.r[SI] as i32,
            RM_DI => self.r[DI] as i32,
            RM_BP_OR_DIRECT_ADDRESS if mod_ == 0 => self.fetch16() as i32,
            RM_BP_OR_DIRECT_ADDRESS => {
                def_seg = SS;
                self.r[BP] as i32
            }
            // The remaining r/m selector addresses BX.
            _ => self.r[BX] as i32,
        };
        if mod_ == MODRM_DISP8_MODE {
            base += self.fetch_s8();
        } else if mod_ == MODRM_DISP16_MODE {
            base += self.fetch16() as i32;
        }
        m.off = base as u16;
        m.seg = if self.seg_override == SEGMENT_OVERRIDE_NONE {
            self.s[def_seg]
        } else {
            self.seg_override as u16
        };
        m.addr = Self::phys(m.seg, m.off);
        m
    }

    pub(crate) fn read_rm8(&self, m: ModRm) -> u8 {
        if m.is_reg {
            self.get_r8(m.rm)
        } else {
            self.rd8(m.addr)
        }
    }

    pub(crate) fn read_rm16(&self, m: ModRm) -> u16 {
        if m.is_reg {
            self.r[m.rm as usize]
        } else {
            self.rd16(m.addr)
        }
    }

    pub(crate) fn write_rm8(&mut self, m: ModRm, value: u8) {
        if m.is_reg {
            self.set_r8(m.rm, value);
        } else {
            self.wr8(m.addr, value);
        }
    }

    pub(crate) fn write_rm16(&mut self, m: ModRm, value: u16) {
        if m.is_reg {
            self.r[m.rm as usize] = value;
        } else {
            self.wr16(m.addr, value);
        }
    }

    pub(crate) fn output(&mut self, value: i16) {
        let i = self.output_len as usize;
        if i < OUTPUT_CAPACITY {
            self.output[i] = value;
            self.output_len += 1;
        }
    }

    pub(crate) fn push_error_text(&mut self, offset: &mut usize, text: &[u8]) {
        for &b in text {
            if *offset < self.error.len() {
                self.error[*offset] = b;
                *offset += 1;
            }
        }
    }

    pub(crate) fn push_error_hex(&mut self, offset: &mut usize, value: u16, digits: usize) {
        let hex = b"0123456789ABCDEF";
        for shift in (0..digits).rev() {
            if *offset < self.error.len() {
                self.error[*offset] =
                    hex[((value >> (shift * HEX_NIBBLE_BITS as usize)) & HEX_NIBBLE_MASK) as usize];
                *offset += 1;
            }
        }
    }

    pub(crate) fn set_unhandled_int(&mut self, n: u8) {
        let mut i = 0;
        self.push_error_text(&mut i, b"unhandled INT ");
        if n >= 1 << HEX_NIBBLE_BITS {
            self.push_error_hex(&mut i, n as u16, 2);
        } else {
            self.push_error_hex(&mut i, n as u16, 1);
        }
        self.push_error_text(&mut i, b"h");
        self.error_len = i as u32;
    }

    pub(crate) fn set_invalid_opcode(&mut self, op: u8) {
        let mut i = 0;
        self.push_error_text(&mut i, b"invalid opcode ");
        self.push_error_hex(&mut i, op as u16, 2);
        self.push_error_text(&mut i, b"h at ");
        self.push_error_hex(&mut i, self.s[CS], HEX_DIGITS_PER_WORD);
        self.push_error_text(&mut i, b":");
        self.push_error_hex(&mut i, self.ip, HEX_DIGITS_PER_WORD);
        self.error_len = i as u32;
        self.halted = 1;
        self.invalid_opcode = 1;
    }
}
