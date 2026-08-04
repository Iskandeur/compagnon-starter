import { test } from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_LIMITS, OWNER_CHAT, chatOf, decide, groupUnlocked, isSendTool, parseGroupAllowlist, parseRestrictedGroups, type SendEvent } from "./wa-guard.ts";

const T0 = 1_800_000_000_000; // instant fixe (pas de Date.now dans les tests)
const req = (over: Partial<Parameters<typeof decide>[1]> = {}) => ({
  tool: "mcp__whatsapp_own__send-text",
  chat: OWNER_CHAT,
  hold: false,
  groupsUnlocked: false,
  ...over,
});
const ev = (n: number, chat: string, ageMs = 0): SendEvent[] =>
  Array.from({ length: n }, (_, i) => ({ ts: T0 - ageMs - i * 10_000, chat, tool: "mcp__whatsapp_own__send-text" }));

test("détecte les outils d'envoi, ignore les lectures", () => {
  assert.ok(isSendTool("mcp__whatsapp_own__send-text"));
  assert.ok(isSendTool("mcp__whatsapp_own__forward-message"));
  assert.ok(isSendTool("mcp__whatsapp_human__send-text"));
  assert.ok(!isSendTool("mcp__whatsapp_own__chats-get-messages"));
  assert.ok(!isSendTool("Bash"));
});

test("laisse passer un message normal au principal", () => {
  assert.equal(decide([], req(), DEFAULT_LIMITS, T0).allow, true);
});

test("refuse tout envoi via le canal humain (impersonation)", () => {
  const d = decide([], req({ tool: "mcp__whatsapp_human__send-text" }), DEFAULT_LIMITS, T0);
  assert.equal(d.allow, false);
  assert.match(d.reason, /READ-ONLY/);
});

test("refuse quand le hold est actif", () => {
  assert.equal(decide([], req({ hold: true }), DEFAULT_LIMITS, T0).allow, false);
});

test("refuse les groupes, sauf déverrouillage explicite", () => {
  const g = { chat: "120363@g.us" };
  assert.equal(decide([], req(g), DEFAULT_LIMITS, T0).allow, false);
  assert.equal(decide([], req({ ...g, groupsUnlocked: true }), DEFAULT_LIMITS, T0).allow, true);
});

test("allowlist groupe : scope à un groupe précis, ignore commentaires/vides", () => {
  const allow = parseGroupAllowlist("# groupe exemple\n111111111111111111@g.us\n\n  \n");
  assert.deepEqual([...allow], ["111111111111111111@g.us"]);
  assert.equal(groupUnlocked(allow, "111111111111111111@g.us"), true);
  assert.equal(groupUnlocked(allow, "999@g.us"), false); // un autre groupe reste bloqué
});

test("allowlist groupe : '*' ouvre tout, fichier vide = rétrocompat (tout)", () => {
  assert.equal(groupUnlocked(parseGroupAllowlist("*"), "nimporte@g.us"), true);
  assert.equal(groupUnlocked(parseGroupAllowlist("# que des commentaires\n"), "x@g.us"), true);
  assert.equal(groupUnlocked(new Set<string>(), "x@g.us"), true);
});

test("allowlist groupe : préfixe '!' reste envoi-autorisé (le '!' est retiré)", () => {
  const allow = parseGroupAllowlist("120363A@g.us\n!120363B@g.us\n");
  assert.equal(groupUnlocked(allow, "120363A@g.us"), true);
  assert.equal(groupUnlocked(allow, "120363B@g.us"), true); // '!' retiré, toujours envoi-autorisé
});

test("parseRestrictedGroups : ne retient que les lignes marquées '!', '!' retiré de l'id", () => {
  const nc = parseRestrictedGroups("120363A@g.us\n!120363B@g.us\n# !120363C@g.us (commentée, ignorée)\n");
  assert.deepEqual([...nc], ["120363B@g.us"]);
  assert.equal(nc.has("120363A@g.us"), false); // non restreint par défaut
});

test("cadence : refuse deux envois collés", () => {
  const recent: SendEvent[] = [{ ts: T0 - 500, chat: OWNER_CHAT, tool: "mcp__whatsapp_own__send-text" }];
  assert.equal(decide(recent, req(), DEFAULT_LIMITS, T0).allow, false);
  assert.equal(decide(recent, req(), DEFAULT_LIMITS, T0 + 5_000).allow, true);
});

test("rafale : refuse au-delà du plafond 5 min", () => {
  const burst = ev(DEFAULT_LIMITS.maxPer5min, OWNER_CHAT, 30_000);
  const d = decide(burst, req(), DEFAULT_LIMITS, T0);
  assert.equal(d.allow, false);
  assert.match(d.reason, /5 min/);
});

test("fan-out : refuse un 4ᵉ destinataire dans l'heure, mais pas le principal", () => {
  const hist: SendEvent[] = ["a@c.us", "b@c.us", "c@c.us"].flatMap((c) => ev(1, c, 60_000));
  const d = decide(hist, req({ chat: "d@c.us" }), DEFAULT_LIMITS, T0);
  assert.equal(d.allow, false);
  assert.match(d.reason, /destinataires distincts/);
  // un destinataire DÉJÀ dans la fenêtre reste joignable (on ne coupe pas une conversation en cours)
  assert.equal(decide(hist, req({ chat: "b@c.us" }), DEFAULT_LIMITS, T0).allow, true);
  // et le principal n'est jamais compté dans le fan-out
  assert.equal(decide(hist, req(), DEFAULT_LIMITS, T0).allow, true);
});

test("la fenêtre glisse : de vieux envois ne bloquent plus", () => {
  const old = ["a@c.us", "b@c.us", "c@c.us"].flatMap((c) => ev(1, c, 2 * 3_600_000));
  assert.equal(decide(old, req({ chat: "d@c.us" }), DEFAULT_LIMITS, T0).allow, true);
});

test("chatOf lit le chatId, sinon '?'", () => {
  assert.equal(chatOf({ chatId: "x@c.us", text: "yo" }), "x@c.us");
  assert.equal(chatOf(undefined), "?");
  assert.equal(chatOf({ text: "yo" }), "?");
});
