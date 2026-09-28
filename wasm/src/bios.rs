use crate::{constants::*, core::Core};

const BIOS_ROM_SEGMENT: u16 = 0xf000;
const BIOS_DISK_PARAMETER_TABLE_OFFSET: u16 = 0x0200;
const BIOS_SYSTEM_CONFIGURATION_TABLE_OFFSET: u16 = 0x0210;
const BOOT_SECTOR_ADDRESS: u32 = 0x7c00;
const BOOT_SIGNATURE_OFFSET: u32 = 510;
const BOOT_SIGNATURE: u16 = 0xaa55;

pub(crate) const INT_BIOS_EQUIPMENT: u8 = 0x11;
pub(crate) const INT_BIOS_SYSTEM: u8 = 0x15;
pub(crate) const INT_BIOS_VIDEO: u8 = 0x10;
pub(crate) const INT_BIOS_SERIAL: u8 = 0x14;
pub(crate) const INT_BIOS_PARALLEL: u8 = 0x17;
pub(crate) const INT_BIOS_TIME: u8 = 0x1a;
pub(crate) const INT_BIOS_DISK: u8 = 0x13;
pub(crate) const INT_BIOS_MEMORY_SIZE: u8 = 0x12;
pub(crate) const INT_BIOS_KEYBOARD: u8 = 0x16;
pub(crate) const INT_BIOS_BOOTSTRAP: u8 = 0x19;

const BIOS_GET_SYSTEM_CONFIGURATION: u8 = 0xc0;
const BIOS_SYSTEM_CONFIGURATION_TABLE_LENGTH: u8 = 8;
const BIOS_PC_AT_MODEL_ID: u8 = 0xfc;
const BIOS_SYSTEM_CONFIGURATION_SUBMODEL: u8 = 0;
const BIOS_REVISION: u8 = 0;
const BIOS_FUNCTION_UNSUPPORTED_STATUS: u8 = 0x86;
const BIOS_KEYBOARD_INTERCEPT: u8 = 0x4f;

const SERIAL_INITIALIZE: u8 = 0x00;
const SERIAL_TRANSMIT: u8 = 0x01;
const SERIAL_RECEIVE: u8 = 0x02;
const SERIAL_GET_STATUS: u8 = 0x03;
const SERIAL_TIMEOUT_STATUS: u8 = 0x80;

const PARALLEL_PRINT: u8 = 0x00;
const PARALLEL_INITIALIZE: u8 = 0x01;
const PARALLEL_GET_STATUS: u8 = 0x02;
const PARALLEL_NO_DEVICE_STATUS: u8 = 0x90;

const TIME_READ_CLOCK: u8 = 0x00;
const TIME_READ_RTC_TIME: u8 = 0x02;
const TIME_READ_RTC_DATE: u8 = 0x04;

const VIDEO_SET_MODE: u8 = 0x00;
const VIDEO_SET_ACTIVE_PAGE: u8 = 0x05;
const VIDEO_SCROLL_UP: u8 = 0x06;
const VIDEO_SCROLL_DOWN: u8 = 0x07;
const VIDEO_SET_CURSOR: u8 = 0x02;
const VIDEO_GET_CURSOR: u8 = 0x03;
const VIDEO_READ_CHAR_ATTRIBUTE: u8 = 0x08;
const VIDEO_WRITE_CHAR_TTY: u8 = 0x0e;
const VIDEO_WRITE_CHAR: u8 = 0x0a;
const VIDEO_WRITE_CHAR_ATTRIBUTE: u8 = 0x09;
const VIDEO_GET_MODE: u8 = 0x0f;
const TEXT_VIDEO_BASE: u32 = 0xb8000;
const TEXT_COLUMNS: u32 = 80;
const TEXT_ROWS: u32 = 25;
const TEXT_PAGE_BYTES: u32 = 0x1000;
const TEXT_PAGE_COUNT: u8 = 8;

const KEYBOARD_READ: u8 = 0x00;
const KEYBOARD_READ_EXTENDED: u8 = 0x10;
const KEYBOARD_CHECK: u8 = 0x01;
const KEYBOARD_CHECK_EXTENDED: u8 = 0x11;

