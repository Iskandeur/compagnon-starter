import { test } from "node:test";
import assert from "node:assert/strict";
import {
  auditCorpus,
  auditMessage,
  boldSpans,
  DETECTORS,
  INDICATIVE_DETECTORS,
  isDaemonTemplate,
  resolveTics,
  selectWindow,
  sentences,
  stripNonProse,
  windowTruncated,
} from "./voice-audit.ts";

const countOf = (body: string, detector: string): number =>
  auditMessage(body, INDICATIVE_DETECTORS).countsByDetector[detector] ?? 0;

test("isDaemonTemplate écarte les gabarits du daemon par préfixe, pas la prose", () => {
  const spec = { prefixes: ["✅ Redémarrage terminé", "🌱 Nouvelle session"] };
  assert.equal(isDaemonTemplate("✅ Redémarrage terminé — je suis revenu sur 6bd01a4.", spec), true);
  assert.equal(isDaemonTemplate("🌱 Nouvelle session au prochain message.", spec), true);
  assert.equal(isDaemonTemplate("Bonjour. Rien de calé aujourd'hui.", spec), false);
  // Un vrai message qui PARLE d'un redémarrage n'est pas un gabarit : seul le début compte.
  assert.equal(isDaemonTemplate("Je redémarre le service pour l'activer, ✅ ensuite.", spec), false);
});

test("isDaemonTemplate écarte aussi par pattern, pour des gabarits sans préfixe fixe", () => {
  const spec = { patterns: [/^(Moteur|Modèle|Effort)[^\n]{0,40}→/] };
  assert.equal(isDaemonTemplate("Moteur → Claude ✅ épinglé + modèle → opus ✅ épinglé.", spec), true);
  // Une phrase qui commence par le même mot mais sans la forme du gabarit reste de la prose.
  assert.equal(isDaemonTemplate("Moteur pinné sur Claude depuis hier soir, je te préviens si ça bascule.", spec), false);
});

test("isDaemonTemplate sans spec ne filtre rien", () => {
  assert.equal(isDaemonTemplate("✅ Redémarrage terminé."), false);
});

test("stripNonProse retire code, code inline et URLs", () => {
  const body = "Regarde ```const x = 1;``` et `npm test` sur https://example.com/a?b=c ok";
  const out = stripNonProse(body);
  assert.ok(!out.includes("const x"));
  assert.ok(!out.includes("npm test"));
  assert.ok(!out.includes("example.com"));
  assert.ok(out.includes("Regarde"));
  assert.ok(out.includes("ok"));
});

test("stripNonProse ne compte pas les tirets d'un bloc de code comme des tics", () => {
  const body = "Voilà :\n```\nconst a = 1; // — un tiret dans du code —\n```\nC'est tout.";
  assert.equal(countOf(body, "tiret-cadratin"), 0);
});

test("sentences découpe sur la ponctuation forte et les sauts de ligne", () => {
  assert.deepEqual(sentences("Un. Deux !\nTrois"), ["Un.", "Deux !", "Trois"]);
  assert.deepEqual(sentences("   "), []);
});

test("boldSpans distingue le gras de titre du gras au milieu d'une phrase", () => {
  const spans = boldSpans("*Titre de section*\nUne phrase avec du *gras inline* dedans.\n- *Puce en gras*");
  assert.equal(spans.length, 3);
  assert.deepEqual(spans.map((s) => s.leadsLine), [true, false, true]);
});

test("boldSpans traite « 1) » et « • » comme du décor de puce, pas comme du texte", () => {
  const spans = boldSpans("1) *Premier point*\n• *Deuxième*");
  assert.deepEqual(spans.map((s) => s.leadsLine), [true, true]);
});

test("gras-inline compte l'emphase, gras-titre la structure", () => {
  const body = "*Verdict*\nLe tarif est *×3,7* au pire, mais *rien à changer*.";
  assert.equal(countOf(body, "gras-inline"), 2);
  assert.equal(countOf(body, "gras-titre"), 1);
});

test("tiret-cadratin compte chaque tiret cadratin de la prose", () => {
  assert.equal(countOf("Rien à signaler — vraiment — rien.", "tiret-cadratin"), 2);
  assert.equal(countOf("Rien a signaler, vraiment.", "tiret-cadratin"), 0);
  // Le trait d'union ordinaire ne doit pas compter (sinon tout mot composé serait un tic).
  assert.equal(countOf("Un garde-fou bien câblé.", "tiret-cadratin"), 0);
});

test("negation-parallele attrape les trois formes de « pas X, c'est Y »", () => {
  assert.equal(countOf("Ce n'est pas un défaut de contenu, c'est un défaut d'heure.", "negation-parallele"), 1);
  assert.equal(countOf("Ce n'est pas une boîte mais une personne.", "negation-parallele"), 1);
  assert.equal(countOf("C'était un défaut de conception, pas un oubli.", "negation-parallele"), 1);
  assert.equal(countOf("Je n'ai pas encore vérifié.", "negation-parallele"), 0);
});

