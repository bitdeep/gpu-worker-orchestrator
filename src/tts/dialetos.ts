import { createHash } from "node:crypto";

import type { TtsSpeakRequest } from "../contracts.js";
import type { TtsEngineConfig, TtsKind } from "./engines.js";
import { concatenarMp3 } from "./mp3.js";
import { dividirEmTrechos } from "./trechos.js";

/** Translate a generic synthesis request to each engine API. Never log text or voice references. */
export interface RespostaDoMotor {
  audio: Buffer;
  contentType: string | null;
  model: string;
  voice: string;
}

export type FetchFn = typeof fetch;

export function caminhoDeSaude(kind: TtsKind): string {
  switch (kind) {
    case "openai":
      return "/health";
    case "chatterbox":
      return "/api/model-info";
    case "qwen3":
      return "/health";
  }
}

/** A resposta de saúde diz "pronto"? O malaiwah responde 200 com `model_ready:false` enquanto carrega. */
export async function motorPronto(kind: TtsKind, res: Response): Promise<boolean> {
  if (!res.ok) return false;
  if (kind !== "qwen3") return true;
  try {
    const corpo = (await res.json()) as { model_ready?: unknown };
    return corpo.model_ready === true;
  } catch {
    return false;
  }
}
async function sintetizarOpenAi(engine: TtsEngineConfig, pedido: TtsSpeakRequest, timeoutMs: number, fetchFn: FetchFn): Promise<RespostaDoMotor> {
  const voice = pedido.voice || engine.voice || "alloy";
  const res = await fetchFn(`${engine.url}/v1/audio/speech`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ model: engine.model, voice, input: pedido.text, response_format: "mp3" }),
    signal: AbortSignal.timeout(timeoutMs)
  });
  if (!res.ok) {
    throw new Error(`TTS HTTP ${res.status}`);
  }
  return { audio: Buffer.from(await res.arrayBuffer()), contentType: res.headers.get("content-type"), model: engine.model, voice };
}
interface VoiceCache {
  references: Map<string, Set<string>>;
  voices: Map<string, Map<string, string>>;
}

function endpointKey(engine: TtsEngineConfig): string {
  return `${engine.url}\0${engine.id}`;
}

function nomeDaReferencia(id: string): string {
  return `${id.replace(/[^a-zA-Z0-9]/g, "").slice(0, 80)}.wav`;
}

async function garantirReferenciaNoChatterbox(engine: TtsEngineConfig, referencia: NonNullable<TtsSpeakRequest["reference"]>, timeoutMs: number, fetchFn: FetchFn, cache: VoiceCache): Promise<string> {
  const nome = nomeDaReferencia(referencia.id);
  let cadastradas = cache.references.get(endpointKey(engine));
  if (!cadastradas) {
    cadastradas = new Set<string>();
    cache.references.set(endpointKey(engine), cadastradas);
  }
  if (cadastradas.has(nome)) return nome;
  try {
    const lista = await fetchFn(`${engine.url}/get_reference_files`, { signal: AbortSignal.timeout(10_000) });
    if (lista.ok) {
      const nomes = (await lista.json()) as unknown;
      if (Array.isArray(nomes) && nomes.includes(nome)) {
        cadastradas.add(nome);
        return nome;
      }
    }
  } catch {
    // An unavailable listing does not prevent an idempotent upload.
  }
  const form = new FormData();
  form.set("files", new Blob([Buffer.from(referencia.audioBase64, "base64")], { type: "audio/wav" }), nome);
  const res = await fetchFn(`${engine.url}/upload_reference`, { method: "POST", body: form, signal: AbortSignal.timeout(timeoutMs) });
  if (!res.ok) {
    throw new Error(`chatterbox: cadastro da referência HTTP ${res.status}`);
  }
  const corpo = (await res.json()) as { uploaded_files?: unknown; errors?: Array<{ error?: string }> };
  if (!Array.isArray(corpo.uploaded_files) || !corpo.uploaded_files.includes(nome)) {
    throw new Error("chatterbox: referência recusada");
  }
  cadastradas.add(nome);
  return nome;
}

