# Auditer sa propre voix — détection mécanique de tics de LLM (français)

## Le problème

Un compagnon qui écrit beaucoup de messages finit par développer des tics reconnaissables comme
« écrits par un LLM » — tirets cadratins, gras à outrance, négations parallèles (« ce n'est pas X,
c'est Y »), annonces de plan, précautions empilées. Se le rappeler ne suffit pas : une règle qu'on
garde en tête ne tient pas dans la durée (le tic revient dès qu'on relâche l'attention), et se
relire un message à la fois ne révèle rien — un tic qui apparaît sur 1 message sur 20 ne se voit
que dans l'agrégat.

## L'idée

Un module pur (`harness/src/lib/voice-audit.ts`, zéro dépendance) qui détecte mécaniquement une
poignée de tics dans du texte français, sans appeler de LLM — l'audit doit être **gratuit**, sinon
il ne tournera jamais assez souvent pour servir. Les motifs viennent du skill
[`humanizer`](https://github.com/blader/humanizer) (33 motifs, adossé au guide « Signs of AI
writing » de Wikipédia, écrit pour l'anglais) : ce module ne retient que ce qui survit à la
traduction vers du chat en français, et uniquement ce qui se compte sans ambiguïté par regex.

⚠️ Ce n'est **pas** un détecteur d'IA et ça ne sert pas à tromper qui que ce soit sur qui écrit :
le but est qu'un message se lise comme quelqu'un qui écrit à quelqu'un, pas comme un essai. Un
compteur haut est un signal à regarder, jamais un verdict — une énumération honnête a parfois la
même forme qu'une figure de style (`humanizer` lui-même insiste sur les faux positifs).

## Les détecteurs

Notés (comptent dans le score) : `tiret-cadratin`, `gras-inline` (gras au milieu d'une phrase — un
gras en tête de ligne est classé à part, `gras-titre`, parce qu'il structure légitimement un
message long), `negation-parallele`, `annonce-de-plan`, `couverture` (précautions empilées),
`cheville` (formules creuses type « afin de », « au niveau de »), `punchline` (chute fabriquée en
fin de message). Indicatifs seulement (hors score, trop de faux positifs) : `gras-titre`,
`regle-de-trois`.

## Usage

```ts
import { auditCorpus, type CorpusMessage } from "./voice-audit.ts";

// Récupère TES messages sortants depuis ta propre source (WhatsApp, Telegram, journal…) —
// hors de ce module, qui reste agnostique de la source.
const messages: CorpusMessage[] = await fetchMyOutgoingMessages();

const report = auditCorpus(messages, [], {
  // Tes propres gabarits de daemon (statuts, réponses de commande) à exclure de l'audit :
  // ils n'ont pas d'auteur humain, les compter mesurerait un gabarit, pas ta voix.
  prefixes: ["✅ Redémarrage terminé", "🌱 Nouvelle session"],
  patterns: [/^(Moteur|Modèle)[^\n]{0,40}→/],
});

console.log(report.perMessageByDetector); // { "tiret-cadratin": 1.2, "gras-inline": 0.8, ... }
console.log(report.worst.slice(0, 5)); // les messages les plus chargés, à relire à la main
```

## Fenêtre temporelle : ce qui rend une mesure comparable à la précédente

Une fenêtre définie comme « les N derniers messages » se termine toujours *maintenant* : rejouer la
même commande le lendemain ne compare pas le même corpus, il a glissé. `selectWindow` fige des
bornes en epoch ms plutôt qu'un nombre de messages :

```ts
import { selectWindow, windowTruncated } from "./voice-audit.ts";

// Ce qui a été écrit DEPUIS une ligne de base :
const depuis = selectWindow(messages, { since: baselineTimestamp });

// Rejouer la ligne de base à l'identique (pour vérifier qu'un chiffre publié est reproductible) :
const base = selectWindow(messages, { until: baselineTimestamp });

// Si ta récupération est plafonnée (ex. 200 derniers messages), vérifie que la fenêtre demandée
// n'a pas été coupée avant son début — sinon un `since` trop ancien mesure un bout de fenêtre en
// se présentant comme la fenêtre entière.
if (windowTruncated(messages, { since: baselineTimestamp }, hitFetchLimit)) {
  console.warn("fenêtre potentiellement incomplète — élargis la récupération");
}
```

`auditCorpus` rend le taux **par 1000 caractères** ET **par message** — les deux ne racontent pas
la même histoire dès que la longueur moyenne des messages bouge (stable par caractère peut
coexister avec en hausse par message, si les messages rallongent).

## Pièges

- **Un chiffre faux est pire que pas de chiffre.** `resolveTics` fait crier une faute de frappe sur
  un nom de détecteur au lieu de rendre silencieusement 0 — une colonne à zéro se lit comme un tic
  éteint, pas comme une erreur de saisie.
- **Exclure les gabarits du daemon avant de mesurer**, sinon l'audit mesure en partie son propre
  système de notifications plutôt que la prose humaine qu'il prétend auditer. Si ton daemon
  fabrique aussi un compte-rendu de secours qui recopie une consigne interne sous ton nom (ça
  arrive : un rapport de tâche qui échoue et que le daemon résume lui-même), détecte-le à sa
  signature propre — un pattern dédié, pas un simple préfixe — et exclus-le de la même façon.
- Le trait d'union ordinaire (mot composé) n'est **pas** un tiret cadratin — seul `—` compte.
- Les regex de `cheville` utilisent des frontières Unicode explicites (`(?<![\p{L}\p{N}])`, pas
  `\b`) : `\b` en JavaScript est défini sur l'ASCII et ne s'ouvre pas devant une majuscule
  accentuée (« À noter que » en début de phrase serait invisible avec `\b`).
