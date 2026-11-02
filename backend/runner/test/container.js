// Test helper: runs the runner image the way Lambda would (no network, read-only root, tmpfs /tmp,
// 1769 MB, one CPU, non-root user) with FAKE credentials in the environment, and talks to it by
// exec'ing node inside the container (port publishing is impossible with --network none).
const { execFileSync, spawnSync } = require('child_process');

const NAME = 'runner-t';
const IMAGE = 'cpp-runner:test';
const UID = 1051;
const FAKE_SECRET = 'FAKE-SECRET-VALUE-12345';

const b64 = src => `eval(Buffer.from('${Buffer.from(src).toString('base64')}','base64').toString())`;
const docker = (args, opts = {}) => execFileSync('docker', args, { encoding: 'utf-8', maxBuffer: 64 * 1024 * 1024, ...opts });

const INVOKE_SRC = `
let d='';process.stdin.on('data',c=>d+=c);process.stdin.on('end',()=>{
const r=require('http').request({host:'127.0.0.1',port:8080,method:'POST',path:'/2015-03-31/functions/function/invocations'},res=>{let b='';res.on('data',c=>b+=c);res.on('end',()=>process.stdout.write(b))});
r.on('error',e=>process.stdout.write(JSON.stringify({transportError:e.message})));r.end(d)})`;

const PS_SRC = `
const fs=require('fs');const out=[];
for(const n of fs.readdirSync('/proc').filter(x=>/^\d+$/.test(x))){try{
const s=fs.readFileSync('/proc/'+n+'/status','utf-8');
out.push({pid:+n,comm:/^Name:\s+(.*)$/m.exec(s)[1],uid:+/^Uid:\s+(\d+)/m.exec(s)[1],state:/^State:\s+(\S)/m.exec(s)[1]})}catch{}}
process.stdout.write(JSON.stringify({ps:out,tmp:fs.readdirSync('/tmp')}))`;

function start({ seccompUnconfined = false, noLandlock = false } = {}) {
  stop();
  const args = ['run', '-d', '--name', NAME, '--network', 'none', '--read-only', '--tmpfs', '/tmp:rw,exec,mode=1777,size=512m',
    '--user', String(UID), '--memory', '1769m', '--cpus', '1',
    '-e', `AWS_SECRET_ACCESS_KEY=${FAKE_SECRET}`, '-e', 'AWS_SESSION_TOKEN=FAKE-TOKEN-ABC', '-e', 'AWS_ACCESS_KEY_ID=FAKEKEYID'];
  if (seccompUnconfined) args.push('--security-opt', 'seccomp=unconfined');
  if (noLandlock) args.push('--security-opt', `seccomp=${require('path').join(__dirname, 'seccomp-no-landlock.json')}`);
  docker([...args, IMAGE]);
  spawnSync('node', ['-e', 'setTimeout(()=>{},2500)']);
}

function stop() {
  spawnSync('docker', ['rm', '-f', NAME], { stdio: 'ignore' });
}

function invoke(event, timeoutMs = 120000) {
  const t0 = Date.now();
  const res = spawnSync('docker', ['exec', '-i', '-u', '0', NAME, 'node', '-e', b64(INVOKE_SRC)], {
    input: JSON.stringify(event), encoding: 'utf-8', maxBuffer: 64 * 1024 * 1024, timeout: timeoutMs
  });
  const wallMs = Date.now() - t0;
  let body;
  try { body = JSON.parse(res.stdout); } catch { body = { transportError: (res.stdout || res.stderr || 'no output').slice(0, 300) }; }
  return { body, wallMs };
}

/** Root's view of the container: processes owned by the runner user and what is left in /tmp. */
function inspect() {
  const out = JSON.parse(docker(['exec', '-u', '0', NAME, 'node', '-e', b64(PS_SRC)]));
  const allowed = new Set(['node', 'aws-lambda-rie', 'bootstrap', 'MainThread']);
  const strangers = out.ps.filter(p => p.uid === UID && p.state !== 'Z' && !allowed.has(p.comm));
  return { strangers: strangers.map(p => `${p.comm}(${p.pid})`), tmp: out.tmp };
}

function running() {
  try { return docker(['inspect', '-f', '{{.State.Running}}', NAME]).trim() === 'true'; } catch { return false; }
}

const logs = () => docker(['logs', NAME], { stdio: ['ignore', 'pipe', 'pipe'] });

module.exports = { running, start, stop, invoke, inspect, logs, FAKE_SECRET, NAME };