/** Normalize language to ISO-639-1 for the multilingual engine. */
function idiomaCurto(language: string | undefined): string {
  const base = (language ?? "pt").toLowerCase().split(/[-_]/)[0] ?? "pt";
  return base || "pt";
}

const TENTATIVAS_ENQUANTO_CARREGA = 20;

async function sintetizarChatterbox(engine: TtsEngineConfig, pedido: TtsSpeakRequest, timeoutMs: number, fetchFn: FetchFn, cache: VoiceCache): Promise<RespostaDoMotor> {
  const corpo: Record<string, unknown> = {
    text: pedido.text,
    output_format: "mp3",
    split_text: true,
    chunk_size: 200,
    language: idiomaCurto(pedido.language),
    exaggeration: 0.4,
    cfg_weight: 0.5,
    temperature: 0.7,
    seed: 7
  };
  let voice: string;
  if (pedido.reference) {
    voice = await garantirReferenciaNoChatterbox(engine, pedido.reference, timeoutMs, fetchFn, cache);
    corpo.voice_mode = "clone";
    corpo.reference_audio_filename = voice;
  } else {
    voice = engine.voice || pedido.voice || "";
    if (!voice) {
      throw new Error("chatterbox: sem referência de voz e sem voz pré-definida configurada (TTS_<ID>_VOICE)");
    }
    corpo.voice_mode = "predefined";
    corpo.predefined_voice_id = voice;
  }
  for (let tentativa = 1; ; tentativa++) {
    const res = await fetchFn(`${engine.url}/tts`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(corpo),
      signal: AbortSignal.timeout(timeoutMs)
    });
    if (res.status === 503 && tentativa < TENTATIVAS_ENQUANTO_CARREGA) {
      await new Promise((r) => setTimeout(r, 3000));
      continue;
    }
    if (!res.ok) {
      throw new Error(`chatterbox: síntese HTTP ${res.status}`);
    }
    return { audio: Buffer.from(await res.arrayBuffer()), contentType: res.headers.get("content-type"), model: engine.model, voice };
  }
}
const QWEN3_MAX_CHARS = 3500;

function idiomaPorNome(language: string | undefined): string {
  const base = idiomaCurto(language);
  const nomes: Record<string, string> = { pt: "Portuguese", en: "English", es: "Spanish", it: "Italian", fr: "French", de: "German", ja: "Japanese", ko: "Korean", ru: "Russian", zh: "Chinese" };
  return nomes[base] ?? "Auto";
}

/** Include the reference transcript hash: reusing a voice registered without text breaks cloning. */
export function nomeDaVozNoQwen3(referencia: NonNullable<TtsSpeakRequest["reference"]>): string {
  if (!referencia.text) return referencia.id;
  return `${referencia.id}-${createHash("sha256").update(referencia.text).digest("hex").slice(0, 12)}`;
}

async function garantirVozNoQwen3(engine: TtsEngineConfig, referencia: NonNullable<TtsSpeakRequest["reference"]>, language: string, timeoutMs: number, fetchFn: FetchFn, cache: VoiceCache): Promise<string> {
  let cadastradas = cache.voices.get(endpointKey(engine));
  if (!cadastradas) {
    cadastradas = new Map<string, string>();
    cache.voices.set(endpointKey(engine), cadastradas);
  }
  const nome = nomeDaVozNoQwen3(referencia);
  const conhecida = cadastradas.get(nome);
  if (conhecida) return conhecida;
  try {
    const lista = await fetchFn(`${engine.url}/v1/voices`, { signal: AbortSignal.timeout(10_000) });
    if (lista.ok) {
      const corpo = (await lista.json()) as { data?: Array<{ id?: unknown; name?: unknown; kind?: unknown }> };
      const achada = corpo.data?.find((v) => v.kind === "custom" && v.name === nome && typeof v.id === "string");
      if (achada && typeof achada.id === "string") {
        cadastradas.set(nome, achada.id);
        return achada.id;
      }
    }
  } catch {
    // Register the reference if listing existing voices is unavailable.
  }
  const form = new FormData();
  form.set("name", nome);
  form.set("audio", new Blob([Buffer.from(referencia.audioBase64, "base64")], { type: "audio/wav" }), "referencia.wav");
  form.set("language", language);
  if (referencia.text) form.set("ref_text", referencia.text);
  const res = await fetchFn(`${engine.url}/v1/voices`, { method: "POST", body: form, signal: AbortSignal.timeout(timeoutMs) });
  if (!res.ok) {
    throw new Error(`qwen3: cadastro da voz HTTP ${res.status}`);
  }
  const corpo = (await res.json()) as { id?: unknown };
  if (typeof corpo.id !== "string" || !corpo.id) {
    throw new Error("qwen3: cadastro da voz sem id");
  }
  cadastradas.set(nome, corpo.id);
  return corpo.id;
}

