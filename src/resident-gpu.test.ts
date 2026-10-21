import { expect, it, vi } from "vitest";
import { createInferenceRuntime } from "./runtime.js";
import { createGpuAccess } from "./gpu-access.js";

it("admits resident audio before a long LLM response completes", async () => {
  const generating = Promise.withResolvers<void>();
  const finish = Promise.withResolvers<void>();
  const runtime = createInferenceRuntime({
    llm: { url: "http://llm", model: "synthetic" },
    // This opt-in must not change ordinary exclusive operations.
    residentGpuOperations: ["llm", "stream"]
  }, { fetch: vi.fn(async () => {
    generating.resolve();
    await finish.promise;
    return Response.json({ choices: [{ message: { content: "done" } }] });
  }) });
  const chat = runtime.chat([], 8);
  await generating.promise;
  let admitted = false;
  const audio = runtime.withGpuLock("stream", async () => { admitted = true; }, { resident: true });
  try {
    await vi.waitFor(() => expect(admitted).toBe(true), { timeout: 100, interval: 5 });
  } finally {
    finish.resolve();
    await Promise.all([chat, audio]);
  }
});

it("keeps preparation and unload exclusive across the atomic downgrade", async () => {
  const prepared = Promise.withResolvers<void>();
  const generating = Promise.withResolvers<void>();
  const finish = Promise.withResolvers<void>();
  const control = { isRunning: async () => true, start: vi.fn(), stop: vi.fn() };
  const runtime = createInferenceRuntime({
    llm: { url: "http://llm", model: "synthetic", container: "llm" },
    residentGpuOperations: ["llm", "stream"]
  }, { containers: control, fetch: vi.fn(async url => {
    if (String(url).endsWith("/health")) { await prepared.promise; return new Response("ok"); }
    generating.resolve(); await finish.promise;
    return Response.json({ choices: [{ message: { content: "done" } }] });
  }) });
  const chat = runtime.chat([], 8);
  const audioEntered = vi.fn(async () => {});
  const audio = runtime.withGpuLock("stream", audioEntered, { resident: true });
  await new Promise(resolve => setTimeout(resolve, 5));
  expect(audioEntered).not.toHaveBeenCalled();
  const unload = runtime.withExclusiveGpu(async () => {});
  prepared.resolve();
  await generating.promise;
  await audio;
  expect(control.stop).not.toHaveBeenCalled();
  finish.resolve();
  await Promise.all([chat, unload]);
  expect(control.stop).toHaveBeenCalledOnce();
});

it.each([undefined, ["llm"]])("keeps unconfigured operations exclusive (%j)", async pair => {
  const access = createGpuAccess(pair);
  const entered = Promise.withResolvers<void>();
  const finish = Promise.withResolvers<void>();
  const first = access.run("llm", true, async () => { entered.resolve(); await finish.promise; });
  await entered.promise;
  const next = vi.fn(async () => {});
  const second = access.run("stream", true, next);
  await new Promise(resolve => setTimeout(resolve, 5));
  expect(next).not.toHaveBeenCalled();
  finish.resolve();
  await Promise.all([first, second]);
  expect(next).toHaveBeenCalledOnce();
});

it("serializes each resident label and waits for both before lifecycle work", async () => {
  const access = createGpuAccess(["llm", "stream"]);
  const llm = Promise.withResolvers<void>();
  const stream = Promise.withResolvers<void>();
  const first = access.run("llm", true, () => llm.promise);
  const second = access.run("stream", true, () => stream.promise);
  const same = vi.fn(async () => {});
  const third = access.run("stream", true, same);
  const exclusive = vi.fn(async () => {});
  const fourth = access.run("stop", false, exclusive);
  await new Promise(resolve => setTimeout(resolve, 5));
  expect(same).not.toHaveBeenCalled();
  llm.resolve();
  await first;
  expect(exclusive).not.toHaveBeenCalled();
  stream.resolve();
  await Promise.all([second, third, fourth]);
  expect(same).toHaveBeenCalledOnce();
  expect(exclusive).toHaveBeenCalledOnce();
});

it("recovers after a resident fails and refuses invalid configurations", async () => {
  const access = createGpuAccess(["llm", "stream"]);
  await expect(access.run("stream", true, async () => { throw new Error("failed"); })).rejects.toThrow("failed");
  await expect(access.run("stop", false, async () => 42)).resolves.toBe(42);
  expect(() => createGpuAccess(["a", "a"])).toThrow();
  expect(() => createGpuAccess(["a", "b", "c"])).toThrow();
  expect(() => createGpuAccess(["private payload"])).toThrow();
});
