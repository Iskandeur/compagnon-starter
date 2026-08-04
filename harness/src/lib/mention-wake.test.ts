import { test } from "node:test";
import assert from "node:assert/strict";
import { isAddressedByMention, wakesOnMention } from "./mention-wake.ts";

test("nom en toutes lettres → adressé, via 'name'", () => {
  assert.deepEqual(isAddressedByMention({ body: "Salut Compagnon !", agentName: "Compagnon" }), {
    addressed: true,
    via: "name",
  });
  assert.deepEqual(isAddressedByMention({ body: "hey compagnon tu peux ?", agentName: "Compagnon" }), {
    addressed: true,
    via: "name",
  });
});

test("limite de mot : pas de faux positif sur un nom qui contient le nom de l'agent", () => {
  assert.equal(wakesOnMention({ body: "Compagnonnage est un beau mot", agentName: "Compagnon" }), false);
});

test("aucun nom, aucun id, aucune mention → pas adressé", () => {
  assert.deepEqual(isAddressedByMention({ body: "on mange à midi ?", agentName: "Compagnon" }), {
    addressed: false,
    via: "none",
  });
});

test("id tapé en texte ('@id') sans mention structurée → détecté, mais marqué 'text-id' (pas une vraie mention)", () => {
  const d = isAddressedByMention({
    body: "@33600000000 tu réponds ?",
    agentName: "Compagnon",
    agentIds: ["33600000000"],
  });
  assert.deepEqual(d, { addressed: true, via: "text-id" });
});

test("mention STRUCTURÉE (payload) sans que l'id apparaisse dans le texte lisible → détecté, via 'structured-mention'", () => {
  const d = isAddressedByMention({
    body: "vous pouvez regarder ça ?",
    agentName: "Compagnon",
    agentIds: ["33600000000"],
    mentionedIds: ["33600000000"],
  });
  assert.deepEqual(d, { addressed: true, via: "structured-mention" });
});

test("mention structurée d'un AUTRE id → pas adressé (pas de faux positif sur le tag de quelqu'un d'autre)", () => {
  const d = isAddressedByMention({
    body: "@33700000000 dm moi",
    agentName: "Compagnon",
    agentIds: ["33600000000"],
    mentionedIds: ["33700000000"],
  });
  assert.deepEqual(d, { addressed: false, via: "none" });
});

test("wakesOnMention : raccourci booléen", () => {
  assert.equal(wakesOnMention({ body: "Compagnon ?", agentName: "Compagnon" }), true);
  assert.equal(wakesOnMention({ body: "rien à voir", agentName: "Compagnon" }), false);
});
