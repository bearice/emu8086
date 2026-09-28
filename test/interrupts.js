import { CPU, R, S } from '../src/cpu.js';
import { Machine } from '../src/machine.js';
import { disasm } from '../src/disasm.js';
import { BIOS_SEG, FIRMWARE_TRAP, installFirmwareVectors, serviceStubOffset } from '../src/firmware.js';

const LOAD_SEG = 0x100;
const ORIGIN = 0x100;
const STACK_TOP = 0xfffe;
const HANDLER_SEG = 0x200;
const HANDLER_OFFSET = 0x200;
const FLAGS = { CF: 1, ZF: 0x40, TF: 0x100, IF: 0x200, DF: 0x400, OF: 0x800 };
const CALLER_FLAGS = FLAGS.IF | FLAGS.TF | FLAGS.DF | 2;

function makeCPU(bytes, firmware = true, options = {}) {
  const cpu = new CPU(options);
  if (firmware) installFirmwareVectors(cpu, { dosCompat: true });
  cpu.s[S.CS] = cpu.s[S.DS] = cpu.s[S.ES] = cpu.s[S.SS] = LOAD_SEG;
  cpu.ip = ORIGIN;
  cpu.r[R.SP] = STACK_TOP;
  cpu.flags = CALLER_FLAGS;
  cpu.mem.set(bytes, (LOAD_SEG << 4) + ORIGIN);
  return cpu;
}

function vectorTo(cpu, vector, segment, offset) {
  cpu.wr16(vector * 4, offset);
  cpu.wr16(vector * 4 + 2, segment);
}

function finish(cpu) {
  for (let i = 0; i < 100 && !cpu.halted && !cpu.error && !cpu.waiting; i++) cpu.step();
}

function frame(cpu) {
  return [0, 2, 4].map((offset) => cpu.rd16((cpu.s[S.SS] << 4) + ((cpu.r[R.SP] + offset) & 0xffff)));
}

