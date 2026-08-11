# Veille de modèles LLM via Artificial Analysis — benchmarks indépendants, gratuits

## Le problème

Savoir « quel modèle utiliser pour quoi » se décide vite sur des impressions ou du bouche-à-oreille.
[Artificial Analysis](https://artificialanalysis.ai) publie des benchmarks indépendants (indices
composites intelligence/coding/agentic, prix par million de tokens, débit, latence) pour la plupart
des modèles du marché — et une API **gratuite** (free tier) qui les expose sans scraping.

## L'idée

Un client pur (`harness/src/lib/artificial-analysis.ts`) qui télécharge la liste des modèles,
calcule un **ratio qualité/prix** (indice d'intelligence ÷ prix mélangé in/out) et classe un modèle
comme « notable » selon deux portes :
- **frontier** : indice ≥ un seuil haut (le peloton de tête, indépendamment du prix) ;
- **valeur** : indice ≥ un plancher de « capable » ET ratio qualité/prix élevé (le pattern
  « DeepSeek Flash » — capacités proches du sommet pour une fraction du prix des ténors).

Les fonctions de calcul (`blendedPrice`, `valueRatio`, `isNotable`, `sortByIntelligence`,
`sortByValue`, `releasedWithin`) sont pures et testées séparément du fetch réseau — aucune n'a
besoin d'un vrai appel API pour être vérifiée.

## Contrainte à connaître : le quota

Le free tier limite à **100 requêtes/jour** (lu sur les headers `X-RateLimit-*` de chaque réponse).
Une veille tient largement dans ce budget (~3 requêtes par scan pour les 3 pages du free tier), mais
seulement si elle tourne **au plus quotidiennement** — jamais sur un cycle de quelques minutes comme
une veille d'actualités classique. `fetchAllLanguageModels()` remonte le quota restant pour qu'un
appelant puisse l'afficher ou décider de ralentir.

## Pattern de veille recommandé : seed puis ack

Comme pour toute veille « nouveautés », le premier run ne doit **pas** annoncer tout le catalogue
existant comme nouveau — sinon le premier réveil liste des dizaines de modèles déjà connus depuis
longtemps. Le geste :

1. **1er run (état absent)** : enregistrer (« seed ») tous les modèles déjà notables et récents dans
   un registre `seen` (slug → date), **sans déclencher d'alerte**.
2. **Runs suivants** : `diffAaModels(models, seen, now)` renvoie uniquement les modèles notables,
   sortis dans la fenêtre récente (`NEW_RELEASE_WINDOW_DAYS`, 45 jours par défaut) et **absents** de
   `seen` — c'est la vraie nouveauté à signaler.
3. Le registre `seen` n'est mis à jour qu'après que l'alerte a été **traitée** (lue, jugée, éventuel-
   lement transmise) — pas automatiquement à chaque scan. Ça évite qu'un scan raté ou une session
   interrompue avale silencieusement une nouveauté jamais vue par l'humain.

```ts
import { fetchAllLanguageModels, diffAaModels, isNotable } from "./artificial-analysis.ts";

const { models } = await fetchAllLanguageModels();

// 1er run : seed sans alerter
if (seenState === undefined) {
  const seeded = {};
  for (const m of models) if (m.releaseDate && isNotable(m)) seeded[m.slug] = new Date().toISOString();
  saveState({ seen: seeded });
} else {
  const fresh = diffAaModels(models, seenState.seen, Date.now());
  if (fresh.length > 0) {
    // alerter, PUIS seulement ensuite marquer ces slugs comme vus
  }
}
```

## Configuration

- Clé API dans la variable d'environnement `ARTIFICIAL_ANALYSIS_API_KEY` (`.env`) — récupérable
  gratuitement sur artificialanalysis.ai.
- Aucune autre dépendance : `fetch` natif, zéro paquet npm.

## Pièges

- **Ne pas dépasser le quota par curiosité.** Chaque invocation manuelle (CLI, debug) coûte 3
  requêtes sur les 100/jour — éviter les boucles d'essai rapprochées pendant le développement.
- **`releaseDate` peut être `null`** (modèle sans date connue côté Artificial Analysis) — ces
  modèles sont exclus de `releasedWithin`/`diffAaModels` par construction (impossible de dire s'ils
  sont « récents »), pas un bug si un modèle attendu n'apparaît jamais dans la veille.
- Le free tier n'expose pas tout (context window, percentiles, liste des providers — réservés au
  tier payant) : ne pas construire une feature qui suppose ces champs présents.
