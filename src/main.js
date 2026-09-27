import { assemble } from './asm.js';
import { disasm } from './disasm.js';
import { Machine, VRAM, COLS, ROWS, LOAD_SEG } from './machine.js';
import { initializeCPU, R, S } from './cpu.js';
import wasmUrl from './wasm/kernel.wasm?url';
import msdos5ImageUrl from '../msdos5.img?url';
import { SAMPLES } from './samples.js';

const CGA = ['#000000', '#0000aa', '#00aa00', '#00aaaa', '#aa0000', '#aa00aa', '#aa5500', '#aaaaaa',
  '#555555', '#5555ff', '#55ff55', '#55ffff', '#ff5555', '#ff55ff', '#ffff55', '#ffffff'];

const hex = (v, n) => v.toString(16).toUpperCase().padStart(n, '0');
const el = (tag, cls, txt) => { const e = document.createElement(tag); if (cls) e.className = cls; if (txt != null) e.textContent = txt; return e; };

document.querySelector('#app').innerHTML = `
<header>
  <h1>8086<span>emulator</span></h1>
  <div class="toolbar">
    <select id="samples" title="Load an example"></select>
    <button id="build" class="primary">Assemble &amp; Run</button>
    <button id="bootmsdos">Boot MS-DOS 5.0</button>
    <button id="bootfloppy">Open floppy image</button>
    <input id="floppyFile" type="file" accept=".img,.ima,.dsk,application/octet-stream" hidden />
    <button id="savefloppy" hidden disabled>Save floppy image</button>
    <button id="opendisk">Open hard disk image</button>
    <input id="hardDiskFile" type="file" accept=".img,.hdd,.raw,application/octet-stream" hidden />
    <button id="saveharddisk" hidden disabled>Save hard disk image</button>
    <button id="runpause">Run</button>
    <button id="step">Step</button>
    <button id="reset">Reset</button>
    <label class="speed">Speed
      <select id="speed">
        <option value="4">4 Hz</option>
        <option value="60">60 Hz</option>
        <option value="2000">2 kHz</option>
        <option value="200000" selected>200 kHz</option>
        <option value="0">max</option>
      </select>
    </label>
    <span id="status" class="status">idle</span>
  </div>
</header>
<main>
  <section class="pane editor-pane">
    <div class="pane-head"><span>source.asm</span><span id="asm-info"></span></div>
    <div class="editor">
      <div class="gutter" id="gutter"></div>
      <textarea id="code" spellcheck="false" autocomplete="off"></textarea>
    </div>
    <div class="errors" id="errors"></div>
  </section>
  <section class="right">
    <div class="pane screen-pane">
      <div class="pane-head"><span>display &mdash; 80&times;25 text (B800:0000)</span><span class="hint">click to type</span></div>
      <canvas id="screen" width="720" height="400" tabindex="0"></canvas>
    </div>
    <div class="pane">
      <div class="pane-head"><span>CPU</span><span id="cycles"></span></div>
      <div class="regs" id="regs"></div>
      <div class="flags" id="flags"></div>
    </div>
  </section>
  <section class="pane disasm-pane">
    <div class="pane-head"><span>disassembly</span><span class="hint">click a row for a breakpoint</span></div>
    <div class="disasm" id="disasm"></div>
  </section>
  <section class="pane mem-pane">
    <div class="pane-head">
      <span>memory</span>
      <span class="memctl">
        <input id="memaddr" value="0100:0100" size="9" spellcheck="false" />
        <button data-goto="cs">CS:IP</button>
        <button data-goto="ss">SS:SP</button>
        <button data-goto="vram">B800</button>
      </span>
    </div>
    <div class="hexdump" id="hexdump"></div>
  </section>
</main>`;

const $ = (id) => document.getElementById(id);
const wasmResponse = await fetch(wasmUrl);
if (!wasmResponse.ok) throw new Error(`failed to load WASM CPU (${wasmResponse.status})`);
await initializeCPU(await wasmResponse.arrayBuffer());
const machine = new Machine();
const cpu = machine.cpu;

// ---------- editor ----------
const code = $('code');
const gutter = $('gutter');
const samplesSel = $('samples');
SAMPLES.forEach((s, i) => samplesSel.append(new Option(s.name, String(i))));
code.value = localStorage.getItem('emu8086.src') || SAMPLES[0].code;