test("annonce-de-plan repère l'annonce de structure", () => {
  assert.equal(countOf("Deux choses, dans l'ordre.", "annonce-de-plan"), 1);
  assert.equal(countOf("Trois axes, nets.", "annonce-de-plan"), 1);
  assert.equal(countOf("J'ai relu le fichier.", "annonce-de-plan"), 0);
});

test("punchline ne se déclenche que sur une chute courte et finale", () => {
  assert.equal(countOf("Le plan promet une solution universelle. Bref : joli mais creux.", "punchline"), 1);
  // Une même formule au MILIEU du message n'est pas une chute.
  assert.equal(countOf("Bref : joli mais creux. Cela dit, je garde un œil dessus au cas où.", "punchline"), 0);
  // Trop longue pour être une punchline fabriquée : c'est une vraie phrase.
  assert.equal(
    countOf("Donc le verdict reste le même qu'hier, pour les raisons détaillées juste au-dessus et revérifiées ce matin.", "punchline"),
    0,
  );
});

test("couverture et cheville comptent les précautions et les formules creuses", () => {
  assert.equal(countOf("C'est probablement bon, sans doute même sûr.", "couverture"), 2);
  assert.equal(countOf("À noter que le sync tourne au niveau de la gateway.", "cheville"), 2);
});

test("auditMessage rend un taux pour 1000 caractères, et l'extrait qui l'a déclenché", () => {
  const r = auditMessage("Rien à signaler — vraiment.");
  assert.equal(r.hits.length, 1);
  assert.equal(r.hits[0].detector, "tiret-cadratin");
  assert.ok(r.hits[0].excerpt.includes("—"));
  assert.ok(r.per1000 > 0);
  assert.equal(auditMessage("").per1000, 0);
});

test("auditMessage n'inclut pas les détecteurs indicatifs dans le score", () => {
  const body = "*Titre*\nRien à signaler.";
  const withIndicative = auditMessage(body, INDICATIVE_DETECTORS);
  assert.equal(withIndicative.countsByDetector["gras-titre"], 1);
  assert.equal(withIndicative.per1000, 0, "un gras de titre ne doit rien coûter au score");
});

test("auditCorpus agrège sur le total du corpus, pas en moyenne de taux", () => {
  // Un message minuscule très chargé ne doit pas peser autant qu'un long message propre.
  const petit = "A —";
  const long = "b".repeat(1000);
  const r = auditCorpus([{ body: petit }, { body: long }]);
  assert.equal(r.kept, 2);
  assert.equal(r.countsByDetector["tiret-cadratin"], 1);
  // 1 tic sur ~1003 caractères ≈ 1/1000, et non la moyenne de (333/1000 et 0).
  assert.ok(r.per1000ByDetector["tiret-cadratin"] < 1.5, `taux inattendu : ${r.per1000ByDetector["tiret-cadratin"]}`);
});

test("auditCorpus écarte les gabarits (par spec) et classe les pires messages en tête", () => {
  const r = auditCorpus(
    [
      { id: "tpl", body: "✅ Redémarrage terminé — je suis revenu sur abc1234." },
      { id: "propre", body: "Rien à signaler aujourd'hui, tout tourne." },
      { id: "charge", body: "Bon — alors — voilà — c'est fait." },
    ],
    [],
    { prefixes: ["✅ Redémarrage terminé"] },
  );
  assert.equal(r.skippedTemplates, 1);
  assert.equal(r.kept, 2);
  assert.equal(r.worst[0].id, "charge");
  assert.equal(r.worst.length, 1, "un message sans tic ne doit pas apparaître dans les pires");
});

test("aucun détecteur ne se déclenche sur un message court et naturel", () => {
  const r = auditMessage("Noté, je m'en occupe demain matin. Bonne nuit.", INDICATIVE_DETECTORS);
  assert.equal(r.hits.length, 0, JSON.stringify(r.hits));
});

test("chaque détecteur porte un nom unique et une justification", () => {
  const names = [...DETECTORS, ...INDICATIVE_DETECTORS].map((d) => d.name);
  assert.equal(new Set(names).size, names.length);
  for (const d of [...DETECTORS, ...INDICATIVE_DETECTORS]) assert.ok(d.why.length > 20, `justification trop courte : ${d.name}`);
});

// --- Fenêtre temporelle : ce qui rend une mesure comparable à la précédente ---

const T = (iso: string) => Date.parse(iso);
const CORPUS = [
  { id: "c", timestamp: T("2026-08-16T01:00:00Z"), body: "après" },
  { id: "b", timestamp: T("2026-08-15T02:52:27Z"), body: "pile sur la borne" },
  { id: "a", timestamp: T("2026-08-14T10:00:00Z"), body: "avant" },
];

