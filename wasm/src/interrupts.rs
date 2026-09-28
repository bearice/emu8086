use crate::{constants::*, core::Core};

const INTERRUPT_VECTOR_ENTRY_BYTES: u32 = 4;
const INTERRUPT_VECTOR_SEGMENT_OFFSET: u32 = 2;

impl Core {
    pub(crate) fn interrupt(&mut self, vector: u8) {
        let entry = vector as u32 * INTERRUPT_VECTOR_ENTRY_BYTES;
        let offset = self.rd16(entry);
        let segment = self.rd16(entry + INTERRUPT_VECTOR_SEGMENT_OFFSET);
        self.push(self.get_flags());
        self.push(self.s[CS]);
        self.push(self.ip);
        self.set_flag(IF, false);
        self.set_flag(TF, false);
        self.s[CS] = segment;
        self.ip = offset;
    }
}
