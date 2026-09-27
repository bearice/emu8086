// Machine layout and architectural widths.
pub(crate) const BYTE_BITS: u32 = 8;
pub(crate) const WORD_BITS: u32 = 16;
pub(crate) const PHYSICAL_ADDRESS_BITS: u32 = 20;
pub(crate) const MEMORY_BYTES: usize = 1 << PHYSICAL_ADDRESS_BITS;
pub(crate) const ADDRESS_SPACE_BYTES: usize = 1 << WORD_BITS;
pub(crate) const PHYSICAL_ADDRESS_MASK: u32 = (MEMORY_BYTES - 1) as u32;
pub(crate) const SEGMENT_SHIFT: u32 = 4;
pub(crate) const BYTE_MASK: u16 = (1u16 << BYTE_BITS) - 1;
pub(crate) const BYTE_HIGH_MASK: u16 = BYTE_MASK << BYTE_BITS;
pub(crate) const WORD_MASK: u16 = ((1u32 << WORD_BITS) - 1) as u16;
pub(crate) const BYTE_SIGN_BIT: u8 = 1 << (BYTE_BITS - 1);
pub(crate) const WORD_SIGN_BIT: u16 = 1 << (WORD_BITS - 1);
pub(crate) const BYTE_MASK_U32: u32 = BYTE_MASK as u32;
pub(crate) const WORD_MASK_U32: u32 = WORD_MASK as u32;
pub(crate) const BYTE_SIGN_BIT_U32: u32 = BYTE_SIGN_BIT as u32;
pub(crate) const WORD_SIGN_BIT_U32: u32 = WORD_SIGN_BIT as u32;
pub(crate) const LITTLE_ENDIAN_HIGH_BYTE_SHIFT: u32 = 8;
pub(crate) const AUX_CARRY_NIBBLE_MASK_U32: u32 = 1 << 4;
pub(crate) const BREAKPOINT_ADDRESS_BITS: u32 = 3;
pub(crate) const BREAKPOINT_BIT_MASK: usize = (1 << BREAKPOINT_ADDRESS_BITS) - 1;
pub(crate) const BREAKPOINT_BYTES: usize = ADDRESS_SPACE_BYTES >> BREAKPOINT_ADDRESS_BITS;
pub(crate) const OUTPUT_CAPACITY: usize = ADDRESS_SPACE_BYTES;
pub(crate) const ERROR_BUFFER_BYTES: usize = 96;
pub(crate) const INPUT_LINE_BUFFER_BYTES: usize = 256;
pub(crate) const REGISTER_COUNT: usize = 8;
pub(crate) const SEGMENT_REGISTER_COUNT: usize = 4;
pub(crate) const SEGMENT_OVERRIDE_NONE: i32 = -1;
pub(crate) const STACK_SLOT_BYTES: u16 = 2;

// General purpose register indices in the ABI register array.
pub(crate) const AX: usize = 0;
pub(crate) const CX: usize = 1;
pub(crate) const DX: usize = 2;
pub(crate) const BX: usize = 3;
pub(crate) const SP: usize = 4;
pub(crate) const BP: usize = 5;
pub(crate) const SI: usize = 6;
pub(crate) const DI: usize = 7;
pub(crate) const BYTE_REGISTER_COUNT: usize = 4;
pub(crate) const BYTE_REGISTER_HIGH_OFFSET: usize = 4;

// Segment register indices in the ABI segment array.
pub(crate) const ES: usize = 0;
pub(crate) const CS: usize = 1;
pub(crate) const SS: usize = 2;
pub(crate) const DS: usize = 3;
pub(crate) const SEGMENT_REGISTER_INDEX_MASK: u8 = 0b11;

