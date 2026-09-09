import { test } from "node:test";
import assert from "node:assert/strict";
import {
  DEFAULT_CANCEL_REACT_EMOJI,
  cancelConfirmationText,
  cancelledTurnError,
  isCancelTurnReaction,
  isCancelledTurn,
} from "./turn-cancel.ts";

const STOP = { emoji: DEFAULT_CANCEL_REACT_EMOJI, isPrincipalAuthor: true };
const react = (over: Record<string, unknown> = {}) => ({
  source: "whatsapp",
  channel: "principal",
  reaction: { emoji: "🛑", targetMsgId: "m1" },
  ...over,
});

test("réaction stop de l'humain principal sur le canal principal → c'est un stop", () => {
  assert.equal(isCancelTurnReaction(react(), STOP), true);
});

test("la cible n'a pas d'importance : son propre message raté compte autant qu'un de l'agent", () => {
  const sien = react({ reaction: { emoji: "🛑", targetMsgId: "false_x_1" } });
  const agent = react({ reaction: { emoji: "🛑", targetMsgId: "true_x_2" } });
  assert.equal(isCancelTurnReaction(sien, STOP), true);
  assert.equal(isCancelTurnReaction(agent, STOP), true);
});

test("un autre emoji ne coupe rien — les réactions qui servent ailleurs restent inoffensives", () => {
  for (const emoji of ["👍", "✋", "🙏", "📝", "👀"]) {
    assert.equal(isCancelTurnReaction(react({ reaction: { emoji, targetMsgId: "m1" } }), STOP), false, emoji);
  }
});

test("un tiers ne peut pas couper la parole à l'agent", () => {
  assert.equal(isCancelTurnReaction(react(), { ...STOP, isPrincipalAuthor: false }), false);
});

test("canal en lecture seule ou canal inconnu → jamais un ordre", () => {
  for (const channel of ["readonly", "unknown", undefined]) {
    assert.equal(isCancelTurnReaction(react({ channel }), STOP), false, String(channel));
  }
});

test("l'écho des réactions posées par l'agent lui-même n'est jamais un stop", () => {
  assert.equal(isCancelTurnReaction(react({ fromMe: true }), STOP), false);
});

test("un autre transport ne déclenche rien, et `source` est paramétrable", () => {
  assert.equal(isCancelTurnReaction(react({ source: "telegram" }), STOP), false);
  assert.equal(isCancelTurnReaction(react({ source: "telegram" }), { ...STOP, source: "telegram" }), true);
});

test("allowedChannels est paramétrable — plusieurs canaux peuvent porter le geste", () => {
  const o = { ...STOP, allowedChannels: ["principal", "second"] };
  assert.equal(isCancelTurnReaction(react({ channel: "second" }), o), true);
  assert.equal(isCancelTurnReaction(react({ channel: "readonly" }), o), false);
});

test("emoji vide = fonctionnalité éteinte, même venant de l'humain principal", () => {
  assert.equal(isCancelTurnReaction(react(), { ...STOP, emoji: "" }), false);
});

test("un évènement qui n'est pas une réaction n'est jamais un stop", () => {
  assert.equal(isCancelTurnReaction({ source: "whatsapp", channel: "principal" }, STOP), false);
});

test("l'erreur d'annulation se reconnaît par son drapeau, une panne ordinaire non", () => {
  assert.equal(isCancelledTurn(cancelledTurnError("🛑")), true);
  assert.equal(isCancelledTurn(new Error("Tour interrompu à la demande (réaction 🛑).")), false);
  for (const notCancelled of [null, undefined, "stop", 42, {}]) {
    assert.equal(isCancelledTurn(notCancelled), false, String(notCancelled));
  }
});

test("la confirmation distingue les trois cas, et ne se tait jamais", () => {
  assert.match(cancelConfirmationText({ aborted: false, dropped: 0 }), /[Rr]ien à interrompre/);
  assert.match(cancelConfirmationText({ aborted: true, dropped: 0 }), /le tour en cours/);
  assert.match(cancelConfirmationText({ aborted: false, dropped: 1 }), /1 message en attente/);
  const both = cancelConfirmationText({ aborted: true, dropped: 3 });
  assert.match(both, /le tour en cours et 3 messages en attente/);
});