function syncGutter() {
  const n = code.value.split('\n').length;
  if (gutter.childElementCount !== n) {
    gutter.innerHTML = '';
    for (let i = 1; i <= n; i++) gutter.append(el('div', 'gl', String(i)));
  }
  gutter.scrollTop = code.scrollTop;
}
code.addEventListener('input', () => { syncGutter(); localStorage.setItem('emu8086.src', code.value); });
code.addEventListener('scroll', () => { gutter.scrollTop = code.scrollTop; });
code.addEventListener('keydown', (e) => {
  if (e.key === 'Tab') {
    e.preventDefault();
    const s = code.selectionStart;
    code.setRangeText('        ', s, code.selectionEnd, 'end');
  }
});
samplesSel.addEventListener('change', () => {
  const s = SAMPLES[+samplesSel.value];
  if (!s) return;
  code.value = s.code;
  localStorage.setItem('emu8086.src', code.value);
  syncGutter();
  build(true);
});
syncGutter();

// ---------- screen ----------
const canvas = $('screen');
const ctx = canvas.getContext('2d');
const CW = 9, CH = 16;
canvas.width = COLS * CW; canvas.height = ROWS * CH;
let blink = true;
setInterval(() => { blink = !blink; drawScreen(); }, 400);

function drawScreen() {
  const m = cpu.mem;
  const page = m[0x462] & 7;
  const pageBase = VRAM + page * 0x1000;
  ctx.fillStyle = '#000';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.font = `${CH - 2}px "DejaVu Sans Mono", "Courier New", monospace`;
  ctx.textBaseline = 'top';
  for (let y = 0; y < ROWS; y++) {
    for (let x = 0; x < COLS; x++) {
      const i = pageBase + (y * COLS + x) * 2;
      const ch = m[i], at = m[i + 1];
      const bg = CGA[(at >> 4) & 7], fg = CGA[at & 0x0f];
      if (bg !== '#000000') { ctx.fillStyle = bg; ctx.fillRect(x * CW, y * CH, CW, CH); }
      if (ch !== 32 && ch !== 0) {
        ctx.fillStyle = fg;
        ctx.fillText(cp437(ch), x * CW + 1, y * CH + 1);
      }
    }
  }
  if (blink && document.activeElement === canvas) {
    const cursor = cpu.rd16(0x450 + page * 2);
    const cx = cursor & 0xff, cy = cursor >> 8;
    ctx.fillStyle = '#c9d1ff';
    ctx.fillRect(cx * CW, cy * CH + CH - 3, CW, 2);
  }
}
const CP437_HIGH = 'ÇüéâäàåçêëèïîìÄÅÉæÆôöòûùÿÖÜ¢£¥₧ƒáíóúñÑªº¿⌐¬½¼¡«»░▒▓│┤╡╢╖╕╣║╗╝╜╛┐└┴┬├─┼╞╟╚╔╩╦╠═╬╧╨╤╥╙╘╒╓╫╪┘┌█▄▌▐▀αßΓπΣσµτΦΘΩδ∞φε∩≡±≥≤⌠⌡÷≈°∙·√ⁿ²■ ';
function cp437(c) {
  if (c >= 32 && c < 127) return String.fromCharCode(c);
  if (c >= 128) return CP437_HIGH[c - 128] || ' ';
  return ['', '☺', '☻', '♥', '♦', '♣', '♠', '•', '◘', '○', '◙', '♂', '♀', '♪', '♫', '☼',
    '►', '◄', '↕', '‼', '¶', '§', '▬', '↨', '↑', '↓', '→', '←', '∟', '↔', '▲', '▼'][c] || ' ';
}

