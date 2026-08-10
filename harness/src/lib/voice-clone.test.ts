import { test } from "node:test";
import assert from "node:assert/strict";
import {
  buildTtsRequest,
  isOwnVoiceEcho,
  looksLikeOggOpus,
  safeEnrichedText,
  sameSpokenWords,
  spokenWords,
  stripAudioTags,
  synthesizeVoice,
} from "./voice-clone.ts";

const VOICE = "voice_id_de_ton_clone";

test("buildTtsRequest : Opus 48k par défaut, le contrat PTT de WhatsApp", () => {
  const { url, body } = buildTtsRequest("salut", { voiceId: VOICE });
  assert.match(url, /\/v1\/text-to-speech\/voice_id_de_ton_clone\?output_format=opus_48000_64$/);
  assert.equal(body.model_id, "eleven_v3");
  assert.equal(body.text, "salut");
});

test("stripAudioTags : les balises sont jouées, jamais prononcées", () => {
  assert.equal(stripAudioTags("[sighs] Bon, [tired] mauvaise nouvelle."), "Bon, mauvaise nouvelle.");
});

test("spokenWords : accents, casse et ponctuation ne comptent pas", () => {
  assert.deepEqual(spokenWords("Ça, c'est réglé !"), ["ca", "c", "est", "regle"]);
});

test("sameSpokenWords : un enrichissement honnête passe", () => {
  const brut = "Bon, mauvaise nouvelle. Le proprio a dit non.";
  const riche = "[sighs] Bon, mauvaise nouvelle. [serious] Le proprio a dit non.";
  assert.equal(sameSpokenWords(brut, riche), true);
});

test("sameSpokenWords : une reformulation est refusée", () => {
  const brut = "Le proprio a dit non.";
  assert.equal(sameSpokenWords(brut, "[sighs] Le propriétaire a refusé."), false);
});

test("sameSpokenWords : une traduction est refusée", () => {
  assert.equal(sameSpokenWords("Le proprio a dit non.", "[sad] The landlord said no."), false);
});

test("sameSpokenWords : une phrase ajoutée est refusée", () => {
  const brut = "Le proprio a dit non.";
  assert.equal(sameSpokenWords(brut, "[sad] Le proprio a dit non. Désolé pour toi."), false);
});

test("safeEnrichedText : on retombe sur le texte brut plutôt que de faire dire n'importe quoi", () => {
  const brut = "Le proprio a dit non.";
  assert.equal(safeEnrichedText(brut, "[sighs] Le propriétaire a refusé."), brut);
  assert.equal(safeEnrichedText(brut, null), brut, "passe LLM en échec → texte brut");
  assert.equal(safeEnrichedText(brut, "[sighs] Le proprio a dit non."), "[sighs] Le proprio a dit non.");
});

test("isOwnVoiceEcho : le compagnon ne se répond pas à lui-même", () => {
  const own = ["33700000000@c.us"];
  assert.equal(isOwnVoiceEcho({ author: "33700000000@c.us" }, own), true);
  assert.equal(isOwnVoiceEcho({ fromMe: true, author: "33611111111@c.us" }, own), true);
  assert.equal(isOwnVoiceEcho({ author: "33611111111@c.us" }, own), false);
});

test("isOwnVoiceEcho : les DEUX formes d'identifiant du même compte", () => {
  // Le trou réel : la liste ne contenait que la forme @c.us, l'évènement arrivait en @lid,
  // et la garde était simplement absente sans que rien ne le signale.
  assert.equal(isOwnVoiceEcho({ author: "33700000000@lid" }, ["33700000000@c.us"]), true);
  assert.equal(isOwnVoiceEcho({ author: "33700000000@c.us" }, ["33700000000@lid"]), true);
});

test("looksLikeOggOpus : ce que WhatsApp accepte en note vocale", () => {
  assert.equal(looksLikeOggOpus(new Uint8Array([0x4f, 0x67, 0x67, 0x53, 0x00])), true);
  assert.equal(looksLikeOggOpus(new Uint8Array([0x49, 0x44, 0x33, 0x04, 0x00])), false, "un mp3");
});

test("synthesizeVoice : la clé part en en-tête, jamais dans l'URL", async () => {
  let seenUrl = "";
  let seenHeaders: Record<string, string> = {};
  const fake = (async (url: string, init: RequestInit) => {
    seenUrl = url;
    seenHeaders = init.headers as Record<string, string>;
    return {
      ok: true,
      arrayBuffer: async () => new Uint8Array([0x4f, 0x67, 0x67, 0x53]).buffer,
    };
  }) as unknown as typeof fetch;

  const bytes = await synthesizeVoice("salut", { voiceId: VOICE, apiKey: "sk-secret", fetchImpl: fake });
  assert.equal(looksLikeOggOpus(bytes), true);
  assert.doesNotMatch(seenUrl, /sk-secret/);
  assert.equal(seenHeaders["xi-api-key"], "sk-secret");
});

test("synthesizeVoice : une erreur API remonte lisible", async () => {
  const fake = (async () => ({ ok: false, status: 401, text: async () => "invalid api key" })) as unknown as typeof fetch;
  await assert.rejects(
    () => synthesizeVoice("salut", { voiceId: VOICE, apiKey: "nope", fetchImpl: fake }),
    /ElevenLabs 401/,
  );
});
