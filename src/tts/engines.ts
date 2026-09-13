/**
 * Motores de voz deste nó — cada um num container próprio, com lazy-load independente.
 *
 * Só configuração (nenhum produto no código):
 *   - legado: TTS_URL / TTS_MODEL / TTS_VOICE / TTS_CONTAINER / TTS_IDLE_MS → motor `TTS_ENGINE_ID`
 *     (padrão "kokoro"), dialeto `TTS_KIND` (padrão "openai", o /v1/audio/speech de sempre);
 *   - extras: TTS_ENGINES="chatterbox,qwen3" e, por id (maiúsculo, `-`→`_`), TTS_<ID>_URL
 *     (obrigatório), TTS_<ID>_KIND (o próprio id quando é um dialeto conhecido), TTS_<ID>_CONTAINER,
 *     TTS_<ID>_MODEL, TTS_<ID>_VOICE, TTS_<ID>_IDLE_MS.
 *
 * O dialeto diz COMO falar com o servidor do motor (e como mandar a referência de voz para os que
 * clonam); o id é o que a aplicação usa para escolher um motor.
 */
export const TTS_KINDS = ["openai", "chatterbox", "qwen3"] as const;
export type TtsKind = (typeof TTS_KINDS)[number];

export interface TtsEngineConfig {
  id: string;
  kind: TtsKind;
  url: string;
  container: string;
  model: string;
  voice: string;
  idleMs: number;
}

const DEFAULT_IDLE_MS = 10 * 60 * 1000;

function isKind(value: string): value is TtsKind {
  return (TTS_KINDS as readonly string[]).includes(value);
}

function chave(id: string): string {
  return id.toUpperCase().replace(/-/g, "_");
}

function trimUrl(url: string | undefined): string {
  return (url ?? "").trim().replace(/\/+$/, "");
}

function idleMs(raw: string | undefined, fallback: number): number {
  const n = Number(raw);
  return raw !== undefined && raw !== "" && Number.isFinite(n) && n >= 0 ? n : fallback;
}

export function resolveTtsEngines(env: NodeJS.ProcessEnv): TtsEngineConfig[] {
  const motores: TtsEngineConfig[] = [];
  const idleLegado = idleMs(env.TTS_IDLE_MS, DEFAULT_IDLE_MS);
  const urlLegada = trimUrl(env.TTS_URL);
  if (urlLegada) {
    const kindLegado = (env.TTS_KIND ?? "openai").trim();
    if (!isKind(kindLegado)) {
      throw new Error(`TTS_KIND="${kindLegado}" não é um dialeto conhecido (${TTS_KINDS.join(", ")}).`);
    }
    motores.push({
      id: (env.TTS_ENGINE_ID ?? "kokoro").trim() || "kokoro",
      kind: kindLegado,
      url: urlLegada,
      container: (env.TTS_CONTAINER ?? "").trim(),
      model: (env.TTS_MODEL ?? "tts-1").trim() || "tts-1",
      voice: (env.TTS_VOICE ?? "").trim(),
      idleMs: idleLegado
    });
  }
  const ids = (env.TTS_ENGINES ?? "")
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
  for (const id of ids) {
    if (motores.some((m) => m.id === id)) continue;
    const k = chave(id);
    const url = trimUrl(env[`TTS_${k}_URL`]);
    if (!url) {
      throw new Error(`Motor de voz "${id}" listado em TTS_ENGINES sem TTS_${k}_URL.`);
    }
    const kindRaw = (env[`TTS_${k}_KIND`] ?? (isKind(id) ? id : "")).trim();
    if (!kindRaw) {
      throw new Error(`Motor de voz "${id}" precisa de TTS_${k}_KIND (${TTS_KINDS.join(", ")}).`);
    }
    if (!isKind(kindRaw)) {
      throw new Error(`TTS_${k}_KIND="${kindRaw}" não é um dialeto conhecido (${TTS_KINDS.join(", ")}).`);
    }
    motores.push({
      id,
      kind: kindRaw,
      url,
      container: (env[`TTS_${k}_CONTAINER`] ?? "").trim(),
      model: (env[`TTS_${k}_MODEL`] ?? "").trim() || id,
      voice: (env[`TTS_${k}_VOICE`] ?? "").trim(),
      idleMs: idleMs(env[`TTS_${k}_IDLE_MS`], idleLegado)
    });
  }
  return motores;
}