test("selectWindow isole ce qui a été écrit APRÈS la ligne de base, borne exclue", () => {
  const since = T("2026-08-15T02:52:27Z");
  assert.deepEqual(selectWindow(CORPUS, { since }).map((m) => m.id), ["c"]);
  // La borne appartient à la ligne de base, pas à ce qui suit : sinon le message qui l'a produite
  // serait compté deux fois, dans la base ET dans la mesure censée la dépasser.
  assert.deepEqual(selectWindow(CORPUS, { until: since }).map((m) => m.id), ["b", "a"]);
});

test("selectWindow sans bornes ne retire rien", () => {
  assert.equal(selectWindow(CORPUS, {}).length, 3);
});

test("selectWindow écarte les messages sans horodatage dès qu'une borne est posée", () => {
  // Un message non daté ne peut pas être prouvé dans la fenêtre : l'inclure gonflerait un corpus
  // « figé » avec de l'indatable, ce qui ruinerait justement la comparabilité recherchée.
  const sansDate = [...CORPUS, { id: "?", body: "sans date" }];
  assert.equal(selectWindow(sansDate, {}).length, 4);
  assert.equal(selectWindow(sansDate, { since: T("2026-08-14T00:00:00Z") }).some((m) => m.id === "?"), false);
});

test("windowTruncated crie quand la limite de récupération a coupé la fenêtre demandée, et se tait sinon", () => {
  const since = T("2026-08-01T00:00:00Z"); // plus ancien que tout le corpus récupéré
  // Limite atteinte + plus rien d'aussi vieux que `since` → il manque probablement des messages.
  assert.equal(windowTruncated(CORPUS, { since }, true), true);
  // Même corpus, mais la récupération n'a pas saturé : on a bien tout, aucun avertissement.
  assert.equal(windowTruncated(CORPUS, { since }, false), false);
  // La fenêtre commence après le plus vieux message récupéré → elle est entièrement couverte.
  assert.equal(windowTruncated(CORPUS, { since: T("2026-08-15T00:00:00Z") }, true), false);
  // Sans `since`, il n'y a pas de début de fenêtre à manquer.
  assert.equal(windowTruncated(CORPUS, {}, true), false);
});

test("auditCorpus rend aussi les tics PAR MESSAGE, l'unité dans laquelle une cible se fixe d'habitude", () => {
  const r = auditCorpus([
    { body: "Bon — alors — voilà." },
    { body: "Rien à signaler." },
  ]);
  assert.equal(r.kept, 2);
  assert.equal(r.countsByDetector["tiret-cadratin"], 2);
  assert.equal(r.perMessageByDetector["tiret-cadratin"], 1);
  // Le taux par caractère et le taux par message ne disent pas la même chose dès que la longueur
  // moyenne des messages bouge — afficher les deux évite de se mentir sur lequel a bougé.
  assert.notEqual(r.per1000ByDetector["tiret-cadratin"], r.perMessageByDetector["tiret-cadratin"]);
});

test("resolveTics : sans demande, les deux tics par défaut", () => {
  const s = resolveTics([]);
  assert.deepEqual(s.tics, ["tiret-cadratin", "gras-inline"]);
  assert.equal(s.needsIndicatif, false);
  assert.equal(s.error, undefined);
});

test("resolveTics : des défauts personnalisés remplacent les défauts de la lib", () => {
  const s = resolveTics([], ["negation-parallele"]);
  assert.deepEqual(s.tics, ["negation-parallele"]);
});

test("resolveTics : un nom inconnu CRIE au lieu d'afficher une colonne à zéro", () => {
  // C'est tout le point : une faute de frappe qui rendrait 0,00 se lirait comme un tic éteint.
  const s = resolveTics(["negation-paralele"]);
  assert.deepEqual(s.tics, []);
  assert.match(s.error ?? "", /détecteur inconnu/);
  assert.match(s.error ?? "", /negation-parallele/); // l'erreur liste les noms valides
});

test("resolveTics : demander un indicatif exige son calcul", () => {
  // `gras-titre` ne tourne qu'avec les détecteurs indicatifs : le demander sans les allumer
  // afficherait 0,00.
  const s = resolveTics(["gras-titre"]);
  assert.deepEqual(s.tics, ["gras-titre"]);
  assert.equal(s.needsIndicatif, true);
});

test("resolveTics : ordre demandé conservé, doublons écartés", () => {
  const s = resolveTics(["negation-parallele", "tiret-cadratin", "negation-parallele"]);
  assert.deepEqual(s.tics, ["negation-parallele", "tiret-cadratin"]);
  assert.equal(s.needsIndicatif, false);
});
