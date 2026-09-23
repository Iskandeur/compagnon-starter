/**
 * Lancer un moteur en priorité CPU basse — PUR.
 *
 * Problème : sur une petite machine (deux cœurs), un travail de fond de l'agent (un job long qui lance
 * des tests, de l'inférence locale, un build) tourne au MÊME rang que le daemon qui doit répondre à
 * l'humain. La charge monte, et c'est la conversation qui ralentit — l'inverse de ce qu'on veut.
 *
 * Remède : préfixer le lancement du moteur par `nice -n N`, plutôt que d'appeler `os.setPriority`
 * après le spawn. Sous Linux la priorité est par THREAD : les threads que le moteur crée pendant son
 * démarrage échapperaient à un réglage posé une fraction de seconde trop tard. `nice` règle la
 * priorité AVANT l'`exec` : le moteur, tous ses threads et chaque outil qu'il lance ensuite en
 * héritent. Le PID reste le même (`nice` s'efface par `exec`), donc une annulation qui tue
 * `child.pid` touche bien le moteur.
 *
 * Portée honnête : `nice` arbitre entre process d'un MÊME cgroup. Il rend la main au daemon face à
 * ses propres jobs ; il ne change rien face à un service qui vit dans un autre cgroup (un conteneur
 * Docker, par exemple) — pour ça, c'est `CPUWeight=` dans l'unité systemd.
 *
 * Usage : `const { cmd, args } = withNiceness("claude", ["-p", prompt], JOB_NICENESS); spawn(cmd, args)`
 * pour un job de fond ; `withNiceness(bin, args, undefined)` pour une conversation (spawn inchangé).
 */

/** Priorité des jobs de fond : 10 sur l'échelle 0 (défaut) → 19 (le plus poli). Assez pour céder
 *  nettement le CPU au daemon, sans affamer un job quand la machine est calme — `nice` ne bride rien
 *  quand personne d'autre ne demande le processeur. */
export const JOB_NICENESS = 10;

export function withNiceness(
  bin: string,
  args: string[],
  niceness: number | undefined,
): { cmd: string; args: string[] } {
  // 0, absent ou invalide : spawn inchangé. Un négatif exigerait des droits root et ferait échouer le
  // lancement entier — on ne l'accepte donc pas plutôt que de le laisser casser un tour.
  if (niceness === undefined || !Number.isInteger(niceness) || niceness <= 0) return { cmd: bin, args };
  return { cmd: "nice", args: ["-n", String(Math.min(niceness, 19)), bin, ...args] };
}
