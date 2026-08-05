import { test } from "node:test";
import assert from "node:assert/strict";
import { GITHUB_LINKS } from "./github-links.js";

test("GITHUB_LINKS expose le repo principal et un éventuel repo public", () => {
  assert.match(GITHUB_LINKS.main.url, /^https:\/\/github\.com\//);
  assert.equal(GITHUB_LINKS.main.visibility, "privé");
  assert.match(GITHUB_LINKS.public.url, /^https:\/\/github\.com\//);
  assert.equal(GITHUB_LINKS.public.visibility, "public");
});

test("GITHUB_LINKS ne code pas les knowledge repos en dur (le registre fait foi)", () => {
  // Les knowledge repos sont lus dynamiquement (src/knowledge-repos.js) ; ce module ne doit ni
  // les dupliquer, ni affirmer qu'il n'y en a aucun.
  assert.equal(GITHUB_LINKS.knowledge, undefined);
  assert.doesNotMatch(GITHUB_LINKS.knowledgeNote, /aucun/i);
  assert.match(GITHUB_LINKS.knowledgeNote, /registry\.json/);
});