export function verifyInterruptDispatch(check) {
  // Every formerly intercepted service must honor a replacement guest vector.
  for (const vector of [0x10, 0x11, 0x12, 0x13, 0x14, 0x15, 0x16, 0x17, 0x19, 0x1a, 0x20, 0x21]) {
    const output = [];
    const cpu = makeCPU([0xcd, vector, 0xf4], true, { onOutput: (c) => output.push(c) });
    cpu.flags = CALLER_FLAGS | FLAGS.CF;
    const originalFlags = cpu.flags;
    vectorTo(cpu, vector, HANDLER_SEG, HANDLER_OFFSET);
    cpu.mem.set([0xb8, 0xef, 0xbe, 0xcf], (HANDLER_SEG << 4) + HANDLER_OFFSET);
    cpu.step();
    check(`INT ${vector.toString(16)}h enters the guest IVT with a real frame`,
      cpu.s[S.CS] === HANDLER_SEG && cpu.ip === HANDLER_OFFSET && cpu.r[R.SP] === STACK_TOP - 6
        && frame(cpu).join(',') === [ORIGIN + 2, LOAD_SEG, originalFlags].join(',')
        && (cpu.flags & (FLAGS.IF | FLAGS.TF)) === 0 && !cpu.error && output.length === 0, true);
    cpu.step();
    cpu.step();
    check(`INT ${vector.toString(16)}h returns through guest IRET`, cpu.r[R.AX] === 0xbeef
      && cpu.s[S.CS] === LOAD_SEG && cpu.ip === ORIGIN + 2 && cpu.r[R.SP] === STACK_TOP
      && cpu.flags === originalFlags && !cpu.error, true);
  }

  for (const [name, vector, bytes, extraFlags] of [
    ['INT3', 3, [0xcc], 0], ['INTO', 4, [0xce], FLAGS.OF], ['divide error', 0, [0xf6, 0xf3], 0],
  ]) {
    const cpu = makeCPU([...bytes, 0xf4], false);
    cpu.flags = CALLER_FLAGS | extraFlags;
    vectorTo(cpu, vector, HANDLER_SEG, HANDLER_OFFSET);
    cpu.mem.set([0xb8, 0xef, 0xbe, 0xcf], (HANDLER_SEG << 4) + HANDLER_OFFSET);
    cpu.step();
    const entered = cpu.s[S.CS] === HANDLER_SEG && cpu.ip === HANDLER_OFFSET;
    cpu.step();
    cpu.step();
    check(`${name} uses IVT and restores its frame`, entered && cpu.r[R.AX] === 0xbeef
      && cpu.ip === ORIGIN + bytes.length && cpu.r[R.SP] === STACK_TOP
      && cpu.flags === (CALLER_FLAGS | extraFlags) && !cpu.error, true);
  }
  const noOverflow = makeCPU([0xce, 0xf4], false);
  noOverflow.step();
  check('INTO with OF clear does not enter an interrupt', noOverflow.ip === ORIGIN + 1
    && noOverflow.r[R.SP] === STACK_TOP && !noOverflow.error, true);

  const zeroVector = makeCPU([0xcd, 0x30], false);
  zeroVector.mem[0] = 0xf4;
  zeroVector.step();
  check('A zero IVT entry jumps to 0000:0000', zeroVector.s[S.CS] === 0 && zeroVector.ip === 0
    && zeroVector.r[R.SP] === STACK_TOP - 6 && !zeroVector.error, true);

  // A caller-provided interrupt frame can wrap within its stack segment.
  const wrapped = makeCPU([0xcd, 0x15, 0xf4]);
  wrapped.s[S.SS] = 0x3000;
  wrapped.r[R.SP] = 4;
  wrapped.r[R.AX] = 0xc000;
  wrapped.flags |= FLAGS.CF;
  finish(wrapped);
  check('Firmware returns CF through a wrapped stack frame', wrapped.halted && !wrapped.error
    && wrapped.r[R.SP] === 4 && wrapped.flags === CALLER_FLAGS && wrapped.s[S.ES] === BIOS_SEG, true);

  for (const [name, call] of [
    ['INT', [0xcd, 0x13]], ['PUSHF/CALL FAR', [0x9c, 0x2e, 0xff, 0x1e, 0x00, 0x03]],
  ]) {
    const cpu = makeCPU([0xb8, 0x00, 0x02, 0xba, 0x80, 0x00, ...call, 0xf4]);
    cpu.wr16(0x1300, serviceStubOffset(0x13));
    cpu.wr16(0x1302, BIOS_SEG);
    finish(cpu);
    check(`BIOS CF error survives ${name} and IRET`, cpu.halted && !cpu.error
      && cpu.r[R.AX] === 0x0100 && cpu.flags === (CALLER_FLAGS | FLAGS.CF)
      && cpu.r[R.SP] === STACK_TOP, true);
  }

  const tailChain = makeCPU([0xb8, 0x00, 0x02, 0xba, 0x80, 0x00, 0xcd, 0x13, 0xf4]);
  vectorTo(tailChain, 0x13, HANDLER_SEG, HANDLER_OFFSET);
  tailChain.mem.set([
    0x2e, 0xff, 0x06, 0x00, 0x03, // INC WORD [CS:0300h]
    0x2e, 0xff, 0x2e, 0x02, 0x03, // JMP FAR [CS:0302h]
  ], (HANDLER_SEG << 4) + HANDLER_OFFSET);
  tailChain.wr16(0x2302, serviceStubOffset(0x13));
  tailChain.wr16(0x2304, BIOS_SEG);
  finish(tailChain);
  check('Guest BIOS hook tail-chains to the original ROM entry', tailChain.halted && !tailChain.error
    && tailChain.rd16(0x2300) === 1 && tailChain.r[R.AX] === 0x0100
    && tailChain.flags === (CALLER_FLAGS | FLAGS.CF) && tailChain.r[R.SP] === STACK_TOP, true);

  const callChain = makeCPU([0xb8, 0x00, 0x02, 0xba, 0x80, 0x00, 0xcd, 0x13, 0xf4]);
  vectorTo(callChain, 0x13, HANDLER_SEG, HANDLER_OFFSET);
  callChain.mem.set([
    0x9c, 0x2e, 0xff, 0x1e, 0x02, 0x03, // PUSHF; CALL FAR [CS:0302h]
    0x9c, 0x2e, 0x8f, 0x06, 0x06, 0x03, // PUSHF; POP WORD [CS:0306h]
    0xcf,
  ], (HANDLER_SEG << 4) + HANDLER_OFFSET);
  callChain.wr16(0x2302, serviceStubOffset(0x13));
  callChain.wr16(0x2304, BIOS_SEG);
  finish(callChain);
  check('Guest PUSHF/CALL FAR chain returns BIOS flags to the hook', callChain.halted && !callChain.error
    && (callChain.rd16(0x2306) & FLAGS.CF) === FLAGS.CF && callChain.r[R.AX] === 0x0100
    && callChain.flags === CALLER_FLAGS && callChain.r[R.SP] === STACK_TOP, true);

  const success = makeCPU([0xb8, 0x00, 0x08, 0xba, 0x80, 0x00, 0xcd, 0x13, 0xf4]);
  success.setHardDiskGeometry(615, 4, 17);
  success.flags |= FLAGS.CF;
  finish(success);
  check('BIOS success clears caller CF through IRET', success.halted && !success.error
    && success.flags === CALLER_FLAGS && success.r[R.SP] === STACK_TOP, true);

  for (const [name, key, flags] of [['empty', -1, FLAGS.ZF], ['available', 0x1e61, 0]]) {
    const cpu = makeCPU([0xb4, 0x01, 0xcd, 0x16, 0xf4], true, { onInput: () => key });
    cpu.flags = CALLER_FLAGS | FLAGS.CF | (key < 0 ? 0 : FLAGS.ZF);
    finish(cpu);
    check(`BIOS keyboard ${name} returns ZF through IRET`, cpu.halted && !cpu.error
      && cpu.flags === (CALLER_FLAGS | FLAGS.CF | flags)
      && (key < 0 || cpu.r[R.AX] === key) && cpu.r[R.SP] === STACK_TOP, true);
  }

  const waiting = new Machine();
  waiting.load(new Uint8Array([0xb4, 0x00, 0xcd, 0x16, 0xf4]), ORIGIN);
  waiting.cpu.flags = CALLER_FLAGS;
  waiting.run(100);
  const savedFrame = frame(waiting.cpu).join(',');
  let stable = waiting.cpu.waiting;
  for (let i = 0; i < 10; i++) {
    waiting.run(100);
    stable &&= waiting.cpu.waiting && waiting.cpu.r[R.SP] === STACK_TOP - 6
      && frame(waiting.cpu).join(',') === savedFrame;
  }
  check('Keyboard wait retries the ROM trap without growing the stack', stable
    && waiting.cpu.s[S.CS] === BIOS_SEG && waiting.cpu.ip === serviceStubOffset(0x16), true);
  waiting.keyPress(0x61, 0x1e);
  waiting.run(100);
  check('Keyboard input resumes IRET to the original caller', waiting.cpu.halted && !waiting.cpu.error
    && waiting.cpu.r[R.AX] === 0x1e61 && waiting.cpu.r[R.SP] === STACK_TOP
    && waiting.cpu.s[S.CS] === LOAD_SEG && waiting.cpu.flags === CALLER_FLAGS, true);

  for (const segment of [LOAD_SEG, BIOS_SEG]) {
    const cpu = makeCPU([FIRMWARE_TRAP, 0x10, 0xcf], false);
    cpu.s[S.CS] = segment;
    cpu.mem.set([FIRMWARE_TRAP, 0x10, 0xcf], (segment << 4) + ORIGIN);
    cpu.step();
    check(`Firmware trap rejects an unregistered entry in segment ${segment.toString(16)}h`,
      cpu.halted && cpu.error?.includes('invalid opcode F1h'), true);
  }

  const realDos = makeCPU([0xcd, 0x21], true);
  realDos.setDosCompatMode(false);
  realDos.step();
  realDos.step();
  check('DOS compatibility trap is disabled for real DOS', realDos.halted
    && realDos.error?.includes('invalid opcode F1h'), true);

  const alias = makeCPU([0xcd, 0x12, 0xf4]);
  vectorTo(alias, 0x12, BIOS_SEG - 1, serviceStubOffset(0x12) + 16);
  finish(alias);
  check('A segment alias of the BIOS ROM entry remains callable', alias.halted && !alias.error
    && alias.r[R.AX] === 640 && alias.r[R.SP] === STACK_TOP && alias.flags === CALLER_FLAGS, true);

  const signature = makeCPU([0xcd, 0x12]);
  signature.mem[(BIOS_SEG << 4) + serviceStubOffset(0x12) + 2] = 0x90;
  signature.step();
  signature.step();
  check('Firmware trap rejects a modified ROM signature', signature.halted
    && signature.error?.includes('invalid opcode F1h'), true);

  const decoded = makeCPU([]);
  const stub = serviceStubOffset(0x13);
  const readROM = (offset) => decoded.rd8((BIOS_SEG << 4) + offset);
  const service = disasm(readROM, stub, BIOS_SEG);
  const afterService = disasm(readROM, stub + service.len, BIOS_SEG);
  check('Debugger decodes a ROM service trap followed by IRET', service.text === 'firmware 13h'
    && service.len === 2 && afterService.text === 'iret' && afterService.len === 1, true);
  check('Debugger treats the same bytes in guest RAM as data',
    disasm(() => FIRMWARE_TRAP, ORIGIN, LOAD_SEG).text, 'db F1h');
}
