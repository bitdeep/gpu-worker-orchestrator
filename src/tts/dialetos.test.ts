import { describe, expect, it, vi } from "vitest";
import { caminhoDeSaude, motorPronto, nomeDaVozNoQwen3, createTtsSynthesizer, type FetchFn } from "./dialetos.js";
import type { TtsEngineConfig } from "./engines.js";

const referencia = { audioBase64: Buffer.from("RIFFwav").toString("base64"), mime: "audio/wav", id: "a".repeat(64) };
const mp3 = new Uint8Array([0x49, 0x44, 0x33, 1, 2, 3]);
const sintetizarNoMotor = createTtsSynthesizer();

function resposta(body: BodyInit | null, init: ResponseInit & { headers?: Record<string, string> } = {}): Response {
  return new Response(body, { status: 200, ...init });
}

describe("caminhoDeSaude", () => {
  it("cada dialeto tem o seu — o chatterbox não tem /health", () => {
    expect(caminhoDeSaude("openai")).toBe("/health");
    expect(caminhoDeSaude("chatterbox")).toBe("/api/model-info");
    expect(caminhoDeSaude("qwen3")).toBe("/health");
  });
});

describe("dialeto openai (kokoro)", () => {
  const engine: TtsEngineConfig = { id: "kokoro", kind: "openai", url: "http://tts:8880", container: "", model: "kokoro", voice: "pf_dora", idleMs: 0 };
  it("manda o /v1/audio/speech de sempre com a voz do engine e ignora a referência", async () => {
    const fetchMock = vi.fn<FetchFn>(() => Promise.resolve(resposta(mp3, { headers: { "content-type": "audio/mpeg" } })));
    const out = await sintetizarNoMotor(engine, { text: "Respire.", voice: "pm_alex", reference: referencia }, 1000, fetchMock);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("http://tts:8880/v1/audio/speech");
    expect(JSON.parse(String(init.body))).toEqual({ model: "kokoro", voice: "pf_dora", input: "Respire.", response_format: "mp3" });
    expect(out.contentType).toBe("audio/mpeg");
    expect(out.voice).toBe("pf_dora");
  });
});

