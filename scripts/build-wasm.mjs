import { spawnSync } from 'node:child_process';
import { copyFile, mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const result = spawnSync('cargo', [
  'build',
  '--manifest-path', resolve(root, 'wasm/Cargo.toml'),
  '--release',
  '--target', 'wasm32v1-none',
], { cwd: root, stdio: 'inherit' });

if (result.error) throw result.error;
if (result.status !== 0) process.exit(result.status ?? 1);

const compiled = resolve(root, 'wasm/target/wasm32v1-none/release/emu8086_wasm_core.wasm');
const asset = resolve(root, 'src/wasm/kernel.wasm');
await mkdir(dirname(asset), { recursive: true });
await copyFile(compiled, asset);
console.log(`WASM CPU written to ${asset}`);