canvas.addEventListener('keydown', (e) => {
  if (e.metaKey || e.ctrlKey) return;
  let c = -1;
  if (e.key.length === 1) c = e.key.charCodeAt(0);
  else if (e.key === 'Enter') c = 13;
  else if (e.key === 'Backspace') c = 8;
  else if (e.key === 'Tab') c = 9;
  else if (e.key === 'Escape') c = 27;
  const scans = {
    Enter: 0x1c, Backspace: 0x0e, Tab: 0x0f, Escape: 0x01,
    ArrowUp: 0x48, ArrowDown: 0x50, ArrowLeft: 0x4b, ArrowRight: 0x4d,
    Home: 0x47, End: 0x4f, PageUp: 0x49, PageDown: 0x51, Insert: 0x52, Delete: 0x53,
    F1: 0x3b, F2: 0x3c, F3: 0x3d, F4: 0x3e, F5: 0x3f, F6: 0x40,
    F7: 0x41, F8: 0x42, F9: 0x43, F10: 0x44, F11: 0x57, F12: 0x58,
    a: 0x1e, b: 0x30, c: 0x2e, d: 0x20, e: 0x12, f: 0x21, g: 0x22, h: 0x23, i: 0x17,
    j: 0x24, k: 0x25, l: 0x26, m: 0x32, n: 0x31, o: 0x18, p: 0x19, q: 0x10, r: 0x13,
    s: 0x1f, t: 0x14, u: 0x16, v: 0x2f, w: 0x11, x: 0x2d, y: 0x15, z: 0x2c,
    '1': 0x02, '2': 0x03, '3': 0x04, '4': 0x05, '5': 0x06, '6': 0x07,
    '7': 0x08, '8': 0x09, '9': 0x0a, '0': 0x0b,
  };
  if (c >= 0 || scans[e.key]) {
    e.preventDefault();
    machine.keyPress(c < 0 ? 0 : c, scans[e.key.toLowerCase()] || scans[e.key] || 0);
    if (!running && cpu.waiting) { running = true; setStatus('running'); }
  }
});

// ---------- registers ----------
const REGNAMES = ['AX', 'CX', 'DX', 'BX', 'SP', 'BP', 'SI', 'DI'];
const SEGNAMES = ['ES', 'CS', 'SS', 'DS'];
const regEls = {};
function buildRegs() {
  const order = ['AX', 'BX', 'CX', 'DX', 'SI', 'DI', 'BP', 'SP', 'CS', 'DS', 'ES', 'SS', 'IP', 'FL'];
  const box = $('regs');
  box.innerHTML = '';
  for (const n of order) {
    const d = el('div', 'reg');
    d.append(el('span', 'rn', n));
    const v = el('span', 'rv', '0000');
    d.append(v);
    regEls[n] = { v, d };
    box.append(d);
  }
  const fbox = $('flags');
  fbox.innerHTML = '';
  for (const f of ['OF', 'DF', 'IF', 'TF', 'SF', 'ZF', 'AF', 'PF', 'CF']) {
    const b = el('span', 'flag', f);
    regEls[f] = { v: b };
    fbox.append(b);
  }
}
buildRegs();

let prev = {};
function updateRegs() {
  const vals = {};
  REGNAMES.forEach((n, i) => (vals[n] = cpu.r[i]));
  SEGNAMES.forEach((n, i) => (vals[n] = cpu.s[i]));
  vals.IP = cpu.ip; vals.FL = cpu.flags;
  for (const [n, o] of Object.entries(vals)) {
    const t = hex(o, 4);
    if (regEls[n].v.textContent !== t) {
      regEls[n].v.textContent = t;
      regEls[n].d.classList.add('changed');
      setTimeout(() => regEls[n].d.classList.remove('changed'), 350);
    }
  }
  const f = cpu.f;
  const on = { OF: f.of, DF: f.df, IF: f.if, TF: f.tf, SF: f.sf, ZF: f.zf, AF: f.af, PF: f.pf, CF: f.cf };
  for (const [k, v] of Object.entries(on)) regEls[k].v.classList.toggle('on', !!v);
  $('cycles').textContent = `${cpu.cycles.toLocaleString()} instr`;
}

// ---------- disassembly ----------
function updateDisasm() {
  const box = $('disasm');
  box.innerHTML = '';
  let off = cpu.ip;
  const base = cpu.s[S.CS];
  for (let i = 0; i < 18; i++) {
    const at = off;
    const d = disasm((p) => cpu.mem[((base << 4) + (p & 0xffff)) & 0xfffff], off);
    const row = el('div', 'drow' + (i === 0 ? ' cur' : '') + (machine.breakpoints.has(at) ? ' bp' : ''));
    row.append(el('span', 'bpdot', machine.breakpoints.has(at) ? '\u25cf' : ''));
    row.append(el('span', 'daddr', `${hex(base, 4)}:${hex(at, 4)}`));
    row.append(el('span', 'dbytes', d.bytes.map((b) => hex(b, 2)).join(' ')));
    row.append(el('span', 'dtext', d.text));
    row.onclick = () => {
      if (machine.breakpoints.has(at)) machine.breakpoints.delete(at); else machine.breakpoints.add(at);
      updateDisasm();
    };
    box.append(row);
    off = (off + d.len) & 0xffff;
  }
}

