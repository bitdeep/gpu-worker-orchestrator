
export interface VerboseSegment {
  text?: string | null;
  avg_logprob?: number | null;
  no_speech_prob?: number | null;
  compression_ratio?: number | null;
}

export interface VerboseTranscription {
  text?: string | null;
  segments?: VerboseSegment[] | null;
}

export interface AsrGateThresholds {
  noSpeechMax: number;
  logprobMin: number;
  compressionMax: number;
}
export const DEFAULT_ASR_GATE: AsrGateThresholds = {
  noSpeechMax: 0.6,
  logprobMin: -1.0,
  compressionMax: 2.4
};
export function gateTranscript(
  data: VerboseTranscription,
  thresholds: AsrGateThresholds = DEFAULT_ASR_GATE
): string {
  const segments = data.segments;
  if (!Array.isArray(segments)) {
    return (data.text ?? "").trim();
  }
  const kept: string[] = [];
  for (const seg of segments) {
    if ((seg.no_speech_prob ?? 0) > thresholds.noSpeechMax) continue;
    if ((seg.avg_logprob ?? 0) < thresholds.logprobMin) continue;
    if ((seg.compression_ratio ?? 0) > thresholds.compressionMax) continue;
    const text = (seg.text ?? "").trim();
    if (text) kept.push(text);
  }
  return kept.join(" ").replace(/\s+/g, " ").trim();
}
