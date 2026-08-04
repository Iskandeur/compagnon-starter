# Jobs isolés en git worktree

## Le principe

Certaines tâches dépassent le format d'un simple aller-retour conversationnel : un refactor étendu,
une migration, une exploration qui prend plusieurs minutes ou heures. Pour ces travaux, le daemon
ne bloque pas la session courante — il met la tâche en **file de jobs** persistée, et l'exécute plus
tard dans une **session isolée**, avec son propre **git worktree dédié**.

Un worktree (`git worktree add`) est un second répertoire de travail qui partage le même `.git` que
le dépôt principal, mais a son propre index et son propre HEAD (potentiellement détaché). C'est ce
qui permet à un job de committer, de changer de branche, de faire des allers-retours de code — sans
jamais toucher à la working-copy que l'agent utilise pour vivre au quotidien.

## L'incident d'origine (pourquoi ce n'est pas optionnel)

**Ne jamais lancer un job directement sur la working-copy vivante de l'agent.** C'est un piège
classique et il coûte cher : si un job long tourne sur le même répertoire que celui où l'agent
commite en continu, deux processus finissent par écrire dans le même repo au même moment. Résultat
garanti — un état incohérent :

- des fichiers écrasés par l'un pendant que l'autre les lit ou les modifie ;
- un `git checkout`/`reset`/`pull` lancé par l'un qui fait sauter le sol sous les pieds d'une
  session en cours de l'autre ;
- des commits qui mélangent des changements de deux travaux sans rapport.

Le fix générique, implémenté ici : chaque job s'exécute dans un worktree **dédié**, créé sous le
dépôt (`<repo>/.tmp-job-<id>`, voir `jobWorktreePath` dans `src/lib/worktree.ts`) et **gitignoré**
(motif `.tmp-` à la racine), donc invisible pour le fil principal. Le worktree partage le `.git` du
repo, donc commit/push depuis le job fonctionnent normalement — seule la working-copy visible de
l'agent reste protégée.

## Le cycle de vie d'un job

```ts
import { createWorktree, removeWorktree, realGitExec } from "./lib/worktree.ts";

async function runJob(repoPath: string, jobId: number) {
  const worktree = await createWorktree(realGitExec, repoPath, jobId);
  try {
    // ... exécute le travail du job DANS `worktree`, jamais dans `repoPath` directement ...
  } finally {
    // Nettoyage TOUJOURS exécuté — succès, erreur applicative ou exception imprévue.
    await removeWorktree(realGitExec, repoPath, worktree);
  }
}
```

Deux garanties portées par `src/lib/worktree.ts` :

- **`createWorktree` ne retombe jamais sur la copie partagée en cas d'échec.** Si
  `git worktree add` échoue, la fonction lève une erreur plutôt que de laisser le job continuer
  ailleurs — on préfère l'échec franc à la collision silencieuse. Elle nettoie aussi, en best-effort,
  un résidu laissé par un run précédent du même job (crash avant nettoyage) avant de retenter l'`add`.
- **`removeWorktree` vit dans un `finally`.** Que le job réussisse, échoue, ou lève une exception non
  gérée, le worktree est retiré (`git worktree remove --force` — jamais un `rm -rf`, qui laisserait
  une référence fantôme dans `.git/worktrees/`). Un échec du nettoyage lui-même est best-effort : il
  ne fait pas échouer le job une seconde fois, juste un avertissement en log.

## Articulation avec le self-scheduling

Un réveil programmé (voir [`self-scheduling.md`](./self-scheduling.md)) peut porter une intention
qui demande un travail long. Dans ce cas, la session réveillée par le scheduler ne fait pas le
travail elle-même en direct : elle le met en file de jobs, qui sera exécuté dans son propre
worktree isolé pendant que la session « vivante » de l'agent continue son fil normal, sans risque de
collision. Le self-scheduling décide *quand* déclencher ; l'isolation par worktree décide *où* le
travail s'exécute en sécurité.
