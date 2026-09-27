use crate::core::Core;

#[link(wasm_import_module = "env")]
extern "C" {
    fn host_port_read(port: i32, width: i32) -> i32;
    fn host_port_write(port: i32, value: i32, width: i32);
}

impl Core {
    pub(crate) fn port_in(&mut self, port: u16, width: u8) -> u16 {
        unsafe { host_port_read(port as i32, width as i32) as u16 }
    }

    pub(crate) fn port_out(&mut self, port: u16, value: u16, width: u8) {
        unsafe { host_port_write(port as i32, value as i32, width as i32) }
    }
}
