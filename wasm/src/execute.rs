use crate::{constants::*, core::Core, opcodes::*};

impl Core {
    pub(crate) fn step(&mut self) -> bool {
        if self.halted != 0 {
            return false;
        }
        self.seg_override = SEGMENT_OVERRIDE_NONE;
        self.waiting = 0;
        let mut rep = REP_PREFIX_NONE;
        let start_ip = self.ip;
        let op = loop {
            let op = self.fetch8();
            match op {
                OP_PREFIX_ES => {
                    self.seg_override = self.s[ES] as i32;
                }
                OP_PREFIX_CS => {
                    self.seg_override = self.s[CS] as i32;
                }
                OP_PREFIX_SS => {
                    self.seg_override = self.s[SS] as i32;
                }
                OP_PREFIX_DS => {
                    self.seg_override = self.s[DS] as i32;
                }
                OP_PREFIX_REPNE => rep = REP_PREFIX_NOT_EQUAL,
                OP_PREFIX_REP => rep = REP_PREFIX_EQUAL,
                OP_PREFIX_LOCK => (),
                _ => break op,
            }
        };
        self.rep_start = start_ip;
        self.exec(op, rep);
        if self.invalid_opcode != 0 {
            self.invalid_opcode = 0;
            return false;
        }
        self.cycles = self.cycles.wrapping_add(1);
        if self.waiting != 0 {
            self.ip = start_ip;
        }
        self.halted == 0
    }