// ModR/M byte layout and its register-direct mode.
pub(crate) const MODRM_MODE_SHIFT: u8 = 6;
pub(crate) const MODRM_REG_SHIFT: u8 = 3;
pub(crate) const MODRM_REG_MASK: u8 = 0b111;
pub(crate) const MODRM_RM_MASK: u8 = 0b111;
pub(crate) const MODRM_REGISTER_MODE: u8 = 0b11;
pub(crate) const MODRM_DISP8_MODE: u8 = 0b01;
pub(crate) const MODRM_DISP16_MODE: u8 = 0b10;
pub(crate) const RM_BX_SI: u8 = 0b000;
pub(crate) const RM_BX_DI: u8 = 0b001;
pub(crate) const RM_BP_SI: u8 = 0b010;
pub(crate) const RM_BP_DI: u8 = 0b011;
pub(crate) const RM_SI: u8 = 0b100;
pub(crate) const RM_DI: u8 = 0b101;
pub(crate) const RM_BP_OR_DIRECT_ADDRESS: u8 = 0b110;
pub(crate) const HEX_NIBBLE_BITS: u32 = 4;
pub(crate) const HEX_NIBBLE_MASK: u16 = 0x0f;
pub(crate) const HEX_DIGITS_PER_WORD: usize = 4;

// ALU operation selectors encoded in the ModR/M reg field.
pub(crate) const ALU_ADD: u8 = 0;
pub(crate) const ALU_OR: u8 = 1;
pub(crate) const ALU_ADC: u8 = 2;
pub(crate) const ALU_SBB: u8 = 3;
pub(crate) const ALU_AND: u8 = 4;
pub(crate) const ALU_SUB: u8 = 5;
pub(crate) const ALU_XOR: u8 = 6;
pub(crate) const ALU_CMP: u8 = 7;
pub(crate) const OPCODE_ALU_OPERATION_SHIFT: u8 = 3;
pub(crate) const OPCODE_REGISTER_INDEX_MASK: u8 = 0b111;
pub(crate) const OPCODE_WIDTH_BIT: u8 = 0b001;
pub(crate) const OPCODE_COUNT_FROM_CL_BIT: u8 = 0b010;
pub(crate) const OPCODE_STRING_BYTE_WORD_MASK: u8 = 0xfe;
pub(crate) const ALU_FORM_COUNT: u8 = 6;
pub(crate) const ALU_FORM_RM_REGISTER_LIMIT: u8 = 2;
pub(crate) const ALU_FORM_REGISTER_RM_LIMIT: u8 = 4;
pub(crate) const ALU_SELECTOR_MASK: u8 = 0b111;
pub(crate) const LOW_NIBBLE_MASK: u8 = 0x0f;
pub(crate) const AL_BYTE_INDEX: u8 = 0;
pub(crate) const AH_BYTE_INDEX: u8 = 4;
pub(crate) const ACCUMULATOR_LOW_BYTE_MASK: u16 = 0x00ff;
pub(crate) const ACCUMULATOR_HIGH_BYTE_MASK: u16 = 0xff00;
pub(crate) const BCD_LOW_DIGIT_MAX: u8 = 9;
pub(crate) const BCD_LOW_DIGIT_MAX_WORD: u16 = 9;
pub(crate) const BCD_ADJUST_LOW_BYTE: u8 = 6;
pub(crate) const BCD_ADJUST_LOW_WORD: u16 = 6;
pub(crate) const BCD_ADJUST_HIGH: u8 = 0x60;
pub(crate) const BCD_ADJUST_WORD: u16 = 0x0106;
pub(crate) const BCD_ADJUST_AX_MASK: u16 = 0xff0f;
pub(crate) const BCD_LOW_NIBBLE_MASK: u16 = 0x000f;
pub(crate) const BCD_AL_HIGH_ADJUST_THRESHOLD: u8 = 0x99;
pub(crate) const DEFAULT_DECIMAL_BASE: u8 = 10;
pub(crate) const INTERRUPT_DIVIDE_ERROR: u8 = 0;
pub(crate) const INTERRUPT_BREAKPOINT: u8 = 3;
pub(crate) const INTERRUPT_OVERFLOW: u8 = 4;
pub(crate) const REP_PREFIX_NONE: u8 = 0;
pub(crate) const REP_PREFIX_EQUAL: u8 = 1;
pub(crate) const REP_PREFIX_NOT_EQUAL: u8 = 2;
pub(crate) const SAHF_SIGN_MASK: u8 = 0x80;
pub(crate) const SAHF_ZERO_MASK: u8 = 0x40;
pub(crate) const SAHF_AUXILIARY_CARRY_MASK: u8 = 0x10;
pub(crate) const SAHF_PARITY_MASK: u8 = 0x04;
pub(crate) const SAHF_CARRY_MASK: u8 = 0x01;

