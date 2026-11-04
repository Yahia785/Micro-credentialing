/*
 * Runner bootstrap: the image ENTRYPOINT, the process Lambda's Runtime API sees for the whole life of the environment.
 *
 * It does one thing: start a worker (node /var/task/once.js), wait for it to end, start the next. The worker talks to the
 * Runtime API itself (one invocation per worker, see once.js), so every invocation runs in a brand-new process and
 * nothing a student program did to a worker's memory survives into the next call.
 *
 * The bootstrap never reads event data, never talks to the Runtime API and keeps no state besides the worker's pid.
 * If a worker ends with an error, wait a moment before starting the next one so a broken image cannot spin the CPU.
 */
#define _GNU_SOURCE
#include <errno.h>
#include <signal.h>
#include <stdio.h>
#include <sys/wait.h>
#include <time.h>
#include <unistd.h>

#define NODE "/var/lang/bin/node"
#define WORKER "/var/task/once.js"

int main(void) {
  for (;;) {
    pid_t pid = fork();
    if (pid < 0) {
      struct timespec ts = { 0, 200 * 1000 * 1000 };
      nanosleep(&ts, NULL);
      continue;
    }
    if (pid == 0) {
      char *argv[] = { "node", WORKER, NULL };
      execv(NODE, argv);
      perror("runner bootstrap: exec " NODE);
      _exit(127);
    }
    int status = 0;
    pid_t got;
    while ((got = waitpid(pid, &status, 0)) < 0 && errno == EINTR) { }
    if (got < 0 || !WIFEXITED(status) || WEXITSTATUS(status) != 0) {
      struct timespec ts = { 0, 200 * 1000 * 1000 };
      nanosleep(&ts, NULL);
    }
  }
}