describe("dialeto chatterbox (devnen/Chatterbox-TTS-Server)", () => {
  const engine: TtsEngineConfig = { id: "chatterbox", kind: "chatterbox", url: "http://tts-chatterbox:8004", container: "c", model: "multilingual", voice: "", idleMs: 0 };

  it("cadastra a referência pelo sha (uma vez) e pede clone em português com output mp3", async () => {
    const chamadas: string[] = [];
    const fetchMock = vi.fn<FetchFn>((url, init) => {
      const u = String(url);
      chamadas.push(`${init?.method ?? "GET"} ${u}`);
      if (u.endsWith("/get_reference_files")) return Promise.resolve(resposta(JSON.stringify([])));
      if (u.endsWith("/upload_reference")) return Promise.resolve(resposta(JSON.stringify({ uploaded_files: [`${"a".repeat(64)}.wav`], errors: [] })));
      if (u.endsWith("/tts")) return Promise.resolve(resposta(mp3, { headers: { "content-type": "audio/mp3" } }));
      return Promise.resolve(resposta("nope", { status: 404 }));
    });
    const out = await sintetizarNoMotor(engine, { text: "Respire fundo.", language: "pt", reference: referencia }, 1000, fetchMock);
    expect(chamadas).toEqual([
      "GET http://tts-chatterbox:8004/get_reference_files",
      "POST http://tts-chatterbox:8004/upload_reference",
      "POST http://tts-chatterbox:8004/tts"
    ]);
    const tts = fetchMock.mock.calls[2] as [string, RequestInit];
    const corpo = JSON.parse(String(tts[1].body)) as Record<string, unknown>;
    expect(corpo).toMatchObject({ text: "Respire fundo.", voice_mode: "clone", reference_audio_filename: `${"a".repeat(64)}.wav`, output_format: "mp3", language: "pt", split_text: true });
    expect(out.voice).toBe(`${"a".repeat(64)}.wav`);
    chamadas.length = 0;
    await sintetizarNoMotor(engine, { text: "De novo.", language: "pt-BR", reference: referencia }, 1000, fetchMock);
    expect(chamadas).toEqual(["POST http://tts-chatterbox:8004/tts"]);
  });

  it("sem referência e sem voz pré-definida, recusa em vez de falar com a voz errada", async () => {
    const fetchMock = vi.fn<FetchFn>();
    await expect(sintetizarNoMotor(engine, { text: "Respire." }, 1000, fetchMock)).rejects.toThrow(/sem referência/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("503 enquanto o modelo carrega é espera, não falha", async () => {
    vi.useFakeTimers();
    try {
      let vez = 0;
      const fetchMock = vi.fn<FetchFn>((url) => {
        const u = String(url);
        if (u.endsWith("/get_reference_files")) return Promise.resolve(resposta(JSON.stringify([`${"b".repeat(64)}.wav`])));
        vez += 1;
        return Promise.resolve(vez === 1 ? resposta("loading", { status: 503 }) : resposta(mp3, { headers: { "content-type": "audio/mp3" } }));
      });
      const p = sintetizarNoMotor(engine, { text: "Respire.", reference: { ...referencia, id: "b".repeat(64) } }, 1000, fetchMock);
      await vi.advanceTimersByTimeAsync(3500);
      const out = await p;
      expect(out.audio.length).toBe(mp3.length);
      expect(vez).toBe(2);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("dialeto qwen3 (malaiwah/qwen3-tts-server)", () => {
  const engine: TtsEngineConfig = { id: "qwen3", kind: "qwen3", url: "http://tts-qwen3:8001", container: "q", model: "qwen3-tts", voice: "", idleMs: 0 };

  it("cadastra a voz pelo sha (uma vez, com ref_text e idioma por nome) e pede a fala pelo id vc_", async () => {
    const chamadas: string[] = [];
    const fetchMock = vi.fn<FetchFn>((url, init) => {
      const u = String(url);
      chamadas.push(`${init?.method ?? "GET"} ${u}`);
      if (u.endsWith("/v1/voices") && (init?.method ?? "GET") === "GET") return Promise.resolve(resposta(JSON.stringify({ data: [{ id: "ryan", kind: "preset", name: "ryan" }] })));
      if (u.endsWith("/v1/voices")) return Promise.resolve(resposta(JSON.stringify({ id: "vc_ab12cd34", kind: "custom", name: "a".repeat(64) }), { status: 201 }));
      if (u.endsWith("/v1/audio/speech")) return Promise.resolve(resposta(mp3, { headers: { "content-type": "audio/mpeg" } }));
      return Promise.resolve(resposta("nope", { status: 404 }));
    });
    const out = await sintetizarNoMotor(engine, { text: "Respire fundo.", language: "pt", reference: { ...referencia, text: "Bom dia, tudo bem?" } }, 1000, fetchMock);
    expect(chamadas).toEqual(["GET http://tts-qwen3:8001/v1/voices", "POST http://tts-qwen3:8001/v1/voices", "POST http://tts-qwen3:8001/v1/audio/speech"]);
    const cadastro = (fetchMock.mock.calls[1] as [string, RequestInit])[1].body as FormData;
    expect(cadastro.get("name")).toBe(nomeDaVozNoQwen3({ ...referencia, text: "Bom dia, tudo bem?" }));
    expect(String(cadastro.get("name"))).toMatch(new RegExp(`^${"a".repeat(64)}-[0-9a-f]{12}$`));
    expect(cadastro.get("language")).toBe("Portuguese");
    expect(cadastro.get("ref_text")).toBe("Bom dia, tudo bem?");
    expect(cadastro.get("audio")).toBeInstanceOf(Blob);
    const fala = JSON.parse(String((fetchMock.mock.calls[2] as [string, RequestInit])[1].body)) as Record<string, unknown>;
    expect(fala).toEqual({ model: "qwen3-tts", input: "Respire fundo.", voice: "vc_ab12cd34", language: "Portuguese", response_format: "mp3" });
    expect(out.voice).toBe("vc_ab12cd34");
    expect(out.contentType).toBe("audio/mpeg");
    chamadas.length = 0;
    await sintetizarNoMotor(engine, { text: "De novo.", language: "pt-BR", reference: { ...referencia, text: "Bom dia, tudo bem?" } }, 1000, fetchMock);
    expect(chamadas).toEqual(["POST http://tts-qwen3:8001/v1/audio/speech"]);
  });

  it("referência SEM transcrição é recusada antes de tocar a GPU (o backend rápido não clona sem ref_text)", async () => {
    const fetchMock = vi.fn<FetchFn>();
    await expect(sintetizarNoMotor(engine, { text: "Respire.", reference: referencia }, 1000, fetchMock)).rejects.toThrow(/sem transcrição/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("voz já cadastrada num processo anterior é achada pela lista (nome = sha + resumo da transcrição), sem recadastrar", async () => {
    const outra = { ...referencia, id: "c".repeat(64), text: "Referência transcrita." };
    const fetchMock = vi.fn<FetchFn>((url, init) => {
      const u = String(url);
      if (u.endsWith("/v1/voices") && (init?.method ?? "GET") === "GET") return Promise.resolve(resposta(JSON.stringify({ data: [{ id: "vc_ffff0000", kind: "custom", name: nomeDaVozNoQwen3(outra) }] })));
      if (u.endsWith("/v1/audio/speech")) return Promise.resolve(resposta(mp3, { headers: { "content-type": "audio/mpeg" } }));
      return Promise.resolve(resposta("nope", { status: 404 }));
    });
    const out = await sintetizarNoMotor(engine, { text: "Respire.", reference: outra }, 1000, fetchMock);
    expect(out.voice).toBe("vc_ffff0000");
    const cadastros = fetchMock.mock.calls.filter(([u, init]) => String(u).endsWith("/v1/voices") && init?.method === "POST");
    expect(cadastros).toHaveLength(0);
  });

  it("voz cadastrada SEM transcrição (nome = sha puro) não é reaproveitada: cadastra de novo, com ref_text", async () => {
    const outra = { ...referencia, id: "d".repeat(64), text: "Agora com transcrição." };
    const fetchMock = vi.fn<FetchFn>((url, init) => {
      const u = String(url);
      if (u.endsWith("/v1/voices") && (init?.method ?? "GET") === "GET") return Promise.resolve(resposta(JSON.stringify({ data: [{ id: "vc_velha000", kind: "custom", name: "d".repeat(64) }] })));
      if (u.endsWith("/v1/voices")) return Promise.resolve(resposta(JSON.stringify({ id: "vc_nova0000", kind: "custom", name: nomeDaVozNoQwen3(outra) }), { status: 201 }));
      if (u.endsWith("/v1/audio/speech")) return Promise.resolve(resposta(mp3, { headers: { "content-type": "audio/mpeg" } }));
      return Promise.resolve(resposta("nope", { status: 404 }));
    });
    const out = await sintetizarNoMotor(engine, { text: "Respire.", reference: outra }, 1000, fetchMock);
    expect(out.voice).toBe("vc_nova0000");
    const cadastros = fetchMock.mock.calls.filter(([u, init]) => String(u).endsWith("/v1/voices") && init?.method === "POST");
    expect(cadastros).toHaveLength(1);
    expect((cadastros[0]?.[1]?.body as FormData).get("ref_text")).toBe("Agora com transcrição.");
  });

  it("exige referência: este dialeto existe para clonar", async () => {
    await expect(sintetizarNoMotor(engine, { text: "Respire." }, 1000, vi.fn<FetchFn>())).rejects.toThrow(/referência/);
  });
});

describe("motorPronto — a resposta de saúde diz pronto?", () => {
  it("openai/chatterbox: 200 basta; qwen3: 200 só com model_ready true", async () => {
    expect(await motorPronto("openai", resposta("ok"))).toBe(true);
    expect(await motorPronto("chatterbox", resposta("loading", { status: 503 }))).toBe(false);
    expect(await motorPronto("qwen3", resposta(JSON.stringify({ status: "loading", model_ready: false })))).toBe(false);
    expect(await motorPronto("qwen3", resposta(JSON.stringify({ status: "healthy", model_ready: true })))).toBe(true);
  });
});

it("separates reference caches across endpoints and SDK instances", async () => {
  const first = createTtsSynthesizer();
  const second = createTtsSynthesizer();
  const engine: TtsEngineConfig = { id: "shared-id", kind: "chatterbox", url: "http://customer-a", container: "", model: "demo", voice: "", idleMs: 0 };
  const uploads: string[] = [];
  const request = vi.fn<FetchFn>(async (url, init) => {
    if (String(url).endsWith("/get_reference_files")) return Response.json([]);
    if (String(url).endsWith("/upload_reference")) {
      uploads.push(String(url));
      const file = (init?.body as FormData).get("files") as File;
      return Response.json({ uploaded_files: [file.name] });
    }
    return resposta(mp3, { headers: { "content-type": "audio/mpeg" } });
  });
  const input = { text: "Example", reference: referencia };
  await first(engine, input, 1000, request);
  await first(engine, input, 1000, request);
  await first({ ...engine, url: "http://customer-b" }, input, 1000, request);
  await second(engine, input, 1000, request);
  expect(uploads).toEqual([
    "http://customer-a/upload_reference", "http://customer-b/upload_reference", "http://customer-a/upload_reference"
  ]);
});
