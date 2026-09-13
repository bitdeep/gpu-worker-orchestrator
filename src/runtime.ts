import { setTimeout as delay } from "node:timers/promises";
import type {
  ChatOptions, ContainerControl, InferenceConfig, InferenceDependencies, InferenceService,
  InferenceState, SynthesizedAudio, TranscribeOptions, TtsSpeakRequest
} from "./contracts.js";
import { gateTranscript, DEFAULT_ASR_GATE, type VerboseTranscription } from "./asr/asr-gate.js";
import { shouldIdleUnload } from "./lazy/idle-unload.js";
import { createTtsSynthesizer, caminhoDeSaude, motorPronto, oQueFaltaNoPedido } from "./tts/dialetos.js";
import type { TtsEngineConfig } from "./tts/engines.js";
import { criarTextoDaReferencia } from "./tts/referencia.js";
import { motoresADescarregarAntesDe, motoresPesadosADescarregar } from "./tts/residencia.js";
import { paraMp3, precisaConverterParaMp3 } from "./tts/mp3.js";

function signalFor(timeoutMs: number, external?: AbortSignal): AbortSignal {
  const timeout = AbortSignal.timeout(timeoutMs);
  return external ? AbortSignal.any([timeout, external]) : timeout;
}

/** One instance per GPU owner. No hub, client identity, queue or environment is read here. */
export function createInferenceRuntime(config: InferenceConfig, deps: InferenceDependencies = {}) {
  const request = deps.fetch ?? fetch;
  const now = deps.now ?? Date.now;
  const voices = config.tts ?? [];
  const synthesizeEngine = createTtsSynthesizer();
  const llm = config.llm;
  const asr = config.asr;
  const warmupMs = config.warmupTimeoutMs ?? 180_000;
  const warmupPollMs = config.warmupPollMs ?? 3000;
  const managed = [llm?.container, ...voices.map((engine) => engine.container)].filter(Boolean);
  if (managed.length && !deps.containers) throw new Error("Managed engines require explicit container control");
  const control: ContainerControl = deps.containers ?? {
    async isRunning() { return false; },
    async start() { throw new Error("Container control is not configured"); },
    async stop() { throw new Error("Container control is not configured"); }
  };
  let tail = Promise.resolve();
  let lastLlmUse = 0;
  let llmWarmup: Promise<void> | null = null;
  let idleTimer: ReturnType<typeof setInterval> | undefined;
  const voiceState = new Map<string, { lastUse: number; warmup: Promise<void> | null }>();
  const states = new Map<InferenceService, InferenceState>();

  function state(service: InferenceService, value: InferenceState["state"], model?: string) {
    const entry: InferenceState = { service, state: value, ...(model !== undefined ? { model } : {}) };
    if (value === "unloaded") states.delete(service);
    else states.set(service, entry);
    deps.onState?.(entry);
  }

  function withGpuLock<T>(operation: string, fn: () => Promise<T>): Promise<T> {
    const run = tail.then(async () => {
      const started = now();
      deps.onEvent?.({ operation, phase: "started" });
      try {
        return await fn();
      } finally {
        deps.onEvent?.({ operation, phase: "finished", durationMs: now() - started });
      }
    });
    tail = run.then(() => undefined, () => undefined);
    return run;
  }

  function voiceStatus(engine: TtsEngineConfig) {
    let entry = voiceState.get(engine.id);
    if (!entry) {
      entry = { lastUse: 0, warmup: null };
      voiceState.set(engine.id, entry);
    }
    return entry;
  }

  async function healthy(url: string, kind?: TtsEngineConfig["kind"], headers?: Readonly<Record<string, string>>) {
    try {
      const response = await request(`${url.replace(/\/+$/, "")}${kind ? caminhoDeSaude(kind) : "/health"}`, {
        signal: AbortSignal.timeout(4000), ...(headers ? { headers } : {})
      });
      return kind ? await motorPronto(kind, response) : response.ok;
    } catch {
      return false;
    }
  }

  async function ensureLlmReady() {
    if (!llm?.container) return;
    if (await healthy(llm.url, undefined, llm.headers?.())) {
      lastLlmUse = now();
      state("llm", "ready", llm.model);
      return;
    }
    if (!llmWarmup) {
      llmWarmup = (async () => {
        state("llm", "loading", llm.model);
        if (!(await control.isRunning(llm.container!))) await control.start(llm.container!);
        const deadline = now() + warmupMs;
        while (now() < deadline) {
          if (await healthy(llm.url, undefined, llm.headers?.())) {
            lastLlmUse = now();
            state("llm", "ready", llm.model);
            return;
          }
          await delay(warmupPollMs);
        }
        throw new Error("LLM warmup timed out");
      })().catch((error: unknown) => {
        state("llm", "unloaded");
        throw error;
      }).finally(() => { llmWarmup = null; });
    }
    await llmWarmup;
  }

  async function unloadVoices(engines: readonly TtsEngineConfig[]) {
    for (const engine of engines) {
      if (engine.container && await control.isRunning(engine.container)) {
        await control.stop(engine.container);
        voiceStatus(engine).lastUse = 0;
        state("tts", "unloaded", `${engine.id}:${engine.model}`);
      }
    }
  }

  async function ensureVoiceReady(engine: TtsEngineConfig) {
    if (!engine.container || await healthy(engine.url, engine.kind)) return;
    const entry = voiceStatus(engine);
    if (!entry.warmup) {
      entry.warmup = (async () => {
        state("tts", "loading", `${engine.id}:${engine.model}`);
        if (!(await control.isRunning(engine.container))) {
          await unloadVoices(motoresADescarregarAntesDe(engine, voices));
          await control.start(engine.container);
        }
        const deadline = now() + warmupMs;
        while (now() < deadline) {
          if (await healthy(engine.url, engine.kind)) {
            state("tts", "ready", `${engine.id}:${engine.model}`);
            return;
          }
          await delay(warmupPollMs);
        }
        throw new Error(`Voice engine ${engine.id} warmup timed out`);
      })().catch((error: unknown) => {
        state("tts", "unloaded");
        throw error;
      }).finally(() => { entry.warmup = null; });
    }
    await entry.warmup;
  }

  async function chat(messages: unknown, maxTokens: number, options: ChatOptions = {}): Promise<string> {
    return withGpuLock("llm", async () => {
      options.signal?.throwIfAborted();
      if (!llm?.url) throw new Error("LLM endpoint is not configured");
      await ensureLlmReady();
      options.signal?.throwIfAborted();
      lastLlmUse = now();
      state("llm", "ready", llm.model);
      const body: Record<string, unknown> = {
        model: llm.model, max_tokens: maxTokens, temperature: 0.3,
        chat_template_kwargs: { enable_thinking: false }, messages
      };
      if (options.jsonObject) {
        body.response_format = {
          type: "json_schema",
          json_schema: {
            name: "structured-result", strict: options.jsonSchema !== undefined,
            schema: options.jsonSchema ?? { type: "object", additionalProperties: true }
          }
        };
      }
      try {
        const response = await request(`${llm.url.replace(/\/+$/, "")}/v1/chat/completions`, {
          method: "POST",
          headers: { "content-type": "application/json", ...llm.headers?.() },
          body: JSON.stringify(body), signal: signalFor(llm.timeoutMs ?? 120_000, options.signal)
        });
        if (!response.ok) throw new Error(`LLM HTTP ${response.status}`);
        const data = await response.json() as { choices?: Array<{ message?: { content?: string } }> };
        return (data.choices?.[0]?.message?.content ?? "").trim();
      } finally {
        lastLlmUse = now();
      }
    });
  }

  async function transcribe(buffer: Buffer, mime: string, options: TranscribeOptions = {}): Promise<string> {
    const attempts = Math.max(1, asr?.retries ?? 3);
    let lastError: unknown;
    for (let attempt = 1; attempt <= attempts; attempt++) {
      options.signal?.throwIfAborted();
      try {
        return await withGpuLock("asr", async () => {
          options.signal?.throwIfAborted();
          if (!asr?.url) throw new Error("ASR endpoint is not configured");
          await unloadVoices(motoresPesadosADescarregar(voices));
          state("asr", "ready", asr.model);
          const form = new FormData();
          form.set("file", new Blob([new Uint8Array(buffer)], { type: mime }), "recording");
          form.set("model", asr.model);
          form.set("language", options.language ?? asr.language ?? "pt");
          form.set("vad_filter", "true");
          form.set("response_format", "verbose_json");
          const prompt = (options.prompt ?? asr.prompt ?? "").trim();
          const hotwords = (options.hotwords ?? asr.hotwords ?? "").trim();
          if (prompt) form.set("prompt", prompt);
          if (hotwords) form.set("hotwords", hotwords);
          const response = await request(`${asr.url.replace(/\/+$/, "")}/v1/audio/transcriptions`, {
            method: "POST", body: form, headers: asr.headers?.() ?? {},
            signal: signalFor(asr.timeoutMs ?? 600_000, options.signal)
          });
          if (!response.ok) throw new Error(`asr HTTP ${response.status}`);
          return gateTranscript(await response.json() as VerboseTranscription, asr.thresholds ?? DEFAULT_ASR_GATE);
        });
      } catch (error) {
        lastError = error;
        if (options.signal?.aborted) throw error;
        deps.onEvent?.({ operation: "asr", phase: "retry", attempt });
        if (attempt < attempts) {
          await delay(1500 * attempt, undefined, options.signal ? { signal: options.signal } : {});
        }
      }
    }
    throw lastError ?? new Error("ASR failed");
  }

  const referenceText = criarTextoDaReferencia(
    asr?.url ? (audio, mime, language) => transcribe(audio, mime, { language }) : null,
    asr?.language ?? "pt"
  );

  async function releaseAsrBeforeVoice(engine: TtsEngineConfig) {
    if (!asr?.unloadBeforeHeavyTts || engine.kind === "openai") return;
    const response = await request(`${asr.url.replace(/\/+$/, "")}/api/ps/${encodeURIComponent(asr.model)}`, {
      method: "DELETE", headers: asr.headers?.() ?? {}, signal: AbortSignal.timeout(30_000)
    });
    // Speaches returns 404 when the model is already absent; weights remain cached on disk.
    if (!response.ok && response.status !== 404) throw new Error(`ASR unload HTTP ${response.status}`);
    state("asr", "unloaded", asr.model);
  }

  async function synthesize(original: TtsSpeakRequest): Promise<SynthesizedAudio> {
    const engine = original.engine ? voices.find((entry) => entry.id === original.engine) : voices[0];
    if (!engine) throw new Error("Requested voice engine is not configured");
    let input = original;
    if (engine.kind === "qwen3" && input.reference && !input.reference.text) {
      const text = await referenceText(input.reference);
      if (text) input = { ...input, reference: { ...input.reference, text } };
    }
    const missing = oQueFaltaNoPedido(engine.kind, input);
    if (missing) throw new Error(missing);
    return withGpuLock(`tts:${engine.id}`, async () => {
      await releaseAsrBeforeVoice(engine);
      await ensureVoiceReady(engine);
      const entry = voiceStatus(engine);
      entry.lastUse = now();
      state("tts", "ready", `${engine.id}:${engine.model}`);
      try {
        const response = await synthesizeEngine(engine, input, config.ttsTimeoutMs ?? 300_000, request);
        const audio = precisaConverterParaMp3(response.contentType) ? await paraMp3(response.audio) : response.audio;
        return { audio, engine: engine.id, model: response.model, voice: response.voice };
      } finally {
        entry.lastUse = now();
      }
    });
  }

  async function embed(texts: string[]): Promise<number[][]> {
    const endpoint = config.embed;
    if (!endpoint?.url) throw new Error("embed_url_unset");
    const response = await request(`${endpoint.url.replace(/\/+$/, "")}/embed`, {
      method: "POST", headers: { "content-type": "application/json", ...endpoint.headers?.() },
      body: JSON.stringify({ inputs: texts, truncate: true }),
      signal: AbortSignal.timeout(endpoint.timeoutMs ?? 60_000)
    });
    if (!response.ok) throw new Error(`embed_http_${response.status}`);
    const data: unknown = await response.json();
    const vectors = Array.isArray(data) ? data : (data as { embeddings?: unknown } | null)?.embeddings;
    if (!Array.isArray(vectors) || vectors.length !== texts.length ||
      !vectors.every((vector: unknown) => Array.isArray(vector) && vector.every((value: unknown) => typeof value === "number" && Number.isFinite(value)))) {
      throw new Error("embed_bad_response");
    }
    return vectors as number[][];
  }

  async function withExclusiveGpu<T>(run: () => Promise<T>): Promise<T> {
    return withGpuLock("batch", async () => {
      await unloadVoices(motoresPesadosADescarregar(voices));
      try {
        if (llm?.container) {
          await control.stop(llm.container);
          state("llm", "unloaded");
          lastLlmUse = 0;
        }
        return await run();
      } finally {
        if (llm?.keepWarm && llm.container) await ensureLlmReady();
      }
    });
  }

  async function seedIdleClocks() {
    if (llm?.container && await control.isRunning(llm.container)) lastLlmUse = now();
    for (const engine of voices) {
      if (engine.container && await control.isRunning(engine.container)) voiceStatus(engine).lastUse = now();
    }
  }

  async function sweepIdle() {
    // Sweeping takes the same lock as requests: a long generation can never be stopped mid-flight.
    return withGpuLock("idle", async () => {
      if (llm?.container && shouldIdleUnload(llm.container, lastLlmUse, llm.keepWarm ? 0 : llm.idleMs ?? 300_000, now(), llmWarmup !== null)) {
        if (await control.isRunning(llm.container)) {
          await control.stop(llm.container);
          lastLlmUse = 0;
          state("llm", "unloaded");
        }
      }
      for (const engine of voices) {
        const entry = voiceStatus(engine);
        if (shouldIdleUnload(engine.container, entry.lastUse, engine.idleMs, now(), entry.warmup !== null)) {
          await unloadVoices([engine]);
        }
      }
    });
  }

  async function startIdleUnloader(intervalMs = 60_000) {
    if (idleTimer) return;
    await seedIdleClocks();
    idleTimer = setInterval(() => {
      void sweepIdle().catch(() => deps.onEvent?.({ operation: "idle", phase: "retry" }));
    }, intervalMs);
    idleTimer.unref();
  }

  return {
    chat, transcribe, synthesize, embed, withGpuLock, withExclusiveGpu, sweepIdle, seedIdleClocks, startIdleUnloader,
    warmup: () => withGpuLock("llm-prewarm", ensureLlmReady),
    states: () => [...states.values()].map((entry) => ({ ...entry })),
    close: () => { if (idleTimer) clearInterval(idleTimer); idleTimer = undefined; }
  };
}