// Shift/rotate selectors encoded in the ModR/M reg field.
pub(crate) const SHIFT_ROL: u8 = 0;
pub(crate) const SHIFT_ROR: u8 = 1;
pub(crate) const SHIFT_RCL: u8 = 2;
pub(crate) const SHIFT_RCR: u8 = 3;
pub(crate) const SHIFT_SHL: u8 = 4;
pub(crate) const SHIFT_SHR: u8 = 5;
pub(crate) const SHIFT_SAL: u8 = 6;
pub(crate) const SHIFT_SAR: u8 = 7;
pub(crate) const SHIFT_COUNT_MASK: u8 = 0b1_1111;

// Group 3 and group 4/5 selectors encoded in the ModR/M reg field.
pub(crate) const GROUP3_TEST: u8 = 0;
pub(crate) const GROUP3_TEST_ALIAS: u8 = 1;
pub(crate) const GROUP3_NOT: u8 = 2;
pub(crate) const GROUP3_NEG: u8 = 3;
pub(crate) const GROUP3_MUL: u8 = 4;
pub(crate) const GROUP3_IMUL: u8 = 5;
pub(crate) const GROUP3_DIV: u8 = 6;
pub(crate) const GROUP3_IDIV: u8 = 7;
pub(crate) const GROUP45_INC: u8 = 0;
pub(crate) const GROUP45_DEC: u8 = 1;
pub(crate) const GROUP45_CALL_NEAR: u8 = 2;
pub(crate) const GROUP45_CALL_FAR: u8 = 3;
pub(crate) const GROUP45_JMP_NEAR: u8 = 4;
pub(crate) const GROUP45_JMP_FAR: u8 = 5;
pub(crate) const GROUP45_PUSH: u8 = 6;

// Condition selectors used by conditional branch instructions.
pub(crate) const COND_OVERFLOW: u8 = 0x0;
pub(crate) const COND_NOT_OVERFLOW: u8 = 0x1;
pub(crate) const COND_CARRY: u8 = 0x2;
pub(crate) const COND_NOT_CARRY: u8 = 0x3;
pub(crate) const COND_ZERO: u8 = 0x4;
pub(crate) const COND_NOT_ZERO: u8 = 0x5;
pub(crate) const COND_BELOW_OR_EQUAL: u8 = 0x6;
pub(crate) const COND_ABOVE: u8 = 0x7;
pub(crate) const COND_SIGN: u8 = 0x8;
pub(crate) const COND_NOT_SIGN: u8 = 0x9;
pub(crate) const COND_PARITY: u8 = 0xa;
pub(crate) const COND_NOT_PARITY: u8 = 0xb;
pub(crate) const COND_LESS: u8 = 0xc;
pub(crate) const COND_GREATER_OR_EQUAL: u8 = 0xd;
pub(crate) const COND_LESS_OR_EQUAL: u8 = 0xe;
pub(crate) const COND_GREATER: u8 = 0xf;

// Status values returned by run().
pub(crate) const STATUS_RUNNING: i32 = 0;
pub(crate) const STATUS_HALTED: i32 = 1;
pub(crate) const STATUS_INPUT: i32 = 2;
pub(crate) const STATUS_BREAKPOINT: i32 = 3;
pub(crate) const STATUS_OUTPUT: i32 = 4;

// 8086 status flag bits.
pub(crate) const CF: u16 = 1 << 0;
pub(crate) const PF: u16 = 1 << 2;
pub(crate) const AF: u16 = 1 << 4;
pub(crate) const ZF: u16 = 1 << 6;
pub(crate) const SF: u16 = 1 << 7;
pub(crate) const TF: u16 = 1 << 8;
pub(crate) const IF: u16 = 1 << 9;
pub(crate) const DF: u16 = 1 << 10;
pub(crate) const OF: u16 = 1 << 11;
pub(crate) const FLAGS_MASK: u16 = CF | PF | AF | ZF | SF | TF | IF | DF | OF;
pub(crate) const FLAGS_RESERVED_ONE: u16 = 1 << 1;
