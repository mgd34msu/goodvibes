import { afterEach, expect, test } from "bun:test";
import { installRecordedIds } from "./recorded-ids";

const realCrypto = Object.getOwnPropertyDescriptor(crypto, "randomUUID");
const g = globalThis as Record<string, unknown>;

class FakeButton {
  disabled = false;
  textContent: string;
  constructor(text: string) {
    this.textContent = text;
  }
  closest() {
    return this;
  }
}

function setup(ids: string[]) {
  let listener: ((event: { target: unknown }) => void) | undefined;
  g.document = { addEventListener: (_: string, fn: typeof listener) => (listener = fn) };
  g.Element = FakeButton;
  installRecordedIds({ ids });
  return { click: (text: string) => listener?.({ target: new FakeButton(text) }) };
}

afterEach(() => {
  if (realCrypto) Object.defineProperty(crypto, "randomUUID", realCrypto);
  delete g.document;
  delete g.Element;
});

test("draws before a Submit click are never given a recorded id", () => {
  const { click } = setup(["req-1", "inp-1"]);
  const early = [crypto.randomUUID(), crypto.randomUUID(), crypto.randomUUID()];
  expect(early).not.toContain("req-1");
  expect(early).not.toContain("inp-1");
  click("Submit");
  expect<string[]>([crypto.randomUUID(), crypto.randomUUID()]).toEqual(["req-1", "inp-1"]);
});

test("after the pair is handed out, later draws are random again and other buttons do not arm it", () => {
  const { click } = setup(["req-1", "inp-1", "req-2", "inp-2"]);
  click("Inspect");
  expect(crypto.randomUUID()).not.toBe("req-1");
  click("Submit");
  crypto.randomUUID();
  crypto.randomUUID();
  expect(crypto.randomUUID()).not.toBe("req-2");
  click("Submit");
  expect<string[]>([crypto.randomUUID(), crypto.randomUUID()]).toEqual(["req-2", "inp-2"]);
});
