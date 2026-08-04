# Routeur pré-vol — choisir modèle et effort par message, pas une fois pour toutes

## Le problème

Un compagnon qui tourne en continu reçoit des messages de nature très différente : un « ok » ou un
emoji, une question factuelle courte, et de temps en temps une vraie tâche (du code à auditer, une
décision à peser, un sujet sensible). Fixer **un seul** couple {modèle, effort de réflexion} pour
tout traiter est toujours un mauvais compromis :

- un modèle capable + effort élevé **partout** → lent et cher sur 90 % des messages, qui sont
  triviaux ;
- un modèle léger + effort bas **partout** → sous-doté dès que le message compte vraiment.

Le routeur pré-vol résout ça en décidant, **message par message**, quel modèle et quel effort
utiliser pour la session qui va vraiment traiter ce message — sans que l'humain ait à y penser à
chaque fois, et sans que l'agent doive s'auto-limiter après coup.

## Le mécanisme

Avant de lancer la session complète, un **appel éclair à un modèle léger** (le moins cher/rapide de
la gamme) lit le message et rend une décision `{model, effort, reason}` sous forme de JSON strict.
Cette décision n'est retenue que si elle passe une **allowlist** (modèle et effort connus) — sinon,
repli silencieux sur le défaut sûr. Le prompt de classification est volontairement conservateur :
« en cas de doute, monte en gamme » — un routeur qui économise sur une tâche difficile coûte plus
cher qu'il ne rapporte.

Trois garde-fous font que ce mécanisme reste invisible quand tout va bien et inoffensif quand ça
casse :

1. **Le pilotage manuel prime toujours.** Voir « pin vs auto » ci-dessous.
2. **Toute panne du routeur (timeout, erreur, sortie invalide) → repli sur le comportement par
   défaut**, jamais de réveil bloqué ou retardé au-delà d'un timeout borné.
3. **Un cliquet de gamme (ratchet)** empêche un message trivial de faire retomber une conversation
   en plein chantier : une fois monté sur un fil, le plancher {modèle, effort} posé ne redescend pas
   tant que le fil reste actif dans une fenêtre d'inactivité glissante (45 minutes par défaut) — sauf
   si l'humain, lui, redescend explicitement via `/model`/`/effort`.

## Pin vs auto — la distinction centrale

Le routeur ne route **que les champs en mode auto**. Dès que l'humain tape une commande explicite,
le champ concerné devient **épinglé** (« pin ») : il garde cette valeur, message après message,
jusqu'à ce qu'elle soit relâchée à la main. Le point subtil : `model`/`effort` ont toujours *une*
valeur en mémoire, donc la valeur seule ne suffit pas à dire si elle a été choisie par l'humain ou
si c'est le défaut. C'est une **sentinelle** qui tranche (chaîne vide pour le modèle, `"auto"` pour
l'effort) — jamais visible de l'humain, mais ce qui permet à `/status` d'afficher honnêtement la
source du choix courant :

- **routeur** : les deux champs en auto, le routeur décide à chaque message ;
- **épinglé** : les deux champs fixés à la main ;
- **mixte** : l'un fixé, l'autre encore en auto.

## Les commandes de pilotage humain

| Commande | Effet |
|---|---|
| `/model <nom>` | Épingle le modèle à `<nom>` — le routeur ne le touche plus. |
| `/effort <niveau>` | Épingle l'effort (`low`\|`medium`\|`high`\|`xhigh`\|`max`) — idem. |
| `/model auto` (ou `/unpin`) | Relâche l'épinglage — le champ repasse en mode auto (routeur). |
| `/status` | Affiche le couple {modèle, effort} effectif et sa source (routeur/épinglé/mixte). |

Un pin ne porte que sur le champ visé : `/model opus` seul laisse l'effort en auto (le routeur
continue de le décider), et réciproquement. `/unpin` (ou `/model auto`) relâche tout.

## Exemple de dialogue

```
Humain : /model claude-sonnet-5
Agent  : ⊙ sonnet/auto · mixte
         Modèle épinglé sur claude-sonnet-5. L'effort reste en auto, je continue à l'ajuster
         message par message.

Humain : résume-moi ce fil en une phrase
Agent  : ⊙ sonnet/low · mixte
         [résumé...]

Humain : /unpin
Agent  : ⊙ sonnet/low · routeur
         Repassé en auto — je choisis à nouveau modèle et effort à chaque message.
```

## Points d'attention si tu adaptes ce mécanisme

- **La liste `ROUTE_MODELS`/`ROUTE_EFFORTS`** (dans `harness/src/lib/router.ts`) doit correspondre
  exactement à ce que ton moteur accepte réellement — une décision hors liste est silencieusement
  rejetée (repli), donc une liste désynchronisée revient à désactiver le routeur sans le savoir.
- **Le cliquet (`ratchet`) et le buffer de contexte roulant sont scopés** (`scopeId` dans
  `routeEngineOpts`) : passe l'identifiant réel du fil/canal dès que ton agent parle à plusieurs
  interlocuteurs, sinon leurs cliquets et contextes se mélangent.
- **`classifyRoute` lance un sous-process** vers le même binaire CLI que ta session principale, avec
  un cwd neutre (pas le dépôt-âme) et sans configuration d'outils — ce n'est qu'un classificateur, il
  n'a besoin d'aucun accès.
- Le pattern (routeur pré-vol + pin/auto + cliquet de gamme) vient à l'origine d'un agent en production ; le
  code ici est une version générique, autonome, sans dépendance à une base de données ou un moteur
  précis — voir `RouterStore`/`EngineOptions` dans `harness/src/lib/router.ts`.
