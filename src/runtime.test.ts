import { describe, expect, it, vi } from "vitest";
import { createInferenceRuntime } from "./runtime.js";
import type { ContainerControl } from "./contracts.js";

function containers(initial: string[] = []) {
  const running = new Set(initial);
  return {
    running,
    isRunning: vi.fn(async (name: string) => running.has(name)),
    start: vi.fn(async (name: string) => { running.add(name); }),
    stop: vi.fn(async (name: string) => { running.delete(name); })
  } satisfies ContainerControl & { running: Set<string> };
}

describe("inference runtime boundary", () => {
  it("uses caller-owned authorization for managed LLM health and inference", async () => {
    const request = vi.fn<typeof fetch>(async (url, init) => {
      expect(new Headers(init?.headers).get("authorization")).toBe("Bearer synthetic");
      return String(url).endsWith("/health") ? new Response("ok") : Response.json({ choices: [{ message: { content: "ok" } }] });
    });
    const runtime = createInferenceRuntime({
      llm: { url: "http://llm", model: "demo", container: "llm", headers: () => ({ authorization: "Bearer synthetic" }) }
    }, { fetch: request, containers: containers(["llm"]) });
    expect(await runtime.chat([], 8)).toBe("ok");
    expect(request).toHaveBeenCalledTimes(2);
  });
  it("serializes calls and recovers after a failed call", async () => {
    const runtime = createInferenceRuntime({});
    const seen: string[] = [];
    const first = runtime.withGpuLock("one", async () => {
      seen.push("one");
      await new Promise((resolve) => setTimeout(resolve, 5));
      throw new Error("expected");
    });
    const second = runtime.withGpuLock("two", async () => { seen.push("two"); return 2; });
    await expect(first).rejects.toThrow("expected");
    await expect(second).resolves.toBe(2);
    expect(seen).toEqual(["one", "two"]);
  });

  it("never unloads a busy LLM when its idle threshold expires", async () => {
    const control = containers(["llm"]);
    let now = 1000;
    let finish: () => void = () => {};
    const requested = Promise.withResolvers<void>();
    const runtime = createInferenceRuntime(
      { llm: { url: "http://llm", model: "demo", container: "llm", idleMs: 10 } },
      { containers: control, now: () => now, fetch: vi.fn(async (url) => {
        if (String(url).endsWith("/health")) return new Response("ok");
        requested.resolve();
        await new Promise<void>((resolve) => { finish = resolve; });
        return Response.json({ choices: [{ message: { content: "ok" } }] });
      }) }
    );
    const chat = runtime.chat([], 8);
    await requested.promise;
    now = 5000;
    const sweep = runtime.sweepIdle();
    expect(control.stop).not.toHaveBeenCalled();
    finish();
    await expect(chat).resolves.toBe("ok");
    await sweep;
    expect(control.stop).not.toHaveBeenCalled();
    now = 6000;
    await runtime.sweepIdle();
    expect(control.stop).toHaveBeenCalledWith("llm");
  });

  it("preserves structured generation and caller cancellation", async () => {
    const request = vi.fn<typeof fetch>(async () => Response.json({ choices: [{ message: { content: '{"ok":true}' } }] }));
    const runtime = createInferenceRuntime({ llm: { url: "http://llm", model: "demo" } }, { fetch: request });
    await runtime.chat([{ role: "user", content: "synthetic" }], 16, { jsonObject: true, jsonSchema: { type: "object" } });
    expect(JSON.parse(String(request.mock.calls[0]?.[1]?.body))).toMatchObject({
      model: "demo", max_tokens: 16, chat_template_kwargs: { enable_thinking: false },
      response_format: { type: "json_schema", json_schema: { strict: true, schema: { type: "object" } } }
    });
    const abort = new AbortController();
    abort.abort();
    await expect(runtime.chat([], 8, { signal: abort.signal })).rejects.toThrow();
    expect(request).toHaveBeenCalledTimes(1);
  });

  it("unloads only managed heavy voices before ASR and preserves VAD and confidence filtering", async () => {
    const control = containers(["heavy", "unrelated"]);
    const request = vi.fn<typeof fetch>(async (_url, init) => {
      const form = init?.body as FormData;
      expect(form.get("vad_filter")).toBe("true");
      expect(form.get("response_format")).toBe("verbose_json");
      expect(form.get("hotwords")).toBe("Example");
      return Response.json({ text: "ignored", segments: [
        { text: "Hello", no_speech_prob: 0.02, avg_logprob: -0.2, compression_ratio: 1.2 },
        { text: "noise", no_speech_prob: 0.99 }
      ] });
    });
    const runtime = createInferenceRuntime({
      asr: { url: "http://asr", model: "whisper", retries: 1 },
      tts: [{ id: "voice", kind: "chatterbox", url: "http://voice", container: "heavy", model: "demo", voice: "", idleMs: 20 }]
    }, { containers: control, fetch: request });
    await expect(runtime.transcribe(Buffer.from("audio"), "audio/wav", { hotwords: "Example" })).resolves.toBe("Hello");
    expect(control.stop).toHaveBeenCalledExactlyOnceWith("heavy");
    expect(control.running.has("unrelated")).toBe(true);
  });

  it("gives batch jobs the same lock, releases the managed LLM, then restores keep-warm", async () => {
    const control = containers(["llm"]);
    const runtime = createInferenceRuntime(
      { llm: { url: "http://llm", model: "demo", container: "llm", keepWarm: true }, warmupPollMs: 1 },
      { containers: control, fetch: vi.fn(async () => new Response(control.running.has("llm") ? "ok" : "loading", { status: control.running.has("llm") ? 200 : 503 })) }
    );
    await expect(runtime.withExclusiveGpu(async () => {
      expect(control.running.has("llm")).toBe(false);
      throw new Error("batch failed");
    })).rejects.toThrow("batch failed");
    expect(control.running.has("llm")).toBe(true);
  });

  it("rejects incomplete Qwen voice references before starting a GPU container", async () => {
    const control = containers();
    const runtime = createInferenceRuntime({
      tts: [{ id: "voice", kind: "qwen3", url: "http://voice", model: "demo", container: "voice", voice: "", idleMs: 10 }]
    }, { containers: control });
    await expect(runtime.synthesize({ text: "Example", reference: { id: "a", mime: "audio/wav", audioBase64: "YQ==" } })).rejects.toThrow(/transcrição/);
    expect(control.start).not.toHaveBeenCalled();
  });
});
