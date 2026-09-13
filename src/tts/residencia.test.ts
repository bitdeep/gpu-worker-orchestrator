import { describe, expect, it } from "vitest";

import type { TtsEngineConfig } from "./engines.js";
import { motoresADescarregarAntesDe, motoresPesadosADescarregar, motorPesado } from "./residencia.js";

const motor = (id: string, kind: TtsEngineConfig["kind"], container: string | undefined = `c-${id}`): TtsEngineConfig => ({
  id,
  kind,
  url: `http://${id}:1`,
  container,
  model: "m",
  voice: "v",
  idleMs: 1000
});

describe("residência na GPU: um motor pesado por vez", () => {
  const kokoro = motor("kokoro", "openai");
  const chatterbox = motor("chatterbox", "chatterbox");
  const qwen3 = motor("qwen3", "qwen3");

  it("quem clona é pesado; vozes prontas não", () => {
    expect(motorPesado(kokoro)).toBe(false);
    expect(motorPesado(chatterbox)).toBe(true);
    expect(motorPesado(qwen3)).toBe(true);
  });

  it("subir o Qwen3 derruba o Chatterbox, e só ele — o Kokoro fica", () => {
    expect(motoresADescarregarAntesDe(qwen3, [kokoro, chatterbox, qwen3]).map((m) => m.id)).toEqual(["chatterbox"]);
    expect(motoresADescarregarAntesDe(chatterbox, [kokoro, chatterbox, qwen3]).map((m) => m.id)).toEqual(["qwen3"]);
  });

  it("subir o Kokoro derruba os pesados ociosos (medido: com o Qwen3 residente o gpu-node fica a 24,0 de 24,5 GB)", () => {
    expect(motoresADescarregarAntesDe(kokoro, [kokoro, chatterbox, qwen3]).map((m) => m.id)).toEqual(["chatterbox", "qwen3"]);
  });

  it("uma transcrição (ASR) derruba todos os pesados e nunca o Kokoro", () => {
    expect(motoresPesadosADescarregar([kokoro, chatterbox, qwen3]).map((m) => m.id)).toEqual(["chatterbox", "qwen3"]);
    expect(motoresPesadosADescarregar([kokoro])).toEqual([]);
  });

  it("motor sem container (não gerido por este manager) não entra na lista", () => {
    const externo: TtsEngineConfig = { ...motor("qwen3", "qwen3"), container: "" };
    expect(motoresADescarregarAntesDe(chatterbox, [kokoro, externo])).toEqual([]);
  });
});
