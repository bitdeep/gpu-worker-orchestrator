import { describe, expect, it } from "vitest";
import { precisaConverterParaMp3 } from "./mp3.js";

describe("precisaConverterParaMp3", () => {
  it("MP3 passa direto; WAV, OGG e desconhecido convertem", () => {
    expect(precisaConverterParaMp3("audio/mpeg")).toBe(false);
    expect(precisaConverterParaMp3("audio/mp3; charset=binary")).toBe(false);
    expect(precisaConverterParaMp3("audio/wav")).toBe(true);
    expect(precisaConverterParaMp3("application/octet-stream")).toBe(true);
    expect(precisaConverterParaMp3(null)).toBe(true);
  });
});
