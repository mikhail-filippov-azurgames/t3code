import { expect, it } from "vite-plus/test";
import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import {
  addBoardCardPin,
  readBoardCardPins,
  removeBoardCardPin,
  subscribeBoardCardPins,
} from "./boardCardPins.ts";

function browserStorage(blocked = false) {
  const values = new Map<string, string>();
  const target = Object.assign(new EventTarget(), {
    localStorage: {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => {
        if (blocked) throw new Error("Storage blocked");
        values.set(key, value);
      },
    },
  });
  const previous = Object.getOwnPropertyDescriptor(globalThis, "window");
  Object.defineProperty(globalThis, "window", { configurable: true, value: target });
  return {
    [Symbol.dispose]: () => {
      if (previous) Object.defineProperty(globalThis, "window", previous);
      else Reflect.deleteProperty(globalThis, "window");
    },
  };
}

const cardId = "11111111-1111-4111-8111-111111111111";
const secondCardId = "22222222-2222-4222-8222-222222222222";
const environmentId = EnvironmentId.make("pin-test");
const threadId = ThreadId.make("pin-thread");

it("isolates pinned cards by environment and thread and ignores invalid duplicate pins", () => {
  using _storage = browserStorage();
  addBoardCardPin(environmentId, threadId, cardId);
  addBoardCardPin(environmentId, threadId, cardId);
  addBoardCardPin(environmentId, threadId, "invalid");
  expect(readBoardCardPins(environmentId, threadId)).toEqual([cardId]);
  expect(readBoardCardPins(EnvironmentId.make("other"), threadId)).toEqual([]);
  expect(readBoardCardPins(environmentId, ThreadId.make("other"))).toEqual([]);
  removeBoardCardPin(environmentId, threadId, cardId);
  expect(readBoardCardPins(environmentId, threadId)).toEqual([]);
});

it("keeps pin and unpin usable when local storage writes fail", () => {
  using _storage = browserStorage(true);
  const notifications: string[][] = [];
  using _subscription = {
    dispose: subscribeBoardCardPins((_key, pins) => notifications.push(pins)),
    [Symbol.dispose]() {
      this.dispose();
    },
  };
  addBoardCardPin(environmentId, threadId, cardId);
  addBoardCardPin(environmentId, threadId, secondCardId);
  expect(readBoardCardPins(environmentId, threadId)).toEqual([cardId, secondCardId]);
  removeBoardCardPin(environmentId, threadId, cardId);
  expect(readBoardCardPins(environmentId, threadId)).toEqual([secondCardId]);
  expect(notifications.at(-1)).toEqual([secondCardId]);
  removeBoardCardPin(environmentId, threadId, secondCardId);
});
