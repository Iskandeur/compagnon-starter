# Stop par réaction — interrompre un raisonnement déjà lancé

**Module** : [`src/lib/turn-cancel.ts`](../src/lib/turn-cancel.ts) · **Tests** : `src/lib/turn-cancel.test.ts`

## Le problème

Un compagnon persistant traite un message en tâche longue : quelques dizaines de secondes à
plusieurs minutes de raisonnement. L'humain, lui, réalise deux secondes après avoir appuyé sur
envoyer qu'il s'est trompé de fichier, de personne, de question.

Il n'a alors aucun recours. Un « non attends, oublie » part derrière dans la file et sera donc traité
**après** le tour qu'il voulait annuler. Résultat : le calcul est payé jusqu'au bout, la réponse
arrive hors sujet, et il faut réécrire. La friction est petite mais elle se répète, et elle tombe
toujours au moment où la personne est déjà agacée contre elle-même.

## Le geste

Une **réaction emoji** (🛑 par défaut) sur **n'importe quel message du fil** — le sien comme un de
l'agent.

Ne pas exiger que la réaction vise le bon message est délibéré : dans l'urgence d'un « zut », viser
précisément est une friction de plus, exactement là où on cherche à en retirer une. Le fil entier est
la cible.

## L'endroit où le brancher, qui est tout l'enjeu

> La décision « ceci est un stop » se prend **synchroniquement à l'arrivée de l'évènement**, dans le
> chemin d'`enqueue` — jamais dans le handler qui traite la file.

Le handler ne s'exécute qu'une fois la lane libre, c'est-à-dire **après** le tour à tuer. Un stop
câblé là s'exécute trop tard et n'interrompt rien.

Ce mode de panne est particulièrement traître parce que tout a l'air de fonctionner : les tests
unitaires passent, l'accusé de réception part, l'humain voit sa confirmation. Seul le tour continue
de tourner en arrière-plan. C'est la raison pour laquelle ce module est **pur** — aucune I/O, aucun
accès base — afin d'être appelable depuis le chemin synchrone du webhook sans rien attendre.

## Le périmètre, et pourquoi chaque restriction existe

| Restriction | Ce qu'elle empêche |
|---|---|
| Un seul transport (`source`) | Un évènement d'un autre canal qui aurait le même emoji. |
| Canaux autorisés (`allowedChannels`) | Un ordre venu d'un canal en lecture seule, ou d'un canal inconnu. |
| Auteur = humain principal | Un tiers dans un groupe qui couperait la parole à l'agent. |
| `fromMe` exclu | **L'auto-interruption.** Si l'agent pose lui-même des réactions d'accusé (👀, ✅…), elles remontent par le même webhook. Sans ce test, l'agent s'interrompt tout seul. |
| Emoji vide = éteint | Permet de désactiver la fonctionnalité par configuration, sans retirer le câblage. |

⚠️ **Choisis un emoji qui ne sert à rien d'autre chez toi.** Si le même symbole valide par ailleurs
une action sensible ou déclenche un traitement, le geste d'urgence devient ambigu précisément le jour
où il ne doit pas l'être.

## Les deux moitiés de l'exécution

Le module décide et formule ; l'orchestrateur exécute. Deux choses à câbler, et oublier la seconde
annule le bénéfice de la première :

1. **Tuer le tour** : `cancelledTurnError(emoji)` posé comme `reason` d'un `AbortController`, plus
   le vidage de ce qui attendait dans la file pour ce chat. Ce qui a été abandonné doit être
   **acquitté** côté source, sinon il sera rejoué au prochain démarrage et l'annulation sera défaite.
2. **Ne pas confondre avec une panne** : `isCancelledTurn(err)` doit court-circuiter tout le
   protocole d'échec — pas de réessai, pas de bascule vers un moteur de secours, pas d'alerte. Sans
   ce test, l'agent relance exactement le calcul qu'on venait d'annuler.

Le marqueur est un **drapeau sur l'objet erreur**, pas son texte : un message traverse des couches
qui le tronquent ou le reformatent, un drapeau survit.

## Toujours accuser réception

`cancelConfirmationText()` répond dans les trois cas, y compris « rien à interrompre ». Un silence
laisse l'humain dans le doute sur l'arrivée de son stop : il réagit une deuxième fois, ou renvoie son
message en double. Le cas où le stop n'a rien trouvé mérite sa phrase autant que celui où il a mordu.

## Adapter

- `DEFAULT_CANCEL_REACT_EMOJI` — l'emoji ; le rendre configurable par variable d'environnement.
- `isCancelTurnReaction(ev, { emoji, isPrincipalAuthor, source?, allowedChannels? })` — le prédicat.
  `isPrincipalAuthor` est calculé par l'appelant : en 1:1 l'auteur est le chat, en groupe c'est
  l'expéditeur réel de la réaction, qui n'est pas le chat.
- Le texte de confirmation utilise le gras à astérisque simple des messageries grand public. Adapte
  au rendu de ton transport.
