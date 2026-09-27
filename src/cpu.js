// JavaScript adapter for the Rust WebAssembly 8086 core.
export const R = { AX: 0, CX: 1, DX: 2, BX: 3, SP: 4, BP: 5, SI: 6, DI: 7 };
export const S = { ES: 0, CS: 1, SS: 2, DS: 3 };

let coreModule;

export async function initializeCPU(source) {
  if (coreModule) return;
  const wasm = await source;
  coreModule = wasm instanceof WebAssembly.Module ? wasm : await WebAssembly.compile(wasm);
}

export class CPU {
  constructor(opts = {}) {
    if (!coreModule) throw new Error('WebAssembly CPU module has not been initialized');
    this.onOutput = opts.onOutput || (() => {});
    this.onInput = opts.onInput || (() => -1);
    this.onDiskRead = opts.onDiskRead || (() => 0);
    this.onDiskWrite = opts.onDiskWrite || (() => 0);
    this.onPortRead = opts.onPortRead || (() => 0);
    this.onPortWrite = opts.onPortWrite || (() => {});
    const dateNow = opts.dateNow || (() => new Date());
    this.instance = new WebAssembly.Instance(coreModule, { env: {
      host_input: (peek) => this.onInput(!!peek) ?? -1,
      host_disk_read: (drive, cylinder, head, sector, count, destination) =>
        this.onDiskRead(drive, cylinder, head, sector, count, destination) | 0,
      host_disk_write: (drive, cylinder, head, sector, count, source) =>
        this.onDiskWrite(drive, cylinder, head, sector, count, source) | 0,
      host_port_read: (port, width) => (this.onPortRead(port & 0xffff, width) ?? 0) | 0,
      host_port_write: (port, value, width) => this.onPortWrite(port & 0xffff, value & 0xffff, width),
      host_time: () => {
        const d = dateNow();
        const cx = (d.getHours() << 8) | d.getMinutes();
        const dx = (d.getSeconds() << 8) | Math.floor(d.getMilliseconds() / 10);
        return ((cx << 16) | dx) | 0;
      },
      host_date: () => {
        const d = dateNow();
        return (((d.getFullYear() & 0xffff) << 16) | ((d.getMonth() + 1) << 8) | d.getDate()) | 0;
      },
    } });
    this.exports = this.instance.exports;
    const { memory } = this.exports;
    if (!(memory instanceof WebAssembly.Memory)) throw new Error('WASM CPU module does not export linear memory');
    this.mem = new Uint8Array(memory.buffer, this.exports.memory_ptr(), 1024 * 1024);
    this.r = new Uint16Array(memory.buffer, this.exports.registers_ptr(), 8);
    this.s = new Uint16Array(memory.buffer, this.exports.segments_ptr(), 4);
    this._textDecoder = new TextDecoder();
  }

  reset() { this.exports.reset(); }

  setDosCompatMode(enabled) { this.exports.set_dos_compat_mode(enabled ? 1 : 0); }
  setFloppyGeometry(cylinders, heads, sectorsPerTrack) {
    this.exports.set_floppy_geometry(cylinders >>> 0, heads >>> 0, sectorsPerTrack >>> 0);
  }
  setHardDiskGeometry(cylinders, heads, sectorsPerTrack) {
    this.exports.set_hard_disk_geometry(cylinders >>> 0, heads >>> 0, sectorsPerTrack >>> 0);
  }

  get ip() { return this.exports.get_ip(); }
  set ip(value) { this.exports.set_ip(value); }

  get flags() { return this.exports.get_flags(); }
  set flags(value) { this.exports.set_flags(value); }

  get f() {
    const f = this.flags;
    return {
      cf: f & 1, pf: (f >> 2) & 1, af: (f >> 4) & 1, zf: (f >> 6) & 1,
      sf: (f >> 7) & 1, tf: (f >> 8) & 1, if: (f >> 9) & 1,
      df: (f >> 10) & 1, of: (f >> 11) & 1,
    };
  }

  get cycles() { return this.exports.get_cycles(); }
  get halted() { return this.exports.get_halted() !== 0; }
  get exited() { return this.exports.get_exited() !== 0; }
  get exitCode() { return this.exports.get_exit_code(); }
  get waiting() { return this.exports.get_waiting() !== 0; }

  get error() {
    const len = this.exports.error_len();
    if (!len) return null;
    const start = this.exports.error_ptr();
    return this._textDecoder.decode(new Uint8Array(this.exports.memory.buffer, start, len));
  }

  get lastRunCount() { return this.exports.get_last_run_count(); }

  rd8(addr) { return this.mem[addr & 0xfffff]; }
  wr8(addr, value) { this.mem[addr & 0xfffff] = value & 0xff; }
  rd16(addr) { return this.rd8(addr) | (this.rd8(addr + 1) << 8); }
  wr16(addr, value) { this.wr8(addr, value); this.wr8(addr + 1, value >> 8); }

  setBreakpoint(ip, enabled) { this.exports.set_breakpoint(ip, enabled ? 1 : 0); }

  flushOutput() {
    const len = this.exports.output_len();
    if (!len) return;
    const start = this.exports.output_ptr();
    const values = new Int16Array(this.exports.memory.buffer, start, len);
    for (let i = 0; i < len; i++) this.onOutput(values[i]);
    this.exports.clear_output();
  }

  step() {
    const ok = this.exports.step() !== 0;
    this.flushOutput();
    return ok;
  }

  run(limit) {
    const status = this.exports.run(limit >>> 0);
    this.flushOutput();
    return status;
  }
}
