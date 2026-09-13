import { describe, expect, it } from "vitest";
import { shouldIdleUnload } from "./idle-unload.js";

const NOW = 1_800_000_000_000;
const IDLE = 300_000; // 5 min

describe("shouldIdleUnload", () => {
  it("não descarrega sem container gerido (vLLM sempre-ligado)", () => {
    expect(shouldIdleUnload("", NOW - IDLE - 1, IDLE, NOW)).toBe(false);
  });

  it("não descarrega antes do idleMs", () => {
    expect(shouldIdleUnload("vllm", NOW - IDLE + 1, IDLE, NOW)).toBe(false);
  });

  it("descarrega passado o idleMs", () => {
    expect(shouldIdleUnload("vllm", NOW - IDLE - 1, IDLE, NOW)).toBe(true);
  });
  it("lastUse=0 (nunca usado) NÃO é motivo para reter: trata como elegível", () => {
    expect(shouldIdleUnload("vllm", 0, IDLE, NOW)).toBe(true);
  });

  it("lastUse negativo/absurdo também é elegível", () => {
    expect(shouldIdleUnload("vllm", -1, IDLE, NOW)).toBe(true);
  });
  it("NÃO descarrega enquanto há start em voo (corrida warmup × idle)", () => {
    expect(shouldIdleUnload("vllm", 0, IDLE, NOW, true)).toBe(false);
    expect(shouldIdleUnload("vllm", NOW - IDLE - 1, IDLE, NOW, true)).toBe(false);
  });

  it("volta a descarregar quando o start termina", () => {
    expect(shouldIdleUnload("vllm", 0, IDLE, NOW, false)).toBe(true);
  });
  it("idleMs <= 0 (keep-warm) NUNCA descarrega por tempo, mesmo vencido/sem uso", () => {
    expect(shouldIdleUnload("vllm", NOW - 999_999_999, 0, NOW)).toBe(false);
    expect(shouldIdleUnload("vllm", 0, 0, NOW)).toBe(false);
    expect(shouldIdleUnload("vllm", NOW - 999_999_999, -1, NOW)).toBe(false);
  });
});
