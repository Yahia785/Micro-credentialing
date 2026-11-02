// Hostile programs. Each must end with the expected status, stay inside the limits, and leave no
// process and no file behind. `expectedOutput` is what a well-behaved sandbox makes the program print.
const SECRET = 'FAKE-SECRET-VALUE-12345';

const base = { timeLimitMs: 1000, memoryLimitKb: 128000, stdin: '' };

module.exports = [
  { name: 'infinite loop', expect: 'time_limit', maxWallMs: 4000,
    source: `int main(){ volatile unsigned long x=0; while(true){ x++; } }` },

  { name: 'sleep', expect: 'time_limit', maxWallMs: 4000,
    source: `#include <unistd.h>\nint main(){ sleep(1000); }` },

  { name: 'memory bomb', expect: 'memory_limit', maxWallMs: 6000,
    source: `#include <cstring>\n#include <cstdlib>\nint main(){ while(true){ char* p=(char*)malloc(1<<20); if(!p) return 3; memset(p,1,1<<20); } }` },

  { name: 'memory bomb (new, bad_alloc)', expect: 'memory_limit', maxWallMs: 6000,
    source: `#include <cstring>\nint main(){ while(true){ char* p=new char[1<<20]; memset(p,1,1<<20); } }` },

  { name: 'fork bomb', expect: 'time_limit', maxWallMs: 6000,
    source: `#include <unistd.h>\nint main(){ while(true){ fork(); } }` },

  { name: 'output flood', expect: 'runtime_error', maxWallMs: 6000, check: r => r.stdout.length <= 1024 * 1024,
    source: `#include <cstdio>\nint main(){ while(true){ putchar('a'); } }` },

  { name: 'stderr flood', expect: 'time_limit', maxWallMs: 6000, check: r => r.stderr.length <= 64 * 1024,
    source: `#include <cstdio>\nint main(){ while(true){ fputc('e', stderr); } }` },

  { name: 'socket connect', expect: 'accepted', expectedOutput: 'blocked',
    source: `#include <sys/socket.h>\n#include <netinet/in.h>\n#include <arpa/inet.h>\n#include <cstdio>\nint main(){ int s=socket(AF_INET,SOCK_STREAM,0); sockaddr_in a{}; a.sin_family=AF_INET; a.sin_port=htons(80); inet_pton(AF_INET,"1.1.1.1",&a.sin_addr); if(s>=0 && connect(s,(sockaddr*)&a,sizeof a)==0){ puts("CONNECTED"); } else puts("blocked"); }` },

  { name: 'curl via system()', expect: 'accepted', expectedOutput: 'blocked',
    source: `#include <cstdlib>\n#include <cstdio>\nint main(){ int rc=system("curl -m 2 http://1.1.1.1 >/dev/null 2>&1"); puts(rc==0 ? "FETCHED" : "blocked"); }` },

  { name: 'read /proc/*/environ for the secret', expect: 'accepted', expectedOutput: 'safe',
    source: `#include <cstdio>\n#include <string>\n#include <fstream>\n#include <sstream>\nint main(){ bool leak=false; for(int pid=1; pid<400; pid++){ std::ifstream f("/proc/"+std::to_string(pid)+"/environ", std::ios::binary); std::stringstream ss; ss<<f.rdbuf(); if(ss.str().find("${SECRET}")!=std::string::npos) leak=true; } std::ifstream me("/proc/self/environ"); puts(leak ? "LEAK" : "safe"); }` },

  { name: 'read own and parent environment', expect: 'accepted', expectedOutput: 'empty',
    source: `#include <cstdio>\n#include <cstdlib>\nextern char** environ;\nint main(){ int n=0; for(char** e=environ; e && *e; e++) n++; puts(n==0 && !getenv("AWS_SECRET_ACCESS_KEY") ? "empty" : "HAS ENV"); }` },

  { name: 'read /etc/passwd, /etc/hostname, /proc/meminfo', expect: 'accepted', expectedOutput: 'denied',
    source: `#include <cstdio>\n#include <initializer_list>\nint main(){ int ok=0; for(const char* p : std::initializer_list<const char*>{"/etc/passwd","/etc/hostname","/proc/meminfo","/var/task/index.js","/proc/self/status"}){ FILE* f=fopen(p,"r"); if(f){ ok++; fclose(f);} } puts(ok? "READABLE":"denied"); }` },

  { name: 'write outside the work folder', expect: 'accepted', expectedOutput: 'denied',
    source: `#include <cstdio>\n#include <initializer_list>\n#include <sys/stat.h>\nint main(){ int ok=0; for(const char* p : std::initializer_list<const char*>{"/var/task/x","/etc/x","/usr/x","/tmp/x","/tmp/other/x","/x"}){ FILE* f=fopen(p,"w"); if(f){ ok++; fclose(f);} } mkdir("/tmp/dir",0777); puts(ok? "WROTE":"denied"); }` },

  { name: 'popen(env) sees no AWS variables', expect: 'accepted', expectedOutput: '0',
    source: `#include <cstdio>
int main(){ FILE* p=popen("/usr/bin/env | /usr/bin/grep -c AWS","r"); char b[16]={0}; if(p) fgets(b,sizeof b,p); fputs(b,stdout); }` },

  { name: 'stack overflow', expect: 'runtime_error', maxWallMs: 6000,
    source: `int f(int n){ volatile char buf[4096]; buf[0]=n; return f(n+1)+buf[0]; }\nint main(){ return f(0); }` },

  { name: 'null dereference', expect: 'runtime_error',
    source: `int main(){ int* p=nullptr; *p=1; return *p; }` },

  { name: 'open-file limit', expect: 'accepted', expectedOutput: 'limited',
    source: `#include <fcntl.h>\n#include <cstdio>\nint main(){ int n=0; while(open("/dev/null",O_RDONLY)>=0 && n<100000) n++; puts(n<100 ? "limited" : "UNLIMITED"); }` },

  { name: 'huge file write (16 MB cap)', expect: 'runtime_error', maxWallMs: 8000,
    source: `#include <cstdio>\n#include <cstring>\nint main(){ FILE* f=fopen("big.bin","w"); char b[1<<16]; memset(b,1,sizeof b); for(int i=0;i<4000;i++){ fwrite(b,1,sizeof b,f); fflush(f);} }` },

  { name: 'fill /tmp with many files', expect: 'any', maxWallMs: 8000,
    source: `#include <cstdio>\n#include <string>\n#include <cstring>\nint main(){ char b[1<<20]; memset(b,1,sizeof b); for(int i=0;i<2000;i++){ FILE* f=fopen(("f"+std::to_string(i)).c_str(),"w"); if(!f) break; fwrite(b,1,sizeof b,f); fclose(f);} puts("done"); }` },

  { name: 'leaves a background process (fork + sleep)', expect: 'accepted', expectedOutput: 'parent done', maxWallMs: 4000, expectLeftoversKilled: true,
    source: `#include <unistd.h>\n#include <cstdio>\nint main(){ if(fork()==0){ sleep(100000); _exit(0); } puts("parent done"); }` },

  { name: 'daemon: double fork + setsid escapes the process group', expect: 'accepted', expectedOutput: 'parent done', maxWallMs: 4000, expectLeftoversKilled: true,
    source: `#include <unistd.h>\n#include <cstdio>\n#include <cstdlib>\nint main(){ if(fork()==0){ setsid(); if(fork()==0){ for(;;) sleep(1000); } _exit(0); } usleep(100000); puts("parent done"); }` },

  { name: 'busy background child outlives the parent', expect: 'accepted', expectedOutput: 'parent done', maxWallMs: 4000, expectLeftoversKilled: true,
    source: `#include <unistd.h>\n#include <cstdio>\nint main(){ if(fork()==0){ setsid(); volatile unsigned long x=0; for(;;) x++; } usleep(100000); puts("parent done"); }` },

  { name: 'kills its parent (the launcher)', expect: 'internal_error', allowInternal: true, maxWallMs: 8000,
    source: `#include <signal.h>
#include <unistd.h>
int main(){ kill(getppid(), SIGKILL); sleep(5); }` },

  { name: 'kill(-1, SIGKILL): tries to kill the handler itself', expect: 'any', expectDeath: true, maxWallMs: 20000,
    source: `#include <signal.h>
#include <unistd.h>
int main(){ kill(-1, SIGKILL); sleep(5); }` },

  { name: 'program closes stdout and stderr then spins', expect: 'time_limit', maxWallMs: 4000,
    source: `#include <unistd.h>\nint main(){ close(1); close(2); for(;;){} }` },

  { name: 'compile: template recursion bomb', expect: 'compile_error', maxWallMs: 20000,
    source: `template<int N> struct F { static const long long v = F<N-1>::v + F<N-2>::v; };\ntemplate<> struct F<0> { static const long long v = 0; };\ntemplate<> struct F<1> { static const long long v = 1; };\nint main(){ return F<100000>::v; }` },

  { name: 'compile: exponential macro expansion', expect: 'compile_error', maxWallMs: 20000,
    source: (() => {
      const lines = ['#define L0 1'];
      for (let i = 1; i <= 14; i++) lines.push(`#define L${i} ${`L${i - 1} `.repeat(10)}`);
      return `${lines.join('\n')}\nint a[] = { L14 };\nint main(){}`;
    })() },

  { name: 'compile: constexpr infinite loop', expect: 'compile_error', maxWallMs: 20000,
    source: `constexpr int f(){ int x=0; while(true){ x++; } return x; }\nconstexpr int y = f();\nint main(){}` },

  { name: 'compile: #include /etc/passwd', expect: 'compile_error', check: r => !/root:/.test(r.compileOutput),
    source: `#include "/etc/passwd"\nint main(){}` },

  { name: 'compile: #include /proc/*/environ must not leak the secret', expect: 'compile_error', check: r => !r.compileOutput.includes(SECRET),
    source: `#include "/proc/1/environ"\nint main(){}` },

  { name: 'compile: huge static array', expect: 'any', maxWallMs: 20000,
    source: `static char a[1ULL<<42];\nint main(){ return a[5]; }` },

  { name: 'compile: asm/incbin reads a file', expect: 'compile_error', check: r => !/root:/.test(r.compileOutput),
    source: `__asm__(".incbin \\"/etc/passwd\\"");\nint main(){}` },

  { name: 'compile: preprocessor output flood (error spam)', expect: 'compile_error', maxWallMs: 16000, check: r => r.compileOutput.length <= 64 * 1024 + 16,
    source: Array.from({ length: 5000 }, (_, i) => `int a${i} = undefined_${i};`).join('\n') + '\nint main(){}' }
];
