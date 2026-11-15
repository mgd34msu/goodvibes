/**
 * Browser-side id seeding for the native proofs. Runs inside the page via
 * `page.addInitScript(installRecordedIds, { ids, storageKey? })`, so it must stay
 * self-contained. Unrelated draws (hosted attach, push device, judgment requests)
 * keep their native random ids: the recorded ids are handed out only after a click
 * on a "Submit" button, in pairs (requestId, inputId), and never to an earlier draw.
 * With `storageKey` the position survives reloads in sessionStorage.
 */
export interface RecordedIdsArgs {
  ids: string[];
  storageKey?: string;
}

export function installRecordedIds({ ids, storageKey }: RecordedIdsArgs): void {
  const original = crypto.randomUUID.bind(crypto);
  let submitting = false;
  let memoryIndex = 0;
  const read = () => (storageKey ? Number(sessionStorage.getItem(storageKey) ?? 0) : memoryIndex);
  const write = (index: number) => {
    if (storageKey) sessionStorage.setItem(storageKey, String(index));
    else memoryIndex = index;
  };
  document.addEventListener(
    "click",
    (event) => {
      const target = event.target;
      const button = target instanceof Element ? target.closest("button") : null;
      if (button && !button.disabled && button.textContent?.trim() === "Submit") submitting = true;
    },
    true
  );
  Object.defineProperty(crypto, "randomUUID", {
    configurable: true,
    value: () => {
      const index = read();
      if (!submitting || index >= ids.length) return original();
      write(index + 1);
      if (index % 2 === 1) submitting = false;
      return ids[index] as string;
    },
  });
}
