import { describe, expect, it } from "vitest";
import { resolveTtsEngines } from "./engines.js";
describe("resolveTtsEngines", () => {
  it("sem TTS_URL e sem TTS_ENGINES: nenhum motor (capability tts nasce desligada)", () => {
    expect(resolveTtsEngines({})).toEqual([]);
  });

  it("config legada vira o motor 'kokoro' com dialeto openai e os defaults de sempre", () => {
    const [motor] = resolveTtsEngines({ TTS_URL: "http://tts:8880/", TTS_CONTAINER: "gpu-node-tts-1", TTS_MODEL: "kokoro", TTS_VOICE: "pf_dora", TTS_IDLE_MS: "600000" });
    expect(motor).toEqual({ id: "kokoro", kind: "openai", url: "http://tts:8880", container: "gpu-node-tts-1", model: "kokoro", voice: "pf_dora", idleMs: 600000 });
  });

  it("TTS_ENGINES acrescenta motores por prefixo; o dialeto vem do id quando é um conhecido", () => {
    const motores = resolveTtsEngines({
      TTS_URL: "http://tts:8880",
      TTS_ENGINES: "chatterbox, qwen3",
      TTS_CHATTERBOX_URL: "http://tts-chatterbox:8004",
      TTS_CHATTERBOX_CONTAINER: "example-node-tts-chatterbox-1",
      TTS_CHATTERBOX_MODEL: "multilingual",
      TTS_QWEN3_URL: "http://tts-qwen3:8000",
      TTS_QWEN3_CONTAINER: "example-node-tts-qwen3-1",
      TTS_QWEN3_IDLE_MS: "300000"
    });
    expect(motores.map((m) => m.id)).toEqual(["kokoro", "chatterbox", "qwen3"]);
    expect(motores[1]).toMatchObject({ kind: "chatterbox", url: "http://tts-chatterbox:8004", container: "example-node-tts-chatterbox-1", model: "multilingual", idleMs: 600000 });
    expect(motores[2]).toMatchObject({ kind: "qwen3", idleMs: 300000, container: "example-node-tts-qwen3-1" });
  });

  it("motor listado sem URL é erro de boot, não motor mudo", () => {
    expect(() => resolveTtsEngines({ TTS_ENGINES: "chatterbox" })).toThrow(/TTS_CHATTERBOX_URL/);
  });

  it("id desconhecido exige TTS_<ID>_KIND explícito e aceita só dialetos conhecidos", () => {
    expect(() => resolveTtsEngines({ TTS_ENGINES: "minha-voz", TTS_MINHA_VOZ_URL: "http://x" })).toThrow(/TTS_MINHA_VOZ_KIND/);
    expect(resolveTtsEngines({ TTS_ENGINES: "minha-voz", TTS_MINHA_VOZ_URL: "http://x", TTS_MINHA_VOZ_KIND: "openai" })[0]).toMatchObject({ id: "minha-voz", kind: "openai" });
    expect(() => resolveTtsEngines({ TTS_ENGINES: "outra", TTS_OUTRA_URL: "http://x", TTS_OUTRA_KIND: "eleven" })).toThrow(/dialeto/);
  });

  it("o mesmo id duas vezes (legado + lista) não duplica", () => {
    const motores = resolveTtsEngines({ TTS_URL: "http://tts:8880", TTS_ENGINES: "kokoro" });
    expect(motores).toHaveLength(1);
  });
});
