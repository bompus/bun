import { expect, test } from "bun:test";
import { bunEnv, bunExe } from "harness";

test("server.fetch should reject invalid argument types without crashing", async () => {
  using server = Bun.serve({
    port: 0,
    fetch() {
      return new Response("Hello World!");
    },
  });
  // @ts-expect-error
  await expect(server.fetch(1n)).rejects.toThrow("fetch() expects a string, but received BigInt");
  // @ts-expect-error
  await expect(server.fetch(Symbol("x"))).rejects.toThrow("fetch() expects a string, but received Symbol");
  // @ts-expect-error
  await expect(server.fetch(true)).rejects.toThrow("fetch() expects a string, but received Boolean");
  // @ts-expect-error
  await expect(server.fetch(1)).rejects.toThrow("fetch() expects a string, but received Number");
});

test("server.fetch rejects with the thrown value, not a wrapper", async () => {
  const error = new TypeError("from the handler");
  using throws = Bun.serve({
    port: 0,
    fetch() {
      throw error;
    },
  });
  await expect(throws.fetch("/")).rejects.toBe(error);

  using throwsPrimitive = Bun.serve({
    port: 0,
    fetch() {
      throw 42;
    },
  });
  expect(await throwsPrimitive.fetch("/").catch(e => e)).toBe(42);

  // A body that cannot be converted rejects (fetch() never throws synchronously).
  using ok = Bun.serve({
    port: 0,
    fetch() {
      return new Response("ok");
    },
  });
  let thrown = false;
  let promise: Promise<Response> | undefined;
  try {
    // @ts-expect-error
    promise = ok.fetch("/", { method: "POST", body: Symbol("nope") });
  } catch {
    thrown = true;
  }
  expect(thrown).toBe(false);
  await expect(promise).rejects.toThrow();
});

// server.fetch() validates its arguments and calls the handler synchronously.
// A failure there comes back as an already-rejected promise, which must be
// tracked like any other rejection: reported when unhandled, delivered to
// process.on("unhandledRejection") with the returned promise, and followed by
// "rejectionHandled" on a late .catch().
test("early server.fetch rejections are tracked like any other rejection", async () => {
  await using proc = Bun.spawn({
    cmd: [
      bunExe(),
      "-e",
      /* js */ `
        const noHandler = Bun.serve({ port: 0, routes: { "/x": new Response("x") } });
        const server = Bun.serve({
          port: 0,
          fetch(req) {
            if (req.url.endsWith("/throw")) throw new Error("handler threw");
            if (req.url.endsWith("/error")) return new Error("handler returned an error");
            if (req.url.endsWith("/undefined")) return undefined;
            return new Response("ok");
          },
        });
        const cases = {
          noFetchHandler: () => noHandler.fetch("/"),
          noArguments: () => server.fetch(),
          blankUrl: () => server.fetch(""),
          invalidArgument: () => server.fetch(1),
          handlerThrows: () => server.fetch("/throw"),
          handlerReturnsError: () => server.fetch("/error"),
          handlerReturnsUndefined: () => server.fetch("/undefined"),
        };
        const names = new Map();
        const events = [];
        process.on("unhandledRejection", (reason, promise) => events.push("unhandledRejection:" + names.get(promise) + ":" + reason?.message));
        process.on("rejectionHandled", promise => events.push("rejectionHandled:" + names.get(promise)));
        for (const [name, make] of Object.entries(cases)) names.set(make(), name);
        const turn = () => new Promise(r => setImmediate(r));
        await turn();
        await turn();
        for (const promise of names.keys()) promise.catch(() => {});
        await turn();
        await turn();
        noHandler.stop(true);
        server.stop(true);
        console.log(JSON.stringify(events));
      `,
    ],
    env: bunEnv,
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([proc.stdout.text(), proc.stderr.text(), proc.exited]);
  expect(stderr).toBe("");
  expect(JSON.parse(stdout)).toEqual([
    "unhandledRejection:noFetchHandler:fetch() requires the server to have a fetch handler",
    "unhandledRejection:noArguments:fetch() expects a string but received no arguments.",
    "unhandledRejection:blankUrl:fetch() URL must not be a blank string.",
    "unhandledRejection:invalidArgument:fetch() expects a string, but received Number",
    "unhandledRejection:handlerThrows:handler threw",
    "unhandledRejection:handlerReturnsError:handler returned an error",
    "unhandledRejection:handlerReturnsUndefined:fetch() returned an empty value",
    "rejectionHandled:noFetchHandler",
    "rejectionHandled:noArguments",
    "rejectionHandled:blankUrl",
    "rejectionHandled:invalidArgument",
    "rejectionHandled:handlerThrows",
    "rejectionHandled:handlerReturnsError",
    "rejectionHandled:handlerReturnsUndefined",
  ]);
  expect(exitCode).toBe(0);
});