/**
 * O que falta no pedido para este motor sintetizar — ou `null` quando está completo. O manager
 * pergunta ANTES de aquecer o motor (não vale gastar minuto de GPU num pedido que vai falhar), e
 * o dialeto pergunta de novo, por segurança.
 *
 * Qwen3: no backend rápido (faster-qwen3-tts) um clone SEM transcrição não sintetiza — o servidor
 * cadastra a voz, mas a fala devolve 500 ("ref_text is required"). O nó precisa de `ASR_URL`
 * para transcrever a referência, ou a aplicação manda `reference.text`.
 */
export function oQueFaltaNoPedido(kind: TtsEngineConfig["kind"], pedido: TtsSpeakRequest): string | null {
  if (kind !== "qwen3") {
    return null;
  }
  if (!pedido.reference) {
    return "qwen3: este dialeto clona a voz e exige referência no pedido";
  }
  if (!pedido.reference.text) {
    return "qwen3: referência sem transcrição — este motor clona por in-context learning e o nó precisa de ASR_URL para transcrevê-la";
  }
  return null;
}

async function sintetizarQwen3(engine: TtsEngineConfig, pedido: TtsSpeakRequest, timeoutMs: number, fetchFn: FetchFn, cache: VoiceCache): Promise<RespostaDoMotor> {
  const falta = oQueFaltaNoPedido("qwen3", pedido);
  if (falta || !pedido.reference) {
    throw new Error(falta ?? "qwen3: este dialeto clona a voz e exige referência no pedido");
  }
  const language = idiomaPorNome(pedido.language);
  const voice = await garantirVozNoQwen3(engine, pedido.reference, language, timeoutMs, fetchFn, cache);
  const trechos = dividirEmTrechos(pedido.text, QWEN3_MAX_CHARS);
  const partes: Buffer[] = [];
  for (const trecho of trechos) {
    for (let tentativa = 1; ; tentativa++) {
      const res = await fetchFn(`${engine.url}/v1/audio/speech`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model: engine.model || "qwen3-tts", input: trecho, voice, language, response_format: "mp3" }),
        signal: AbortSignal.timeout(timeoutMs)
      });
      if (res.status === 503 && tentativa < TENTATIVAS_ENQUANTO_CARREGA) {
        await new Promise((r) => setTimeout(r, 3000));
        continue;
      }
      if (!res.ok) {
        throw new Error(`qwen3: síntese HTTP ${res.status}`);
      }
      partes.push(Buffer.from(await res.arrayBuffer()));
      break;
    }
  }
  const audio = partes.length === 1 ? (partes[0] ?? Buffer.alloc(0)) : await concatenarMp3(partes);
  return { audio, contentType: "audio/mpeg", model: engine.model || "qwen3-tts", voice };
}

/** Cache is private to this SDK instance and separated by endpoint as well as engine id. */
export function createTtsSynthesizer() {
  const cache: VoiceCache = { references: new Map(), voices: new Map() };
  return async (engine: TtsEngineConfig, pedido: TtsSpeakRequest, timeoutMs: number, fetchFn: FetchFn = fetch): Promise<RespostaDoMotor> => {
    switch (engine.kind) {
      case "openai":
        return sintetizarOpenAi(engine, pedido, timeoutMs, fetchFn);
      case "chatterbox":
        return sintetizarChatterbox(engine, pedido, timeoutMs, fetchFn, cache);
      case "qwen3":
        return sintetizarQwen3(engine, pedido, timeoutMs, fetchFn, cache);
    }
  };
}
