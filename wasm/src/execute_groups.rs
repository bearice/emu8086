use crate::{constants::*, core::Core, opcodes::*};

impl Core {
    pub(crate) fn exec_extended(&mut self, op: u8, rep: u8) {
        if (OP_INC_REG_FIRST..=OP_INC_REG_LAST).contains(&op) {
            let i = (op & OPCODE_REGISTER_INDEX_MASK) as usize;
            self.r[i] = self.inc(self.r[i], true);
            return;
        }
        if (OP_DEC_REG_FIRST..=OP_DEC_REG_LAST).contains(&op) {
            let i = (op & OPCODE_REGISTER_INDEX_MASK) as usize;
            self.r[i] = self.dec(self.r[i], true);
            return;
        }
        if (OP_PUSH_REG_FIRST..=OP_PUSH_REG_LAST).contains(&op) {
            self.push(self.r[(op & OPCODE_REGISTER_INDEX_MASK) as usize]);
            return;
        }
        if (OP_POP_REG_FIRST..=OP_POP_REG_LAST).contains(&op) {
            let v = self.pop();
            self.r[(op & OPCODE_REGISTER_INDEX_MASK) as usize] = v;
            return;
        }
        if (OP_JCC_FIRST..=OP_JCC_LAST).contains(&op) {
            let d = self.fetch_s8();
            if self.cond(op & LOW_NIBBLE_MASK) {
                self.ip = self.ip.wrapping_add(d as u16);
            }
            return;
        }
        if (OP_ALU_IMMEDIATE_FIRST..=OP_ALU_IMMEDIATE_LAST).contains(&op) {
            let m = self.modrm();
            let wide = op & OPCODE_WIDTH_BIT != 0;
            let imm = if op == OP_ALU_IMMEDIATE_WORD {
                self.fetch16()
            } else if op == OP_ALU_IMMEDIATE_SIGN_EXTENDED {
                self.fetch_s8() as i16 as u16
            } else {
                self.fetch8() as u16
            };
            let aluop = m.reg;
            let carry = self.flag(CF);
            if wide {
                let result = self.alu(aluop, self.read_rm16(m), imm, true, carry);
                if aluop != ALU_CMP {
                    self.write_rm16(m, result);
                }
            } else {
                let result = self.alu(
                    aluop,
                    self.read_rm8(m) as u16,
                    imm & BYTE_MASK,
                    false,
                    carry,
                );
                if aluop != ALU_CMP {
                    self.write_rm8(m, result as u8);
                }
            }
            return;
        }
        if (OP_XCHG_AX_REG_FIRST..=OP_XCHG_AX_REG_LAST).contains(&op) {
            let i = (op & OPCODE_REGISTER_INDEX_MASK) as usize;
            let t = self.r[AX];
            self.r[AX] = self.r[i];
            self.r[i] = t;
            return;
        }
        if matches!(
            op,
            OP_MOVS_BYTE
                | OP_MOVS_WORD
                | OP_CMPS_BYTE
                | OP_CMPS_WORD
                | OP_STOS_BYTE
                | OP_STOS_WORD
                | OP_LODS_BYTE
                | OP_LODS_WORD
                | OP_SCAS_BYTE
                | OP_SCAS_WORD
        ) {
            self.string_op(op, rep);
            return;
        }
        if (OP_MOV_REG8_IMM_FIRST..=OP_MOV_REG8_IMM_LAST).contains(&op) {
            let v = self.fetch8();
            self.set_r8(op & OPCODE_REGISTER_INDEX_MASK, v);
            return;
        }
        if (OP_MOV_REG16_IMM_FIRST..=OP_MOV_REG16_IMM_LAST).contains(&op) {
            let v = self.fetch16();
            self.r[(op & OPCODE_REGISTER_INDEX_MASK) as usize] = v;
            return;
        }
        if (OP_SHIFT_IMM_FIRST..=OP_SHIFT_IMM_LAST).contains(&op) {
            let m = self.modrm();
            let wide = op & OPCODE_WIDTH_BIT != 0;
            let count = if op & OPCODE_COUNT_FROM_CL_BIT != 0 {
                self.r[CX] as u8
            } else {
                1
            };
            if wide {
                let v = self.read_rm16(m);
                let v = self.shift_op(m.reg, v, count, true);
                self.write_rm16(m, v);
            } else {
                let v = self.read_rm8(m) as u16;
                let v = self.shift_op(m.reg, v, count, false);
                self.write_rm8(m, v as u8);
            }
            return;
        }
        if (OP_COPROCESSOR_ESCAPE_FIRST..=OP_COPROCESSOR_ESCAPE_LAST).contains(&op) {
            self.modrm();
            return;
        }
        if op == OP_TEST_NOT_NEG_BYTE || op == OP_TEST_NOT_NEG_WORD {
            self.group3(op);
            return;
        }
        if op == OP_INC_DEC_CALL_JMP_PUSH_BYTE || op == OP_INC_DEC_CALL_JMP_PUSH_WORD {
            self.group45(op);
            return;
        }
        self.set_invalid_opcode(op);
    }

