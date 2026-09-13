import { describe, it, expect } from "vitest";
import { gateTranscript, DEFAULT_ASR_GATE } from "./asr-gate.js";
const good = { text: "Essa semana foi difícil.", no_speech_prob: 0.02, avg_logprob: -0.25, compression_ratio: 1.3 };

describe("gateTranscript", () => {
  it("silêncio com VAD (segments vazio) → string vazia", () => {
    expect(gateTranscript({ text: "", segments: [] })).toBe("");
  });

  it("NÃO devolve o texto de topo quando há array de segmentos (evita alucinação vazar)", () => {
    expect(gateTranscript({ text: "Acesse o site example.com", segments: [] })).toBe("");
  });

  it("mantém segmento confiável", () => {
    expect(gateTranscript({ segments: [good] })).toBe("Essa semana foi difícil.");
  });

  it("descarta segmento com no_speech_prob alto", () => {
    expect(gateTranscript({ segments: [{ ...good, text: "example.com", no_speech_prob: 0.92 }] })).toBe("");
  });

  it("descarta segmento com avg_logprob baixo (decoder inseguro)", () => {
    expect(gateTranscript({ segments: [{ ...good, text: "Use acentuação correta.", avg_logprob: -1.8 }] })).toBe("");
  });

  it("descarta segmento com compression_ratio alto (repetição/loop)", () => {
    expect(gateTranscript({ segments: [{ ...good, text: "sim sim sim sim sim", compression_ratio: 3.5 }] })).toBe("");
  });

  it("em mistura, mantém só os confiáveis e junta com espaço", () => {
    const out = gateTranscript({
      segments: [
        good,
        { ...good, text: "example.com", no_speech_prob: 0.95 },
        { ...good, text: "E o trabalho apertou." }
      ]
    });
    expect(out).toBe("Essa semana foi difícil. E o trabalho apertou.");
  });

  it("segmento sem métricas é mantido (benefício da dúvida — não derruba fala real)", () => {
    expect(gateTranscript({ segments: [{ text: "Oi, tudo bem?" }] })).toBe("Oi, tudo bem?");
  });

  it("fallback: resposta não-verbose (sem segments) usa o texto de topo", () => {
    expect(gateTranscript({ text: "  texto simples  " })).toBe("texto simples");
  });

  it("thresholds customizados afrouxam/apertam o corte", () => {
    const seg = { ...good, avg_logprob: -1.5 };
    expect(gateTranscript({ segments: [seg] })).toBe(""); // default -1.0 corta
    expect(gateTranscript({ segments: [seg] }, { ...DEFAULT_ASR_GATE, logprobMin: -2.0 })).toBe("Essa semana foi difícil.");
  });
});
