import { describe, expect, it } from "vitest";
import { dividirEmTrechos } from "./trechos.js";

describe("dividirEmTrechos", () => {
  it("texto curto é um trecho só; vazio é nenhum", () => {
    expect(dividirEmTrechos("Respire fundo.", 100)).toEqual(["Respire fundo."]);
    expect(dividirEmTrechos("   ", 100)).toEqual([]);
  });

  it("corta em fim de frase, nunca no meio da palavra, e cada trecho cabe no limite", () => {
    const texto = "Respire fundo, devagar. Sinta o ar entrar e sair. A cada expiração, os ombros descem. O corpo encontra o próprio ritmo. Este é um momento só seu.";
    const trechos = dividirEmTrechos(texto, 60);
    expect(trechos.length).toBeGreaterThan(1);
    for (const t of trechos) {
      expect(t.length).toBeLessThanOrEqual(60);
      expect(/[.!?…]$/.test(t)).toBe(true);
    }
    expect(trechos.join(" ")).toBe(texto);
  });

  it("frase maior que o limite é cortada por palavras", () => {
    const longa = Array.from({ length: 40 }, (_, i) => `palavra${i}`).join(" ") + ".";
    const trechos = dividirEmTrechos(longa, 50);
    expect(trechos.every((t) => t.length <= 50)).toBe(true);
    expect(trechos.join(" ").replace(/\s+/g, " ")).toBe(longa);
  });
});
