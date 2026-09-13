import type { AsrGateThresholds } from "./asr/asr-gate.js";
import type { TtsEngineConfig } from "./tts/engines.js";

export interface TtsReference {
  id: string;
  mime: string;
  audioBase64: string;
  text?: string | undefined;
}

export interface TtsSpeakRequest {
  text: string;
  engine?: string | undefined;
  voice?: string | undefined;
  language?: string | undefined;
  reference?: TtsReference | undefined;
}

export interface EngineEndpoint {
  url: string;
  model: string;
  timeoutMs?: number;
  /** Resolved only when making a request; never included in diagnostics. */
  headers?: () => Readonly<Record<string, string>>;
}

export interface TranscribeOptions {
  language?: string;
  prompt?: string;
  hotwords?: string;
  signal?: AbortSignal;
}

export interface ChatOptions {
  jsonObject?: boolean;
  jsonSchema?: Record<string, unknown>;
  signal?: AbortSignal;
}

export interface SynthesizedAudio {
  audio: Buffer;
  engine: string;
  model: string;
  voice: string;
}

export type InferenceService = "asr" | "llm" | "tts" | "embed";
export interface InferenceState {
  service: InferenceService;
  state: "unloaded" | "loading" | "ready" | "releasing";
  model?: string;
}

export interface ContainerControl {
  isRunning(name: string): Promise<boolean>;
  start(name: string): Promise<void>;
  stop(name: string, graceSeconds?: number): Promise<void>;
}

export interface InferenceConfig {
  llm?: EngineEndpoint & { container?: string; idleMs?: number; keepWarm?: boolean };
  asr?: EngineEndpoint & {
    language?: string;
    prompt?: string;
    hotwords?: string;
    retries?: number;
    thresholds?: AsrGateThresholds;
    /** Speaches only: release its resident Whisper model before Chatterbox/Qwen3 inference. */
    unloadBeforeHeavyTts?: boolean;
  };
  tts?: readonly TtsEngineConfig[];
  ttsTimeoutMs?: number;
  embed?: Omit<EngineEndpoint, "model">;
  warmupTimeoutMs?: number;
  warmupPollMs?: number;
}

export interface InferenceDependencies {
  containers?: ContainerControl;
  fetch?: typeof fetch;
  now?: () => number;
  onState?: (state: InferenceState) => void;
  /** Only operation labels, counters and durations. No prompts, audio or engine responses. */
  onEvent?: (event: { operation: string; phase: "started" | "finished" | "retry"; durationMs?: number; attempt?: number }) => void;
}
