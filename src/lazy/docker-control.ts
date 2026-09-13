import http from "node:http";
import type { ContainerControl } from "../contracts.js";

/** Explicit local container allowlist. The caller provisions containers; this API cannot create them. */
export function createDockerController(options: { containers: readonly string[]; socketPath?: string }): ContainerControl {
  const allowed = new Set(options.containers.filter(Boolean));
  const socketPath = options.socketPath ?? "/var/run/docker.sock";
  function containerPath(name: string) {
    if (!allowed.has(name)) throw new Error("Container is outside the configured inference scope");
    return `/containers/${encodeURIComponent(name)}`;
  }
  function request(method: string, path: string): Promise<{ status: number; body: string }> {
    return new Promise((resolve, reject) => {
      const req = http.request({ socketPath, method, path, timeout: 15_000 }, (response) => {
        let body = "";
        response.on("data", (chunk: Buffer) => {
          body += chunk.toString();
          if (body.length > 1024 * 1024) req.destroy(new Error("Docker response exceeds limit"));
        });
        response.on("error", reject);
        response.on("end", () => resolve({ status: response.statusCode ?? 0, body }));
      });
      req.on("error", reject);
      req.on("timeout", () => req.destroy(new Error("Docker socket timed out")));
      req.end();
    });
  }
  return {
    async isRunning(name) {
      const path = containerPath(name);
      const response = await request("GET", `${path}/json`);
      if (response.status === 404) return false;
      if (response.status !== 200) throw new Error(`Docker inspect HTTP ${response.status}`);
      const data = JSON.parse(response.body) as { State?: { Running?: boolean } };
      return data.State?.Running === true;
    },
    async start(name) {
      const response = await request("POST", `${containerPath(name)}/start`);
      if (response.status !== 204 && response.status !== 304) throw new Error(`Docker start HTTP ${response.status}`);
    },
    async stop(name, graceSeconds = 10) {
      if (!Number.isInteger(graceSeconds) || graceSeconds < 0 || graceSeconds > 300) throw new Error("Invalid stop grace period");
      const response = await request("POST", `${containerPath(name)}/stop?t=${graceSeconds}`);
      if (response.status !== 204 && response.status !== 304) throw new Error(`Docker stop HTTP ${response.status}`);
    }
  };
}
