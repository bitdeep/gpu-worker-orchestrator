import type { TtsEngineConfig } from "./engines.js";

const KINDS_PESADOS: ReadonlySet<TtsEngineConfig["kind"]> = new Set(["chatterbox", "qwen3"]);

export function motorPesado(motor: TtsEngineConfig): boolean {
  return KINDS_PESADOS.has(motor.kind);
}

/** Os motores pesados GERIDOS (com container) que têm de sair da GPU antes de outro trabalho — `exceto` é quem vai usar a placa. */
export function motoresPesadosADescarregar(motores: readonly TtsEngineConfig[], exceto?: TtsEngineConfig): TtsEngineConfig[] {
  return motores.filter((m) => m.id !== exceto?.id && m.container && motorPesado(m));
}

/** Antes de `alvo` subir: todo pesado que não seja ele. (Kokoro subindo também derruba o pesado ocioso.) */
export function motoresADescarregarAntesDe(alvo: TtsEngineConfig, motores: readonly TtsEngineConfig[]): TtsEngineConfig[] {
  return motoresPesadosADescarregar(motores, alvo);
}
