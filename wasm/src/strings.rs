use crate::{constants::*, core::Core, opcodes::*};

impl Core {
    pub(crate) fn str_src(&self) -> u16 {
        if self.seg_override < 0 {
            self.s[DS]
        } else {
            self.seg_override as u16
        }
    }

    pub(crate) fn string_op(&mut self, op: u8, rep: u8) {
        let wide = op & OPCODE_WIDTH_BIT != 0;
        let delta: i32 =
            (if self.flag(DF) { -1 } else { 1 }) * if wide { STACK_SLOT_BYTES as i32 } else { 1 };
        let src = self.str_src();
        match op & OPCODE_STRING_BYTE_WORD_MASK {
            OP_MOVS_BYTE => {
                let v = if wide {
                    self.rd16(Self::phys(src, self.r[SI]))
                } else {
                    self.rd8(Self::phys(src, self.r[SI])) as u16
                };
                if wide {
                    self.wr16(Self::phys(self.s[ES], self.r[DI]), v);
                } else {
                    self.wr8(Self::phys(self.s[ES], self.r[DI]), v as u8);
                }
                self.r[SI] = self.r[SI].wrapping_add(delta as u16);
                self.r[DI] = self.r[DI].wrapping_add(delta as u16);
            }
            OP_CMPS_BYTE => {
                let a = if wide {
                    self.rd16(Self::phys(src, self.r[SI]))
                } else {
                    self.rd8(Self::phys(src, self.r[SI])) as u16
                };
                let b = if wide {
                    self.rd16(Self::phys(self.s[ES], self.r[DI]))
                } else {
                    self.rd8(Self::phys(self.s[ES], self.r[DI])) as u16
                };
                self.alu(ALU_CMP, a, b, wide, false);
                self.r[SI] = self.r[SI].wrapping_add(delta as u16);
                self.r[DI] = self.r[DI].wrapping_add(delta as u16);
            }
            OP_STOS_BYTE => {
                let value = self.r[AX];
                if wide {
                    self.wr16(Self::phys(self.s[ES], self.r[DI]), value);
                } else {
                    self.wr8(Self::phys(self.s[ES], self.r[DI]), value as u8);
                }
                self.r[DI] = self.r[DI].wrapping_add(delta as u16);
            }
            OP_LODS_BYTE => {
                if wide {
                    self.r[AX] = self.rd16(Self::phys(src, self.r[SI]));
                } else {
                    let v = self.rd8(Self::phys(src, self.r[SI]));
                    self.set_r8(AL_BYTE_INDEX, v);
                }
                self.r[SI] = self.r[SI].wrapping_add(delta as u16);
            }
            OP_SCAS_BYTE => {
                let b = if wide {
                    self.rd16(Self::phys(self.s[ES], self.r[DI]))
                } else {
                    self.rd8(Self::phys(self.s[ES], self.r[DI])) as u16
                };
                self.alu(
                    ALU_CMP,
                    if wide {
                        self.r[AX]
                    } else {
                        self.r[AX] & BYTE_MASK
                    },
                    b,
                    wide,
                    false,
                );
                self.r[DI] = self.r[DI].wrapping_add(delta as u16);
            }
            _ => (),
        }
        if rep == 0 {
            return;
        }
        if self.r[CX] == 0 {
            return;
        }
        self.r[CX] = self.r[CX].wrapping_sub(1);
        let is_cmp = (op & OPCODE_STRING_BYTE_WORD_MASK) == OP_CMPS_BYTE
            || (op & OPCODE_STRING_BYTE_WORD_MASK) == OP_SCAS_BYTE;
        let mut again = self.r[CX] != 0;
        if is_cmp {
            again = again
                && if rep == 1 {
                    self.flag(ZF)
                } else {
                    !self.flag(ZF)
                };
        }
        if again {
            self.ip = self.rep_start;
        }
    }
}
