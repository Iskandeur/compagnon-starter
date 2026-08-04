# Continuité bornée en groupe (« ping-pong ») — pourquoi et comment

## Le problème que ça règle

Un agent always-on dans un groupe WhatsApp ne doit, par défaut, se réveiller QUE s'il est
explicitement adressé (nommé ou mentionné — cf. `mention-wake.ts`). C'est le bon défaut pour
éviter de répondre à des messages qui ne lui sont pas destinés. Mais dans un groupe où un vrai
échange se joue à plusieurs tours — surtout s'il y a **un autre agent** dans le groupe (le
compagnon d'un proche, par exemple) — ce défaut devient vite pénible : dès que l'autre partie
répond sans redire le nom de l'agent, le fil retombe, et il faut le re-taguer à chaque message
pour continuer la conversation.

La continuité bornée règle ça : une fois l'agent nommé/mentionné une première fois, il reste
« dans l'échange » pendant un nombre de tours limité, sans qu'on ait besoin de le renommer à
chaque message.

## Le piège à ne jamais rater : le ping-pong infini

**Deux agents always-on dans le même groupe, sans plafond, peuvent se répondre l'un à l'autre
indéfiniment.** Le scénario est simple et bête :

1. Ton humain nomme ton agent dans un groupe où le compagnon d'un proche est aussi présent.
2. Ton agent répond. Le compagnon du proche, qui a lui aussi une continuité activée, considère que
   ce message d'un tiers (ton agent) le concerne et répond à son tour.
3. Ton agent reçoit ce nouveau message, considère qu'IL est dans une continuité active, et répond
   encore.
4. Retour à l'étape 2 — **indéfiniment**, tant que personne n'intervient.

Sans plafond, c'est une boucle de coûts (chaque tour est un appel IA) et de spam (le groupe se
remplit de messages) qui ne s'arrête que si un humain la coupe manuellement — et encore faut-il
qu'il s'en aperçoive à temps. C'est pour ça que la continuité N'EST JAMAIS illimitée dans ce
module : elle est **strictement bornée par un budget de tours** (`maxTurns`, cf.
`lib/pingpong.ts`), et **un humain garde toujours la main** pour la couper à tout moment, quel que
soit l'état du budget.

## Le modèle (`lib/pingpong.ts`)

- **Nommé/mentionné** → réveil, et le budget est RECHARGÉ à `maxTurns` (par défaut 6). C'est le
  seul déclencheur qui *ouvre* ou *relance* la fenêtre — la continuité ne s'arme jamais sur la
  seule initiative de l'agent.
- **Continuité désactivée** (`enabled: false`) → pas de réveil hors nommage explicite : retour au
  comportement strict « nommé seulement ».
- **Budget > 0, pas nommé** → réveil, budget décrémenté de 1. C'est le ping-pong : l'agent reste
  dans l'échange sans qu'on le renomme.
- **Budget épuisé, pas nommé** → pas de réveil. L'agent se tait jusqu'à être renommé.

`decideGroupWake(named, state)` est une fonction PURE : elle ne fait aucune I/O, elle prend l'état
courant et renvoie la décision + le nouvel état. Toute la persistance (lecture/écriture du budget)
passe par les interfaces `PingPongStore` / `PingPongWriter`, à brancher sur ta propre couche de
stockage (SQLite, fichier JSON...).

## Coupure humaine explicite

Prévois une commande de pilotage (ex. `/pingpong off`, `/pingpong stop`, `/pingpong <N>` pour
changer le plafond) qui, au minimum :

- peut désactiver la continuité (`enabled = false`) à tout moment ;
- peut remettre le budget à 0 immédiatement (`setPingPongRemaining(store, 0)`), pour couper un
  échange en cours sans attendre qu'il s'épuise tout seul.

C'est le filet de sécurité humain par-dessus le plafond automatique : le plafond protège contre
l'oubli (personne ne regarde le groupe), la commande protège contre l'imprévu (un échange qui part
dans une direction indésirable avant d'avoir consommé tout son budget).

## Brancher `pingpong.ts` dans le routage des messages entrants

Dans la fonction qui traite un message entrant de groupe, typiquement :

```ts
import { isAddressedByMention } from "./lib/mention-wake.ts";
import { decideGroupWake, readPingPong, setPingPongRemaining } from "./lib/pingpong.ts";

// ev = message entrant déjà normalisé ; store = ta couche de persistance (settings clé/valeur)
if (ev.isGroup) {
  const named = isAddressedByMention({
    body: ev.body,
    agentName: config.agentName,
    agentIds: config.agentSelfIds,
    mentionedIds: ev.mentionedIds, // cf. mentions-whatsapp-piege.md pour l'obtenir correctement
  }).addressed;

  if (groupHasContinuityUnlocked(ev.chatId)) {
    // Groupe où la continuité bornée est activée (ex. un groupe multi-agents de confiance).
    const decision = decideGroupWake(named, readPingPong(store));
    setPingPongRemaining(store, decision.remaining);
    if (!decision.wake) return; // budget épuisé ou continuité off → silence
    // decision.reason (« nommé » / « continuité » / « budget épuisé » / « continuité off »)
    // est utile à logguer pour comprendre après coup pourquoi l'agent a (ou n'a pas) répondu.
  } else if (!named) {
    return; // groupe « strict » par défaut : pas nommé → pas de réveil
  }
}
// ... réveil de l'agent avec ev
```

Points d'attention :

- **Filtre les messages que l'agent envoie lui-même AVANT d'arriver ici.** Ce module suppose que
  seuls des messages de TIERS consomment le budget — sinon la protection contre le ping-pong
  infini ne sert à rien (l'agent consommerait son propre budget sur ses propres messages).
- **Active la continuité seulement dans les groupes où c'est explicitement voulu** (whitelist par
  `chatId`), pas partout par défaut — c'est un mécanisme puissant, à réserver aux groupes de
  confiance où le fil à plusieurs tours a un intérêt réel.
- **Le budget est volontairement simple** dans cette implémentation (un seul état global, pas un
  budget par groupe) : c'est un choix conservateur, à faire évoluer vers un budget par `chatId` si
  tu déverrouilles la continuité dans plusieurs groupes à la fois.
