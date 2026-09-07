import { TCPSocketListener } from "bun";
import { afterAll, beforeAll, describe, expect, mock, spyOn, test } from "bun:test";
import { bunEnv, bunExe } from "harness";

let server;
let requestCount = 0;
beforeAll(async () => {
  server = Bun.serve({
    port: 0,
    fetch(request) {
      requestCount++;
      return new Response(undefined, { headers: request.headers });
    },
  });
});
afterAll(() => {
  server!.stop(true);
});

test("fetch(request subclass with headers)", async () => {
  class MyRequest extends Request {
    constructor(input: RequestInfo, init?: RequestInit) {
      super(input, init);
      this.headers.set("hello", "world");
    }
  }
  const myRequest = new MyRequest(server!.url + "/");
  const { headers } = await fetch(myRequest);

  expect(headers.get("hello")).toBe("world");
});

test("fetch(RequestInit, headers)", async () => {
  const myRequest = {
    headers: {
      "hello": "world",
    },
    url: server!.url,
  };
  const { headers } = await fetch(myRequest, {
    headers: {
      "hello": "world2",
    },
  });

  expect(headers.get("hello")).toBe("world2");
});

test("fetch(url, RequestSubclass)", async () => {
  class MyRequest extends Request {
    constructor(input: RequestInfo, init?: RequestInit) {
      super(input, init);
      this.headers.set("hello", "world");
    }
  }
  const myRequest = new MyRequest(server!.url);
  const { headers } = await fetch(server.url, myRequest);

  expect(headers.get("hello")).toBe("world");
});

test("fetch({toString throwing}, {headers} isn't accessed)", async () => {
  const obj = {
    headers: null,
  };
  const mocked = spyOn(obj, "headers");
  const str = {
    toString: mock(() => {
      throw new Error("bad2");
    }),
  };
  expect(async () => await fetch(str, obj)).toThrow("bad2");
  expect(mocked).not.toHaveBeenCalled();
  expect(str.toString).toHaveBeenCalledTimes(1);
});

// https://github.com/oven-sh/bun/issues/33644
describe("fetch() rejects instead of throwing synchronously when option conversion throws", () => {
  function expectRejects(factory: () => Promise<Response>, message: string) {
    let promise: Promise<Response>;
    try {
      promise = factory();
    } catch (e) {
      throw new Error(`fetch() threw synchronously (expected a rejected promise): ${(e as Error).message}`);
    }
    expect(promise).toBeInstanceOf(Promise);
    return expect(promise).rejects.toThrow(message);
  }

  test("url toString() throws", async () => {
    await expectRejects(
      () =>
        fetch({
          toString() {
            throw new Error("UBOOM");
          },
        } as any),
      "UBOOM",
    );
  });

  test("init.headers iterable throws", async () => {
    await expectRejects(
      () =>
        fetch("http://127.0.0.1:1/", {
          headers: {
            *[Symbol.iterator]() {
              throw new Error("HBOOM");
            },
          } as any,
        }),
      "HBOOM",
    );
  });

  const propertyNames = [
    "body",
    "decompress",
    "headers",
    "keepalive",
    "method",
    "proxy",
    "redirect",
    "signal",
    "timeout",
    "tls",
    "unix",
    "verbose",
  ];
  test.each(propertyNames)("init.%s getter throws", async name => {
    await expectRejects(
      () =>
        fetch("http://127.0.0.1:1/", {
          get [name]() {
            throw new Error(`${name}-BOOM`);
          },
        } as any),
      `${name}-BOOM`,
    );
  });
});

test("fetch(RequestSubclass, undefined)", async () => {
  class MyRequest extends Request {
    constructor(input: RequestInfo, init?: RequestInit) {
      super(input, init);
      this.headers.set("hello", "world");
    }
  }
  const myRequest = new MyRequest(server!.url);
  const { headers } = await fetch(myRequest, undefined);

  expect(headers.get("hello")).toBe("world");
});

