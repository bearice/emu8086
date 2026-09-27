#![no_std]

extern crate core as rust_core;

use crate::core::Core;
use rust_core::cell::UnsafeCell;
use rust_core::panic::PanicInfo;

mod alu;
mod constants;
mod core;
mod execute;
mod execute_groups;
mod interrupts;
mod opcodes;
mod strings;
mod wasm_abi;
pub use wasm_abi::*;

struct SharedCore(UnsafeCell<Core>);
unsafe impl Sync for SharedCore {}

static CORE: SharedCore = SharedCore(UnsafeCell::new(Core::new()));

#[panic_handler]
fn panic(_info: &PanicInfo) -> ! {
    loop {
        rust_core::hint::spin_loop();
    }
}

pub(crate) fn state() -> &'static mut Core {
    unsafe { &mut *CORE.0.get() }
}
