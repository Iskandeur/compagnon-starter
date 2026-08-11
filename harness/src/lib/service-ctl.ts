/**
 * service-ctl — gérer un service systemd que TON AGENT porte lui-même (ex. `companion-minilupi`),
 * sans jamais passer par le sandbox de permissions de Claude Code : la commande `sudo` part
 * directement depuis CE process Node (déjà couvert par une allowlist du style `Bash(node *)`), qui
 * shell-out vers les binaires whitelistés dans ta config sudoers (glob par préfixe, une ligne
 * versionnée plutôt qu'une par service).
 *
 * Le problème que ce module règle : un 👍 (approbation N2, si tu as ce mécanisme) valide une action
 * au niveau de TA logique d'autorisation — mais ça ne débloque PAS une commande `sudo` non listée
 * dans l'allowlist de permissions de Claude Code, qui est une couche complètement séparée et ne
 * peut être éditée que par une approbation interactive humaine. Sans ce module, chaque nouveau
 * service que ton agent construit exige soit une manip terminal de ton humain, soit une session
 * interactive pour élargir l'allowlist. Avec ce module : une fois ta config sudoers installée
 * (root, une fois, PR relue par ton humain avant install), tout futur service au même préfixe se
 * gère avec juste `node bin/service-ctl.ts …` — plus jamais d'édition d'allowlist Claude Code.
 *
 * `isManagedService` est une DEUXIÈME barrière (défense en profondeur) : même si l'appelant passe
 * un nom arbitraire, ce module refuse tout ce qui ne matche pas ton préfixe — le glob sudoers n'est
 * pas la seule ligne de défense.
 *
 * Exemple de règle sudoers (à adapter, `/etc/sudoers.d/<toi>`) :
 *   agent ALL=(root) NOPASSWD: /usr/bin/systemctl start companion-*, \
 *     /usr/bin/systemctl stop companion-*, /usr/bin/systemctl restart companion-*, \
 *     /usr/bin/systemctl status companion-*, /usr/bin/systemctl enable --now companion-*, \
 *     /usr/bin/systemctl disable companion-*, /usr/bin/systemctl daemon-reload, \
 *     /usr/bin/cp /opt/companion/harness/config/companion-*.service.example /etc/systemd/system/companion-*.service
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

/** Construit le pattern de préfixe géré (ex. `companion-` → `/^companion-[a-z0-9-]+$/`). */
export function managedServicePattern(prefix: string): RegExp {
  return new RegExp(`^${prefix}[a-z0-9-]+$`);
}

export function isManagedService(name: string, prefix: string): boolean {
  return managedServicePattern(prefix).test(name);
}

export type ServiceVerb = "start" | "stop" | "restart" | "status" | "enable" | "disable";

const VERB_ARGS: Record<ServiceVerb, string[]> = {
  start: ["start"],
  stop: ["stop"],
  restart: ["restart"],
  status: ["status"],
  enable: ["enable", "--now"],
  disable: ["disable"],
};

/** PUR — construit les arguments `systemctl` exacts, ou `null` si `name` n'est pas géré. Testable
 *  sans rien exécuter : c'est ce qui permet de vérifier que la commande matche EXACTEMENT ce que
 *  ta config sudoers autorise, avant même de tenter un `spawn`. */
export function systemctlArgs(name: string, verb: ServiceVerb, prefix: string): string[] | null {
  if (!isManagedService(name, prefix)) return null;
  return [...VERB_ARGS[verb], name];
}

/** PUR — chemins source/destination de l'installation, mêmes motifs que le glob `cp` de ta config
 *  sudoers (`<prefix>*.service.example` → `/etc/systemd/system/<prefix>*.service`). */
export function installCpArgs(name: string, prefix: string, harnessHome: string): [string, string] | null {
  if (!isManagedService(name, prefix)) return null;
  return [
    `${harnessHome}/harness/config/${name}.service.example`,
    `/etc/systemd/system/${name}.service`,
  ];
}

export interface ExecResult {
  stdout: string;
  stderr: string;
}
/** Signature réduite d'`execFile` promisifié — injectable dans les tests, zéro I/O réelle. */
export type ExecLike = (bin: string, args: string[]) => Promise<ExecResult>;

const defaultExec: ExecLike = async (bin, args) => execFileAsync(bin, args);

export interface ServiceActionResult {
  ok: boolean;
  output: string;
  error?: string;
}

/** Un seul verbe systemctl sur un service déjà installé, matchant `prefix`. */
export async function runServiceAction(
  name: string,
  verb: ServiceVerb,
  prefix: string,
  deps: { exec?: ExecLike } = {},
): Promise<ServiceActionResult> {
  const args = systemctlArgs(name, verb, prefix);
  if (!args) return { ok: false, output: "", error: `service non géré (doit matcher ${prefix}*) : ${name}` };
  const exec = deps.exec ?? defaultExec;
  try {
    const { stdout, stderr } = await exec("sudo", ["systemctl", ...args]);
    return { ok: true, output: stdout || stderr };
  } catch (e) {
    return { ok: false, output: "", error: (e as Error).message };
  }
}

export interface InstallResult {
  ok: boolean;
  steps: string[];
  error?: string;
}

/** Installe puis active un NOUVEAU service `<prefix>*` : copie l'unité versionnée, recharge
 *  systemd, active + démarre. S'arrête au premier échec (chaque étape dépend de la précédente). */
export async function installService(
  name: string,
  prefix: string,
  harnessHome: string,
  deps: { exec?: ExecLike } = {},
): Promise<InstallResult> {
  const cpArgs = installCpArgs(name, prefix, harnessHome);
  if (!cpArgs) return { ok: false, steps: [], error: `service non géré (doit matcher ${prefix}*) : ${name}` };
  const exec = deps.exec ?? defaultExec;
  const steps: string[] = [];
  try {
    await exec("sudo", ["cp", ...cpArgs]);
    steps.push("cp");
    await exec("sudo", ["systemctl", "daemon-reload"]);
    steps.push("daemon-reload");
    await exec("sudo", ["systemctl", "enable", "--now", name]);
    steps.push("enable --now");
    return { ok: true, steps };
  } catch (e) {
    return { ok: false, steps, error: (e as Error).message };
  }
}