describe("does not send a request when", () => {
  let requestCount = 0;
  let server: TCPSocketListener | undefined;
  let url: string;

  beforeAll(async () => {
    server = Bun.listen({
      port: 0,
      hostname: "127.0.0.1",
      socket: {
        open(socket) {
          requestCount++;
          socket.terminate();
        },
        data(socket, data) {
          socket.terminate();
        },
      },
    });
    url = "http://" + server!.hostname + ":" + server!.port;
  });
  afterAll(() => {
    server!.stop(true);
  });

  test("Invalid headers", async () => {
    const prevCount = requestCount;
    expect(
      async () =>
        await fetch(url, {
          headers: {
            "😀smile ": "😀",
          },
        }),
    ).toThrow("Invalid header name");
    // Give it a chance to possibly send the request.
    await Bun.sleep(2);
    expect(requestCount).toBe(prevCount);
  });

  test("Invalid url", async () => {
    const prevCount = requestCount;
    expect(async () => await fetch("😀")).toThrow();
    // Give it a chance to possibly send the request.
    await Bun.sleep(2);
    expect(requestCount).toBe(prevCount);
  });

  test("Invalid redirect", async () => {
    const prevCount = requestCount;
    expect(async () => await fetch(url, { redirect: "😀" })).toThrow("redirect must be");
    // Give it a chance to possibly send the request.
    await Bun.sleep(2);
    expect(requestCount).toBe(prevCount);
  });

  test("proxy and unix", async () => {
    const prevCount = requestCount;
    expect(async () => await fetch(url, { proxy: url, unix: "/tmp/abc.sock" })).toThrow(
      "cannot use a proxy with a unix socket",
    );
    // Give it a chance to possibly send the request.
    await Bun.sleep(2);
    expect(requestCount).toBe(prevCount);
  });

  test("Invalid ca in tls", async () => {
    const prevCount = requestCount;
    expect(async () => await fetch(url, { tls: { ca: 123 } })).toThrow("TLSOptions.ca");
    // Give it a chance to possibly send the request.
    await Bun.sleep(2);
    expect(requestCount).toBe(prevCount);
  });

  const propertyNamesToThrow = [
    "body",
    "decompress",
    "headers",
    "keepalive",
    "method",
    "proxy",
    "redirect",
    "signal",
    "timeout",
    "tls",
    "unix",
    "verbose",
  ];

  test(`body on GET`, async () => {
    const prevCount = requestCount;
    expect(
      async () =>
        await fetch(url, {
          body: async function* () {
            throw new Error("boom");
          },
        }),
    ).toThrow("cannot have body");
    // Give it a chance to possibly send the request.
    await Bun.sleep(2);
    expect(requestCount).toBe(prevCount);
  });

  for (const propertyName of propertyNamesToThrow) {
    test(`get "${propertyName}" throws (url, 1st arg)`, async () => {
      const prevCount = requestCount;
      expect(
        async () =>
          await fetch(url, {
            get [propertyName]() {
              throw new Error("boom");
            },
          }),
      ).toThrow("boom");
      // Give it a chance to possibly send the request.
      await Bun.sleep(2);
      expect(requestCount).toBe(prevCount);
    });

    test(`get "${propertyName}" throws (1st arg)`, async () => {
      const prevCount = requestCount;
      expect(
        async () =>
          await fetch({
            url,
            get [propertyName]() {
              throw new Error("boom");
            },
          }),
      ).toThrow("boom");
      // Give it a chance to possibly send the request.
      await Bun.sleep(2);
      expect(requestCount).toBe(prevCount);
    });

    test(`get "${propertyName}" throws (Request object, 1st arg)`, async () => {
      const prevCount = requestCount;
      expect(
        async () =>
          await fetch(new Request(url), {
            get [propertyName]() {
              throw new Error("boom");
            },
          }),
      ).toThrow("boom");

      // Give it a chance to possibly send the request.
      await Bun.sleep(2);
      expect(requestCount).toBe(prevCount);
    });
  }
});

