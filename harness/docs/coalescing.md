# Coalescing — fusionner une rafale de messages en un seul réveil

## Le problème

Un humain qui écrit vite envoie souvent plusieurs messages courts d'affilée plutôt qu'un seul
message long (« attends » / « en fait » / « laisse tomber, plutôt X »). Sans traitement particulier,
chaque message déclenche son propre réveil de l'agent :

- coût multiplié (un réveil = un appel modèle, parfois cher) ;
- réponses fragmentées, parfois à un message déjà obsolète 2 secondes plus tard ;
- dans le pire cas, l'agent répond au message 1 pendant que le message 3 (qui change tout) est
  encore en train d'arriver.

## Le mécanisme

Deux leviers, tous deux à **latence bornée** (jamais plus que la fenêtre configurée) :

1. **Pendant un traitement en cours** : les messages suivants du même chat sont accumulés dans un
   buffer, puis fusionnés et versés dans la file dès que l'agent se libère — zéro délai ajouté, ils
   partent au tour suivant.
2. **Agent libre — fenêtre de grâce** (~2 s par défaut) : au premier message d'un chat, un timer
   s'arme. Tout ce qui arrive du même chat avant l'expiration du timer est fusionné en un seul
   évènement. Le timer n'est jamais réarmé « à zéro » à chaque nouveau message (ça retarderait sans
   fin une rafale continue) — sauf pour le signal d'attente ci-dessous.

Un **signal d'attente** (mot-clé configurable, ex. `att` pour « attends ») envoyé **seul** dans un
message rallonge la fenêtre à une durée plus longue (ex. 30 s) : l'humain signale qu'il n'a pas fini
d'écrire. Ce signal n'est **jamais transmis comme contenu** à l'agent — il ne fait que déclencher
l'attente, silencieusement.

## Code (extrait de `harness/src/lib/coalesce.ts`, générique et testable)

Le prédicat qui décide si un message est fusionnable :

```ts
export function isCoalesceable(ev: CoalesceEvent): boolean {
  return !!ev.chatId && !ev.voice && !ev.reaction && !ev.image && !ev.body.trim().startsWith("/");
}
```

Commandes (`/…`), vocaux, réactions et images ne sont **jamais** coalescés : ils sont traités seuls
et tout de suite, quel que soit l'état de la fenêtre.

Le signal d'attente : un message coalescçable dont le corps, une fois « trim » et mis en minuscules,
est *exactement* le token :

```ts
export function isWaitSignal(ev: CoalesceEvent, token: string): boolean {
  return isCoalesceable(ev) && ev.body.trim().toLowerCase() === token.toLowerCase();
}
```

La décision de routage à l'arrivée d'un évènement (pure, testable sans I/O) :

```ts
export function planEnqueue(
  ev: CoalesceEvent,
  opts: { processing: boolean; graceMs: number },
): "buffer" | "grace" | "dispatch" {
  if (!isCoalesceable(ev)) return "dispatch";
  if (opts.processing) return "buffer";
  if (opts.graceMs > 0) return "grace";
  return "dispatch";
}
```

Et l'orchestration (buffer + timer + file séquentielle) vit dans la classe `GraceCoalescer` du même
fichier — regarde son code, il est court et commenté pas à pas. Les tests
(`harness/src/lib/coalesce.test.ts`) utilisent des **timers réels avec des valeurs faibles**
(quelques dizaines de ms) plutôt que des mocks de temps : plus lent qu'un fake timer, mais ça
vérifie le comportement observable de bout en bout (une rafale envoyée = un seul traitement reçu),
pas seulement les prédicats purs.

## Points d'attention si tu adaptes ce mécanisme

- **Toujours grouper par identifiant de conversation** (`chatId` ou équivalent) : deux chats
  distincts ne doivent jamais se fusionner entre eux, même s'ils arrivent au même instant.
- La fenêtre de grâce doit rester **courte** (quelques secondes) : c'est un compromis entre
  « laisser le temps à une rafale de se compléter » et « ne pas faire attendre un humain qui a posé
  une question simple et unique ».
- Le signal d'attente doit être **un mot du quotidien, court, qu'on ne tape jamais par accident
  seul** dans un message — et surtout jamais réinjecté comme contenu réel : un utilisateur qui tape
  juste « att » ne veut pas que l'agent lui réponde « att ? je ne comprends pas ».
