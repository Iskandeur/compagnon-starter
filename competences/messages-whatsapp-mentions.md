# WhatsApp — une vraie @-mention ne passe pas par le texte

**Le problème.** Taper `@<numéro>` (ou `@<id>`) directement dans le corps du texte n'est **pas**
une vraie mention : WhatsApp l'affiche en brut (`@33612345678`), illisible pour le destinataire.
Beaucoup de wrappers MCP autour de l'API d'envoi de texte (« send-text » ou équivalent) n'exposent
**aucun champ dédié aux mentions** — donc tout `@` tapé dans le texte part tel quel, sans que rien
ne prévienne de l'échec. C'est le genre de piège qui se reproduit plusieurs fois avant qu'on le
remarque, parce que rien ne casse : le message part, il a juste l'air cassé chez l'autre.

## La règle

Une vraie mention passe par le **champ dédié de l'API d'envoi** (une liste d'identifiants,
typiquement nommée `mentions` ou `mentionedIds`), jamais par le texte brut. Si l'outil que tu
utilises pour envoyer n'expose pas ce champ, deux options :
1. passer par l'appel API brut (endpoint HTTP direct plutôt que le wrapper simplifié) avec le
   champ mentions rempli ;
2. renoncer à la mention technique et nommer la personne par son prénom dans le texte.

**Réflexe avant d'envoyer** : si ton brouillon contient un `@` suivi d'un identifiant/numéro,
arrête-toi — ne l'envoie pas via l'outil « texte simple » sans vérifier qu'il supporte les
mentions.

## Le test observable

Ne te fie pas à « ça a l'air d'avoir marché » — vérifie la réponse de l'API d'envoi : si elle
contient une liste des identifiants effectivement mentionnés (non vide), la mention s'affichera
chez le destinataire ; si cette liste est vide, la mention ne s'affichera **pas**, même si le `@`
apparaît dans le texte envoyé. C'est la seule façon fiable de savoir si l'envoi a vraiment
fonctionné, avant que l'humain te le signale.

## Pourquoi documenter un truisme aussi « évident »

Connaître la règle et l'appliquer au moment d'écrire sont deux choses différentes : le réflexe par
défaut (l'outil texte simple) reste tentant précisément parce qu'il ne renvoie jamais d'erreur
explicite. Le seul filet qui tient dans la durée : un grep mental systématique du brouillon avant
envoi (« y a-t-il un `@` suivi de chiffres/identifiant ? »), pas la mémoire de la règle seule.
