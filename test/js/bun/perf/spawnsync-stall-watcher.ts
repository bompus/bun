// Watcher for spawnsync-stall-probe.test.ts. Runs as a separate process
// because the probe's JS thread is blocked inside spawnSync while a stall is in
// progress. Polls /proc for children of the probe process; when one outlives
// `thresholdMs`, prints the child's and the parent's kernel-side state once.
//
// usage: bun spawnsync-stall-watcher.ts <parent-pid> <comm-to-watch> [thresholdMs]
import { existsSync, readdirSync, readFileSync, readlinkSync } from "node:fs";

const parent = Number(process.argv[2]);
const comm = process.argv[3];
const thresholdMs = Number(process.argv[4] ?? 2000);

function read(path: string, max = 8192): string {
  try {
    return readFileSync(path, "utf8").slice(0, max).trimEnd();
  } catch (error) {
    return `<${(error as NodeJS.ErrnoException).code ?? error}>`;
  }
}

function children(pid: number): number[] {
  const out: number[] = [];
  try {
    for (const tid of readdirSync(`/proc/${pid}/task`)) {
      for (const k of read(`/proc/${pid}/task/${tid}/children`).split(/\s+/)) if (/^\d+$/.test(k)) out.push(Number(k));
    }
  } catch {}
  return out;
}

function fds(pid: number): string {
  try {
    return readdirSync(`/proc/${pid}/fd`)
      .map(fd => {
        let target = "?";
        try {
          target = readlinkSync(`/proc/${pid}/fd/${fd}`);
        } catch {}
        let info = "";
        if (target.startsWith("socket:") || target.startsWith("pipe:") || target.startsWith("anon_inode:")) {
          info = read(`/proc/${pid}/fdinfo/${fd}`, 400)
            .split("\n")
            .filter(l => /^(flags|eventpoll|tfd)/.test(l))
            .join(",")
            .replace(/\s+/g, "");
        }
        return `${fd}->${target}${info ? `(${info})` : ""}`;
      })
      .join(" ");
  } catch (error) {
    return `<${(error as NodeJS.ErrnoException).code ?? error}>`;
  }
}

function statLine(pid: number, tid?: number): string {
  const base = tid === undefined ? `/proc/${pid}` : `/proc/${pid}/task/${tid}`;
  const stat = read(`${base}/stat`);
  const after = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
  const name = stat.slice(stat.indexOf("(") + 1, stat.lastIndexOf(")"));
  return `${tid ?? pid} (${name}) state=${after[0]} utime=${after[11]} stime=${after[12]} wchan=${read(`${base}/wchan`)} syscall=${read(`${base}/syscall`).split(" ").slice(0, 4).join(" ")}`;
}

function epollInterest(pid: number): string {
  // Every epoll fd of the process, with the fds it watches (tfd lines).
  const lines: string[] = [];
  try {
    for (const fd of readdirSync(`/proc/${pid}/fd`)) {
      let target = "";
      try {
        target = readlinkSync(`/proc/${pid}/fd/${fd}`);
      } catch {}
      if (target !== "anon_inode:[eventpoll]") continue;
      const tfds = read(`/proc/${pid}/fdinfo/${fd}`, 65536)
        .split("\n")
        .filter(l => l.startsWith("tfd:"))
        .map(l => l.replace(/\s+/g, " ").trim());
      lines.push(`epoll fd ${fd}: ${tfds.length} entries${tfds.length ? "\n    " + tfds.join("\n    ") : ""}`);
    }
  } catch {}
  return lines.join("\n");
}

async function ss(): Promise<string> {
  try {
    const proc = Bun.spawn({ cmd: ["ss", "-xapn"], stdout: "pipe", stderr: "pipe", stdin: "ignore" });
    const [out] = await Promise.all([proc.stdout.text(), proc.exited]);
    return out
      .split("\n")
      .filter(line => line.includes(`pid=${parent},`) || /Recv-Q/.test(line))
      .slice(0, 60)
      .join("\n");
  } catch (error) {
    return `<ss: ${error}>`;
  }
}

const firstSeen = new Map<number, number>();
const reported = new Set<number>();
let reports = 0;

while (existsSync(`/proc/${parent}`) && reports < 4) {
  const now = Date.now();
  const kids = children(parent);
  for (const pid of kids) {
    const stat = read(`/proc/${pid}/stat`);
    const name = stat.slice(stat.indexOf("(") + 1, stat.lastIndexOf(")"));
    if (name !== comm) continue;
    if (!firstSeen.has(pid)) firstSeen.set(pid, now);
    if (now - firstSeen.get(pid)! < thresholdMs || reported.has(pid)) continue;
    reported.add(pid);
    reports++;
    const lines = [
      `=== STALL: ${comm} pid ${pid} has been a child of ${parent} for ${now - firstSeen.get(pid)!} ms`,
      `child: ${statLine(pid)}`,
      `child status: ${read(`/proc/${pid}/status`)
        .split("\n")
        .filter(l => /^(State|PPid|Threads|SigQ|SigPnd|ShdPnd|SigBlk|SigIgn|SigCgt)/.test(l))
        .join("; ")
        .replace(/\s+/g, " ")}`,
      `child stack: ${read(`/proc/${pid}/stack`).replace(/\n/g, " <- ")}`,
      `child fds: ${fds(pid)}`,
      `parent threads:`,
      ...(() => {
        try {
          return readdirSync(`/proc/${parent}/task`).map(tid => `  ${statLine(parent, Number(tid))}`);
        } catch {
          return ["  <gone>"];
        }
      })(),
      `parent fds: ${fds(parent)}`,
      `parent epoll:\n${epollInterest(parent)}`,
      `parent children: ${kids.map(k => statLine(k)).join("\n  ")}`,
      `unix sockets (ss):\n${await ss()}`,
      `=== end STALL report`,
    ];
    process.stderr.write(lines.join("\n") + "\n");
  }
  for (const pid of [...firstSeen.keys()]) if (!kids.includes(pid)) firstSeen.delete(pid);
  await Bun.sleep(200);
}