// ---------- memory ----------
let memBase = (LOAD_SEG << 4) + 0x100;
$('memaddr').addEventListener('change', () => {
  const t = $('memaddr').value.trim();
  const m = /^([0-9a-f]{1,4}):([0-9a-f]{1,4})$/i.exec(t);
  if (m) memBase = (parseInt(m[1], 16) << 4) + parseInt(m[2], 16);
  else if (/^[0-9a-f]{1,5}$/i.test(t)) memBase = parseInt(t, 16);
  updateMem();
});
document.querySelectorAll('[data-goto]').forEach((b) => b.addEventListener('click', () => {
  const k = b.dataset.goto;
  if (k === 'cs') { memBase = (cpu.s[S.CS] << 4) + cpu.ip; $('memaddr').value = `${hex(cpu.s[S.CS], 4)}:${hex(cpu.ip, 4)}`; }
  if (k === 'ss') { memBase = (cpu.s[S.SS] << 4) + cpu.r[R.SP]; $('memaddr').value = `${hex(cpu.s[S.SS], 4)}:${hex(cpu.r[R.SP], 4)}`; }
  if (k === 'vram') { memBase = VRAM; $('memaddr').value = 'B800:0000'; }
  updateMem();
}));

function updateMem() {
  const box = $('hexdump');
  let html = '';
  const start = memBase & 0xffff0;
  for (let row = 0; row < 12; row++) {
    const a = (start + row * 16) & 0xfffff;
    let h = '', t = '';
    for (let i = 0; i < 16; i++) {
      const b = cpu.mem[(a + i) & 0xfffff];
      h += `<span class="${b ? '' : 'z'}">${hex(b, 2)}</span> `;
      t += b >= 32 && b < 127 ? String.fromCharCode(b).replace('&', '&amp;').replace('<', '&lt;') : '.';
    }
    html += `<div class="hrow"><span class="haddr">${hex(a, 5)}</span><span class="hbytes">${h}</span><span class="hascii">${t}</span></div>`;
  }
  box.innerHTML = html;
}

// ---------- assemble / run ----------
let running = false;
let symbolAddrs = new Map();

function setStatus(s, kind = '') {
  const e = $('status');
  e.textContent = s;
  e.className = 'status ' + kind;
}

function build(autorun) {
  const res = assemble(code.value);
  const errBox = $('errors');
  errBox.innerHTML = '';
  if (!res.ok) {
    for (const e of res.errors) {
      const d = el('div', 'err', `line ${e.line}: ${e.message}`);
      d.onclick = () => focusLine(e.line);
      errBox.append(d);
    }
    setStatus(`${res.errors.length} error${res.errors.length > 1 ? 's' : ''}`, 'bad');
    $('asm-info').textContent = '';
    return false;
  }
  machine.load(res.bytes, res.origin);
  symbolAddrs = new Map(Object.entries(res.symbols).filter(([k, v]) => k !== '__here' && typeof v === 'number'));
  $('asm-info').textContent = `${res.bytes.length} bytes @ ${hex(LOAD_SEG, 4)}:${hex(res.origin, 4)}`;
  setStatus(autorun ? 'running' : 'loaded', 'ok');
  running = !!autorun;
  refresh();
  if (autorun) canvas.focus();
  return true;
}

function focusLine(n) {
  const lines = code.value.split('\n');
  let pos = 0;
  for (let i = 0; i < n - 1 && i < lines.length; i++) pos += lines[i].length + 1;
  code.focus();
  code.setSelectionRange(pos, pos + (lines[n - 1] || '').length);
}

function refresh() {
  updateRegs(); updateDisasm(); updateMem(); drawScreen();
  $('runpause').textContent = running ? 'Pause' : 'Run';
  $('savefloppy').hidden = !machine.floppyImage;
  $('savefloppy').disabled = !machine.diskDirty;
  $('saveharddisk').hidden = !machine.hardDiskAttached;
  $('saveharddisk').disabled = !machine.hardDiskDirty;
}

