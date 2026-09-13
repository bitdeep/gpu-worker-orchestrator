import { execFile, spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

/** Normalize engine audio to MP3 at 96 kbps. The caller supplies FFmpeg in its worker image. */
const TIMEOUT_MS = 120_000;

export function precisaConverterParaMp3(contentType: string | null | undefined): boolean {
  const tipo = (contentType ?? "").toLowerCase();
  return !(tipo.includes("audio/mpeg") || tipo.includes("audio/mp3"));
}

export async function paraMp3(entrada: Buffer): Promise<Buffer> {
  return new Promise<Buffer>((resolve, reject) => {
    const ffmpeg = spawn(
      "ffmpeg",
      ["-hide_banner", "-loglevel", "error", "-nostdin", "-i", "pipe:0", "-vn", "-c:a", "libmp3lame", "-b:a", "96k", "-f", "mp3", "pipe:1"],
      { stdio: ["pipe", "pipe", "pipe"], timeout: TIMEOUT_MS, killSignal: "SIGKILL" }
    );
    const pedacos: Buffer[] = [];
    ffmpeg.stdout.on("data", (d: Buffer) => pedacos.push(d));
    // Decoder diagnostics may contain private metadata or paths from the input.
    ffmpeg.stderr.resume();
    ffmpeg.on("error", () => reject(new Error("Audio converter could not start")));
    ffmpeg.on("close", (codigo) => {
      const saida = Buffer.concat(pedacos);
      if (codigo !== 0 || saida.length === 0) {
        reject(new Error(`Audio conversion failed (exit ${String(codigo)})`));
        return;
      }
      resolve(saida);
    });
    ffmpeg.stdin.on("error", () => undefined);
    ffmpeg.stdin.end(entrada);
  });
}

const executar = promisify(execFile);

/**
 * Junta partes MP3 (trechos de um roteiro longo) num arquivo só, pelo demuxer `concat` do
 * ffmpeg, sem re-encodar. As partes são nossas (acabaram de sair do motor): nada de terceiro.
 */
export async function concatenarMp3(partes: Buffer[]): Promise<Buffer> {
  if (partes.length === 1 && partes[0]) return partes[0];
  const dir = await mkdtemp(path.join(os.tmpdir(), "tts-concat-"));
  try {
    const nomes: string[] = [];
    for (const [i, parte] of partes.entries()) {
      const nome = path.join(dir, `parte-${String(i).padStart(3, "0")}.mp3`);
      await writeFile(nome, parte);
      nomes.push(nome);
    }
    const lista = path.join(dir, "lista.txt");
    await writeFile(lista, nomes.map((n) => `file '${n}'`).join("\n") + "\n");
    const saida = path.join(dir, "saida.mp3");
    await executar("ffmpeg", ["-hide_banner", "-loglevel", "error", "-nostdin", "-f", "concat", "-safe", "0", "-i", lista, "-c", "copy", "-y", saida], {
      timeout: TIMEOUT_MS,
      killSignal: "SIGKILL",
      maxBuffer: 1024 * 1024
    });
    return await readFile(saida);
  } catch {
    throw new Error("Audio concatenation failed");
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => undefined);
  }
}
