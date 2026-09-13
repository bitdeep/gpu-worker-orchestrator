import { describe, expect, it } from "vitest";
import { createServer } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createDockerController } from "./docker-control.js";

describe("scoped Docker control", () => {
  it("rejects unconfigured containers before contacting Docker", async () => {
    const control = createDockerController({ containers: ["llm"], socketPath: "/does-not-exist" });
    await expect(control.start("unrelated")).rejects.toThrow(/scope/);
    await expect(control.stop("unrelated")).rejects.toThrow(/scope/);
    await expect(control.isRunning("unrelated")).rejects.toThrow(/scope/);
    await expect(control.stop("llm", -1)).rejects.toThrow(/grace/);
  });

  it("honors Docker status codes and never creates containers", async () => {
    const directory = await mkdtemp(join(tmpdir(), "inference-controller-"));
    const socketPath = join(directory, "docker.sock");
    const calls: string[] = [];
    let inspectStatus = 200;
    const server = createServer((req, res) => {
      calls.push(`${req.method} ${req.url}`);
      res.statusCode = req.method === "GET" ? inspectStatus : 304;
      res.end(req.method === "GET" ? JSON.stringify({ State: { Running: true } }) : undefined);
    });
    await new Promise<void>((resolve) => server.listen(socketPath, resolve));
    try {
      const control = createDockerController({ containers: ["llm"], socketPath });
      expect(await control.isRunning("llm")).toBe(true);
      await control.start("llm");
      await control.stop("llm", 5);
      inspectStatus = 403;
      await expect(control.isRunning("llm")).rejects.toThrow("403");
      inspectStatus = 404;
      expect(await control.isRunning("llm")).toBe(false);
      expect(calls.slice(0, 3)).toEqual([
        "GET /containers/llm/json", "POST /containers/llm/start", "POST /containers/llm/stop?t=5"
      ]);
    } finally {
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
      await rm(directory, { recursive: true, force: true });
    }
  });
});
