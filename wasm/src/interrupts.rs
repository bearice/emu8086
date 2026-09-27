use crate::{constants::*, core::Core};

const INTERRUPT_VECTOR_ENTRY_BYTES: u32 = 4;
const INTERRUPT_VECTOR_SEGMENT_OFFSET: u32 = 2;

const INT_BIOS_VIDEO: u8 = 0x10;
const INT_BIOS_KEYBOARD: u8 = 0x16;
const INT_DOS_TERMINATE: u8 = 0x20;
const INT_DOS_SERVICES: u8 = 0x21;

const VIDEO_SET_MODE: u8 = 0x00;
const VIDEO_WRITE_CHAR_TTY: u8 = 0x0e;
const VIDEO_WRITE_CHAR: u8 = 0x0a;
const VIDEO_WRITE_CHAR_ATTRIBUTE: u8 = 0x09;

const DOS_READ_CHAR_ECHO: u8 = 0x01;
const DOS_WRITE_CHAR: u8 = 0x02;
const DOS_DIRECT_CONSOLE_IO: u8 = 0x06;
const DOS_READ_CHAR: u8 = 0x07;
const DOS_READ_CHAR_NO_ECHO: u8 = 0x08;
const DOS_WRITE_STRING: u8 = 0x09;
const DOS_BUFFERED_INPUT: u8 = 0x0a;
const DOS_GET_TIME: u8 = 0x2c;
const DOS_TERMINATE_WITH_CODE: u8 = 0x4c;

const KEYBOARD_READ: u8 = 0x00;
const KEYBOARD_READ_EXTENDED: u8 = 0x10;
const KEYBOARD_CHECK: u8 = 0x01;
const KEYBOARD_CHECK_EXTENDED: u8 = 0x11;

const DOS_STRING_TERMINATOR: u8 = b'$';
const ASCII_BACKSPACE: i32 = 8;
const ASCII_CARRIAGE_RETURN: i32 = 13;
const ASCII_LINE_FEED: u8 = 10;
const DOS_DIRECT_IO_INPUT_SENTINEL: u8 = 0xff;
const DOS_INPUT_COUNT_OFFSET: u16 = 1;
const DOS_INPUT_DATA_OFFSET: u16 = 2;
const MAX_LINE_LENGTH: u32 = u8::MAX as u32;

#[link(wasm_import_module = "env")]
extern "C" {
    fn host_input(peek: i32) -> i32;
    fn host_time() -> i32;
}

impl Core {
    pub(crate) fn put_char(&mut self, value: u8) {
        self.output(value as i16);
    }

    pub(crate) fn input(&mut self, peek: bool) -> i32 {
        unsafe { host_input(peek as i32) }
    }

    pub(crate) fn interrupt(&mut self, n: u8) {
        if self.handle_bios(n) {
            return;
        }
        let vec = self.rd16(n as u32 * INTERRUPT_VECTOR_ENTRY_BYTES);
        let seg =
            self.rd16(n as u32 * INTERRUPT_VECTOR_ENTRY_BYTES + INTERRUPT_VECTOR_SEGMENT_OFFSET);
        if vec == 0 && seg == 0 {
            self.set_unhandled_int(n);
            self.halted = 1;
            return;
        }
        self.push(self.get_flags());
        self.push(self.s[CS]);
        self.push(self.ip);
        self.set_flag(IF, false);
        self.set_flag(TF, false);
        self.s[CS] = seg;
        self.ip = vec;
    }

