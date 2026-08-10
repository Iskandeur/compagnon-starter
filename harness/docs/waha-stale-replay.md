# Anti-rejeu webhook — ne pas répondre à un vieux message rejoué comme s'il était neuf

## Le problème

Un gateway de messagerie (WAHA pour WhatsApp, et la plupart des connecteurs du même genre) tamponne
`ts = Date.now()` — l'heure de **réception** — sur chaque évènement webhook, pas l'horodatage réel du
message. Quand le connecteur rejoue un vieux message (reconnexion de session, resync après un
restart, retry différé), le message traverse le pipeline avec l'heure du jour et l'agent y répond
comme si c'était neuf.

**Vécu en production (2026-08-08)** : trois vocaux vieux de 3 jours ont resurgi dans un groupe comme
s'ils venaient d'arriver. L'agent y a répondu une deuxième fois, sans reconnaître qu'il avait déjà
traité ce sujet — l'humain a dû signaler l'incohérence de timing.

## Le mécanisme

Deux horodatages, jamais confondus :

- **`msgTs`** — l'horodatage **réel** du message, tel que rapporté par le connecteur (champ
  `timestamp`/`t` du payload WAHA, en secondes). C'est une donnée, pas une construction.
- **`ts`** — l'heure de **réception** par le gateway.

Au moment d'enfiler l'évènement (avant toute autre décision de routage), on compare `ts - msgTs` :
au-delà d'une fenêtre (défaut **30 min** — large pour absorber un vrai retard de livraison, court
pour attraper un rejeu de plusieurs heures/jours), on **préfixe le corps d'un avertissement** au lieu
de le traiter comme neuf.

On ne supprime **jamais** le message : un message réellement retardé (téléphone hors réseau, file
d'attente) doit rester visible, juste correctement contextualisé. L'avertissement dit à l'agent de
vérifier l'historique réel avant de répondre — il garde la trace, il corrige l'interprétation.

## Code (`harness/src/lib/waha-stale-replay.ts`, générique et testable)

```ts
export function isStaleReplay(ev: WahaEvent, windowMs: number): boolean {
  if (!ev.msgTs) return false; // sans horodatage réel, rien à comparer — best-effort
  return ev.ts - ev.msgTs > windowMs;
}

export function annotateStaleWahaReplay<T extends WahaEvent>(ev: T, windowMs: number): T {
  if (ev.source !== "whatsapp" || !isStaleReplay(ev, windowMs)) return ev;
  const warning =
    `[⚠️ MESSAGE POTENTIELLEMENT PÉRIMÉ — horodatage réel il y a ${formatGap(ev.ts - ev.msgTs!)}. ` +
    `Probable rejeu du connecteur (reconnexion/resync), pas un message qui vient d'arriver. ...]`;
  return { ...ev, body: `${warning}\n\n${ev.body}` };
}
```

Branchement minimal côté gateway : appelle `annotateStaleWahaReplay` en toute première ligne de
l'enfilement, et utilise `ev.msgTs` (au lieu de `ev.ts`) pour l'horodatage affiché dans le prompt —
un vieux message rejoué doit montrer sa vraie date, pas celle du jour.

## Pièges

- **Ne pas mesurer la fraîcheur au moment du traitement** : un message frais qui attend dans la file
  derrière un long réveil « vieillit » et serait jeté à tort. Compare `ts - msgTs`, jamais
  `Date.now() - msgTs`.
- **Généraliser à TOUS les messages entrants**, pas seulement aux vocaux/transcriptions — le trou
  classique est un garde-fou posé sur un chemin (la transcription) qui ne couvre pas le chemin
  principal (les textes entrants).
- Sans `msgTs` connu (source interne, ou payload sans horodatage) : laisser passer (best-effort),
  ne jamais bloquer un réveil pour ça.
