#!/usr/bin/env node
/**
 * `restart` — redémarre proprement le daemon (service systemd générique, ex. `compagnon.service`).
 * À appeler APRÈS avoir envoyé ta réponse (le restart tue le réveil courant ; tu confirmes au
 * réveil suivant). systemd relance le process.
 *
 * Le restart est robuste PAR CONSTRUCTION : le `systemctl` part DÉTACHÉ (il survit à la mort du
 * réveil courant), et un drapeau met les messages entrants en attente au lieu de laisser un
 * message arrivé au mauvais moment avorter le redémarrage. Les messages arrivés pendant restent
 * en inbox et sont rejoués au boot suivant — « mis dans la queue, traités juste après ».
 *
 * Au BOOT du daemon (pas dans ce script — cf. ton propre point d'entrée), grave un identifiant de
 * version (ex. le SHA git courant, `git rev-parse HEAD`) dans une clé `daemon_boot_id`. Ça permet
 * de vérifier après coup que le restart a réellement ABOUTI (nouveau process, nouveau SHA) et pas
 * seulement été LANCÉ — deux choses différentes : `systemctl restart` peut réussir à lancer la
 * commande sans que le nouveau process ne démarre correctement (crash au boot, permission refusée,
 * service manager en rade). Comparer `daemon_boot_id` avant/après restart confirme l'aboutissement.
 *
 * Ce script est un EXEMPLE autonome basé sur `node:sqlite` (natif, Node ≥22) pour illustrer le
 * mécanisme de bout en bout, avec une mini table `settings` (clé/valeur) et `inbox` (messages
 * entrants, avec un état fait/pas fait). Adapte `openStore()` à ta propre couche de persistance :
 * le seul contrat exigé est `RestartStore & InboxAcker` (cf. `src/lib/restart-guard.ts`).
 */
import { spawn } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import { ackInflight, markRestartPending, LANES, type InboxAcker, type RestartStore } from "../src/lib/restart-guard.ts";

/** Nom du service systemd à redémarrer. Remplace par le tien, ou passe-le en argument CLI. */
const DEFAULT_UNIT = "compagnon.service";

/** Chemin de la base sqlite. Adapte à ta convention de chemins (ici : variable d'env, ou fichier
 *  local par défaut — pratique pour tester ce script isolément). */
function resolveDbPath(): string {
  return process.env.COMPAGNON_DB_PATH ?? "./data/compagnon.sqlite";
}

/** Ouvre (ou crée) le store minimal utilisé par ce script d'exemple. */
function openStore(path: string): RestartStore & InboxAcker {
  const db = new DatabaseSync(path);
  db.exec(`
    CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS inbox (id INTEGER PRIMARY KEY AUTOINCREMENT, body TEXT, done INTEGER DEFAULT 0);
  `);
  return {
    getSetting(key: string): string | null {
      const row = db.prepare("SELECT value FROM settings WHERE key = ?").get(key) as { value: string } | undefined;
      return row?.value ?? null;
    },
    setSetting(key: string, value: string): void {
      db.prepare("INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(key, value);
    },
    markInboxDone(id: number): void {
      db.prepare("UPDATE inbox SET done = 1 WHERE id = ?").run(id);
    },
  };
}

/**
 * Demande le redémarrage du service. Détaché → survit à la mort de l'appelant : `spawn` fait un
 * `setsid()`, le process obtient sa PROPRE session et son propre groupe de process. Un signal
 * envoyé au groupe du réveil (le mécanisme qui tue les enfants d'une session agent) ne l'atteint
 * donc plus. Et comme le fork+exec a lieu AVANT que `spawn` ne rende la main, le process existe
 * déjà quand cette fonction retourne : même si l'appelant est tué à l'instant d'après, le restart
 * va au bout.
 */
function restartSelf(unit: string): void {
  // Adapte la commande à ton contexte (sudoers, systemd user unit, docker restart, etc.). Si tu
  // whitelistes une commande sudo précise, ne rajoute PAS d'options ici : la liste blanche matche
  // souvent la commande exacte.
  const child = spawn("sudo", ["systemctl", "restart", unit], { detached: true, stdio: "ignore" });
  child.on("error", (e: Error) => console.error("[restart] lancement impossible:", e.message));
  child.unref();
}

/** Préfixe du réveil de REPRISE (si ton scheduler sait programmer un réveil futur — adapte / retire
 *  si tu n'as pas cette notion). */
const REPRISE_DELAY_MS = 90_000;

// —— Voie qui DEMANDE le restart : on n'acquitte QUE celle-là (cf. restart-guard.ackInflight).
// Passe `--lane wake` (ou la variable d'env de ton choix) quand tu redémarres depuis un réveil de
// FOND : sinon tu acquitterais un message en cours de traitement sur la voie « conv » → PERDU.
// Défaut `conv` : le cas courant est « je redémarre après avoir répondu ».
function parseLane(argv: string[]): string {
  const i = argv.indexOf("--lane");
  const raw = (i >= 0 ? argv[i + 1] : process.env.COMPAGNON_LANE) ?? "";
  return (LANES as readonly string[]).includes(raw) ? raw : "conv";
}
// Premier argument positionnel (hors flags `--lane <val>`) = l'unité systemd ; défaut générique.
function parseUnit(argv: string[]): string {
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--lane") { i++; continue; }
    if (!argv[i].startsWith("--")) return argv[i];
  }
  return DEFAULT_UNIT;
}

const cliArgs = process.argv.slice(2);
const lane = parseLane(cliArgs);
const unit = parseUnit(cliArgs);

try {
  const db = openStore(resolveDbPath());
  markRestartPending(db, Date.now());
  console.log(`↻ drapeau « restart en cours » posé — les messages entrants seront mis en file (rejoués au boot).`);
  const acked = ackInflight(db, [lane]);
  if (acked > 0) {
    console.log(`↻ ${acked} message(s) EN VOL de la voie « ${lane} » acquitté(s) (anti-doublon de rejeu ; les autres voies préservées).`);
  }
  // Réveil de reprise (~90 s) : anti « dead air ». Optionnel — retire si ton scheduler ne gère pas
  // les réveils programmés, ou branche-le sur ta propre table de tâches.
  console.log(`↻ réveil de reprise à programmer dans ~${REPRISE_DELAY_MS / 1000}s (branche ta propre logique de scheduler ici).`);
} catch (e) {
  console.error("préparation du restart incomplète:", (e as Error).message);
}

restartSelf(unit);
console.log(`↻ redémarrage de « ${unit} » demandé (détaché — il aboutira même si ce réveil est coupé).`);