const DISK_RESET: u8 = 0x00;
const DISK_GET_STATUS: u8 = 0x01;
const DISK_READ_SECTORS: u8 = 0x02;
const DISK_WRITE_SECTORS: u8 = 0x03;
const DISK_VERIFY_SECTORS: u8 = 0x04;
const DISK_GET_PARAMETERS: u8 = 0x08;
const DISK_GET_TYPE: u8 = 0x15;
const FLOPPY_DRIVE: u8 = 0x00;
const HARD_DISK_DRIVE: u8 = 0x80;
const DISKETTE_TYPE: u8 = 0x01;
const FIXED_DISK_TYPE: u8 = 0x03;
const DISK_INVALID_COMMAND: u8 = 0x01;
const DISK_SECTOR_NOT_FOUND: u8 = 0x04;
const DISK_DRIVE_NOT_READY: u8 = 0x80;

#[link(wasm_import_module = "env")]
extern "C" {
    fn host_input(peek: i32) -> i32;
    fn host_time() -> i32;
    fn host_date() -> i32;
    fn host_disk_read(
        drive: i32,
        cylinder: i32,
        head: i32,
        sector: i32,
        count: i32,
        destination: i32,
    ) -> i32;
    fn host_disk_write(
        drive: i32,
        cylinder: i32,
        head: i32,
        sector: i32,
        count: i32,
        source: i32,
    ) -> i32;
}

impl Core {
    pub(crate) fn input(&mut self, peek: bool) -> i32 {
        unsafe { host_input(peek as i32) }
    }

    pub(crate) fn bios_service(&mut self, n: u8) -> bool {
        match n {
            INT_BIOS_EQUIPMENT => {
                self.r[AX] = if self.floppy_cylinders == 0 {
                    0x0020
                } else {
                    0x0021
                };
                true
            }
            INT_BIOS_MEMORY_SIZE => {
                self.r[AX] = 640;
                true
            }
            INT_BIOS_SYSTEM => self.bios_system(),
            INT_BIOS_SERIAL => {
                self.bios_serial();
                true
            }
            INT_BIOS_PARALLEL => {
                self.bios_parallel();
                true
            }
            INT_BIOS_TIME => self.bios_time(),
            INT_BIOS_VIDEO => {
                self.bios_video();
                true
            }
            INT_BIOS_DISK => {
                self.bios_disk();
                true
            }
            INT_BIOS_KEYBOARD => self.bios_keyboard(),
            INT_BIOS_BOOTSTRAP => {
                self.bios_bootstrap();
                true
            }
            _ => false,
        }
    }

    fn bios_system(&mut self) -> bool {
        if (self.r[AX] >> BYTE_BITS) as u8 == BIOS_KEYBOARD_INTERCEPT {
            self.set_flag(CF, true);
            return true;
        }

        if (self.r[AX] >> BYTE_BITS) as u8 != BIOS_GET_SYSTEM_CONFIGURATION {
            self.r[AX] = ((BIOS_FUNCTION_UNSUPPORTED_STATUS as u16) << BYTE_BITS)
                | (self.r[AX] & ACCUMULATOR_LOW_BYTE_MASK);
            self.set_flag(CF, true);
            return true;
        }

        let table = [
            BIOS_SYSTEM_CONFIGURATION_TABLE_LENGTH,
            BIOS_PC_AT_MODEL_ID,
            BIOS_SYSTEM_CONFIGURATION_SUBMODEL,
            BIOS_REVISION,
            0,
            0,
            0,
            0,
        ];
        let base = Self::phys(BIOS_ROM_SEGMENT, BIOS_SYSTEM_CONFIGURATION_TABLE_OFFSET);
        for (offset, value) in table.into_iter().enumerate() {
            self.wr8(base + offset as u32, value);
        }

        self.r[AX] &= ACCUMULATOR_LOW_BYTE_MASK;
        self.s[ES] = BIOS_ROM_SEGMENT;
        self.r[BX] = BIOS_SYSTEM_CONFIGURATION_TABLE_OFFSET;
        self.set_flag(CF, false);
        true
    }

