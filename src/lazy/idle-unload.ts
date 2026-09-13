/**
 * Decisão pura do idle-unload (libera VRAM de um serviço gerido pelo manager).
 *
 * `lastUse <= 0` = container gerido de pé, sem uso registrado desde o boot do manager. Isso NÃO é
 * motivo para retê-lo: era o bug que deixava o vLLM segurando ~19GB da 4090 indefinidamente depois
 * de um deploy/`compose up`. O boot semeia o relógio (grace de idleMs) e, sem uso, o serviço cai.
 * O caller ainda checa `isContainerRunning` antes de parar, então um serviço já parado é no-op.
 */
export function shouldIdleUnload(
  container: string,
  lastUse: number,
  idleMs: number,
  now: number,
  starting = false
): boolean {
  if (!container) return false;
  if (idleMs <= 0) return false;
  if (starting) return false;
  const since = lastUse > 0 ? lastUse : 0;
  return now - since > idleMs;
}
