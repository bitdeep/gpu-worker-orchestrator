import type { TtsReference } from "../contracts.js";

/**
 * A transcrição da referência de voz, para os motores que clonam por "in-context learning".
 *
 * O Qwen3-TTS aceita a referência sem texto, mas aí cai em modo x-vector (só o embedding do
 * locutor) e a clonagem perde prosódia — a documentação da Alibaba diz que "ref_text" é o que
 * faz a diferença. Quem tem o ASR é o nó, então é o nó que transcreve: uma vez por referência
 * (o id é o sha256 do WAV) e antes de entrar no lock da GPU, porque o ASR pega o mesmo lock.
 * Sem ASR configurado, retorna undefined. O caller decide se seu motor exige a transcrição;
 * o dialeto rápido de Qwen3 recusa a síntese sem esse texto antes de aquecer a GPU.
 */
export type Transcritor = (audio: Buffer, mime: string, language: string) => Promise<string>;

const MAXIMO_EM_CACHE = 64;

export function criarTextoDaReferencia(transcrever: Transcritor | null, language = "pt") {
  const cache = new Map<string, string>();
  return async function textoDaReferencia(referencia: TtsReference): Promise<string | undefined> {
    if (referencia.text) return referencia.text;
    if (!transcrever) return undefined;
    const emCache = cache.get(referencia.id);
    if (emCache !== undefined) return emCache || undefined;
    let texto = "";
    try {
      texto = (await transcrever(Buffer.from(referencia.audioBase64, "base64"), referencia.mime, language)).trim();
    } catch {
      return undefined;
    }
    if (cache.size >= MAXIMO_EM_CACHE) {
      const primeira = cache.keys().next().value;
      if (primeira !== undefined) cache.delete(primeira);
    }
    cache.set(referencia.id, texto);
    return texto || undefined;
  };
}