    fn bios_serial(&mut self) {
        let function = (self.r[AX] >> BYTE_BITS) as u8;
        let character = self.r[AX] as u8;
        self.r[AX] = match function {
            SERIAL_INITIALIZE | SERIAL_GET_STATUS => 0,
            SERIAL_TRANSMIT => ((SERIAL_TIMEOUT_STATUS as u16) << BYTE_BITS) | character as u16,
            SERIAL_RECEIVE => (SERIAL_TIMEOUT_STATUS as u16) << BYTE_BITS,
            _ => (SERIAL_TIMEOUT_STATUS as u16) << BYTE_BITS,
        };
    }

    fn bios_parallel(&mut self) {
        let function = (self.r[AX] >> BYTE_BITS) as u8;
        let status = match function {
            PARALLEL_PRINT | PARALLEL_INITIALIZE | PARALLEL_GET_STATUS => PARALLEL_NO_DEVICE_STATUS,
            _ => SERIAL_TIMEOUT_STATUS,
        };
        self.r[AX] = ((status as u16) << BYTE_BITS) | (self.r[AX] & ACCUMULATOR_LOW_BYTE_MASK);
    }

    fn bios_time(&mut self) -> bool {
        let function = (self.r[AX] >> BYTE_BITS) as u8;
        let time = unsafe { host_time() as u32 };
        let hour = (time >> 24) as u8;
        let minute = (time >> 16) as u8;
        let second = (time >> 8) as u8;
        match function {
            TIME_READ_CLOCK => {
                let elapsed_seconds = (hour as u64 * 60 + minute as u64) * 60 + second as u64;
                let ticks = (elapsed_seconds * 182_065 / 10_000) as u32;
                self.r[CX] = (ticks >> WORD_BITS) as u16;
                self.r[DX] = ticks as u16;
                self.r[AX] &= ACCUMULATOR_HIGH_BYTE_MASK;
                self.wr8(0x470, 0);
                self.wr16(0x46c, ticks as u16);
                self.wr16(0x46e, (ticks >> WORD_BITS) as u16);
                self.set_flag(CF, false);
                true
            }
            TIME_READ_RTC_TIME => {
                self.r[CX] =
                    ((Self::to_bcd(hour) as u16) << BYTE_BITS) | Self::to_bcd(minute) as u16;
                self.r[DX] = (Self::to_bcd(second) as u16) << BYTE_BITS;
                self.set_flag(CF, false);
                true
            }
            TIME_READ_RTC_DATE => {
                let date = unsafe { host_date() as u32 };
                let year = (date >> WORD_BITS) as u16;
                let month = (date >> BYTE_BITS) as u8;
                let day = date as u8;
                self.r[CX] = ((Self::to_bcd((year / 100) as u8) as u16) << BYTE_BITS)
                    | Self::to_bcd((year % 100) as u8) as u16;
                self.r[DX] = ((Self::to_bcd(month) as u16) << BYTE_BITS) | Self::to_bcd(day) as u16;
                self.set_flag(CF, false);
                true
            }
            _ => false,
        }
    }

    fn to_bcd(value: u8) -> u8 {
        ((value / 10) << 4) | (value % 10)
    }

