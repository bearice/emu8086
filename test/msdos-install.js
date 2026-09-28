import { Machine, VRAM, COLS, ROWS } from '../src/machine.js';
import { R, S } from '../src/cpu.js';

const KEY_SCANS = {
  A: 0x1e, B: 0x30, C: 0x2e, D: 0x20, E: 0x12, F: 0x21, G: 0x22, H: 0x23,
  I: 0x17, J: 0x24, K: 0x25, L: 0x26, M: 0x32, N: 0x31, O: 0x18, P: 0x19,
  Q: 0x10, R: 0x13, S: 0x1f, T: 0x14, U: 0x16, V: 0x2f, W: 0x11, X: 0x2d,
  Y: 0x15, Z: 0x2c, ' ': 0x39, '.': 0x34, '>': 0x34, '\\': 0x2b,
};

function sendCommand(machine, line) {
  for (const character of line) machine.keyPress(character.charCodeAt(0), KEY_SCANS[character.toUpperCase()]);
  machine.keyPress(13, 0x1c);
}

function atCommandPrompt(text) {
  return /^C(?:>|:\\[^\n>]*>)$/.test(text.trimEnd().split('\n').at(-1));
}

function runToPrompt(machine, expected = '') {
  for (let batch = 0; batch < 2000 && !machine.cpu.error && !machine.cpu.halted; batch++) {
    machine.run(10_000);
    const text = screenText(machine.cpu);
    if (batch >= 3 && machine.kbd.length === 0 && atCommandPrompt(text) && text.includes(expected)) return text;
  }
  return '';
}

function screenText(cpu) {
  const base = VRAM + (cpu.mem[0x462] & 7) * 0x1000;
  return Array.from({ length: ROWS }, (_, row) => Array.from({ length: COLS }, (_, column) => {
    const character = cpu.mem[base + (row * COLS + column) * 2];
    return character >= 32 && character < 127 ? String.fromCharCode(character) : ' ';
  }).join('').trimEnd()).join('\n');
}

export function verifyMsDosInstallation(check, image) {
  const machine = new Machine();
  machine.bootFloppy(image);
  const cpu = machine.cpu;
  const prompts = ['Welcome to Setup.', 'The settings are correct.',
    'The listed options are correct.', 'Allocate all free hard disk space for MS-DOS.'];
  let phase = 0;
  let rebooted = false;
  let installed = false;
  let shellDisabled = false;
  for (let batch = 0; batch < 30_000 && !cpu.error && !cpu.halted; batch++) {
    const previousCycles = cpu.cycles;
    machine.run(10_000);
    if (cpu.cycles < previousCycles) rebooted = true;
    if (!cpu.waiting) continue;
    const text = screenText(cpu);
    if (phase < prompts.length && text.includes(prompts[phase])) {
      if (phase === 2) {
        machine.keyPress(0, 0x48); // Select Run Shell on startup.
        phase = 20;
      } else {
        machine.keyPress(13, 0x1c);
        phase++;
      }
    } else if (phase === 20) {
      machine.keyPress(13, 0x1c);
      phase = 21;
    } else if (phase === 21 && text.includes('Do not run MS-DOS Shell on startup')) {
      machine.keyPress(0, 0x50);
      phase = 22;
    } else if (phase === 22) {
      machine.keyPress(13, 0x1c);
      phase = 23;
    } else if (phase === 23 && text.includes('Run Shell on startup     : NO')) {
      shellDisabled = true;
      machine.keyPress(0, 0x50);
      phase = 24;
    } else if (phase === 24) {
      machine.keyPress(13, 0x1c);
      phase = 3;
    } else if (text.includes('Enter new date') || text.includes('Enter new time')) {
      machine.keyPress(13, 0x1c);
    } else if (phase === prompts.length) {
      installed = text.includes('Setup is now complete.');
      break;
    }
  }
  check('MS-DOS Setup partitions, reboots, formats, and finishes installation', installed
    && rebooted && !cpu.error && !cpu.halted, true);
  check('Setup installs for command-line startup', shellDisabled, true);
  const disk = machine.hardDisk.bytes;
  const partitionLba = (disk[454] | (disk[455] << 8) | (disk[456] << 16) | (disk[457] << 24)) >>> 0;
  check('Setup creates an active FAT16 partition', disk[446] === 0x80 && disk[450] === 0x04
    && partitionLba === 17 && disk[510] === 0x55 && disk[511] === 0xaa, true);
  const volume = partitionLba * 512;
  check('Setup formats a bootable FAT16 volume', disk[volume + 11] === 0 && disk[volume + 12] === 2
    && disk[volume + 510] === 0x55 && disk[volume + 511] === 0xaa, true);
  check('Machine can eject the installer floppy', typeof machine.ejectFloppy, 'function');
  if (!installed || typeof machine.ejectFloppy !== 'function') return;
  machine.ejectFloppy();
  machine.keyPress(13, 0x1c);
  const prompt = runToPrompt(machine);
  check('Installed MS-DOS boots from C: after ejecting floppy', !!prompt && !cpu.error, true);
  if (!prompt) return;
  sendCommand(machine, 'DIR DOS\\COMMAND.COM');
  const directory = runToPrompt(machine, 'COMMAND  COM');
  sendCommand(machine, 'DIR DOS\\FORMAT.COM');
  const formatDirectory = runToPrompt(machine, 'FORMAT   COM');
  check('C: DIR lists installed COMMAND.COM and FORMAT.COM', directory.includes('COMMAND  COM')
    && formatDirectory.includes('FORMAT   COM'), true);
  const marker = 'EMU C DRIVE WRITE OK';
  sendCommand(machine, `ECHO ${marker} > CHECK.TXT`);
  check('C: ECHO writes a file', !!runToPrompt(machine), true);
  sendCommand(machine, 'TYPE CHECK.TXT');
  check('C: TYPE reads back the written file', !!runToPrompt(machine, marker), true);

  const savedDisk = machine.hardDisk.bytes.slice();
  const restored = new Machine();
  restored.attachHardDisk(savedDisk);
  restored.bootHardDisk();
  check('Saved installed hard-disk image boots without a floppy', !!runToPrompt(restored)
    && restored.bootDrive === 0x80 && !restored.cpu.error, true);
  sendCommand(restored, 'TYPE CHECK.TXT');
  check('Hard-disk file contents survive image reload', !!runToPrompt(restored, marker), true);

  restored.cpu.mem.set([0xcd, 0x19], 0x10100);
  restored.cpu.s[S.CS] = 0x1000;
  restored.cpu.ip = 0x100;
  restored.step();
  check('BIOS INT 19h falls back to the installed hard disk', restored.cpu.s[S.CS] === 0
    && restored.cpu.ip === 0x7c00 && restored.cpu.r[R.DX] === 0x80 && !restored.cpu.halted, true);
  return machine;
}