    pub(crate) fn handle_bios(&mut self, n: u8) -> bool {
        let ah = (self.r[AX] >> 8) as u8;
        let al = self.r[AX] as u8;
        if n == INT_BIOS_VIDEO {
            match ah {
                VIDEO_WRITE_CHAR_TTY | VIDEO_WRITE_CHAR | VIDEO_WRITE_CHAR_ATTRIBUTE => {
                    self.put_char(al)
                }
                VIDEO_SET_MODE => self.output(-1),
                _ => (),
            }
            return true;
        }
        if n == INT_DOS_SERVICES {
            match ah {
                DOS_READ_CHAR_ECHO => {
                    let c = self.input(false);
                    if c < 0 {
                        self.waiting = 1;
                        return true;
                    }
                    self.waiting = 0;
                    self.r[AX] = (self.r[AX] & ACCUMULATOR_HIGH_BYTE_MASK) | (c as u16 & BYTE_MASK);
                    self.put_char(c as u8);
                    true
                }
                DOS_WRITE_CHAR | DOS_DIRECT_CONSOLE_IO => {
                    if ah == DOS_DIRECT_CONSOLE_IO
                        && self.r[DX] as u8 == DOS_DIRECT_IO_INPUT_SENTINEL
                    {
                        let c = self.input(false);
                        if c < 0 {
                            self.set_flag(ZF, true);
                            return true;
                        }
                        self.set_flag(ZF, false);
                        self.r[AX] =
                            (self.r[AX] & ACCUMULATOR_HIGH_BYTE_MASK) | (c as u16 & BYTE_MASK);
                        return true;
                    }
                    self.put_char(self.r[DX] as u8);
                    true
                }
                DOS_READ_CHAR | DOS_READ_CHAR_NO_ECHO => {
                    let c = self.input(false);
                    if c < 0 {
                        self.waiting = 1;
                        return true;
                    }
                    self.waiting = 0;
                    self.r[AX] = (self.r[AX] & ACCUMULATOR_HIGH_BYTE_MASK) | (c as u16 & BYTE_MASK);
                    true
                }
                DOS_WRITE_STRING => {
                    let mut off = self.r[DX];
                    for _ in 0..ADDRESS_SPACE_BYTES {
                        let c = self.rd_seg8(self.s[DS], off);
                        if c == DOS_STRING_TERMINATOR {
                            break;
                        }
                        self.put_char(c);
                        off = off.wrapping_add(1);
                    }
                    true
                }
                DOS_BUFFERED_INPUT => {
                    let base = self.r[DX];
                    let max = self.rd_seg8(self.s[DS], base) as usize;
                    loop {
                        let c = self.input(false);
                        if c < 0 {
                            self.waiting = 1;
                            return true;
                        }
                        if c == ASCII_CARRIAGE_RETURN {
                            self.put_char(ASCII_CARRIAGE_RETURN as u8);
                            self.put_char(ASCII_LINE_FEED);
                            self.wr8(
                                Self::phys(self.s[DS], base.wrapping_add(DOS_INPUT_COUNT_OFFSET)),
                                self.line_len as u8,
                            );
                            for i in 0..self.line_len as usize {
                                let byte = self.line_buf[i];
                                self.wr8(
                                    Self::phys(
                                        self.s[DS],
                                        base.wrapping_add(DOS_INPUT_DATA_OFFSET + i as u16),
                                    ),
                                    byte,
                                );
                            }
                            self.wr8(
                                Self::phys(
                                    self.s[DS],
                                    base.wrapping_add(DOS_INPUT_DATA_OFFSET + self.line_len as u16),
                                ),
                                ASCII_CARRIAGE_RETURN as u8,
                            );
                            self.line_len = 0;
                            self.waiting = 0;
                            return true;
                        }
                        if c == ASCII_BACKSPACE {
                            if self.line_len > 0 {
                                self.line_len -= 1;
                                self.output(8);
                            }
                            continue;
                        }
                        if self.line_len < max.saturating_sub(1) as u32
                            && self.line_len < MAX_LINE_LENGTH
                        {
                            self.line_buf[self.line_len as usize] = c as u8;
                            self.line_len += 1;
                            self.put_char(c as u8);
                        }
                    }
                }
                DOS_TERMINATE_WITH_CODE => {
                    self.exited = 1;
                    self.halted = 1;
                    self.exit_code = al as u32;
                    true
                }
                DOS_GET_TIME => {
                    let time = unsafe { host_time() as u32 };
                    self.r[CX] = (time >> 16) as u16;
                    self.r[DX] = time as u16;
                    true
                }
                _ => true,
            }
        } else if n == INT_BIOS_KEYBOARD {
            if ah == KEYBOARD_READ || ah == KEYBOARD_READ_EXTENDED {
                let c = self.input(false);
                if c < 0 {
                    self.waiting = 1;
                    return true;
                }
                self.waiting = 0;
                self.r[AX] = (c as u16 & BYTE_MASK)
                    | (((c as u16) << LITTLE_ENDIAN_HIGH_BYTE_SHIFT) & ACCUMULATOR_HIGH_BYTE_MASK);
                return true;
            }
            if ah == KEYBOARD_CHECK || ah == KEYBOARD_CHECK_EXTENDED {
                let c = self.input(true);
                if c < 0 {
                    self.set_flag(ZF, true);
                } else {
                    self.set_flag(ZF, false);
                    self.r[AX] = (c as u16 & BYTE_MASK)
                        | (((c as u16) << LITTLE_ENDIAN_HIGH_BYTE_SHIFT)
                            & ACCUMULATOR_HIGH_BYTE_MASK);
                }
                return true;
            }
            true
        } else if n == INT_DOS_TERMINATE {
            self.exited = 1;
            self.halted = 1;
            true
        } else {
            false
        }
    }
}
