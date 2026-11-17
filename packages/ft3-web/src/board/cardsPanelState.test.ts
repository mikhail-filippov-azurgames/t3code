import { EnvironmentId, ThreadId, type ScopedThreadRef } from "@t3tools/contracts";
import { BoardCardId, type BoardCardLookupDetail } from "@t3tools/ft3-board/contracts";
import { expect, it } from "vite-plus/test";
import {
  getCardsPanelState,
  readCardsPanelDetail,
  removeCardsPanelCard,
  retainCardsPanelPins,
  resetCardsPanelState,
} from "./cardsPanelState";

const cardId = BoardCardId.make("11111111-1111-4111-8111-111111111111");
const ref = (thread = "lead", environment = "env"): ScopedThreadRef => ({
  environmentId: EnvironmentId.make(environment),
  threadId: ThreadId.make(thread),
});

it("shares session entries only for the same environment, thread and card", () => {
  resetCardsPanelState();
  const entry = getCardsPanelState(ref(), cardId);
  entry.update({ requestText: "Draft", descriptionExpanded: true });
  expect(getCardsPanelState(ref(), cardId)).toBe(entry);
  for (const other of [
    getCardsPanelState(ref("other"), cardId),
    getCardsPanelState(ref("lead", "other"), cardId),
    getCardsPanelState(ref(), "other-card"),
    getCardsPanelState(ref()),
  ]) {
    expect(other.getSnapshot().requestText).toBe("");
    expect(other.getSnapshot().descriptionExpanded).toBe(false);
  }
});

it("removes cached details and viewing state and closes the removed card plan", () => {
  resetCardsPanelState();
  const panel = getCardsPanelState(ref());
  const entry = getCardsPanelState(ref(), cardId);
  const detail = { card: { cardId } } as BoardCardLookupDetail;
  panel.update({ selectedPlanId: cardId });
  entry.update({ requestText: "Draft", collapsed: true });
  entry.retainDetail(detail);
  expect(readCardsPanelDetail(ref(), cardId)).toBe(detail);
  removeCardsPanelCard(ref(), cardId);
  expect(readCardsPanelDetail(ref(), cardId)).toBeUndefined();
  expect(panel.getSnapshot().selectedPlanId).toBeNull();
  expect(entry.getDetail()).toBeUndefined();
  const fresh = getCardsPanelState(ref(), cardId);
  expect(fresh).not.toBe(entry);
  expect(fresh.getSnapshot().requestText).toBe("");
  expect(fresh.getSnapshot().collapsed).toBe(false);
});

it("preserves another card plan when removing a different card", () => {
  resetCardsPanelState();
  const panel = getCardsPanelState(ref());
  panel.update({ selectedPlanId: cardId });
  const otherCard = getCardsPanelState(ref(), "other-card");
  otherCard.update({ requestText: "Draft" });
  retainCardsPanelPins(ref(), [cardId]);
  expect(otherCard.getSnapshot().requestText).toBe("");
  expect(getCardsPanelState(ref(), "other-card")).not.toBe(otherCard);
  expect(panel.getSnapshot().selectedPlanId).toBe(cardId);
});

it("resets the registry between sessions and tests", () => {
  resetCardsPanelState();
  const panel = getCardsPanelState(ref());
  const card = getCardsPanelState(ref(), cardId);
  panel.update({ selectedPlanId: cardId });
  panel.retainLeadMembership(true);
  card.update({ requestText: "Draft" });
  resetCardsPanelState();
  expect(panel.getSnapshot().selectedPlanId).toBeNull();
  expect(card.getSnapshot().requestText).toBe("");
  expect(getCardsPanelState(ref())).not.toBe(panel);
  expect(getCardsPanelState(ref()).getLeadMembership()).toBeUndefined();
});

it("keeps the 50 most recently used inactive threads", () => {
  resetCardsPanelState();
  const first = getCardsPanelState(ref("0"), cardId);
  const second = getCardsPanelState(ref("1"), cardId);
  for (let index = 2; index < 50; index++) getCardsPanelState(ref(String(index)));
  expect(getCardsPanelState(ref("0"), cardId)).toBe(first);
  getCardsPanelState(ref("50"));
  expect(getCardsPanelState(ref("0"), cardId)).toBe(first);
  expect(getCardsPanelState(ref("1"), cardId)).not.toBe(second);
});

it("protects mounted panels from eviction and prunes after they unsubscribe", () => {
  resetCardsPanelState();
  const active = getCardsPanelState(ref("active"));
  const unsubscribe = active.subscribe(() => {});
  for (let index = 0; index < 60; index++) getCardsPanelState(ref(String(index)));
  expect(getCardsPanelState(ref("active"))).toBe(active);
  unsubscribe();
  for (let index = 60; index < 111; index++) getCardsPanelState(ref(String(index)));
  expect(getCardsPanelState(ref("active"))).not.toBe(active);
});
