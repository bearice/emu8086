use crate::constants::*;
use crate::state;

#[no_mangle]
pub extern "C" fn memory_ptr() -> *mut u8 {
    let c = crate::state();
    c.mem.as_mut_ptr()
}

#[no_mangle]
pub extern "C" fn registers_ptr() -> *mut u16 {
    let c = crate::state();
    c.r.as_mut_ptr()
}

#[no_mangle]
pub extern "C" fn segments_ptr() -> *mut u16 {
    let c = crate::state();
    c.s.as_mut_ptr()
}

#[no_mangle]
#[allow(clippy::missing_safety_doc)]
pub extern "C" fn reset() {
    state().reset();
}

#[no_mangle]
#[allow(clippy::missing_safety_doc)]
pub extern "C" fn get_ip() -> u32 {
    state().ip as u32
}

#[no_mangle]
#[allow(clippy::missing_safety_doc)]
pub extern "C" fn set_ip(value: u32) {
    state().ip = value as u16;
}

#[no_mangle]
#[allow(clippy::missing_safety_doc)]
pub extern "C" fn get_flags() -> u32 {
    state().get_flags() as u32
}

#[no_mangle]
#[allow(clippy::missing_safety_doc)]
pub extern "C" fn set_flags(value: u32) {
    state().set_flags(value as u16);
}

#[no_mangle]
#[allow(clippy::missing_safety_doc)]
pub extern "C" fn set_dos_compat_mode(enabled: u32) {
    state().dos_compat_mode = (enabled != 0) as u32;
}

#[no_mangle]
#[allow(clippy::missing_safety_doc)]
pub extern "C" fn set_floppy_geometry(cylinders: u32, heads: u32, sectors_per_track: u32) {
    let c = state();
    c.floppy_cylinders = cylinders as u16;
    c.floppy_heads = heads as u16;
    c.floppy_sectors_per_track = sectors_per_track as u16;
}

#[no_mangle]
#[allow(clippy::missing_safety_doc)]
pub extern "C" fn set_hard_disk_geometry(cylinders: u32, heads: u32, sectors_per_track: u32) {
    let c = state();
    c.hard_disk_cylinders = cylinders as u16;
    c.hard_disk_heads = heads as u16;
    c.hard_disk_sectors_per_track = sectors_per_track as u16;
}

#[no_mangle]
#[allow(clippy::missing_safety_doc)]
pub extern "C" fn get_cycles() -> u32 {
    state().cycles
}

#[no_mangle]
#[allow(clippy::missing_safety_doc)]
pub extern "C" fn get_halted() -> u32 {
    state().halted
}

#[no_mangle]
#[allow(clippy::missing_safety_doc)]
pub extern "C" fn get_exited() -> u32 {
    state().exited
}

#[no_mangle]
#[allow(clippy::missing_safety_doc)]
pub extern "C" fn get_exit_code() -> u32 {
    state().exit_code
}

#[no_mangle]
#[allow(clippy::missing_safety_doc)]
pub extern "C" fn get_waiting() -> u32 {
    state().waiting
}

#[no_mangle]
#[allow(clippy::missing_safety_doc)]
pub extern "C" fn error_ptr() -> *const u8 {
    state().error.as_ptr()
}

#[no_mangle]
#[allow(clippy::missing_safety_doc)]
pub extern "C" fn error_len() -> u32 {
    state().error_len
}

#[no_mangle]
#[allow(clippy::missing_safety_doc)]
pub extern "C" fn output_ptr() -> *const i16 {
    state().output.as_ptr()
}

#[no_mangle]
#[allow(clippy::missing_safety_doc)]
pub extern "C" fn output_len() -> u32 {
    state().output_len
}

#[no_mangle]
#[allow(clippy::missing_safety_doc)]
pub extern "C" fn clear_output() {
    state().output_len = 0;
}

#[no_mangle]
#[allow(clippy::missing_safety_doc)]
pub extern "C" fn get_last_run_count() -> u32 {
    state().last_run_count
}

#[no_mangle]
#[allow(clippy::missing_safety_doc)]
pub extern "C" fn step() -> u32 {
    state().step() as u32
}

#[no_mangle]
#[allow(clippy::missing_safety_doc)]
pub extern "C" fn run(limit: u32) -> i32 {
    let c = state();
    c.last_run_count = 0;
    for _ in 0..limit {
        if c.halted != 0 {
            return STATUS_HALTED;
        }
        c.step();
        c.last_run_count += 1;
        if c.halted != 0 {
            return STATUS_HALTED;
        }
        if c.waiting != 0 {
            return STATUS_INPUT;
        }
        let ip = c.ip as usize;
        if c.breakpoints[ip >> BREAKPOINT_ADDRESS_BITS] & (1 << (ip & BREAKPOINT_BIT_MASK)) != 0 {
            return STATUS_BREAKPOINT;
        }
        if c.output_len != 0 {
            return STATUS_OUTPUT;
        }
    }
    if c.halted != 0 {
        STATUS_HALTED
    } else {
        STATUS_RUNNING
    }
}

#[no_mangle]
#[allow(clippy::missing_safety_doc)]
pub extern "C" fn set_breakpoint(ip: u32, enabled: u32) {
    let ip = (ip as usize) & (ADDRESS_SPACE_BYTES - 1);
    let byte = &mut state().breakpoints[ip >> BREAKPOINT_ADDRESS_BITS];
    let mask = 1 << (ip & BREAKPOINT_BIT_MASK);
    if enabled != 0 {
        *byte |= mask;
    } else {
        *byte &= !mask;
    }
}