    fn bios_video(&mut self) {
        let ah = (self.r[AX] >> 8) as u8;
        let al = self.r[AX] as u8;
        let page = ((self.r[BX] >> 8) as u8) & 7;
        match ah {
            VIDEO_SET_MODE => {
                self.wr8(0x449, al);
                self.wr16(0x44a, TEXT_COLUMNS as u16);
                self.wr16(0x44c, (TEXT_COLUMNS * TEXT_ROWS * 2) as u16);
                self.wr16(0x44e, 0);
                self.wr8(0x462, 0);
                self.clear_video_page(0, 0x07);
            }
            VIDEO_SET_CURSOR => {
                let requested = self.r[DX];
                let row = ((requested >> 8) as u32).min(TEXT_ROWS - 1);
                let column = (requested as u8 as u32).min(TEXT_COLUMNS - 1);
                let cursor = ((row as u16) << 8) | column as u16;
                self.wr16(0x450 + (page as u32 * 2), cursor);
            }
            VIDEO_GET_CURSOR => {
                let cursor = self.rd16(0x450 + (page as u32 * 2));
                self.r[CX] = self.rd16(0x460);
                self.r[DX] = cursor;
                self.r[BX] = ((page as u16) << 8) | (self.r[BX] & 0xff);
            }
            VIDEO_SET_ACTIVE_PAGE => self.wr8(0x462, page),
            VIDEO_SCROLL_UP | VIDEO_SCROLL_DOWN => self.bios_scroll(al, ah == VIDEO_SCROLL_UP),
            VIDEO_READ_CHAR_ATTRIBUTE => {
                let cursor = self.rd16(0x450 + page as u32 * 2);
                let row = ((cursor >> 8) as u32).min(TEXT_ROWS - 1);
                let column = ((cursor & 0xff) as u32).min(TEXT_COLUMNS - 1);
                let address = TEXT_VIDEO_BASE
                    + page as u32 * TEXT_PAGE_BYTES
                    + (row * TEXT_COLUMNS + column) * 2;
                self.r[AX] =
                    ((self.rd8(address + 1) as u16) << BYTE_BITS) | self.rd8(address) as u16;
            }
            VIDEO_WRITE_CHAR_TTY => {
                // Some text-mode callers leave BH untouched instead of supplying a page.
                let tty_page = if (self.r[BX] >> BYTE_BITS) as u8 >= TEXT_PAGE_COUNT {
                    self.rd8(0x462) & (TEXT_PAGE_COUNT - 1)
                } else {
                    page
                };
                self.bios_teletype(al, tty_page);
            }
            VIDEO_WRITE_CHAR | VIDEO_WRITE_CHAR_ATTRIBUTE => {
                let cursor = self.rd16(0x450 + (page as u32 * 2));
                let row = (cursor >> 8) as u32;
                let column = (cursor & 0xff) as u32;
                let count = self.r[CX] as u32;
                let attr = self.r[BX] as u8;
                for i in 0..count {
                    let cell = row * TEXT_COLUMNS + column + i;
                    if cell >= TEXT_ROWS * TEXT_COLUMNS {
                        break;
                    }
                    let index = TEXT_VIDEO_BASE + page as u32 * TEXT_PAGE_BYTES + (cell * 2);
                    self.wr8(index, al);
                    if ah == VIDEO_WRITE_CHAR_ATTRIBUTE {
                        self.wr8(index + 1, attr);
                    }
                }
            }
            VIDEO_GET_MODE => {
                let mode = self.rd8(0x449);
                let columns = self.rd16(0x44a) as u8;
                self.r[AX] = ((columns as u16) << 8) | mode as u16;
                self.r[BX] = ((self.rd8(0x462) as u16) << 8) | (self.r[BX] & 0xff);
            }
            _ => (),
        }
    }

    fn bios_teletype(&mut self, character: u8, page: u8) {
        let cursor_address = 0x450 + page as u32 * 2;
        let cursor = self.rd16(cursor_address);
        let mut row = ((cursor >> 8) as u32).min(TEXT_ROWS - 1);
        let mut column = ((cursor & 0xff) as u32).min(TEXT_COLUMNS - 1);
        match character {
            b'\r' => column = 0,
            b'\n' => row += 1,
            8 => {
                if column > 0 {
                    column -= 1;
                } else if row > 0 {
                    row -= 1;
                    column = TEXT_COLUMNS - 1;
                }
            }
            7 => (),
            _ => {
                if row < TEXT_ROWS && column < TEXT_COLUMNS {
                    let address = TEXT_VIDEO_BASE
                        + page as u32 * TEXT_PAGE_BYTES
                        + ((row * TEXT_COLUMNS + column) * 2);
                    self.wr8(address, character);
                    column += 1;
                }
                if column >= TEXT_COLUMNS {
                    column = 0;
                    row += 1;
                }
            }
        }
        while row >= TEXT_ROWS {
            let page_base = TEXT_VIDEO_BASE + page as u32 * TEXT_PAGE_BYTES;
            for line in 0..TEXT_ROWS - 1 {
                for col in 0..TEXT_COLUMNS {
                    let destination = page_base + ((line * TEXT_COLUMNS + col) * 2);
                    let source = destination + TEXT_COLUMNS * 2;
                    let character = self.rd8(source);
                    let attribute = self.rd8(source + 1);
                    self.wr8(destination, character);
                    self.wr8(destination + 1, attribute);
                }
            }
            let last_line = page_base + ((TEXT_ROWS - 1) * TEXT_COLUMNS * 2);
            for col in 0..TEXT_COLUMNS {
                let cell = last_line + col * 2;
                self.wr8(cell, b' ');
                self.wr8(cell + 1, 0x07);
            }
            row -= 1;
        }
        self.wr16(cursor_address, ((row as u16) << 8) | column as u16);
    }