$('build').onclick = () => build(true);
$('bootfloppy').onclick = () => $('floppyFile').click();
$('opendisk').onclick = () => $('hardDiskFile').click();
function startFloppyImage(image, name) {
  const geometry = machine.bootFloppy(image);
  machine.floppyName = name;
  symbolAddrs.clear();
  $('asm-info').textContent = `${name} · ${geometry.cylinders} cylinders, ${geometry.heads} heads, ${geometry.sectorsPerTrack} sectors/track`;
  running = true;
  setStatus(`booting ${name}`, 'ok');
  canvas.focus();
  refresh();
}
$('bootmsdos').onclick = async () => {
  try {
    const response = await fetch(msdos5ImageUrl);
    if (!response.ok) throw new Error(`could not load bundled MS-DOS image (${response.status})`);
    startFloppyImage(new Uint8Array(await response.arrayBuffer()), 'msdos5.img');
  } catch (error) {
    setStatus(error.message || String(error), 'bad');
  }
};
$('floppyFile').addEventListener('change', async () => {
  const file = $('floppyFile').files?.[0];
  if (!file) return;
  try {
    startFloppyImage(new Uint8Array(await file.arrayBuffer()), file.name);
  } catch (error) {
    setStatus(error.message || String(error), 'bad');
  } finally {
    $('floppyFile').value = '';
  }
});
$('hardDiskFile').addEventListener('change', async () => {
  const file = $('hardDiskFile').files?.[0];
  if (!file) return;
  try {
    const geometry = machine.attachHardDisk(new Uint8Array(await file.arrayBuffer()), file.name);
    $('asm-info').textContent = `${file.name} · ${geometry.cylinders} cylinders, ${geometry.heads} heads, ${geometry.sectorsPerTrack} sectors/track`;
    setStatus(`attached ${file.name}`, 'ok');
    refresh();
  } catch (error) {
    setStatus(error.message || String(error), 'bad');
  } finally {
    $('hardDiskFile').value = '';
  }
});
function saveDiskImage(drive) {
  const disk = drive === 0 ? machine.floppyDisk : machine.hardDisk;
  if (!disk?.dirty) return;
  const blob = new Blob([disk.bytes], { type: 'application/octet-stream' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = drive === 0
    ? (machine.floppyName || 'floppy.img')
    : (machine.hardDiskName || 'harddisk.img');
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 0);
  machine.markDiskSaved(drive);
  refresh();
}
$('savefloppy').onclick = () => saveDiskImage(0);
$('saveharddisk').onclick = () => saveDiskImage(0x80);
$('step').onclick = () => { running = false; machine.step(); afterStop(); refresh(); };
$('reset').onclick = () => { running = false; machine.reload(); setStatus('reset'); refresh(); };
$('runpause').onclick = () => {
  if (cpu.halted) { machine.reload(); }
  running = !running;
  setStatus(running ? 'running' : 'paused', running ? 'ok' : '');
  if (running) canvas.focus();
  refresh();
};

function afterStop() {
  if (cpu.error) setStatus(cpu.error, 'bad');
  else if (cpu.exited) setStatus(`program exited (code ${cpu.exitCode})`, 'ok');
  else if (cpu.halted) setStatus('halted', '');
}

let lastFrame = performance.now();
function frame(now) {
  const dt = Math.min(now - lastFrame, 100) / 1000;
  lastFrame = now;
  if (running && !cpu.halted) {
    const hz = +$('speed').value;
    const budget = hz === 0 ? 400000 : Math.max(1, Math.round(hz * dt));
    const r = machine.run(budget);
    if (r === 'halted') { running = false; afterStop(); }
    else if (r === 'breakpoint') { running = false; setStatus(`breakpoint at ${hex(cpu.ip, 4)}`, 'ok'); }
    else if (r === 'input') { setStatus('waiting for keyboard input…', 'wait'); }
    else if ($('status').textContent.startsWith('waiting')) setStatus('running', 'ok');
    refresh();
  }
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);

document.addEventListener('keydown', (e) => {
  if (e.key === 'F8' || (e.key === 'Enter' && (e.ctrlKey || e.metaKey))) { e.preventDefault(); build(true); }
  if (e.key === 'F10') { e.preventDefault(); running = false; machine.step(); afterStop(); refresh(); }
});

build(false);
refresh();
