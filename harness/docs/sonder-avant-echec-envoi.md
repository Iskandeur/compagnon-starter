# Sonder avant de déclarer un envoi en échec — un 5xx ne prouve pas que rien n'est parti

## Le problème

Un gateway de messagerie qui pilote un client web (WAHA pour WhatsApp, et la plupart des connecteurs
du même genre) peut répondre une erreur serveur **après** avoir livré le message. L'échec porte sur la
lecture du reçu (l'objet qui porte l'id du message, perdu côté navigateur avant d'être lu), pas sur
l'envoi lui-même.

Un agent qui traite cette erreur comme un échec relance l'envoi, et son humain reçoit le même message
deux fois.

**Vécu en production** : un `HTTP 500` avec une erreur de protocole du navigateur (« Promise was
collected ») sur un message déjà livré. L'agent a relancé onze secondes plus tard ; le message est
arrivé en double.

## Le mécanisme

Sur une réponse d'envoi en erreur :

- **4xx** (session inexistante, destinataire invalide, corps refusé) : la requête a été refusée avant
  l'envoi. Rien n'est parti, on lève tout de suite.
- **5xx** : on ne sait pas. On **relit les derniers messages du fil** (une lecture, ~10 messages) et on
  cherche un message envoyé par l'agent (`fromMe`), au corps **strictement identique**, horodaté dans
  une fenêtre courte (défaut 2 min, dans les deux sens pour tolérer l'écart d'horloge).
  - Trouvé : l'envoi a réussi. On renvoie son id et on ne relance pas.
  - Pas trouvé, ou la sonde elle-même échoue : on lève **l'erreur d'origine**, inchangée.

## Pourquoi ces choix

- **Égalité stricte du corps.** Un faux négatif coûte un doublon (le comportement d'avant). Un faux
  positif coûterait un message jamais envoyé que l'agent croirait parti, ce qui est bien pire. Dans le
  doute, on ne trouve rien.
- **La sonde ne fait jamais échouer plus que l'erreur d'origine.** Si elle plante, c'est l'erreur
  d'envoi qui remonte, pas celle de la sonde.
- **La sonde est une lecture.** Elle ne passe pas par le coupe-circuit anti-flood des envois et ne
  consomme aucun quota d'envoi.

## Brancher

`src/lib/send-probe.ts` est pur : tu fournis l'envoi et la lecture du fil.

```ts
import { pickRecentOwnMessage, sendWithProbe } from "./lib/send-probe.ts";

const id = await sendWithProbe({
  send: async () => {
    const res = await fetch(`${base}/api/sendText`, { method: "POST", headers, body: JSON.stringify({ session, chatId, text }) });
    if (res.ok) { const j: any = await res.json(); return { ok: true, status: res.status, id: j?.id?._serialized ?? null }; }
    return { ok: false, status: res.status, errorText: await res.text() };
  },
  probe: async () => {
    const res = await fetch(`${base}/api/${session}/chats/${encodeURIComponent(chatId)}/messages?limit=10&downloadMedia=false`, { headers });
    if (!res.ok) throw new Error(`lecture du fil ${res.status}`);
    return pickRecentOwnMessage(await res.json(), text, Date.now(), 120_000);
  },
});
```

Pour un autre connecteur, adapte seulement `pickRecentOwnMessage` à la forme de ses messages
(`fromMe`, corps, horodatage en secondes, id).
