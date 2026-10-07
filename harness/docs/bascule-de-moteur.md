# Bascule automatique de moteur, et quand elle a le droit de contredire un épinglage

## Le problème

Un compagnon qui tourne en continu dépend d'un moteur LLM (un CLI d'agent, une API). Ce moteur
tombe de trois façons qui n'ont pas le même remède :

| Panne | Exemple | Se lève seule ? | Un autre moteur passerait ? |
|---|---|---|---|
| Limite du fournisseur | quota de session, 429, surcharge 529 | oui, à une heure souvent annoncée | oui |
| Aléa réseau | `ECONNRESET`, DNS, 503 | oui, vite | non, il hoquetterait pareil |
| Panne sans issue | OAuth expiré, 401/403, compte prépayé à zéro (402) | **jamais** sans geste humain | oui |

Sans bascule, une limite de fournisseur ou une auth morte rend l'agent muet : les réveils de fond
échouent en silence et l'humain ne s'en aperçoit qu'en écrivant, quand son message tombe dans le vide.

## Le mécanisme

`src/lib/engine-failover.ts` décide ; ton orchestrateur exécute. Sur l'échec d'un tour :

1. `shouldFailover(...)` répond oui seulement si l'erreur est une limite du fournisseur ou une panne
   sans issue, que le moteur qui a échoué est bien celui qui devait servir, et qu'aucun blocage
   anti-boucle n'est en cours.
2. Si oui, tu rejoues **le même tour** sur le moteur de secours, avec `failoverHeaderHint(...)` dans
   le prompt pour que la réponse annonce la bascule.
3. Le secours répond → `afterFailoverSucceeded(...)` : les tours suivants partent sur lui jusqu'à
   l'heure de retour annoncée par l'erreur (`parseRetryAfter`), 1 h par défaut, 6 h au plus.
4. Le secours échoue aussi → `afterFailoverFailed(...)` : plus de bascule pendant 30 min, tu retombes
   sur ton retry avec backoff habituel. Pas de ping-pong entre deux moteurs morts.
5. À l'expiration de la fenêtre, `resolveActiveEngine(...)` rend le moteur préféré. S'il répond,
   `afterEngineSucceeded(...)` efface l'état ; sinon un nouvel épisode commence. Aucun timer.

L'état passe par un magasin clé/valeur que tu fournis (`readFailoverState` / `writeFailoverState`) :
il doit survivre à un redémarrage du daemon, sinon un restart en plein épisode renvoie le tour
suivant sur le moteur mort.

## La règle qui vaut le module : l'épinglage et ses limites

Si ton humain a épinglé un moteur (`/model x`), la bascule ne le contredit pas sur un quota : il se
lèvera, et attendre ce moteur-là est un choix. Mais une auth morte ou un solde à zéro ne se lèvent
jamais seuls. Obéir à l'épinglage, là, revient à rendre l'agent muet jusqu'à ce que quelqu'un s'en
aperçoive, ce que personne ne demande en tapant `/model`.

D'où `isDeadEndError` : la seule famille d'erreurs qui passe outre un épinglage. Le tour suivant
retente quand même le moteur épinglé (un échec rapide, quelques secondes), donc l'épinglage reste vrai
et le retour est immédiat dès que la panne est réparée.

**Vécu en production**, deux fois avec la même forme : un épinglage oublié en base, puis une auth
morte dans la nuit (une fois), un compte prépayé vidé (l'autre fois). Plusieurs heures de réveils de
fond perdus alors que l'autre moteur, avec son auth indépendante, tournait très bien à côté.

## Pièges

- **La formule de quota la plus courante n'est pas la plus évidente.** « You've hit your session
  limit · resets 3am (UTC) » ne contient ni « usage limit » ni « 429 ». Sans motif dédié, le quota le
  plus banal se classe « erreur inconnue » : ni retry, ni bascule. Teste tes motifs sur les messages
  bruts que ton moteur renvoie vraiment, pas sur ceux de sa doc.
- **« token expired » est un faux ami** (fenêtre de contexte) : `isAuthError` exclut les messages qui
  parlent de contexte ou de `max_tokens`.
- **Un id de session ne traverse pas les moteurs.** Reprendre le fil d'un CLI avec l'id d'un autre
  échoue. `engineSessionKey(scope, engine, preferred)` garde un fil par moteur ; le préféré conserve
  la clé historique pour n'imposer aucune migration.
- **Une erreur peut arriver dans un succès.** Certains fournisseurs renvoient leur 429 dans le texte
  d'une réponse sortie proprement (code 0). Si ton moteur fait ça, passe aussi la sortie courte d'un
  tour réussi à `isTransientError` avant de la livrer comme réponse.

## Brancher

```ts
import {
  readFailoverState, writeFailoverState, resolveActiveEngine, shouldFailover,
  afterFailoverSucceeded, afterFailoverFailed, afterEngineSucceeded, failoverHeaderHint,
} from "./lib/engine-failover.ts";

const PREFERRED = "primary", FALLBACK = "secondary";

async function runTurn(prompt: string, pinned: string | null) {
  const now = Date.now();
  const state = readFailoverState(store);
  const { engine } = resolveActiveEngine({ pinned, state, preferred: PREFERRED, nowMs: now });
  try {
    const out = await runEngine(engine, prompt);
    writeFailoverState(store, afterEngineSucceeded(engine, state, PREFERRED));
    return out;
  } catch (e) {
    const msg = String((e as Error).message ?? e);
    const fallback = engine === PREFERRED ? FALLBACK : PREFERRED;
    if (!shouldFailover({ failedEngine: engine, fallback, errorMessage: msg, pinned, preferred: PREFERRED, state, nowMs: now, enabled: true })) throw e;
    try {
      const out = await runEngine(fallback, failoverHeaderHint(engine, fallback) + "\n\n" + prompt);
      writeFailoverState(store, afterFailoverSucceeded(msg, now, fallback));
      return out;
    } catch (e2) {
      writeFailoverState(store, afterFailoverFailed(now));
      throw e2; // ton retry avec backoff prend le relais
    }
  }
}
```

`store` est n'importe quoi qui offre `get(key)` / `set(key, value)` : une table `settings` SQLite,
un fichier JSON.