    pub(crate) fn exec(&mut self, op: u8, rep: u8) {
        if op < OP_ALU_REGISTER_IMMEDIATE_LIMIT && op & OPCODE_REGISTER_INDEX_MASK < ALU_FORM_COUNT
        {
            let aluop = (op >> OPCODE_ALU_OPERATION_SHIFT) & ALU_SELECTOR_MASK;
            let form = op & OPCODE_REGISTER_INDEX_MASK;
            let wide = form & OPCODE_WIDTH_BIT != 0;
            if form < ALU_FORM_RM_REGISTER_LIMIT {
                let m = self.modrm();
                let carry = self.flag(CF);
                if wide {
                    let result = self.alu(
                        aluop,
                        self.read_rm16(m),
                        self.r[m.reg as usize],
                        true,
                        carry,
                    );
                    if aluop != ALU_CMP {
                        self.write_rm16(m, result);
                    }
                } else {
                    let result = self.alu(
                        aluop,
                        self.read_rm8(m) as u16,
                        self.get_r8(m.reg) as u16,
                        false,
                        carry,
                    );
                    if aluop != ALU_CMP {
                        self.write_rm8(m, result as u8);
                    }
                }
            } else if form < ALU_FORM_REGISTER_RM_LIMIT {
                let m = self.modrm();
                let carry = self.flag(CF);
                if wide {
                    let result = self.alu(
                        aluop,
                        self.r[m.reg as usize],
                        self.read_rm16(m),
                        true,
                        carry,
                    );
                    if aluop != ALU_CMP {
                        self.r[m.reg as usize] = result;
                    }
                } else {
                    let result = self.alu(
                        aluop,
                        self.get_r8(m.reg) as u16,
                        self.read_rm8(m) as u16,
                        false,
                        carry,
                    );
                    if aluop != ALU_CMP {
                        self.set_r8(m.reg, result as u8);
                    }
                }
            } else if wide {
                let b = self.fetch16();
                let carry = self.flag(CF);
                let result = self.alu(aluop, self.r[AX], b, true, carry);
                if aluop != ALU_CMP {
                    self.r[AX] = result;
                }
            } else {
                let b = self.fetch8() as u16;
                let carry = self.flag(CF);
                let result = self.alu(aluop, self.r[AX] & BYTE_MASK, b, false, carry);
                if aluop != ALU_CMP {
                    self.set_r8(AL_BYTE_INDEX, result as u8);
                }
            }
            return;
        }

        match op {
            OP_PUSH_ES => self.push(self.s[ES]),
            OP_POP_ES => self.s[ES] = self.pop(),
            OP_PUSH_CS => self.push(self.s[CS]),
            OP_POP_CS => self.s[CS] = self.pop(),
            OP_PUSH_SS => self.push(self.s[SS]),
            OP_POP_SS => self.s[SS] = self.pop(),
            OP_PUSH_DS => self.push(self.s[DS]),
            OP_POP_DS => self.s[DS] = self.pop(),

            OP_DAA => {
                let al = self.r[AX] as u8;
                let mut v = al;
                if al & LOW_NIBBLE_MASK > BCD_LOW_DIGIT_MAX || self.flag(AF) {
                    v = v.wrapping_add(BCD_ADJUST_LOW_BYTE);
                    self.set_flag(AF, true);
                } else {
                    self.set_flag(AF, false);
                }
                if al > BCD_AL_HIGH_ADJUST_THRESHOLD || self.flag(CF) {
                    v = v.wrapping_add(BCD_ADJUST_HIGH);
                    self.set_flag(CF, true);
                } else {
                    self.set_flag(CF, false);
                }
                self.set_r8(AL_BYTE_INDEX, v);
                self.szp8(v);
            }
            OP_DAS => {
                let al = self.r[AX] as u8;
                let mut v = al;
                if al & LOW_NIBBLE_MASK > BCD_LOW_DIGIT_MAX || self.flag(AF) {
                    v = v.wrapping_sub(BCD_ADJUST_LOW_BYTE);
                    self.set_flag(AF, true);
                } else {
                    self.set_flag(AF, false);
                }
                if al > BCD_AL_HIGH_ADJUST_THRESHOLD || self.flag(CF) {
                    v = v.wrapping_sub(BCD_ADJUST_HIGH);
                    self.set_flag(CF, true);
                } else {
                    self.set_flag(CF, false);
                }
                self.set_r8(AL_BYTE_INDEX, v);
                self.szp8(v);
            }
            OP_AAA => {
                if (self.r[AX] & BCD_LOW_NIBBLE_MASK) > BCD_LOW_DIGIT_MAX_WORD || self.flag(AF) {
                    self.r[AX] = self.r[AX].wrapping_add(BCD_ADJUST_WORD);
                    self.set_flag(AF, true);
                    self.set_flag(CF, true);
                } else {
                    self.set_flag(AF, false);
                    self.set_flag(CF, false);
                }
                self.r[AX] &= BCD_ADJUST_AX_MASK;
            }
            OP_AAS => {
                if (self.r[AX] & BCD_LOW_NIBBLE_MASK) > BCD_LOW_DIGIT_MAX_WORD || self.flag(AF) {
                    self.r[AX] = self.r[AX].wrapping_sub(BCD_ADJUST_LOW_WORD);
                    let ah = self.get_r8(AH_BYTE_INDEX).wrapping_sub(1);
                    self.r[AX] =
                        (self.r[AX] & BYTE_MASK) | ((ah as u16) << LITTLE_ENDIAN_HIGH_BYTE_SHIFT);
                    self.set_flag(AF, true);
                    self.set_flag(CF, true);
                } else {
                    self.set_flag(AF, false);
                    self.set_flag(CF, false);
                }
                self.r[AX] &= BCD_ADJUST_AX_MASK;
            }
            OP_AAM => {
                let base = self.fetch8();
                let base = if base == 0 {
                    DEFAULT_DECIMAL_BASE
                } else {
                    base
                };
                let al = self.r[AX] as u8;
                self.r[AX] =
                    (((al / base) as u16) << LITTLE_ENDIAN_HIGH_BYTE_SHIFT) | (al % base) as u16;
                self.szp8(self.r[AX] as u8);
            }
            OP_AAD => {
                let base = self.fetch8();
                let base = if base == 0 {
                    DEFAULT_DECIMAL_BASE
                } else {
                    base
                };
                let al = (self.r[AX] as u8).wrapping_add(
                    ((self.r[AX] >> LITTLE_ENDIAN_HIGH_BYTE_SHIFT) as u8).wrapping_mul(base),
                );
                self.r[AX] = al as u16;
                self.szp8(al);
            }

            OP_TEST_RM8_REG8 => {
                let m = self.modrm();
                self.alu(
                    4,
                    self.read_rm8(m) as u16,
                    self.get_r8(m.reg) as u16,
                    false,
                    false,
                );
            }
            OP_TEST_RM16_REG16 => {
                let m = self.modrm();
                self.alu(
                    ALU_AND,
                    self.read_rm16(m),
                    self.r[m.reg as usize],
                    true,
                    false,
                );
            }
            OP_XCHG_RM8_REG8 => {
                let m = self.modrm();
                let a = self.read_rm8(m);
                let b = self.get_r8(m.reg);
                self.write_rm8(m, b);
                self.set_r8(m.reg, a);
            }
            OP_XCHG_RM16_REG16 => {
                let m = self.modrm();
                let a = self.read_rm16(m);
                let b = self.r[m.reg as usize];
                self.write_rm16(m, b);
                self.r[m.reg as usize] = a;
            }
            OP_MOV_RM8_REG8 => {
                let m = self.modrm();
                self.write_rm8(m, self.get_r8(m.reg));
            }
            OP_MOV_RM16_REG16 => {
                let m = self.modrm();
                self.write_rm16(m, self.r[m.reg as usize]);
            }
            OP_MOV_REG8_RM8 => {
                let m = self.modrm();
                let v = self.read_rm8(m);
                self.set_r8(m.reg, v);
            }
            OP_MOV_REG16_RM16 => {
                let m = self.modrm();
                self.r[m.reg as usize] = self.read_rm16(m);
            }
            OP_MOV_RM16_SEG => {
                let m = self.modrm();
                self.write_rm16(m, self.s[(m.reg & SEGMENT_REGISTER_INDEX_MASK) as usize]);
            }
            OP_LEA => {
                let m = self.modrm();
                self.r[m.reg as usize] = m.off;
            }
            OP_MOV_SEG_RM16 => {
                let m = self.modrm();
                let v = self.read_rm16(m);
                self.s[(m.reg & SEGMENT_REGISTER_INDEX_MASK) as usize] = v;
            }
            OP_POP_RM16 => {
                let m = self.modrm();
                let v = self.pop();
                self.write_rm16(m, v);
            }

            OP_CBW => {
                let al = self.r[AX] as u8;
                self.r[AX] = (al as i8 as i16) as u16;
            }
            OP_CWD => {
                self.r[DX] = if self.r[AX] & WORD_SIGN_BIT != 0 {
                    WORD_MASK
                } else {
                    0
                }
            }
            OP_CALL_FAR_IMMEDIATE => {
                let off = self.fetch16();
                let seg = self.fetch16();
                self.push(self.s[CS]);
                self.push(self.ip);
                self.s[CS] = seg;
                self.ip = off;
            }
            OP_WAIT => (),
            OP_PUSHF => self.push(self.get_flags()),
            OP_POPF => {
                let f = self.pop();
                self.set_flags(f);
            }
            OP_SAHF => {
                let ah = self.get_r8(AH_BYTE_INDEX);
                self.set_flag(SF, ah & SAHF_SIGN_MASK != 0);
                self.set_flag(ZF, ah & SAHF_ZERO_MASK != 0);
                self.set_flag(AF, ah & SAHF_AUXILIARY_CARRY_MASK != 0);
                self.set_flag(PF, ah & SAHF_PARITY_MASK != 0);
                self.set_flag(CF, ah & SAHF_CARRY_MASK != 0);
            }
            OP_LAHF => {
                let ah = (self.get_flags() & (CF | PF | AF | ZF | SF)) | FLAGS_RESERVED_ONE;
                self.r[AX] = (self.r[AX] & ACCUMULATOR_LOW_BYTE_MASK)
                    | (ah << LITTLE_ENDIAN_HIGH_BYTE_SHIFT);
            }

            OP_MOV_AL_MOFFS8 => {
                let off = self.fetch16();
                let seg = if self.seg_override == SEGMENT_OVERRIDE_NONE {
                    self.s[DS]
                } else {
                    self.seg_override as u16
                };
                let v = self.rd8(Self::phys(seg, off));
                self.set_r8(AL_BYTE_INDEX, v);
            }
            OP_MOV_AX_MOFFS16 => {
                let off = self.fetch16();
                let seg = if self.seg_override == SEGMENT_OVERRIDE_NONE {
                    self.s[DS]
                } else {
                    self.seg_override as u16
                };
                self.r[AX] = self.rd16(Self::phys(seg, off));
            }
            OP_MOV_MOFFS8_AL => {
                let off = self.fetch16();
                let seg = if self.seg_override == SEGMENT_OVERRIDE_NONE {
                    self.s[DS]
                } else {
                    self.seg_override as u16
                };
                self.wr8(Self::phys(seg, off), self.r[AX] as u8);
            }
            OP_MOV_MOFFS16_AX => {
                let off = self.fetch16();
                let seg = if self.seg_override == SEGMENT_OVERRIDE_NONE {
                    self.s[DS]
                } else {
                    self.seg_override as u16
                };
                self.wr16(Self::phys(seg, off), self.r[AX]);
            }
            OP_TEST_AL_IMM8 => {
                let imm = self.fetch8();
                self.alu(ALU_AND, self.r[AX] & BYTE_MASK, imm as u16, false, false);
            }
            OP_TEST_AX_IMM16 => {
                let imm = self.fetch16();
                self.alu(ALU_AND, self.r[AX], imm, true, false);
            }

            OP_RET_NEAR_IMM => {
                let n = self.fetch16();
                self.ip = self.pop();
                self.r[SP] = self.r[SP].wrapping_add(n);
            }
            OP_RET_NEAR => self.ip = self.pop(),
            OP_LES | OP_LDS => {
                let m = self.modrm();
                let off = self.rd16(m.addr);
                let seg = self.rd16(m.addr + 2);
                self.r[m.reg as usize] = off;
                self.s[if op == OP_LES { ES } else { DS }] = seg;
            }
            OP_MOV_RM8_IMM => {
                let m = self.modrm();
                let v = self.fetch8();
                self.write_rm8(m, v);
            }
            OP_MOV_RM16_IMM => {
                let m = self.modrm();
                let v = self.fetch16();
                self.write_rm16(m, v);
            }
            OP_RET_FAR_IMM => {
                let n = self.fetch16();
                self.ip = self.pop();
                self.s[CS] = self.pop();
                self.r[SP] = self.r[SP].wrapping_add(n);
            }
            OP_RET_FAR => {
                self.ip = self.pop();
                self.s[CS] = self.pop();
            }
            OP_INT3 => self.interrupt(INTERRUPT_BREAKPOINT),
            OP_INT_IMM => {
                let n = self.fetch8();
                self.interrupt(n);
            }
            OP_INTO => {
                if self.flag(OF) {
                    self.interrupt(INTERRUPT_OVERFLOW);
                }
            }
            OP_IRET => {
                self.ip = self.pop();
                self.s[CS] = self.pop();
                let f = self.pop();
                self.set_flags(f);
            }

            OP_XLAT => {
                let off = self.r[BX].wrapping_add(self.r[AX] & BYTE_MASK);
                let seg = if self.seg_override == SEGMENT_OVERRIDE_NONE {
                    self.s[DS]
                } else {
                    self.seg_override as u16
                };
                let v = self.rd8(Self::phys(seg, off));
                self.set_r8(AL_BYTE_INDEX, v);
            }
            OP_LOOPNE | OP_LOOPE | OP_LOOP => {
                let d = self.fetch_s8();
                self.r[CX] = self.r[CX].wrapping_sub(1);
                let take = if op == OP_LOOP {
                    self.r[CX] != 0
                } else if op == OP_LOOPE {
                    self.r[CX] != 0 && self.flag(ZF)
                } else {
                    self.r[CX] != 0 && !self.flag(ZF)
                };
                if take {
                    self.ip = self.ip.wrapping_add(d as u16);
                }
            }
            OP_JCXZ => {
                let d = self.fetch_s8();
                if self.r[CX] == 0 {
                    self.ip = self.ip.wrapping_add(d as u16);
                }
            }
            OP_IN_AL_IMM8 => {
                let port = self.fetch8() as u16;
                let value = self.port_in(port, IO_WIDTH_BYTE) as u8;
                self.set_r8(AL_BYTE_INDEX, value);
            }
            OP_IN_AX_IMM8 => {
                let port = self.fetch8() as u16;
                self.r[AX] = self.port_in(port, IO_WIDTH_WORD);
            }
            OP_OUT_IMM8_AL => {
                let port = self.fetch8() as u16;
                self.port_out(port, self.get_r8(AL_BYTE_INDEX) as u16, IO_WIDTH_BYTE);
            }
            OP_OUT_IMM8_AX => {
                let port = self.fetch8() as u16;
                self.port_out(port, self.r[AX], IO_WIDTH_WORD);
            }
            OP_IN_AL_DX => {
                let value = self.port_in(self.r[DX], IO_WIDTH_BYTE) as u8;
                self.set_r8(AL_BYTE_INDEX, value);
            }
            OP_IN_AX_DX => self.r[AX] = self.port_in(self.r[DX], IO_WIDTH_WORD),
            OP_OUT_DX_AL => {
                self.port_out(self.r[DX], self.get_r8(AL_BYTE_INDEX) as u16, IO_WIDTH_BYTE)
            }
            OP_OUT_DX_AX => self.port_out(self.r[DX], self.r[AX], IO_WIDTH_WORD),
            OP_CALL_NEAR_REL16 => {
                let d = self.fetch16() as i16;
                self.push(self.ip);
                self.ip = self.ip.wrapping_add(d as u16);
            }
            OP_JMP_NEAR_REL16 => {
                let d = self.fetch16() as i16;
                self.ip = self.ip.wrapping_add(d as u16);
            }
            OP_JMP_FAR_IMMEDIATE => {
                let off = self.fetch16();
                let seg = self.fetch16();
                self.ip = off;
                self.s[CS] = seg;
            }
            OP_JMP_SHORT => {
                let d = self.fetch_s8();
                self.ip = self.ip.wrapping_add(d as u16);
            }

            OP_HLT => self.halted = 1,
            OP_CMC => self.set_flag(CF, !self.flag(CF)),
            OP_CLC => self.set_flag(CF, false),
            OP_STC => self.set_flag(CF, true),
            OP_CLI => self.set_flag(IF, false),
            OP_STI => self.set_flag(IF, true),
            OP_CLD => self.set_flag(DF, false),
            OP_STD => self.set_flag(DF, true),
            OP_NOP => (),
            _ => self.exec_extended(op, rep),
        }
    }
}