    fn clear_video_page(&mut self, page: u8, attribute: u8) {
        let base = TEXT_VIDEO_BASE + page as u32 * TEXT_PAGE_BYTES;
        for cell in 0..TEXT_ROWS * TEXT_COLUMNS {
            let address = base + cell * 2;
            self.wr8(address, b' ');
            self.wr8(address + 1, attribute);
        }
        self.wr16(0x450 + page as u32 * 2, 0);
    }

    fn bios_scroll(&mut self, lines: u8, up: bool) {
        let page = (self.rd8(0x462) & 7) as u32;
        let attribute = (self.r[BX] >> BYTE_BITS) as u8;
        let top = (self.r[CX] >> 8) as u32;
        let left = (self.r[CX] & 0xff) as u32;
        let bottom = (self.r[DX] >> 8) as u32;
        let right = (self.r[DX] & 0xff) as u32;
        if top > bottom || left > right || bottom >= TEXT_ROWS || right >= TEXT_COLUMNS {
            return;
        }
        let height = bottom - top + 1;
        let count = if lines == 0 { height } else { lines as u32 }.min(height);
        for step in 0..height {
            let dst_row = if up { top + step } else { bottom - step };
            let src_row = if up {
                dst_row + count
            } else {
                dst_row.saturating_sub(count)
            };
            for column in left..=right {
                let dst = TEXT_VIDEO_BASE
                    + page * TEXT_PAGE_BYTES
                    + ((dst_row * TEXT_COLUMNS + column) * 2);
                if (up && dst_row + count <= bottom) || (!up && dst_row >= top + count) {
                    let src = TEXT_VIDEO_BASE
                        + page * TEXT_PAGE_BYTES
                        + ((src_row * TEXT_COLUMNS + column) * 2);
                    self.wr8(dst, self.rd8(src));
                    self.wr8(dst + 1, self.rd8(src + 1));
                } else {
                    self.wr8(dst, b' ');
                    self.wr8(dst + 1, attribute);
                }
            }
        }
    }

    fn bios_keyboard(&mut self) -> bool {
        let ah = (self.r[AX] >> 8) as u8;
        match ah {
            KEYBOARD_READ | KEYBOARD_READ_EXTENDED => {
                let key = self.input(false);
                if key < 0 {
                    self.waiting = 1;
                } else {
                    self.waiting = 0;
                    self.r[AX] = key as u16;
                }
                true
            }
            KEYBOARD_CHECK | KEYBOARD_CHECK_EXTENDED => {
                let key = self.input(true);
                if key < 0 {
                    self.set_flag(ZF, true);
                } else {
                    self.set_flag(ZF, false);
                    self.r[AX] = key as u16;
                }
                true
            }
            _ => true,
        }
    }