// fetch() never throws synchronously: argument and option errors come back as a
// rejected promise. Those promises must take part in unhandled-rejection
// tracking exactly like a `Promise.reject()`: an unhandled one reaches
// process.on("unhandledRejection") with (reason, promise), the default policy
// prints it and exits 1, and a late .catch() emits "rejectionHandled" only
// after "unhandledRejection" fired for that promise.
describe("early rejections are tracked like any other rejection", () => {
  // Every case rejects before a request is queued, so nothing here touches the network.
  const cases = /* js */ `
    const used = new Request("http://127.0.0.1:1/", { method: "POST", body: "abc" });
    await used.text();
    const blobUrl = URL.createObjectURL(new Blob(["x"]));
    URL.revokeObjectURL(blobUrl);
    const cases = {
      abortedSignal: () => fetch("http://127.0.0.1:1/", { signal: AbortSignal.abort() }),
      signalNotAbortSignal: () => fetch("http://127.0.0.1:1/", { signal: "nope" }),
      getWithBody: () => fetch("http://127.0.0.1:1/", { method: "GET", body: "x" }),
      bodyAlreadyUsed: () => fetch(used),
      invalidHeaderName: () => fetch("http://127.0.0.1:1/", { headers: { "bad header\\n": "x" } }),
      invalidRedirect: () => fetch("http://127.0.0.1:1/", { redirect: "bogus" }),
      invalidProxyUrl: () => fetch("http://127.0.0.1:1/", { proxy: "not a url::" }),
      proxyWithUnix: () => fetch("http://x/", { unix: "/tmp/nope.sock", proxy: "http://127.0.0.1:1" }),
      invalidTlsOption: () => fetch("https://127.0.0.1:1/", { tls: { ca: 42 } }),
      symbolBody: () => fetch("http://127.0.0.1:1/", { method: "POST", body: Symbol("x") }),
      toStringThrows: () => fetch({ toString() { throw new Error("toString"); } }),
      revokedBlobUrl: () => fetch(blobUrl),
      invalidDataUrl: () => fetch("data:application/json;base64,!!!!"),
      blankUrl: () => fetch(""),
      noArguments: () => fetch(),
      invalidUrl: () => fetch("http://[bad"),
      unsupportedProtocol: () => fetch("gopher://x/"),
    };
  `;
  const caseNames = [
    "abortedSignal",
    "signalNotAbortSignal",
    "getWithBody",
    "bodyAlreadyUsed",
    "invalidHeaderName",
    "invalidRedirect",
    "invalidProxyUrl",
    "proxyWithUnix",
    "invalidTlsOption",
    "symbolBody",
    "toStringThrows",
    "revokedBlobUrl",
    "invalidDataUrl",
    "blankUrl",
    "noArguments",
    "invalidUrl",
    "unsupportedProtocol",
  ];
  // unhandledRejection is delivered at the end of the event-loop turn that
  // rejected, rejectionHandled on the turn after the late .catch().
  const turn = `await new Promise(r => setImmediate(r)); await new Promise(r => setImmediate(r));`;

  async function run(script: string, ...args: string[]) {
    await using proc = Bun.spawn({
      cmd: [bunExe(), ...args, "-e", script],
      env: bunEnv,
      stdout: "pipe",
      stderr: "pipe",
    });
    const [stdout, stderr, exitCode] = await Promise.all([proc.stdout.text(), proc.stderr.text(), proc.exited]);
    return { stdout, stderr, exitCode };
  }

  test("unhandledRejection receives (reason, promise), then rejectionHandled on a late catch", async () => {
    const { stdout, stderr, exitCode } = await run(/* js */ `
      ${cases}
      const names = new Map();
      const events = [];
      process.on("unhandledRejection", (reason, promise) => {
        // DOMException#code is the legacy numeric code, so prefer a string code, else the name.
        const kind = typeof reason?.code === "string" ? reason.code : (reason?.name ?? typeof reason);
        events.push("unhandledRejection:" + names.get(promise) + ":" + kind);
      });
      process.on("rejectionHandled", promise => events.push("rejectionHandled:" + names.get(promise)));
      for (const [name, make] of Object.entries(cases)) names.set(make(), name);
      ${turn}
      for (const promise of names.keys()) promise.catch(() => {});
      ${turn}
      console.log(JSON.stringify(events));
    `);
    expect(stderr).toBe("");
    expect(JSON.parse(stdout)).toEqual([
      "unhandledRejection:abortedSignal:AbortError",
      "unhandledRejection:signalNotAbortSignal:ERR_INVALID_ARG_TYPE",
      "unhandledRejection:getWithBody:ERR_INVALID_ARG_VALUE",
      "unhandledRejection:bodyAlreadyUsed:ERR_BODY_ALREADY_USED",
      "unhandledRejection:invalidHeaderName:TypeError",
      "unhandledRejection:invalidRedirect:ERR_INVALID_ARG_TYPE",
      "unhandledRejection:invalidProxyUrl:ERR_INVALID_ARG_VALUE",
      "unhandledRejection:proxyWithUnix:ERR_INVALID_ARG_VALUE",
      "unhandledRejection:invalidTlsOption:ERR_INVALID_ARG_TYPE",
      "unhandledRejection:symbolBody:TypeError",
      "unhandledRejection:toStringThrows:Error",
      "unhandledRejection:revokedBlobUrl:ERR_INVALID_ARG_VALUE",
      "unhandledRejection:invalidDataUrl:Error",
      "unhandledRejection:blankUrl:ERR_INVALID_URL",
      "unhandledRejection:noArguments:ERR_MISSING_ARGS",
      "unhandledRejection:invalidUrl:ERR_INVALID_URL",
      "unhandledRejection:unsupportedProtocol:ERR_INVALID_ARG_VALUE",
      ...caseNames.map(name => "rejectionHandled:" + name),
    ]);
    expect(exitCode).toBe(0);
  });

  test("with no listener the rejection is printed and the exit code is 1", async () => {
    const { stderr, exitCode } = await run(/* js */ `
      fetch("gopher://x/");
      fetch("http://127.0.0.1:1/", { signal: AbortSignal.abort() });
      ${turn}
    `);
    expect(stderr).toContain("protocol must be http:, https: or s3:");
    expect(stderr).toContain("AbortError");
    expect(exitCode).toBe(1);
  });

  test("--unhandled-rejections=strict sees them too", async () => {
    const { stderr, exitCode } = await run(`fetch("gopher://x/"); ${turn}`, "--unhandled-rejections=strict");
    expect(stderr).toContain("protocol must be http:, https: or s3:");
    expect(exitCode).toBe(1);
  });

  test("a rejection handled in the same tick is not reported and emits no rejectionHandled", async () => {
    const { stdout, stderr, exitCode } = await run(/* js */ `
      ${cases}
      const events = [];
      process.on("unhandledRejection", reason => events.push("unhandledRejection:" + reason?.message));
      process.on("rejectionHandled", () => events.push("rejectionHandled"));
      const reasons = [];
      for (const make of Object.values(cases)) make().catch(e => reasons.push(e?.code ?? e?.name ?? typeof e));
      ${turn}
      console.log(JSON.stringify({ events, rejected: reasons.length }));
    `);
    expect(stderr).toBe("");
    expect(JSON.parse(stdout)).toEqual({ events: [], rejected: caseNames.length });
    expect(exitCode).toBe(0);
  });
});
