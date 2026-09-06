// Temporary diagnostics for the linux-aarch64 hang of the function tracer test
// (linker-order.test.ts "records exact entries, and keeps them across an exec'd
// child"). Everything here prints facts about a process tree that stopped
// making progress; nothing here changes what the test asserts.
import { existsSync, readdirSync, readFileSync, readlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";

function readMaybe(path: string, max = 4096): string {
  try {
    return readFileSync(path, "utf8").slice(0, max).trimEnd();
  } catch (error) {
    return `<${(error as NodeJS.ErrnoException).code ?? error}>`;
  }
}

export function childrenOf(pid: number): number[] {
  const out: number[] = [];
  try {
    for (const tid of readdirSync(`/proc/${pid}/task`)) {
      const kids = readMaybe(`/proc/${pid}/task/${tid}/children`);
      for (const k of kids.split(/\s+/)) if (/^\d+$/.test(k)) out.push(Number(k));
    }
  } catch {}
  return out;
}

function fdsOf(pid: number | "self"): string {
  try {
    return readdirSync(`/proc/${pid}/fd`)
      .map(fd => {
        let target = "?";
        try {
          target = readlinkSync(`/proc/${pid}/fd/${fd}`);
        } catch {}
        return `${fd}->${target}`;
      })
      .join(" ");
  } catch (error) {
    return `<${(error as NodeJS.ErrnoException).code ?? error}>`;
  }
}

/** One process: scheduler state, cpu time, signal masks, where it sleeps, its fds. */
export function describeProc(pid: number): string {
  const stat = readMaybe(`/proc/${pid}/stat`);
  // Fields after the ")" that closes comm: state ppid pgrp session tty tpgid flags minflt cminflt majflt cmajflt utime stime ...
  const after = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
  const summary =
    after.length > 12
      ? `state=${after[0]} ppid=${after[1]} pgrp=${after[2]} utime=${after[11]} stime=${after[12]} minflt=${after[7]} majflt=${after[9]}`
      : stat;
  const status = readMaybe(`/proc/${pid}/status`, 65536)
    .split("\n")
    .filter(line =>
      /^(Name|State|Tgid|PPid|Threads|SigQ|SigPnd|ShdPnd|SigBlk|SigIgn|SigCgt|VmRSS|voluntary_ctxt_switches|nonvoluntary_ctxt_switches):/.test(
        line,
      ),
    )
    .map(line => line.replace(/\s+/g, " "))
    .join("; ");
  return [
    `pid ${pid}: ${summary}`,
    `  cmdline: ${readMaybe(`/proc/${pid}/cmdline`).replace(/\0/g, " ")}`,
    `  status: ${status}`,
    `  wchan: ${readMaybe(`/proc/${pid}/wchan`)} | syscall: ${readMaybe(`/proc/${pid}/syscall`)}`,
    `  stack: ${readMaybe(`/proc/${pid}/stack`).replace(/\n/g, " <- ")}`,
    `  fds: ${fdsOf(pid)}`,
  ].join("\n");
}

/** The process and everything below it. */
export function describeTree(pid: number, depth = 0): string {
  const lines = [describeProc(pid).replace(/^/gm, "  ".repeat(depth))];
  for (const kid of childrenOf(pid)) lines.push(describeTree(kid, depth + 1));
  return lines.join("\n");
}

export function describeSelf(): string {
  return `self pid ${process.pid} fds: ${fdsOf("self")}`;
}

export async function run(cmd: string[]): Promise<string> {
  try {
    await using proc = Bun.spawn({ cmd, stdout: "pipe", stderr: "pipe", stdin: "ignore" });
    const [stdout, stderr] = await Promise.all([proc.stdout.text(), proc.stderr.text(), proc.exited]);
    return (stdout + stderr).trimEnd();
  } catch (error) {
    return `<${error}>`;
  }
}

/**
 * The body of linker-order.test.ts's tracer case, callable from a generated
 * test file so the same work runs inside a `bun test --parallel` worker that
 * has already run other files. On a stall it prints the process tree, the
 * tracer's own state, and which of stdout/stderr/exited settled.
 */
export async function runTracerCase(opts: {
  /** Directory to build in. The caller owns it. */
  root: string;
  /** Appended by every run of a round. */
  diag: string;
  tag: string;
  /** Print the step timings even when the run is fine. */
  verbose?: boolean;
  watchdogMs?: number;
}): Promise<void> {
  const { bunEnv } = await import("harness");
  const { readTextSymbols } = await import("../../../../scripts/orderfile/generate.ts");
  const orderfile = join(import.meta.dir, "../../../../scripts/orderfile");
  const compiler = process.env.CC || Bun.which("cc") || Bun.which("clang") || Bun.which("gcc");
  const { root, diag, tag } = opts;
  const watchdogMs = opts.watchdogMs ?? 40_000;
  const tracer = join(root, "functrace.so");
  const fixture = join(root, "fixture");
  const child = join(root, "child");
  const starts = join(root, "starts.bin");
  const trace = join(root, "trace.bin");

  writeFileSync(join(root, "child.c"), "int main(void) { return 0; }\n");
  writeFileSync(
    join(root, "functrace-probe.c"),
    probeTracerSource(readFileSync(join(orderfile, "functrace.c"), "utf8")),
  );

  const t0 = performance.now();
  const steps: string[] = [];
  const step = (name: string) => steps.push(`${name}@${(performance.now() - t0).toFixed(0)}ms`);
  const settled = { stdout: false, stderr: false, exited: false };
  let spawned: Bun.Subprocess | undefined;

  async function compile(args: string[]) {
    await using proc = Bun.spawn({ cmd: [compiler!, "-O1", ...args], env: bunEnv, stdout: "pipe", stderr: "pipe" });
    const [stdout, stderr, exitCode] = await Promise.all([proc.stdout.text(), proc.stderr.text(), proc.exited]);
    if (exitCode !== 0) throw new Error(`${compiler} ${args.join(" ")} exited ${exitCode}:\n${stdout}${stderr}`);
  }

  const watchdog = setTimeout(async () => {
    const lines = [
      `=== functrace ${tag} STALLED after ${watchdogMs} ms: steps ${steps.join(" ")}; fixture pid=${spawned?.pid} settled=${JSON.stringify(settled)} exitCode=${spawned?.exitCode} signal=${spawned?.signalCode}`,
      describeSelf(),
      describeProc(process.pid),
    ];
    if (spawned) {
      lines.push(describeTree(spawned.pid));
      try {
        process.kill(spawned.pid, "SIGUSR1");
      } catch (error) {
        lines.push(`SIGUSR1: ${error}`);
      }
      await Bun.sleep(500);
    }
    lines.push(
      `--- ps\n${await run(["sh", "-c", "ps -eo pid,ppid,pgid,stat,wchan:32,etime,time,args --forest | grep -v 'ps -eo' | head -80"])}`,
    );
    lines.push(`--- tracer diag\n${existsSync(diag) ? readFileSync(diag, "utf8").slice(-60_000) : "<none>"}`);
    console.error(lines.join("\n"));
    if (spawned) {
      for (const pid of [...childrenOf(spawned.pid), spawned.pid]) {
        try {
          process.kill(pid, "SIGKILL");
        } catch {}
      }
    }
  }, watchdogMs);

  try {
    await Promise.all([
      compile(["-shared", "-fPIC", "-o", tracer, join(root, "functrace-probe.c"), "-ldl", "-lpthread"]).then(() =>
        step("tracer"),
      ),
      compile(["-o", fixture, join(import.meta.dir, "functrace-fixture.c")]).then(() => step("fixture")),
      compile(["-o", child, join(root, "child.c")]).then(() => step("child")),
    ]);
    const symbols = readTextSymbols(fixture);
    step("nm");
    if (symbols.size <= 33) throw new Error(`nm listed ${symbols.size} text symbols`);
    const list = [...symbols.keys()].map(BigInt);
    const words = new BigUint64Array(3 + list.length);
    words.set([0x4e55425354525453n, 1n, BigInt(list.length)], 0);
    words.set(list, 3);
    await Bun.write(starts, new Uint8Array(words.buffer));
    step("starts");

    await using proc = Bun.spawn({
      cmd: [fixture, child],
      env: {
        ...bunEnv,
        LD_PRELOAD: tracer,
        BUN_FUNCTRACE_STARTS: starts,
        BUN_FUNCTRACE_OUT: trace,
        BUN_FUNCTRACE_DIAG: diag,
        BUN_FUNCTRACE_DIAG_ALARM: String(Math.floor(watchdogMs / 1000) - 4),
      },
      stdout: "pipe",
      stderr: "pipe",
    });
    spawned = proc;
    step(`spawn(${proc.pid})`);
    const [stdout, stderr, exitCode] = await Promise.all([
      proc.stdout.text().finally(() => ((settled.stdout = true), step("stdout"))),
      proc.stderr.text().finally(() => ((settled.stderr = true), step("stderr"))),
      proc.exited.finally(() => ((settled.exited = true), step("exited"))),
    ]);
    if (stdout.trim() !== "497" || stderr !== "" || exitCode !== 0) {
      throw new Error(`${tag}: stdout=${JSON.stringify(stdout)} stderr=${JSON.stringify(stderr)} exit=${exitCode}`);
    }
    const entries = new BigUint64Array(await Bun.file(trace).arrayBuffer());
    if (entries[0] !== 0x4e55424543415254n || Number(entries[4]) < 34) {
      throw new Error(`${tag}: trace magic ${entries[0]} entries ${entries[4]}`);
    }
    step("done");
    if (opts.verbose) console.error(`functrace steps: ${steps.join(" ")}`);
  } finally {
    clearTimeout(watchdog);
  }
}

/**
 * functrace.c plus a watchdog: counts traps, reports a trap that fires again at
 * an address whose breakpoint was already restored (which would spin forever),
 * and on SIGALRM (armed at load) or SIGUSR1 writes the tracer's state and the
 * interrupted context to $BUN_FUNCTRACE_DIAG. The tracer logic is untouched.
 */
export function probeTracerSource(stock: string): string {
  const hook = "static void on_trap(int sig, siginfo_t *si, void *uc)\n{\n    (void)si;";
  if (!stock.includes(hook)) throw new Error("functrace.c changed shape; update the probe hook");
  let patched = stock.replace(
    hook,
    [
      "static volatile unsigned long diag_traps = 0;",
      "static volatile unsigned long diag_repeats = 0;",
      "static volatile uintptr_t diag_last_pc = 0;",
      "static void diag_report_repeat(uintptr_t at, size_t i);",
      "static void on_trap(int sig, siginfo_t *si, void *uc)",
      "{",
      "    (void)si;",
      "    __atomic_fetch_add(&diag_traps, 1, __ATOMIC_RELAXED);",
      "#if defined(__linux__) && defined(__x86_64__)",
      "    diag_last_pc = (uintptr_t)((ucontext_t *)uc)->uc_mcontext.gregs[REG_RIP];",
      "#elif defined(__linux__)",
      "    diag_last_pc = (uintptr_t)((ucontext_t *)uc)->uc_mcontext.pc;",
      "#endif",
    ].join("\n"),
  );

  // A trap at a start whose breakpoint was already restored means the write or
  // the icache maintenance did not take: the handler restores it again and
  // returns to the same address, which traps again. Count it and say so.
  const record = "    if (__atomic_exchange_n(&seen[i], 1, __ATOMIC_RELAXED) == 0) {";
  if (!patched.includes(record)) throw new Error("functrace.c changed shape; update the repeat probe");
  patched = patched.replace(
    record,
    [
      "    if (__atomic_load_n(&seen[i], __ATOMIC_RELAXED) != 0) {",
      "        __atomic_fetch_add(&diag_repeats, 1, __ATOMIC_RELAXED);",
      "        diag_report_repeat(at, i);",
      "    }",
      record,
    ].join("\n"),
  );
  return patched + "\n" + diagTail;
}

const diagTail = String.raw`
// ─── probe diagnostics (test-only) ──────────────────────────────────────────
#include <stdarg.h>
#include <errno.h>
#include <time.h>

static char diag_path[1024];

static void diag_write(int fd, const char *fmt, ...)
{
    char buf[1024];
    va_list ap;
    va_start(ap, fmt);
    int n = vsnprintf(buf, sizeof buf, fmt, ap);
    va_end(ap);
    if (n > (int)sizeof buf - 1) n = (int)sizeof buf - 1;
    if (n > 0) (void)!write(fd, buf, (size_t)n);
}

static void diag_copy_file(int fd, const char *path, size_t max)
{
    int in = open(path, O_RDONLY | O_CLOEXEC);
    if (in < 0) { diag_write(fd, "<%s: errno %d>\n", path, errno); return; }
    char buf[4096];
    size_t total = 0;
    ssize_t n;
    while (total < max && (n = read(in, buf, sizeof buf)) > 0) { (void)!write(fd, buf, (size_t)n); total += (size_t)n; }
    close(in);
}

// A breakpoint that fires again after its restore: the 16 first ones say where,
// with the instruction as seen through both mappings.
static void diag_report_repeat(uintptr_t at, size_t i)
{
    if (!diag_path[0] || __atomic_load_n(&diag_repeats, __ATOMIC_RELAXED) > 16) return;
    int fd = open(diag_path, O_CREAT | O_WRONLY | O_APPEND | O_CLOEXEC, 0644);
    if (fd < 0) return;
    int r = region_of(at);
    insn_t rx = *(const insn_t *)at;
    insn_t rw = r >= 0 ? *(const insn_t *)(regions[r].rw + (at - regions[r].start)) : 0;
    diag_write(fd, "REPEAT trap pid %d at %#lx (-slide %#lx) start[%zu] traps=%lu repeats=%lu orig=%#lx rx=%#lx rw=%#lx breakpoint=%#lx\n",
               (int)getpid(), (unsigned long)at, (unsigned long)(at - slide), i, (unsigned long)diag_traps,
               (unsigned long)diag_repeats, originals ? (unsigned long)originals[i] : 0ul, (unsigned long)rx,
               (unsigned long)rw, (unsigned long)BREAKPOINT);
    close(fd);
}

static void diag_dump(int sig, siginfo_t *si, void *uc)
{
    (void)si;
    int fd = open(diag_path, O_CREAT | O_WRONLY | O_APPEND | O_CLOEXEC, 0644);
    if (fd < 0) return;
    struct timespec ts;
    clock_gettime(CLOCK_MONOTONIC, &ts);
    ucontext_t *ctx = (ucontext_t *)uc;
#if defined(__linux__) && defined(__x86_64__)
    uintptr_t pc = (uintptr_t)ctx->uc_mcontext.gregs[REG_RIP], sp = (uintptr_t)ctx->uc_mcontext.gregs[REG_RSP], lr = 0;
#elif defined(__linux__)
    uintptr_t pc = (uintptr_t)ctx->uc_mcontext.pc, sp = (uintptr_t)ctx->uc_mcontext.sp, lr = (uintptr_t)ctx->uc_mcontext.regs[30];
#else
    uintptr_t pc = 0, sp = 0, lr = 0;
#endif
    diag_write(fd, "=== diag signal %d pid %d t=%ld.%03ld armed=%d traps=%lu repeats=%lu last_trap_pc=%#lx (-slide %#lx) entries=%lu start_count=%zu regions=%d slide=%#lx\n",
               sig, (int)getpid(), (long)ts.tv_sec, ts.tv_nsec / 1000000, armed, (unsigned long)diag_traps, (unsigned long)diag_repeats,
               (unsigned long)diag_last_pc, (unsigned long)(diag_last_pc ? diag_last_pc - slide : 0),
               record ? (unsigned long)record[4] : 0ul, start_count, region_count, (unsigned long)slide);
    diag_write(fd, "pc=%#lx (-slide %#lx, region %d) sp=%#lx lr=%#lx (-slide %#lx)\n", (unsigned long)pc,
               (unsigned long)(pc - slide), region_of(pc), (unsigned long)sp, (unsigned long)lr, (unsigned long)(lr ? lr - slide : 0));
    if (region_of(pc) >= 0) {
        int r = region_of(pc);
        insn_t rx = *(const insn_t *)(pc & ~(uintptr_t)(sizeof(insn_t) - 1));
        insn_t rw = *(const insn_t *)(regions[r].rw + ((pc & ~(uintptr_t)(sizeof(insn_t) - 1)) - regions[r].start));
        diag_write(fd, "insn at pc: rx=%#lx rw=%#lx breakpoint=%#lx start_index=%zu\n", (unsigned long)rx, (unsigned long)rw,
                   (unsigned long)BREAKPOINT, find_start(pc));
    }
#if defined(__linux__) && defined(__aarch64__)
    for (int i = 0; i < 31; i += 4)
        diag_write(fd, "x%-2d=%#018lx x%-2d=%#018lx x%-2d=%#018lx x%-2d=%#018lx\n", i, (unsigned long)ctx->uc_mcontext.regs[i], i + 1,
                   (unsigned long)(i + 1 < 31 ? ctx->uc_mcontext.regs[i + 1] : 0), i + 2, (unsigned long)(i + 2 < 31 ? ctx->uc_mcontext.regs[i + 2] : 0),
                   i + 3, (unsigned long)(i + 3 < 31 ? ctx->uc_mcontext.regs[i + 3] : 0));
    diag_write(fd, "pstate=%#lx fault_address=%#lx\n", (unsigned long)ctx->uc_mcontext.pstate, (unsigned long)ctx->uc_mcontext.fault_address);
#endif
    for (size_t i = 0; i < start_count; i++) {
        int r = region_of(starts[i]);
        insn_t rx = *(const insn_t *)starts[i];
        insn_t rw = r >= 0 ? *(const insn_t *)(regions[r].rw + (starts[i] - regions[r].start)) : 0;
        diag_write(fd, "start[%zu] %#lx (-slide %#lx) seen=%d orig=%#lx now rx=%#lx rw=%#lx%s\n", i, (unsigned long)starts[i],
                   (unsigned long)(starts[i] - slide), seen ? seen[i] : -1, originals ? (unsigned long)originals[i] : 0ul,
                   (unsigned long)rx, (unsigned long)rw, rx != rw ? " MISMATCH" : "");
    }
    for (int r = 0; r < region_count; r++)
        diag_write(fd, "region[%d] %#lx-%#lx rw=%p\n", r, (unsigned long)regions[r].start, (unsigned long)regions[r].end, (void *)regions[r].rw);
    diag_write(fd, "--- /proc/self/stat\n");
    diag_copy_file(fd, "/proc/self/stat", 4096);
    diag_write(fd, "\n--- /proc/self/status\n");
    diag_copy_file(fd, "/proc/self/status", 8192);
    diag_write(fd, "--- /proc/self/maps\n");
    diag_copy_file(fd, "/proc/self/maps", 65536);
    diag_write(fd, "=== end diag\n");
    close(fd);
}

__attribute__((constructor(102))) static void diag_init(void)
{
    const char *path = getenv("BUN_FUNCTRACE_DIAG");
    if (!path) return;
    snprintf(diag_path, sizeof diag_path, "%s", path);
    unsetenv("BUN_FUNCTRACE_DIAG");
    struct sigaction sa;
    memset(&sa, 0, sizeof sa);
    sa.sa_sigaction = diag_dump;
    sa.sa_flags = SA_SIGINFO | SA_ONSTACK | SA_RESTART;
    sigemptyset(&sa.sa_mask);
#if defined(__linux__)
    if (!real_sigaction) real_sigaction = (sigaction_fn)dlsym(RTLD_NEXT, "sigaction");
    real_sigaction(SIGUSR1, &sa, NULL);
    real_sigaction(SIGALRM, &sa, NULL);
#else
    sigaction(SIGUSR1, &sa, NULL);
    sigaction(SIGALRM, &sa, NULL);
#endif
    const char *secs = getenv("BUN_FUNCTRACE_DIAG_ALARM");
    alarm(secs ? (unsigned)atoi(secs) : 20);
    // Every run appends to one file in the stress phases, so the per-run line is opt-in.
    if (!getenv("BUN_FUNCTRACE_DIAG_VERBOSE")) return;
    int fd = open(diag_path, O_CREAT | O_WRONLY | O_APPEND | O_CLOEXEC, 0644);
    if (fd >= 0) {
        diag_write(fd, "loaded pid %d armed=%d start_count=%zu regions=%d slide=%#lx\n", (int)getpid(), armed, start_count, region_count, (unsigned long)slide);
        close(fd);
    }
}

__attribute__((destructor)) static void diag_exit(void)
{
    unsigned long repeats = __atomic_load_n(&diag_repeats, __ATOMIC_RELAXED);
    if (!diag_path[0] || (!repeats && !getenv("BUN_FUNCTRACE_DIAG_VERBOSE"))) return;
    int fd = open(diag_path, O_CREAT | O_WRONLY | O_APPEND | O_CLOEXEC, 0644);
    if (fd < 0) return;
    diag_write(fd, "EXIT pid %d traps=%lu repeats=%lu entries=%lu\n", (int)getpid(), (unsigned long)diag_traps, repeats,
               record ? (unsigned long)record[4] : 0ul);
    close(fd);
}
`;
