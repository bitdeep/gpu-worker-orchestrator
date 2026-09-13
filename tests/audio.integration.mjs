import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { paraMp3, concatenarMp3 } from "../dist/tts/mp3.js";

// Generated tone, no personal voice or external fixture.
const wav = spawnSync("ffmpeg", [
  "-hide_banner", "-loglevel", "error", "-f", "lavfi",
  "-i", "sine=frequency=440:duration=0.5", "-ar", "24000", "-ac", "1", "-f", "wav", "pipe:1"
], { timeout: 10_000 });
assert.equal(wav.status, 0, "FFmpeg is required for this integration check");
const mp3 = await paraMp3(wav.stdout);
const joined = await concatenarMp3([mp3, mp3]);
const decoded = spawnSync("ffmpeg", [
  "-hide_banner", "-loglevel", "error", "-i", "pipe:0", "-ar", "24000", "-ac", "1", "-f", "s16le", "pipe:1"
], { input: joined, timeout: 10_000 });
assert.equal(decoded.status, 0);
assert.ok(decoded.stdout.length >= 24000 * 2, "Concatenation must preserve both audio parts");
await assert.rejects(paraMp3(Buffer.from("private-metadata-sentinel")), (error) => {
  assert.match(error.message, /^Audio conversion failed/);
  assert.ok(!error.message.includes("private-metadata-sentinel"));
  return true;
});
console.log(JSON.stringify({ conversion: true, concatenation: true, privateDiagnosticsOmitted: true }));
