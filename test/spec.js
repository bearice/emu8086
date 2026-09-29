// Standards conformance suites (8086 CPU + PC BIOS).
//
// Run directly for a fast, focused pass:  node test/spec.js
// test/run.js also imports and runs everything here.
import { readFile } from 'node:fs/promises';
import { initializeCPU } from '../src/cpu.js';
import { runCpuArith } from './spec-cpu-arith.js';
import { runBiosStandard } from './spec-bios.js';

if (process.argv[1] && process.argv[1].endsWith('spec.js')) {
  await initializeCPU(await readFile(new URL('../src/wasm/kernel.wasm', import.meta.url)));
}

let fail = 0;
const check = (name, got, want) => {
  const ok = got === want;
  if (!ok) fail++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : `\n   got:  ${JSON.stringify(got)}\n   want: ${JSON.stringify(want)}`}`);
};

/** Run every standards conformance suite, reporting through `check`. */
export function runSpecSuites(report = check) {
  return runCpuArith(report) + runBiosStandard(report);
}

// Standalone: node test/spec.js
if (process.argv[1] && process.argv[1].endsWith('spec.js')) {
  const failures = runSpecSuites();
  console.log(failures ? `\n${failures} failing` : '\nall green');
  process.exit(failures ? 1 : 0);
}
