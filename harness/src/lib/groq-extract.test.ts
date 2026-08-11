import { test } from "node:test";
import assert from "node:assert/strict";
import {
  buildExtractionMessages,
  parseExtractionResponse,
  extractDurableFacts,
  GROQ_CHAT_URL,
  type FactCandidate,
} from "./groq-extract.ts";

test("buildExtractionMessages : system + user, le texte passe tel quel", () => {
  const msgs = buildExtractionMessages("Michel a rejoint Composio en process.");
  assert.equal(msgs.length, 2);
  assert.equal(msgs[0].role, "system");
  assert.match(msgs[0].content, /FAITS DURABLES/);
  assert.equal(msgs[1].role, "user");
  assert.equal(msgs[1].content, "Michel a rejoint Composio en process.");
});

test("parseExtractionResponse : JSON valide → candidats normalisés", () => {
  const raw = JSON.stringify({
    facts: [{ subject: "Michel", fact: "En process avec Composio", confidence: "medium" }],
  });
  const out = parseExtractionResponse(raw);
  assert.deepEqual(out, [{ subject: "Michel", fact: "En process avec Composio", confidence: "medium" }]);
});

test("parseExtractionResponse : liste vide → []", () => {
  assert.deepEqual(parseExtractionResponse(JSON.stringify({ facts: [] })), []);
});

test("parseExtractionResponse : JSON invalide → [] (jamais d'exception)", () => {
  assert.deepEqual(parseExtractionResponse("pas du json"), []);
});

test("parseExtractionResponse : champ facts absent/mauvaise forme → []", () => {
  assert.deepEqual(parseExtractionResponse(JSON.stringify({ oops: true })), []);
  assert.deepEqual(parseExtractionResponse(JSON.stringify({ facts: "pas une liste" })), []);
});

test("parseExtractionResponse : confidence inconnue → repliée sur 'low' (jamais surconfiant par défaut)", () => {
  const raw = JSON.stringify({ facts: [{ subject: "Raph", fact: "Invite en Dordogne", confidence: "yolo" }] });
  const out = parseExtractionResponse(raw);
  assert.equal(out[0].confidence, "low");
});

test("parseExtractionResponse : subject/fact vides ou non-strings sont filtrés", () => {
  const raw = JSON.stringify({
    facts: [
      { subject: "", fact: "vide", confidence: "high" },
      { subject: "Ok", fact: "", confidence: "high" },
      { subject: 42, fact: "pas une string", confidence: "high" },
      { subject: "Bon", fact: "Celui-ci passe", confidence: "high" },
    ],
  });
  const out = parseExtractionResponse(raw);
  assert.deepEqual(out, [{ subject: "Bon", fact: "Celui-ci passe", confidence: "high" }]);
});

test("extractDurableFacts : sans clé API → [] sans appeler fetch", async () => {
  let called = false;
  const fetchFn = (async () => {
    called = true;
    return new Response("{}");
  }) as typeof fetch;
  const out = await extractDurableFacts("texte", undefined, { fetchFn });
  assert.deepEqual(out, []);
  assert.equal(called, false);
});

test("extractDurableFacts : texte vide → [] sans appeler fetch", async () => {
  let called = false;
  const fetchFn = (async () => {
    called = true;
    return new Response("{}");
  }) as typeof fetch;
  const out = await extractDurableFacts("   ", "fake-key", { fetchFn });
  assert.deepEqual(out, []);
  assert.equal(called, false);
});

test("extractDurableFacts : réponse OK → parse le content du 1er choice", async () => {
  const expected: FactCandidate[] = [{ subject: "Alex", fact: "A un nouveau poste", confidence: "high" }];
  const fetchFn = (async (url: string) => {
    assert.equal(url, GROQ_CHAT_URL);
    return new Response(
      JSON.stringify({ choices: [{ message: { content: JSON.stringify({ facts: expected }) } }] }),
      { status: 200 },
    );
  }) as typeof fetch;
  const out = await extractDurableFacts("Alex a un nouveau poste", "fake-key", { fetchFn });
  assert.deepEqual(out, expected);
});

test("extractDurableFacts : HTTP non-OK (ex. rate-limit 429) → [] sans jeter (contrat FALLBACK)", async () => {
  const fetchFn = (async () => new Response("rate limited", { status: 429 })) as typeof fetch;
  const out = await extractDurableFacts("texte", "fake-key", { fetchFn });
  assert.deepEqual(out, []);
});

test("extractDurableFacts : fetch qui jette (réseau/timeout) → [] sans propager (contrat FALLBACK)", async () => {
  const fetchFn = (async () => {
    throw new Error("network down");
  }) as typeof fetch;
  const out = await extractDurableFacts("texte", "fake-key", { fetchFn });
  assert.deepEqual(out, []);
});

test("extractDurableFacts : content absent des choices → []", async () => {
  const fetchFn = (async () => new Response(JSON.stringify({ choices: [] }), { status: 200 })) as typeof fetch;
  const out = await extractDurableFacts("texte", "fake-key", { fetchFn });
  assert.deepEqual(out, []);
});

test("extractDurableFacts : content non-JSON → [] (parseExtractionResponse absorbe)", async () => {
  const fetchFn = (async () =>
    new Response(JSON.stringify({ choices: [{ message: { content: "n'importe quoi" } }] }), { status: 200 })) as typeof fetch;
  const out = await extractDurableFacts("texte", "fake-key", { fetchFn });
  assert.deepEqual(out, []);
});
