// Hostile programs. Each must end with the expected status, stay inside the limits, and leave no
// process and no file behind. The runner never sees an expected output, so `expectStdout` (trimmed) is checked by
// the test harness on what the program printed. `needsLandlock` marks cases whose protection is the Landlock file
// policy: they are skipped when the kernel has no Landlock (standard Lambda runs 5.10), where that protection is
// absent by design (see SECURITY.md). `needsSeccomp` marks the cases that check our own seccomp filter, which standard Lambda
// does not let us install (its own filter is the sandbox there).
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

  // ---- seccomp: the filter the launcher installs before exec (this is what stops the network on Lambda) ----
  { name: 'seccomp: every denied syscall fails with EPERM and the program keeps running', needsSeccomp: true, expect: 'accepted', expectStdout: 'all denied',
    source: `#include <unistd.h>
#include <sys/syscall.h>
#include <cerrno>
#include <cstdio>
#ifndef SYS_io_uring_setup
#define SYS_io_uring_setup 425
#endif
int main(){
  struct { const char* n; long nr; } t[] = {
    {"socket",SYS_socket},{"socketpair",SYS_socketpair},{"connect",SYS_connect},{"bind",SYS_bind},{"listen",SYS_listen},
    {"accept",SYS_accept},{"accept4",SYS_accept4},{"sendto",SYS_sendto},{"sendmsg",SYS_sendmsg},{"recvfrom",SYS_recvfrom},
    {"recvmsg",SYS_recvmsg},{"ptrace",SYS_ptrace},{"process_vm_readv",SYS_process_vm_readv},{"process_vm_writev",SYS_process_vm_writev},
    {"mount",SYS_mount},{"unshare",SYS_unshare},{"setns",SYS_setns},{"keyctl",SYS_keyctl},{"add_key",SYS_add_key},
    {"request_key",SYS_request_key},{"bpf",SYS_bpf},{"perf_event_open",SYS_perf_event_open},{"userfaultfd",SYS_userfaultfd},
    {"io_uring_setup",SYS_io_uring_setup},{"x32 socket",SYS_socket|0x40000000L}};
  int bad=0;
  for(auto& e: t){ errno=0; long r=syscall(e.nr,0,0,0,0,0,0); if(r!=-1||errno!=EPERM){ printf("NOT DENIED: %s r=%ld errno=%d\\n",e.n,r,errno); bad++; } }
  puts(bad ? "FAIL" : "all denied");
}` },

  { name: 'seccomp: socket(), socketpair() and ptrace() through libc give EPERM', needsSeccomp: true, expect: 'accepted', expectStdout: 'EPERM EPERM EPERM EPERM',
    source: `#include <sys/socket.h>
#include <sys/ptrace.h>
#include <cerrno>
#include <cstdio>
int main(){
  int a=socket(AF_INET,SOCK_STREAM,0); int e1=errno;
  errno=0; int b=socket(AF_UNIX,SOCK_STREAM,0); int e2=errno;
  int sv[2]; errno=0; int c=socketpair(AF_UNIX,SOCK_STREAM,0,sv); int e3=errno;
  errno=0; long d=ptrace(PTRACE_TRACEME,0,0,0); int e4=errno;
  printf("%s %s %s %s\\n", a<0&&e1==EPERM?"EPERM":"?", b<0&&e2==EPERM?"EPERM":"?", c<0&&e3==EPERM?"EPERM":"?", d<0&&e4==EPERM?"EPERM":"?");
}` },

  { name: 'seccomp: ordinary system calls still work (pipe, fork, threads, mmap, files, clock)', expect: 'accepted', expectStdout: 'works',
    source: `#include <unistd.h>
#include <sys/mman.h>
#include <sys/wait.h>
#include <thread>
#include <chrono>
#include <cstdio>
#include <cstring>
int main(){
  int p[2]; if(pipe(p)) return 1;
  pid_t c=fork(); if(c==0){ write(p[1],"x",1); _exit(0); }
  char b; if(read(p[0],&b,1)!=1||b!='x') return 2; waitpid(c,nullptr,0);
  int n=0; std::thread t([&]{ n=7; }); t.join(); if(n!=7) return 3;
  void* m=mmap(nullptr,1<<20,PROT_READ|PROT_WRITE,MAP_PRIVATE|MAP_ANONYMOUS,-1,0); if(m==MAP_FAILED) return 4; memset(m,1,1<<20);
  FILE* f=fopen("t.txt","w"); if(!f) return 5; fputs("hi",f); fclose(f);
  auto t0=std::chrono::steady_clock::now(); (void)t0;
  puts("works");
}` },

  { name: 'seccomp: 32-bit int 0x80 cannot reach socketcall', expect: 'any', check: r => !/CONNECTED/.test(r.stdout),
    source: `#include <cstdio>
int main(){ long r; asm volatile("int $0x80" : "=a"(r) : "a"(102L), "b"(1L), "c"(0L) : "memory"); printf("r=%ld\\n", r); }` },

  { name: 'socket connect', expect: 'accepted', expectStdout: 'blocked',
    source: `#include <sys/socket.h>\n#include <netinet/in.h>\n#include <arpa/inet.h>\n#include <cstdio>\nint main(){ int s=socket(AF_INET,SOCK_STREAM,0); sockaddr_in a{}; a.sin_family=AF_INET; a.sin_port=htons(80); inet_pton(AF_INET,"1.1.1.1",&a.sin_addr); if(s>=0 && connect(s,(sockaddr*)&a,sizeof a)==0){ puts("CONNECTED"); } else puts("blocked"); }` },

  { name: 'curl via system()', expect: 'accepted', expectStdout: 'blocked',
    source: `#include <cstdlib>\n#include <cstdio>\nint main(){ int rc=system("curl -m 2 http://1.1.1.1 >/dev/null 2>&1"); puts(rc==0 ? "FETCHED" : "blocked"); }` },

  { name: 'read /proc/*/environ for the secret', needsLandlock: true, expect: 'accepted', expectStdout: 'safe',
    source: `#include <cstdio>\n#include <string>\n#include <fstream>\n#include <sstream>\nint main(){ bool leak=false; for(int pid=1; pid<400; pid++){ std::ifstream f("/proc/"+std::to_string(pid)+"/environ", std::ios::binary); std::stringstream ss; ss<<f.rdbuf(); if(ss.str().find("${SECRET}")!=std::string::npos) leak=true; } std::ifstream me("/proc/self/environ"); puts(leak ? "LEAK" : "safe"); }` },

  { name: 'read own and parent environment', expect: 'accepted', expectStdout: 'empty',
    source: `#include <cstdio>\n#include <cstdlib>\nextern char** environ;\nint main(){ int n=0; for(char** e=environ; e && *e; e++) n++; puts(n==0 && !getenv("AWS_SECRET_ACCESS_KEY") ? "empty" : "HAS ENV"); }` },

  { name: 'read /etc/passwd, /etc/hostname, /proc/meminfo', needsLandlock: true, expect: 'accepted', expectStdout: 'denied',
    source: `#include <cstdio>\n#include <initializer_list>\nint main(){ int ok=0; for(const char* p : std::initializer_list<const char*>{"/etc/passwd","/etc/hostname","/proc/meminfo","/var/task/index.js","/proc/self/status"}){ FILE* f=fopen(p,"r"); if(f){ ok++; fclose(f);} } puts(ok? "READABLE":"denied"); }` },

  { name: 'write outside the work folder', needsLandlock: true, expect: 'accepted', expectStdout: 'denied',
    source: `#include <cstdio>\n#include <initializer_list>\n#include <sys/stat.h>\nint main(){ int ok=0; for(const char* p : std::initializer_list<const char*>{"/var/task/x","/etc/x","/usr/x","/tmp/x","/tmp/other/x","/x"}){ FILE* f=fopen(p,"w"); if(f){ ok++; fclose(f);} } mkdir("/tmp/dir",0777); puts(ok? "WROTE":"denied"); }` },

  { name: 'popen(env) sees no AWS variables', expect: 'accepted', expectStdout: '0',
    source: `#include <cstdio>
int main(){ FILE* p=popen("/usr/bin/env | /usr/bin/grep -c AWS","r"); char b[16]={0}; if(p) fgets(b,sizeof b,p); fputs(b,stdout); }` },

  { name: 'stack overflow', expect: 'runtime_error', maxWallMs: 6000,
    source: `int f(int n){ volatile char buf[4096]; buf[0]=n; return f(n+1)+buf[0]; }\nint main(){ return f(0); }` },

  { name: 'null dereference', expect: 'runtime_error',
    source: `int main(){ int* p=nullptr; *p=1; return *p; }` },

  { name: 'open-file limit', expect: 'accepted', expectStdout: 'limited',
    source: `#include <fcntl.h>\n#include <cstdio>\nint main(){ int n=0; while(open("/dev/null",O_RDONLY)>=0 && n<100000) n++; puts(n<100 ? "limited" : "UNLIMITED"); }` },

  { name: 'huge file write (16 MB cap)', expect: 'runtime_error', maxWallMs: 8000,
    source: `#include <cstdio>\n#include <cstring>\nint main(){ FILE* f=fopen("big.bin","w"); char b[1<<16]; memset(b,1,sizeof b); for(int i=0;i<4000;i++){ fwrite(b,1,sizeof b,f); fflush(f);} }` },

  { name: 'fill /tmp with many files', expect: 'any', maxWallMs: 8000,
    source: `#include <cstdio>\n#include <string>\n#include <cstring>\nint main(){ char b[1<<20]; memset(b,1,sizeof b); for(int i=0;i<2000;i++){ FILE* f=fopen(("f"+std::to_string(i)).c_str(),"w"); if(!f) break; fwrite(b,1,sizeof b,f); fclose(f);} puts("done"); }` },

  { name: 'leaves a background process (fork + sleep)', expect: 'accepted', expectStdout: 'parent done', maxWallMs: 4000, expectLeftoversKilled: true,
    source: `#include <unistd.h>\n#include <cstdio>\nint main(){ if(fork()==0){ sleep(100000); _exit(0); } puts("parent done"); }` },

  { name: 'daemon: double fork + setsid escapes the process group', expect: 'accepted', expectStdout: 'parent done', maxWallMs: 4000, expectLeftoversKilled: true,
    source: `#include <unistd.h>\n#include <cstdio>\n#include <cstdlib>\nint main(){ if(fork()==0){ setsid(); if(fork()==0){ for(;;) sleep(1000); } _exit(0); } usleep(100000); puts("parent done"); }` },

  { name: 'busy background child outlives the parent', expect: 'accepted', expectStdout: 'parent done', maxWallMs: 4000, expectLeftoversKilled: true,
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

  { name: 'compile: #include /etc/passwd', needsLandlock: true, expect: 'compile_error', check: r => !/root:/.test(r.compileOutput),
    source: `#include "/etc/passwd"\nint main(){}` },

  { name: 'compile: #include /proc/*/environ must not leak the secret', needsLandlock: true, expect: 'compile_error', check: r => !r.compileOutput.includes(SECRET),
    source: `#include "/proc/1/environ"\nint main(){}` },

  { name: 'compile: huge static array', expect: 'any', maxWallMs: 20000,
    source: `static char a[1ULL<<42];\nint main(){ return a[5]; }` },

  { name: 'compile: asm/incbin reads a file', needsLandlock: true, expect: 'compile_error', check: r => !/root:/.test(r.compileOutput),
    source: `__asm__(".incbin \\"/etc/passwd\\"");\nint main(){}` },

  { name: 'compile: preprocessor output flood (error spam)', expect: 'compile_error', maxWallMs: 16000, check: r => r.compileOutput.length <= 64 * 1024 + 16,
    source: Array.from({ length: 5000 }, (_, i) => `int a${i} = undefined_${i};`).join('\n') + '\nint main(){}' }
];
