// node run-diagnose.js   Local check (Docker, no network) of the handler's diagnose mode. Prints the same table as
// scripts/diagnose.ps1 does for the deployed function. Locally every step is expected to work.
const c = require('./container');

c.start();
const { body } = c.invoke({ diagnose: true });
c.stop();

const modes = ['direct', 'grandchild'];
const probeOf = { direct: body.direct, grandchild: body.grandchild, 'via launcher': body.viaLauncher && body.viaLauncher.probe };
const names = [];
for (const mode of Object.keys(probeOf)) for (const r of (probeOf[mode] && probeOf[mode].results) || []) if (!names.includes(r.name)) names.push(r.name);
const cell = (mode, name) => {
  const r = ((probeOf[mode] && probeOf[mode].results) || []).find(x => x.name === name);
  return r ? (r.ok ? 'ok' : `ERR ${r.errno}${r.err ? ' ' + r.err : ''}`) : '-';
};
console.table(names.map(name => ({ probe: name.slice(0, 70), direct: cell('direct', name), grandchild: cell('grandchild', name), 'via launcher': cell('via launcher', name) })));
console.log('launcher report (via launcher):', JSON.stringify(body.viaLauncher && body.viaLauncher.launcher));

// Steps that must work in the local container (the Docker default profile allows them). Failures that are expected here:
// seccomp without no_new_privs (EACCES), and /proc/<parent>/mem when the parent is not a visible process.
const mustWork = names.filter(n => !/without no_new_privs|yama|<parent>\/mem|status|\[launcher does not use\]/.test(n));
const bad = [];
for (const mode of ['direct', 'grandchild']) for (const n of mustWork) if (cell(mode, n) !== 'ok') bad.push(`${mode}: ${n} -> ${cell(mode, n)}`);
const launcher = body.viaLauncher && body.viaLauncher.launcher;
if (!launcher || launcher.step !== 'none' || launcher.errno !== 0 || !launcher.seccomp) bad.push(`launcher report: ${JSON.stringify(launcher)}`);
if (!body.direct || !body.direct.results.length || !body.grandchild.results.length) bad.push('missing probe results');
console.log(bad.length ? `FAIL\n${bad.join('\n')}` : `OK: ${mustWork.length} steps work in direct and grandchild runs; the launcher reports step=none errno=0`);
process.exit(bad.length ? 1 : 0);
