# Le piège des mentions WhatsApp : texte "@..." ≠ vraie mention

Piège vérifié en pratique, du genre qui fait perdre une soirée : taper `@33600000000` dans le
texte d'un message WhatsApp **n'est pas une mention**. Ça ressemble à une mention, ça s'affiche
comme du texte contenant un `@`, mais WhatsApp ne notifie pas le contact tagué, ne le surligne
pas, et aucune vraie mention n'est enregistrée côté serveur. Une vraie mention WhatsApp est une
**structure de données séparée du texte affiché** : une liste d'identifiants explicitement
mentionnés, envoyée à côté du corps du message.

## Le piège précis : le wrapper MCP `send-text` ne le fait pas

Si ton agent envoie ses messages WhatsApp via un serveur MCP standard (type WAHA-MCP ou
équivalent), l'outil `send-text` typique n'expose souvent **aucun champ `mentions`** dans son
schéma — seulement `chatId` et `text` (et parfois `session`). Résultat : si l'agent tape
`@33600000000` dans le texte via ce wrapper, le message part bien, le texte contient bien
`@33600000000`... mais **c'est du texte brut**. Pas de notification, pas de surlignage, pas de
mention structurée pour le destinataire. L'agent (et l'humain qui le lit dans les logs) peut
légitimement croire que la mention a fonctionné, puisque le texte est correct — c'est justement ce
qui rend le piège sournois.

**Vérifie toujours le schéma exact de ton wrapper MCP avant de supposer qu'il gère les mentions.**
Certains le font (champ `mentions` accepté), d'autres non — et l'absence du champ ne lève aucune
erreur : le texte part quand même, silencieusement dégradé en simple `@texte`.

## La vraie mention : appel direct à l'API, avec un champ `mentions`

Pour poser une vraie mention structurée, il faut appeler directement l'API de la passerelle
WhatsApp (WAHA ou équivalent) — pas via le wrapper MCP — avec un payload qui inclut explicitement
le champ des identifiants mentionnés :

```
POST {WAHA_BASE_URL}/api/sendText
Content-Type: application/json
X-Api-Key: <ta clé, si configurée>

{
  "session": "<nom de la session WhatsApp>",
  "chatId": "<id du groupe ou du chat>@g.us",
  "text": "Hey @33600000000, tu peux jeter un œil ?",
  "mentions": ["33600000000@c.us"]
}
```

Points importants :

- Le champ `mentions` attend une **liste d'identifiants au format complet de la messagerie**
  (ex. `<numéro>@c.us` pour un contact individuel), pas juste le numéro brut.
- Le texte affiché (`text`) doit quand même contenir `@<numéro>` pour que WhatsApp sache où
  positionner le surlignage dans le rendu — le champ `mentions` seul, sans le `@numéro` dans le
  texte, ne suffit pas à produire un rendu correct côté client.
- Cet appel direct contourne le wrapper MCP : fais-le depuis ton propre code (fetch natif, ou tout
  client HTTP), pas depuis l'outil MCP `send-text` s'il n'expose pas ce champ.

Exemple générique en TypeScript (`fetch` natif, sans dépendance), à adapter à ta config :

```ts
interface Config {
  wahaBaseUrl: string;
  wahaApiKey?: string;
}

/** Envoie un texte AVEC une vraie mention structurée (contourne le wrapper MCP send-text, qui
 *  n'expose généralement pas de champ `mentions`). Renvoie la liste des ids réellement mentionnés
 *  selon la réponse de l'API — vide si la mention n'a PAS pris (cf. section "test observable"). */
async function sendTextWithMention(
  cfg: Config,
  session: string,
  chatId: string,
  text: string,
  mentionIds: string[], // ex. ["33600000000@c.us"]
): Promise<string[]> {
  const res = await fetch(`${cfg.wahaBaseUrl}/api/sendText`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(cfg.wahaApiKey ? { "X-Api-Key": cfg.wahaApiKey } : {}),
    },
    body: JSON.stringify({ session, chatId, text, mentions: mentionIds }),
  });
  if (!res.ok) {
    throw new Error(`sendText ${res.status} : ${(await res.text()).slice(0, 300)}`);
  }
  const j: any = await res.json();
  // Forme défensive : la clé exacte varie selon la version de la passerelle.
  const list: unknown = j?.mentionedJidList ?? j?._data?.mentionedJidList;
  return Array.isArray(list) ? list.filter((x): x is string => typeof x === "string") : [];
}
```

## Le test observable : `mentionedJidList` non vide

Ne te fie pas au fait que l'appel HTTP renvoie `200 OK` — ça veut seulement dire que le message
est parti, texte ou pas. **La preuve qu'une vraie mention a été posée est un champ
`mentionedJidList` (ou équivalent selon la version de ta passerelle) NON VIDE dans la réponse de
l'API**, contenant les identifiants effectivement mentionnés. Si ce champ est absent ou vide alors
que tu as passé un `mentions: [...]` non vide en entrée, quelque chose s'est mal passé (format
d'id incorrect, wrapper qui ignore le champ, version d'API qui ne le supporte pas) — le message
est probablement parti en texte brut, comme dans le piège ci-dessus.

En résumé : `text` contenant `@numéro` = **rien ne garantit une vraie mention**. Réponse API avec
`mentionedJidList` non vide = **preuve qu'elle a fonctionné**. Vérifie toujours la seconde
condition avant de considérer qu'une mention est passée, surtout si tu passes par une couche
d'abstraction (wrapper MCP, SDK tiers) dont tu n'as pas lu le schéma exact.
