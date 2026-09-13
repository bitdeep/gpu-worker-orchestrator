import { describe, expect, it, vi } from "vitest";
import { criarTextoDaReferencia } from "./referencia.js";

const ref = { audioBase64: Buffer.from("wav").toString("base64"), mime: "audio/wav", id: "a".repeat(64) };

describe("textoDaReferencia", () => {
  it("sem ASR no nó, sem texto — e sem erro", async () => {
    const texto = criarTextoDaReferencia(null);
    expect(await texto(ref)).toBeUndefined();
  });

  it("texto que já veio do hub tem prioridade sobre o ASR", async () => {
    const transcrever = vi.fn(() => Promise.resolve("outro"));
    const texto = criarTextoDaReferencia(transcrever);
    expect(await texto({ ...ref, text: "Bom dia." })).toBe("Bom dia.");
    expect(transcrever).not.toHaveBeenCalled();
  });

  it("transcreve UMA vez por referência (sha) e reaproveita; ASR quebrado vira 'sem texto'", async () => {
    const transcrever = vi.fn(() => Promise.resolve("  Respire fundo.  "));
    const texto = criarTextoDaReferencia(transcrever, "pt");
    expect(await texto(ref)).toBe("Respire fundo.");
    expect(await texto(ref)).toBe("Respire fundo.");
    expect(transcrever).toHaveBeenCalledTimes(1);
    expect(transcrever).toHaveBeenCalledWith(Buffer.from("wav"), "audio/wav", "pt");
    const quebrado = criarTextoDaReferencia(vi.fn(() => Promise.reject(new Error("asr HTTP 503"))));
    expect(await quebrado({ ...ref, id: "b".repeat(64) })).toBeUndefined();
  });
});
