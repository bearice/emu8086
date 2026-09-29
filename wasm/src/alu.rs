use crate::{constants::*, core::Core};

impl Core {
    pub(crate) fn szp8(&mut self, value: u8) {
        self.set_flag(ZF, value == 0);
        self.set_flag(SF, value & BYTE_SIGN_BIT != 0);
        self.set_flag(PF, value.count_ones() & 1 == 0);
    }

    pub(crate) fn szp16(&mut self, value: u16) {
        self.set_flag(ZF, value == 0);
        self.set_flag(SF, value & WORD_SIGN_BIT != 0);
        self.set_flag(PF, (value as u8).count_ones() & 1 == 0);
    }

    pub(crate) fn alu(&mut self, op: u8, a: u16, b: u16, wide: bool, carry_in: bool) -> u16 {
        let mask = if wide { WORD_MASK_U32 } else { BYTE_MASK_U32 };
        let sign = if wide {
            WORD_SIGN_BIT_U32
        } else {
            BYTE_SIGN_BIT_U32
        };
        let a = a as u32 & mask;
        let b = b as u32 & mask;
        let carry = u32::from(carry_in);
        let (mut res, set_szp) = match op {
            ALU_ADD | ALU_ADC => {
                let c = if op == ALU_ADC { carry } else { 0 };
                let raw = a + b + c;
                self.set_flag(CF, raw > mask);
                self.set_flag(AF, (a ^ b ^ raw) & AUX_CARRY_NIBBLE_MASK_U32 != 0);
                self.set_flag(OF, (!(a ^ b) & (a ^ raw)) & sign != 0);
                (raw & mask, true)
            }
            ALU_SBB | ALU_SUB | ALU_CMP => {
                let c = if op == ALU_SBB { carry } else { 0 };
                let raw = a as i32 - b as i32 - c as i32;
                self.set_flag(CF, raw < 0);
                self.set_flag(AF, (a ^ b ^ raw as u32) & AUX_CARRY_NIBBLE_MASK_U32 != 0);
                self.set_flag(OF, ((a ^ b) & (a ^ raw as u32)) & sign != 0);
                ((raw as u32) & mask, true)
            }
            ALU_OR => {
                self.flags &= !(CF | OF | AF);
                ((a | b) & mask, true)
            }
            ALU_AND => {
                self.flags &= !(CF | OF | AF);
                ((a & b) & mask, true)
            }
            ALU_XOR => {
                self.flags &= !(CF | OF | AF);
                ((a ^ b) & mask, true)
            }
            _ => (0, false),
        };
        if set_szp {
            if wide {
                self.szp16(res as u16);
            } else {
                self.szp8(res as u8);
            }
        }
        res &= mask;
        res as u16
    }

    pub(crate) fn inc(&mut self, value: u16, wide: bool) -> u16 {
        let cf = self.flag(CF);
        let result = self.alu(ALU_ADD, value, 1, wide, false);
        self.set_flag(CF, cf);
        result
    }

    pub(crate) fn dec(&mut self, value: u16, wide: bool) -> u16 {
        let cf = self.flag(CF);
        let result = self.alu(ALU_SUB, value, 1, wide, false);
        self.set_flag(CF, cf);
        result
    }

    pub(crate) fn cond(&self, c: u8) -> bool {
        let cf = self.flag(CF);
        let pf = self.flag(PF);
        let zf = self.flag(ZF);
        let sf = self.flag(SF);
        let of = self.flag(OF);
        match c {
            COND_OVERFLOW => of,
            COND_NOT_OVERFLOW => !of,
            COND_CARRY => cf,
            COND_NOT_CARRY => !cf,
            COND_ZERO => zf,
            COND_NOT_ZERO => !zf,
            COND_BELOW_OR_EQUAL => cf || zf,
            COND_ABOVE => !(cf || zf),
            COND_SIGN => sf,
            COND_NOT_SIGN => !sf,
            COND_PARITY => pf,
            COND_NOT_PARITY => !pf,
            COND_LESS => sf != of,
            COND_GREATER_OR_EQUAL => sf == of,
            COND_LESS_OR_EQUAL => zf || sf != of,
            COND_GREATER => !zf && sf == of,
            _ => !zf && sf == of,
        }
    }

    pub(crate) fn shift_op(&mut self, op: u8, value: u16, count: u8, wide: bool) -> u16 {
        let mask = if wide { WORD_MASK_U32 } else { BYTE_MASK_U32 };
        let sign = if wide {
            WORD_SIGN_BIT_U32
        } else {
            BYTE_SIGN_BIT_U32
        };
        // The 8086 consumes the full CL byte. Masking to five bits is a 286+
        // behavior and changes counts such as 32 into a no-op.
        if count == 0 {
            return value;
        }
        let mut v = value as u32 & mask;
        let original_value = v;
        let original_carry = self.flag(CF);
        for _ in 0..count {
            match op {
                SHIFT_ROL => {
                    let c = v & sign != 0;
                    v = ((v << 1) | c as u32) & mask;
                    self.set_flag(CF, c);
                }
                SHIFT_ROR => {
                    let c = v & 1 != 0;
                    v = (v >> 1) | if c { sign } else { 0 };
                    self.set_flag(CF, c);
                }
                SHIFT_RCL => {
                    let c = v & sign != 0;
                    let cf = self.flag(CF) as u32;
                    v = ((v << 1) | cf) & mask;
                    self.set_flag(CF, c);
                }
                SHIFT_RCR => {
                    let c = v & 1 != 0;
                    v = (v >> 1) | if self.flag(CF) { sign } else { 0 };
                    self.set_flag(CF, c);
                }
                SHIFT_SHL | SHIFT_SAL => {
                    let c = v & sign != 0;
                    v = (v << 1) & mask;
                    self.set_flag(CF, c);
                }
                SHIFT_SHR => {
                    let c = v & 1 != 0;
                    v >>= 1;
                    self.set_flag(CF, c);
                }
                SHIFT_SAR => {
                    let c = v & 1 != 0;
                    v = (v >> 1) | if v & sign != 0 { sign } else { 0 };
                    self.set_flag(CF, c);
                }
                _ => {
                    let c = v & 1 != 0;
                    v = (v >> 1) | if v & sign != 0 { sign } else { 0 };
                    self.set_flag(CF, c);
                }
            }
        }
        if count == 1 {
            let overflow = match op {
                SHIFT_ROL | SHIFT_RCL | SHIFT_SHL | SHIFT_SAL => (v & sign != 0) ^ self.flag(CF),
                SHIFT_ROR => (original_value & sign != 0) ^ (original_value & 1 != 0),
                SHIFT_RCR => (original_value & sign != 0) ^ original_carry,
                SHIFT_SHR => original_value & sign != 0,
                SHIFT_SAR => false,
                _ => false,
            };
            self.set_flag(OF, overflow);
        }
        if op > SHIFT_RCR {
            if wide {
                self.szp16(v as u16);
            } else {
                self.szp8(v as u8);
            }
            self.set_flag(AF, false);
        }
        v as u16
    }
}