    fn bios_disk(&mut self) {
        let function = (self.r[AX] >> 8) as u8;
        let drive = self.r[DX] as u8;
        match function {
            DISK_RESET => {
                let status = if self.disk_geometry(drive).is_some() {
                    0
                } else {
                    DISK_DRIVE_NOT_READY
                };
                self.set_disk_status(drive, status);
                self.set_bios_disk_result(status, 0);
            }
            DISK_GET_STATUS => {
                let status = self
                    .disk_geometry(drive)
                    .map_or(DISK_DRIVE_NOT_READY, |_| self.disk_status(drive));
                self.set_bios_disk_result(status, 0);
            }
            DISK_READ_SECTORS | DISK_WRITE_SECTORS => {
                let cx = self.r[CX];
                let dx = self.r[DX];
                let cl = cx as u8;
                let cylinder = ((cx >> 8) & 0xff) | (((cl as u16) & 0xc0) << 2);
                let sector = (cl & 0x3f) as u32;
                let head = (dx >> 8) as u8 as u32;
                let count = self.r[AX] as u8 as u32;
                let destination = Self::phys(self.s[ES], self.r[BX]) as i32;

                if count == 0 || sector == 0 {
                    self.set_disk_status(drive, DISK_INVALID_COMMAND);
                    self.set_bios_disk_result(DISK_INVALID_COMMAND, 0);
                    return;
                }
                if self.disk_geometry(drive).is_none() {
                    self.set_disk_status(drive, DISK_DRIVE_NOT_READY);
                    self.set_bios_disk_result(DISK_DRIVE_NOT_READY, 0);
                    return;
                }
                let ok = unsafe {
                    if function == DISK_READ_SECTORS {
                        host_disk_read(
                            drive as i32,
                            cylinder as i32,
                            head as i32,
                            sector as i32,
                            count as i32,
                            destination,
                        )
                    } else {
                        host_disk_write(
                            drive as i32,
                            cylinder as i32,
                            head as i32,
                            sector as i32,
                            count as i32,
                            destination,
                        )
                    }
                };
                let status = if ok != 0 { 0 } else { DISK_SECTOR_NOT_FOUND };
                self.set_disk_status(drive, status);
                self.set_bios_disk_result(status, if status == 0 { count as u8 } else { 0 });
            }
            DISK_GET_PARAMETERS => self.bios_disk_parameters(),
            DISK_VERIFY_SECTORS => self.bios_verify_sectors(drive),
            DISK_GET_TYPE => self.bios_disk_type(drive),
            _ => self.set_bios_disk_result(DISK_INVALID_COMMAND, 0),
        }
    }

    fn bios_disk_parameters(&mut self) {
        let drive = self.r[DX] as u8;
        let Some((cylinders, heads, sectors_per_track)) = self.disk_geometry(drive) else {
            self.set_disk_status(drive, DISK_DRIVE_NOT_READY);
            self.set_bios_disk_result(DISK_DRIVE_NOT_READY, 0);
            return;
        };
        let max_cylinder = cylinders - 1;
        let ch = (max_cylinder & 0xff) as u8;
        let cl = (sectors_per_track as u8 & 0x3f) | (((max_cylinder >> 2) as u8) & 0xc0);
        let dh = heads.saturating_sub(1) as u8;
        self.r[AX] = 0;
        self.r[CX] = ((ch as u16) << 8) | cl as u16;
        self.r[DX] = ((dh as u16) << 8) | 1;
        if drive == FLOPPY_DRIVE {
            self.s[ES] = BIOS_ROM_SEGMENT;
            self.r[DI] = BIOS_DISK_PARAMETER_TABLE_OFFSET;
        }
        self.set_disk_status(drive, 0);
        self.set_flag(CF, false);
    }

    fn bios_disk_type(&mut self, drive: u8) {
        let Some((cylinders, heads, sectors_per_track)) = self.disk_geometry(drive) else {
            self.set_disk_status(drive, DISK_DRIVE_NOT_READY);
            self.set_bios_disk_result(DISK_DRIVE_NOT_READY, 0);
            return;
        };
        let disk_type = if drive == HARD_DISK_DRIVE {
            FIXED_DISK_TYPE
        } else {
            DISKETTE_TYPE
        };
        self.r[AX] = ((disk_type as u16) << BYTE_BITS) | (self.r[AX] & ACCUMULATOR_LOW_BYTE_MASK);
        if drive == HARD_DISK_DRIVE {
            let sectors = cylinders as u32 * heads as u32 * sectors_per_track as u32;
            self.r[CX] = (sectors >> WORD_BITS) as u16;
            self.r[DX] = sectors as u16;
        }
        self.set_disk_status(drive, 0);
        self.set_flag(CF, false);
    }

