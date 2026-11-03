// node run-timing.js   cold and warm timing of one call with 5 runs (container limited to 1 CPU, 1769 MB)
const c = require('./container');

const event = {
  source: '#include <iostream>\n#include <vector>\n#include <algorithm>\nint main(){int n; std::cin>>n; std::vector<int> v(n); for(int i=0;i<n;i++) v[i]=(i*7919)%10007; std::sort(v.begin(),v.end()); long long s=0; for(int x: v) s+=x; std::cout<<s<<"\\n";}',
  runs: [1000, 2000, 5000, 10000, 20000].map(n => ({ stdin: String(n) })),
  timeLimitMs: 2000,
  memoryLimitKb: 256000
};

const t0 = Date.now();
c.start();
const startMs = Date.now() - t0;
const cold = c.invoke(event);
const warm = Array.from({ length: 8 }, () => c.invoke(event));

const ms = x => x.wallMs;
const warmMs = warm.map(ms).sort((a, b) => a - b);
console.log(JSON.stringify({
  containerStartMs: startMs,
  coldCallMs: ms(cold),
  warmCallMs: warm.map(ms),
  warmMedianMs: warmMs[Math.floor(warmMs.length / 2)],
  warmMaxMs: warmMs[warmMs.length - 1],
  statuses: cold.body.results.map(r => r.status),
  diagnosticsWarm: warm[warm.length - 1].body.diagnostics
}, null, 1));
c.stop();
