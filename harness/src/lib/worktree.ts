/**
 * Isolation des jobs longs par git worktree DÉDIÉ.
 *
 * Piège classique : si un travail long (un "job") lancé par l'agent tourne directement sur la
 * working-copy VIVANTE du dépôt — celle où l'agent vit et commite en continu — ses écritures
 * collisionnent avec celles du fil principal. Deux processus qui modifient le même repo en même
 * temps, c'est un état incohérent garanti : fichiers écrasés, un `git checkout`/`reset` qui saute
 * sous les pieds d'une session en cours, un commit qui embarque des fichiers d'un autre travail.
 *
 * Le fix générique : chaque job s'exécute dans un worktree dédié, sous le repo (donc dans l'arbre
 * de fichiers auquel le sandbox a accès) et gitignoré (motif `.tmp-` à la racine) — le fil
 * principal ne le voit jamais comme untracked. Un worktree partage le `.git` du repo, donc
 * commit/push depuis le worktree fonctionnent normalement.
 *
 * L'exécuteur git (`GitExec`) est INJECTABLE → la logique (chemin, commandes, gestion d'échec) est
 * testable sans vrai git. `realGitExec` est l'implémentation réelle (spawn).
 *
 * Voir docs/jobs-worktree-isoles.md pour le principe complet, y compris pourquoi le nettoyage doit
 * vivre dans un `finally` côté appelant.
 */
import { spawn } from "node:child_process";
import { join } from "node:path";

export interface ExecResult {
  code: number;
  stdout: string;
  stderr: string;
}

/** Exécute `git <args>` dans `cwd`. Résout toujours (ne rejette pas) → l'appelant lit `code`. */
export type GitExec = (args: string[], cwd: string) => Promise<ExecResult>;

/** Chemin du worktree dédié au job #id (sous le repo, gitignoré via le motif `.tmp-`). */
export function jobWorktreePath(repoPath: string, jobId: number): string {
  return join(repoPath, `.tmp-job-${jobId}`);
}

/** `git worktree add --detach <path> <base>` : worktree en HEAD détachée sur `base`. */
export function addArgs(path: string, base: string): string[] {
  return ["worktree", "add", "--detach", path, base];
}

/** `git worktree remove --force <path>` : la bonne voie de nettoyage (jamais `rm -rf` — un
 *  `rm -rf` laisse `.git/worktrees/<id>` enregistré, git croit encore le worktree vivant et
 *  refuse d'en recréer un au même endroit). */
export function removeArgs(path: string): string[] {
  return ["worktree", "remove", "--force", path];
}

/** Exécuteur git réel via spawn. Ne rejette jamais : encapsule l'erreur dans `{code:1,...}`. */
export const realGitExec: GitExec = (args, cwd) =>
  new Promise((resolve) => {
    const child = spawn("git", args, { cwd, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    child.on("error", (e) => resolve({ code: 1, stdout, stderr: stderr || String(e) }));
    child.on("close", (code) => resolve({ code: code ?? 1, stdout, stderr }));
  });

/**
 * Crée le worktree du job et retourne son chemin. Lève si `git worktree add` échoue (le job ne
 * doit PAS retomber sur la copie partagée en fallback → on préfère l'échec franc à la collision).
 *
 * Nettoyage préalable best-effort : le chemin est déterministe par `jobId` (`jobWorktreePath`) —
 * si un run précédent du MÊME job a planté avant son nettoyage (crash du process, pas juste un
 * échec applicatif), le worktree reste enregistré et `worktree add` échoue à demeure sur
 * « already exists », rendant le job irrécupérable même après une remise en file. On tente donc un
 * `worktree remove --force` AVANT le `add` — no-op silencieux si rien n'existait à ce chemin, purge
 * le résidu sinon.
 */
export async function createWorktree(
  exec: GitExec,
  repoPath: string,
  jobId: number,
  base = "HEAD",
): Promise<string> {
  const path = jobWorktreePath(repoPath, jobId);
  await exec(removeArgs(path), repoPath); // best-effort, résultat ignoré (rien à nettoyer = échec bénin)
  const res = await exec(addArgs(path, base), repoPath);
  if (res.code !== 0) {
    const detail = (res.stderr || res.stdout).trim();
    throw new Error(`git worktree add a échoué (code ${res.code}) : ${detail}`);
  }
  return path;
}

/**
 * Retire le worktree du job (best-effort). DOIT être appelé en `finally` par l'appelant (voir
 * docs/jobs-worktree-isoles.md) pour garantir le nettoyage même si le job a levé une exception. Un
 * échec de nettoyage ne fait PAS échouer davantage le job : on loggue et on laisse le dossier
 * (gitignoré → invisible pour le fil principal, nettoyable plus tard). Retourne `true` au succès.
 */
export async function removeWorktree(exec: GitExec, repoPath: string, path: string): Promise<boolean> {
  const res = await exec(removeArgs(path), repoPath);
  if (res.code !== 0) {
    const detail = (res.stderr || res.stdout).trim();
    console.warn(`[worktree] nettoyage ${path} échoué (best-effort, laissé sur place) : ${detail}`);
    return false;
  }
  return true;
}
