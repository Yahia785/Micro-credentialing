#!/usr/bin/env node
// Makes ONE C++ source file from functions.h + functions.cpp + driver/main.cpp, because the runner
// accepts a single source file only. The `#include "functions.h"` lines are removed from the .cpp
// and from the driver (the header text is already at the top of the file).
//
//   node build.js <dir>                      dir has functions.h and functions.cpp   -> prints to stdout
//   node build.js <dir> --out combined.cpp
//   node build.js <dir> --cpp other.cpp      use another .cpp with the header in <dir> (what-if / trace copies)
const fs = require('fs');
const path = require('path');

const DRIVER = path.join(__dirname, 'driver', 'main.cpp');
const LOCAL_INCLUDE = /^[ \t]*#[ \t]*include[ \t]*"functions\.h"[ \t]*\r?\n?/gm;

function build(dir, cppPath) {
  const header = fs.readFileSync(path.join(dir, 'functions.h'), 'utf8');
  const impl = fs.readFileSync(cppPath || path.join(dir, 'functions.cpp'), 'utf8');
  const driver = fs.readFileSync(DRIVER, 'utf8');
  return [
    '// ---- functions.h ----',
    header.trimEnd(),
    '',
    '// ---- functions.cpp ----',
    impl.replace(LOCAL_INCLUDE, '').trim(),
    '',
    '// ---- driver/main.cpp ----',
    driver.replace(LOCAL_INCLUDE, '').trim(),
    '',
  ].join('\n');
}

module.exports = { build };

if (require.main === module) {
  const args = process.argv.slice(2);
  const opt = (name) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : null; };
  const dir = args.find((a, i) => !a.startsWith('--') && !(i > 0 && args[i - 1].startsWith('--')));
  if (!dir) {
    console.error('usage: node build.js <dir> [--cpp file] [--out file]');
    process.exit(2);
  }
  const source = build(path.resolve(dir), opt('--cpp') && path.resolve(opt('--cpp')));
  if (opt('--out')) fs.writeFileSync(opt('--out'), source);
  else process.stdout.write(source);
}
