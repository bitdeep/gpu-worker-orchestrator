interface Entry {
  operation: string;
  shared: boolean;
  admit: () => void;
}

/**
 * A bounded resident pair may overlap. Lifecycle work remains exclusive.
 * Downgrade retains ownership, so no unload can enter between prepare and use.
 * This is process-local admission, not CUDA stream scheduling or preemption.
 */
export function createGpuAccess(residentOperations: readonly string[] = []) {
  if (residentOperations.length > 2 || new Set(residentOperations).size !== residentOperations.length ||
      residentOperations.some(value => !/^[a-z][a-z0-9:-]{0,63}$/.test(value))) {
    throw new Error("Invalid resident GPU operation pair");
  }
  const allowed = new Set(residentOperations);
  const active = new Set<Entry>();
  const waiting: Entry[] = [];
  const compatible = (entry: Entry) => active.size === 0 ||
    (entry.shared && active.size < 2 &&
      [...active].every(other => other.shared && other.operation !== entry.operation));
  function dispatch() {
    // Preserve FIFO when idle. While a resident runs, its compatible partner
    // can enter even if an exclusive task is waiting for that resident to end.
    for (let index = 0; index < waiting.length;) {
      const entry = waiting[index]!;
      if (!compatible(entry)) { index++; continue; }
      waiting.splice(index, 1);
      active.add(entry);
      entry.admit();
    }
  }
  return {
    async run<T>(operation: string, resident: boolean,
      fn: (share: () => void) => Promise<T>): Promise<T> {
      const entry: Entry = { operation, shared: resident && allowed.has(operation), admit: () => {} };
      const entered = new Promise<void>(resolve => { entry.admit = resolve; });
      waiting.push(entry);
      dispatch();
      await entered;
      try {
        return await fn(() => {
          if (!active.has(entry)) throw new Error("GPU lease already released");
          if (allowed.has(operation)) {
            entry.shared = true;
            dispatch();
          }
        });
      } finally {
        active.delete(entry);
        dispatch();
      }
    }
  };
}
