# Catégoriser ton usage par sujet (`usage-topics.ts`)

**But.** Répondre à « sur quoi je passe le plus de temps avec mon compagnon ? » avec des chiffres,
pas une impression — en catégorisant chaque tour de `session_log` par SUJET (pas par canal).

**Quand l'utiliser.** Ton humain te demande une photo de ton usage (ex. répartition en camembert),
ou tu veux toi-même vérifier si ton activité dérive (trop de temps sur un sujet, pas assez sur un
autre…).

## Pourquoi `scope`/`source` ne suffisent pas

Ces colonnes de `session_log` disent **comment** un tour est arrivé (canal WhatsApp, job, veille,
réveil programmé…), jamais **de quoi** il parle. Deux tours `source=job` peuvent être deux sujets
complètement différents — seul `summary` (texte libre) porte le sujet.

## L'outil

```
node harness/bin/usage-topics.ts          # tableau lisible, barres ASCII
node harness/bin/usage-topics.ts --json   # {total, breakdown:[{key,label,count,pct}]}
```

Logique pure et testée dans `harness/src/lib/usage-topics.ts` (`TopicRule`, `categorizeSummary`,
`computeTopicBreakdown`) — CLI en lecture seule (`node:sqlite`, `resolveDbPath()`), aucune écriture.

## Comment ça catégorise

Règles **ordonnées** (la première qui matche gagne) contre le texte de `summary`. Le fichier fournit
`EXAMPLE_TOPIC_RULES` — un jeu d'exemple générique (`veille`, `infra`, `dev`, `agenda`, `perso`),
**pas une taxonomie prête à l'emploi** : les sujets réels d'un compagnon dépendent entièrement de ce
pour quoi son humain l'utilise. Deux catégories résiduelles complètent toujours la liste :
`conversation` (rien d'autre ne matche) et `sans_resume` (résumé vide ou absent).

## Écrire tes propres règles

1. Relis un échantillon de tes vrais résumés (`select summary from session_log order by last_seen
   desc limit 50`) — ne devine pas des mots-clés à l'aveugle, pars du texte réel.
2. Range tes règles du plus **spécifique** au plus **générique** : un résumé de job pour un projet
   précis peut ressembler à un job générique (`job #NN : Contexte : <projet>…`) — si tu as une
   catégorie dédiée pour ce projet, sa règle doit passer AVANT la règle générique `dev`, sinon elle
   se fait absorber.
3. Si une catégorie devient un fourre-tout qui grossit sans fin (souvent `conversation`), c'est le
   signal qu'une règle manque encore — ajoute-la plutôt que de laisser dériver.

## Brancher un dashboard

`usage-topics.ts --json` donne directement `{total, breakdown}` — consommable tel quel par un
graphique en camembert/donut côté dashboard, sans logique de calcul supplémentaire côté frontend.
