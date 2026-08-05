import { test } from "node:test";
import assert from "node:assert/strict";
import { GITHUB_LINKS } from "./github-links.js";

test("GITHUB_LINKS expose un repo principal et un repo public", () => {
  assert.ok(GITHUB_LINKS.main.url.startsWith("https://github.com/"));
  assert.equal(GITHUB_LINKS.main.visibility, "privé");
  assert.ok(GITHUB_LINKS.public.url.startsWith("https://github.com/"));
  assert.equal(GITHUB_LINKS.public.visibility, "public");
});

test("GITHUB_LINKS ne code pas les knowledge repos en dur (le registre fait foi)", () => {
  assert.equal(GITHUB_LINKS.knowledge, undefined);
  assert.match(GITHUB_LINKS.knowledgeNote, /registry\.json/);
});
