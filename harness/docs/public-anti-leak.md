# Garde-fou anti-fuite repos publics — ne jamais pousser une donnée privée vers un repo public

## Le problème

Un agent qui touche à GitHub peut facilement pousser (ou merger une PR qui pousse) un fragment de
donnée privée vers un repo **public** : un identifiant WhatsApp en dur, une adresse email réelle,
un chemin d'hôte, un secret. Une fois public, c'est public — un `git push` n'a pas de « undo »
réel. Le risque est d'autant plus grand que l'agent écrit vite, souvent dans une session parallèle.

## Le mécanisme — deux verrous complémentaires

### 1. Preflight avant tout geste public (scan du contenu)

Avant de promettre, pousser ou merger quoi que ce soit vers un repo public, on scanne le contenu
contre deux listes de patterns :

- **littéraux privés exacts** (les numéros, emails, IDs, chemins d'hôte réels — plus la recherche
  est exacte, moins il y a de faux positifs) ;
- **patterns « mosaïque »** (des ancres faibles de catégories différentes qui co-occurrent —
  ex. un format de numéro + un nom de lieu) pour attraper les fuites indirectes.

Mode `--staged` / `--git-diff <base>` / `--tree <dir>` : on scanne ce qui va réellement partir, pas
tout le dépôt.

### 2. Guard au moment du merge (blindage mécanique, fail-closed)

Un hook (PreToolUse) intercepte l'outil `merge_pull_request` sur les repos publics connus. Il ne
suffit pas de croire la description de la PR : le hook va chercher le **vrai diff public**
(`https://github.com/{owner}/{repo}/pull/{n}.diff`, accessible sans auth sur un repo public) et le
scanne à l'instant du merge avec les mêmes règles. **Fail-closed** : si la récupération du diff
échoue, le merge est refusé. La vigilance humaine devient une vérification automatique plutôt que
de disparaître.

## Code — principes, à adapter à ton runtime

```ts
// Le hook (conceptuel) — à l'appel de merge_pull_request sur un repo public connu :
async function guardPublicMerge(tool, input, scanSources) {
  const diff = await fetch(`https://github.com/${owner}/${repo}/pull/${n}.diff`); // public, sans auth
  if (!diff.ok) return deny("diff irrécupérable — merge refusé (fail-closed)");
  const findings = scanSources(await diff.text()); // mêmes règles que le preflight
  if (findings.length > 0) return deny("donnée privée dans le diff public: " + findings.join(", "));
  return allow();
}
```

## Pièges

- **Ne jamais lever un blocage à l'aveugle** parce qu'on ne peut pas voir le diff depuis l'appel —
  aller chercher ce diff, même sans auth (le repo est déjà public).
- **Les variables d'environnement de contournement pour les tests doivent être hors de la voie de
  production** (une stub injectable, pas un flag de prod).
- Le critère « partageable » : une feature n'entre dans un repo public que si elle est générique
  (mécanique, pas la vie de quelqu'un), anonymisable sans perte de sens, et autonome (documentée
  sans présupposer l'historique de l'auteur).