    fn bios_verify_sectors(&mut self, drive: u8) {
        let Some((cylinders, heads, sectors_per_track)) = self.disk_geometry(drive) else {
            self.set_disk_status(drive, DISK_DRIVE_NOT_READY);
            self.set_bios_disk_result(DISK_DRIVE_NOT_READY, 0);
            return;
        };
        let cx = self.r[CX];
        let cylinder = ((cx >> BYTE_BITS) & BYTE_MASK) | ((cx & 0xc0) << 2);
        let sector = cx & 0x3f;
        let head = self.r[DX] >> BYTE_BITS;
        let count = self.r[AX] as u8;
        let first_lba = (cylinder as u32 * heads as u32 + head as u32) * sectors_per_track as u32
            + sector.saturating_sub(1) as u32;
        let total_sectors = cylinders as u32 * heads as u32 * sectors_per_track as u32;
        // Image-backed sectors have no physical ECC errors. Verify the range
        // without transferring data into ES:BX (FORMAT commonly sets it to 0).
        let status = if count == 0 || sector == 0 {
            DISK_INVALID_COMMAND
        } else if cylinder >= cylinders
            || head >= heads
            || sector > sectors_per_track
            || first_lba + count as u32 > total_sectors
        {
            DISK_SECTOR_NOT_FOUND
        } else {
            0
        };
        self.set_disk_status(drive, status);
        self.set_bios_disk_result(status, if status == 0 { count } else { 0 });
    }

    fn disk_geometry(&self, drive: u8) -> Option<(u16, u16, u16)> {
        let geometry = if drive == FLOPPY_DRIVE {
            (
                self.floppy_cylinders,
                self.floppy_heads,
                self.floppy_sectors_per_track,
            )
        } else if drive == HARD_DISK_DRIVE {
            (
                self.hard_disk_cylinders,
                self.hard_disk_heads,
                self.hard_disk_sectors_per_track,
            )
        } else {
            return None;
        };
        if geometry.0 == 0 || geometry.1 == 0 || geometry.2 == 0 {
            None
        } else {
            Some(geometry)
        }
    }

    fn disk_status(&self, drive: u8) -> u8 {
        if drive == FLOPPY_DRIVE {
            self.floppy_last_disk_status
        } else if drive == HARD_DISK_DRIVE {
            self.hard_disk_last_status
        } else {
            DISK_DRIVE_NOT_READY
        }
    }

    fn set_disk_status(&mut self, drive: u8, status: u8) {
        if drive == FLOPPY_DRIVE {
            self.floppy_last_disk_status = status;
        } else if drive == HARD_DISK_DRIVE {
            self.hard_disk_last_status = status;
        }
    }

    fn set_bios_disk_result(&mut self, status: u8, count: u8) {
        self.r[AX] = ((status as u16) << 8) | count as u16;
        self.set_flag(CF, status != 0);
    }

    fn bios_bootstrap(&mut self) {
        let mut drive = FLOPPY_DRIVE;
        let mut loaded =
            unsafe { host_disk_read(drive as i32, 0, 0, 1, 1, BOOT_SECTOR_ADDRESS as i32) };
        if loaded == 0 || self.rd16(BOOT_SECTOR_ADDRESS + BOOT_SIGNATURE_OFFSET) != BOOT_SIGNATURE {
            drive = HARD_DISK_DRIVE;
            loaded =
                unsafe { host_disk_read(drive as i32, 0, 0, 1, 1, BOOT_SECTOR_ADDRESS as i32) };
        }
        if loaded == 0 || self.rd16(BOOT_SECTOR_ADDRESS + BOOT_SIGNATURE_OFFSET) != BOOT_SIGNATURE {
            self.set_bios_disk_result(DISK_DRIVE_NOT_READY, 0);
            self.halted = 1;
            return;
        }
        self.r = [0; REGISTER_COUNT];
        self.s = [0; SEGMENT_REGISTER_COUNT];
        self.s[SS] = 0;
        self.r[SP] = BOOT_SECTOR_ADDRESS as u16;
        self.r[DX] = drive as u16;
        self.ip = BOOT_SECTOR_ADDRESS as u16;
        self.flags = IF;
        self.halted = 0;
        self.exited = 0;
        self.waiting = 0;
        self.invalid_opcode = 0;
        self.error_len = 0;
    }
}
