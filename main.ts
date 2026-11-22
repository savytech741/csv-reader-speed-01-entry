// Driver for the csv-reader-speed entry.
//
// The harness runs `node main.ts`. It hands the driver a directory of cases
// (cases.json: an array of {id, input}) and expects one answers.json back in
// the output directory: an array of answers, one per case, in the same order
// as the cases. Each case is answered on its own by run() from solve.js.
//
// Outside the container the two directories come from the environment:
// MAKEFUN_INPUT_DIR and MAKEFUN_OUTPUT_DIR. When neither is set the driver
// falls back to /input and /output.

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { setFlagsFromString } from 'node:v8';

// The house baseline runs with incremental marking off, and entries are
// allowed to tune V8 flags too — so switch it off here, before the solver
// module is loaded, and let the whole timed run happen under that setting.
setFlagsFromString('--no-incremental-marking');

// Dynamic import on purpose: the solver must only load after the flag above.
const solver = await import('./solve.js');

const inputDir = process.env.MAKEFUN_INPUT_DIR ?? '/input';
const outputDir = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';

const caseList = JSON.parse(readFileSync(join(inputDir, 'cases.json'), 'utf8'));

const results = [];
for (const entry of caseList) {
  results.push(solver.run(entry.input));
}

mkdirSync(outputDir, { recursive: true });
writeFileSync(join(outputDir, 'answers.json'), JSON.stringify(results));