    pub(crate) fn group3(&mut self, op: u8) {
        let wide = op & OPCODE_WIDTH_BIT != 0;
        let m = self.modrm();
        let val = if wide {
            self.read_rm16(m)
        } else {
            self.read_rm8(m) as u16
        };
        match m.reg {
            GROUP3_TEST | GROUP3_TEST_ALIAS => {
                let imm = if wide {
                    self.fetch16()
                } else {
                    self.fetch8() as u16
                };
                self.alu(ALU_AND, val, imm, wide, false);
            }
            GROUP3_NOT => {
                if wide {
                    self.write_rm16(m, !val);
                } else {
                    self.write_rm8(m, !(val as u8));
                }
            }
            GROUP3_NEG => {
                let result = self.alu(ALU_SUB, 0, val, wide, false);
                if wide {
                    self.write_rm16(m, result);
                } else {
                    self.write_rm8(m, result as u8);
                }
                self.set_flag(CF, val != 0);
            }
            GROUP3_MUL => {
                if wide {
                    let product = self.r[AX] as u32 * val as u32;
                    self.r[AX] = product as u16;
                    self.r[DX] = (product >> 16) as u16;
                    let overflow = self.r[DX] != 0;
                    self.set_flag(CF, overflow);
                    self.set_flag(OF, overflow);
                } else {
                    let product = (self.r[AX] as u8 as u16) * val;
                    self.r[AX] = product;
                    let overflow = product & ACCUMULATOR_HIGH_BYTE_MASK != 0;
                    self.set_flag(CF, overflow);
                    self.set_flag(OF, overflow);
                }
            }
            GROUP3_IMUL => {
                if wide {
                    let product = (self.r[AX] as i16 as i32) * (val as i16 as i32);
                    self.r[AX] = product as u16;
                    self.r[DX] = (product >> 16) as u16;
                    let overflow = product < i16::MIN as i32 || product > i16::MAX as i32;
                    self.set_flag(CF, overflow);
                    self.set_flag(OF, overflow);
                } else {
                    let product = (self.r[AX] as u8 as i8 as i16) * (val as u8 as i8 as i16);
                    self.r[AX] = product as u16;
                    let overflow = product < i8::MIN as i16 || product > i8::MAX as i16;
                    self.set_flag(CF, overflow);
                    self.set_flag(OF, overflow);
                }
            }
            GROUP3_DIV => {
                if val == 0 {
                    self.interrupt(INTERRUPT_DIVIDE_ERROR);
                    return;
                }
                if wide {
                    let num = ((self.r[DX] as u32) << 16) | self.r[AX] as u32;
                    let q = num / val as u32;
                    if q > WORD_MASK_U32 {
                        self.interrupt(INTERRUPT_DIVIDE_ERROR);
                        return;
                    }
                    self.r[AX] = q as u16;
                    self.r[DX] = (num % val as u32) as u16;
                } else {
                    let num = self.r[AX];
                    let q = num / val;
                    if q > BYTE_MASK {
                        self.interrupt(INTERRUPT_DIVIDE_ERROR);
                        return;
                    }
                    self.r[AX] = q | ((num % val) << LITTLE_ENDIAN_HIGH_BYTE_SHIFT);
                }
            }
            GROUP3_IDIV => {
                let d = if wide {
                    val as i16 as i64
                } else {
                    val as u8 as i8 as i64
                };
                if d == 0 {
                    self.interrupt(INTERRUPT_DIVIDE_ERROR);
                    return;
                }
                if wide {
                    let num = ((((self.r[DX] as u32) << 16) | self.r[AX] as u32) as i32) as i64;
                    let q = num / d;
                    let rem = num % d;
                    self.r[AX] = q as u16;
                    self.r[DX] = rem as u16;
                } else {
                    let num = self.r[AX] as i16 as i64;
                    let q = num / d;
                    let rem = num % d;
                    self.r[AX] =
                        (q as u8 as u16) | ((rem as u8 as u16) << LITTLE_ENDIAN_HIGH_BYTE_SHIFT);
                }
            }
            _ => (),
        }
    }

    pub(crate) fn group45(&mut self, op: u8) {
        let wide = op & OPCODE_WIDTH_BIT != 0;
        let m = self.modrm();
        match m.reg {
            GROUP45_INC => {
                if wide {
                    let v = self.inc(self.read_rm16(m), true);
                    self.write_rm16(m, v);
                } else {
                    let v = self.inc(self.read_rm8(m) as u16, false);
                    self.write_rm8(m, v as u8);
                }
            }
            GROUP45_DEC => {
                if wide {
                    let v = self.dec(self.read_rm16(m), true);
                    self.write_rm16(m, v);
                } else {
                    let v = self.dec(self.read_rm8(m) as u16, false);
                    self.write_rm8(m, v as u8);
                }
            }
            GROUP45_CALL_NEAR => {
                let t = self.read_rm16(m);
                self.push(self.ip);
                self.ip = t;
            }
            GROUP45_CALL_FAR => {
                let off = self.rd16(m.addr);
                let seg = self.rd16(m.addr + 2);
                self.push(self.s[CS]);
                self.push(self.ip);
                self.ip = off;
                self.s[CS] = seg;
            }
            GROUP45_JMP_NEAR => self.ip = self.read_rm16(m),
            GROUP45_JMP_FAR => {
                let off = self.rd16(m.addr);
                let seg = self.rd16(m.addr + 2);
                self.ip = off;
                self.s[CS] = seg;
            }
            GROUP45_PUSH => {
                let v = self.read_rm16(m);
                self.push(v);
            }
            _ => (),
        }
    }
}
