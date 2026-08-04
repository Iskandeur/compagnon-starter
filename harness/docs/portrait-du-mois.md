# Le portrait du mois

> ⚠️ **Avant toute chose : le piège du quota gratuit.** Beaucoup de providers d'API image ont un
> « free tier » qui accepte les requêtes sans erreur claire, mais dont le quota réel de
> générations d'images est **zéro**. L'échec est silencieux (réponse vide, ou un statut HTTP qui
> ne dit rien d'utile) — pas un message du style « quota dépassé ». Si `harness/bin/portrait.ts`
> échoue de façon mystérieuse, vérifie **en premier** que ta clé (`IMAGE_API_KEY`) est bien une
> clé **payante**, avant de chercher un bug dans le code. Ça a coûté une soirée de debug la
> première fois — ne la reperds pas.

## Le rituel

Le 1er de chaque mois, l'agent génère une image qui résume le mois écoulé, l'archive, et la
partage avec son humain. C'est un petit rituel de mémoire : un « portrait » visuel qui marque le
temps qui passe, à relire dans un an.

Ce pattern vient à l'origine d'un agent en production — repris ici sous une forme générique, à adapter.

## Plomberie vs âme

C'est la distinction qui compte le plus dans ce rituel :

- **La plomberie** (`harness/bin/portrait.ts`) : lire le prompt, appeler une API de génération
  d'image, archiver le PNG et le prompt qui l'a produit dans `data/portraits/`, notifier. Du code
  mécanique, sans jugement créatif.
- **L'âme** : composer le prompt lui-même. Ça, c'est le travail de l'agent, fait à la main (ou en
  conversation avec son humain) **au réveil du 1er, avant de lancer le script** — relire son mois
  (journal, mémoire), choisir ce qui compte vraiment, et l'écrire en un texte qui a du sens comme
  prompt d'image. Le script ne fait jamais ce travail à ta place : si tu le laisses générer un
  prompt tout seul à partir d'une concaténation brute du journal (le mode fallback, voir plus
  bas), tu obtiens une image qui illustre une liste de courses, pas un portrait.

Concrètement, le déroulé du 1er :

1. L'agent relit son mois (`journal/AAAA-MM-*.md`, `memoire/` si pertinent).
2. L'agent rédige un prompt d'image : ce qu'il retient, l'ambiance, les symboles qui comptent.
3. L'agent sauvegarde ce prompt dans un fichier (ex. `data/portrait-prompt.txt`).
4. L'agent (ou un réveil programmé) lance :
   ```
   node harness/bin/portrait.ts --prompt-file data/portrait-prompt.txt
   ```
5. Le script appelle l'API image, archive `data/portraits/AAAA-MM.png` et
   `data/portraits/AAAA-MM.prompt.txt`, puis notifie (si `PORTRAIT_WEBHOOK_URL` est configuré).

## Brancher un réveil programmé mensuel

Ce starter ne présume d'aucun scheduler particulier — branche celui que tu as :

- **Un scheduler de daemon** (si ton corps en a un) : programme un réveil le 1er de chaque mois.
  À ce réveil, l'agent doit d'abord faire le travail de rédaction (l'âme, étapes 1-3 ci-dessus)
  **en conversation avec lui-même**, puis lancer le script (étape 4). Ne programme jamais
  directement l'exécution du script seul : sans prompt rédigé à la main, tu retombes dans le mode
  fallback dégradé.
- **cron / systemd timer**, si tu préfères une approche purement infra : le job programmé peut
  invoquer `claude` (ou l'équivalent que tu utilises) avec une instruction du type « c'est le 1er,
  fais ton portrait du mois », en lui laissant la main pour rédiger le prompt puis lancer le
  script lui-même — plutôt que d'appeler `portrait.ts` directement.

## Variables d'environnement

| Variable               | Rôle                                                                 |
|-------------------------|-----------------------------------------------------------------------|
| `IMAGE_API_URL`         | Endpoint HTTP du provider de génération d'image choisi.              |
| `IMAGE_API_KEY`         | Sa clé — **doit être une clé payante** (voir le piège en haut).      |
| `PORTRAIT_WEBHOOK_URL`  | Optionnel. Si défini, un POST JSON `{ month, path }` y est envoyé une fois l'image archivée — branche ton propre canal de notification derrière (WhatsApp, Telegram, email...). |

## Options du script

```
node harness/bin/portrait.ts --prompt-file <fichier>   # prompt rédigé à la main (recommandé)
node harness/bin/portrait.ts --prompt "..."             # prompt en ligne de commande
node harness/bin/portrait.ts --month 2026-07             # mois explicite (sinon: mois courant)
node harness/bin/portrait.ts --no-send                   # génère et archive sans notifier
```

Sans `--prompt` ni `--prompt-file`, le script retombe sur un mode dégradé : il concatène
brutalement les fichiers `journal/AAAA-MM-*.md` du mois comme prompt. C'est utile pour tester la
plomberie sans avoir encore rédigé de prompt, mais ce n'est **pas** le rituel complet — voir
« Plomberie vs âme » plus haut.

## Format de réponse de l'API image

Le format de requête/réponse dépend entièrement du provider branché derrière `IMAGE_API_URL`. Le
script envoie `{ prompt: "..." }` en JSON et essaie de lire l'image en base64 à trois endroits
courants dans la réponse (`image`, `data[0].b64_json`, ou la forme `candidates[].content.parts[]`
façon Gemini generateContent — c'est le provider qu'utilisait la version originale de ce script).
Si ton provider répond avec une autre forme, adapte l'extraction dans `generateImage()`.
