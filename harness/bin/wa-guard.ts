#!/usr/bin/env node
/**
 * `wa-guard` — hook PreToolUse branché sur les outils d'envoi WhatsApp (cf. `src/wa-guard.ts`).
 *
 * Usage (`.claude/settings.json`) :
 *   { "type": "command", "command": "node <repo>/harness/bin/wa-guard.ts" }
 * Il lit l'évènement hook en JSON sur stdin, décide, et répond en JSON (allow / deny + raison).
 * Chaque envoi autorisé est journalisé dans `<COMPAGNON_HOME>/data/wa-guard-state.json` (fenêtre 24 h).
 *
 * Modes utilitaires :
 *   node bin/wa-guard.ts --status   → état des compteurs (ce qui reste avant plafond)
 *   node bin/wa-guard.ts --reset    → vide l'historique (à n'utiliser qu'en test)
 *
 * Ce script est un exemple autonome : chemins résolus via des variables d'environnement simples
 * (`COMPAGNON_HOME`), sans dépendre d'une couche `lib/paths.ts` applicative. Adapte à ta convention
 * si tu en as une (le seul contrat qui compte est celui de `src/wa-guard.ts`, pur et déjà testé).
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { DEFAULT_LIMITS, OWNER_CHAT, chatOf, decide, groupUnlocked, isSendTool, parseGroupAllowlist, type SendEvent } from "../src/wa-guard.ts";

const HOME = process.env.COMPAGNON_HOME ?? join(import.meta.dirname, "..", "..");
const STATE = process.env.WA_GUARD_STATE_PATH ?? join(HOME, "data", "wa-guard-state.json");
const GROUPS_ALLOWLIST = process.env.WA_GUARD_GROUPS_PATH ?? join(HOME, "harness", "config", "wa-guard-groups-ok");
const HOUR = 3_600_000;

function load(): SendEvent[] {
  if (!existsSync(STATE)) return []; // absent = premier envoi (silence, pas une erreur)
  try {
    const raw = JSON.parse(readFileSync(STATE, "utf8"));
    return Array.isArray(raw) ? raw.filter((e) => typeof e?.ts === "number") : [];
  } catch {
    return []; // on n'échoue jamais ouvert sur une erreur de lecture
  }
}

function save(events: SendEvent[]): void {
  const now = Date.now();
  try {
    mkdirSync(dirname(STATE), { recursive: true });
    writeFileSync(STATE, JSON.stringify(events.filter((e) => e.ts > now - 24 * HOUR)));
  } catch {
    /* best-effort */
  }
}

/** Ce groupe est-il déverrouillé ? Lit l'allowlist VERSIONNÉE (`harness/config/wa-guard-groups-ok`)
 *  et la scope au chat. Introuvable → on échoue FERMÉ (pas de déverrouillage silencieux). */
function groupsUnlockedFor(chat: string): boolean {
  if (!chat.endsWith("@g.us")) return false; // pas un groupe : l'allowlist n'entre pas en jeu
  if (!existsSync(GROUPS_ALLOWLIST)) {
    console.error(`[wa-guard] allowlist groupe INTROUVABLE (${GROUPS_ALLOWLIST}) → groupes bloqués par défaut.`);
    return false;
  }
  return groupUnlocked(parseGroupAllowlist(readFileSync(GROUPS_ALLOWLIST, "utf8")), chat);
}

/** Résumé lisible de l'état de déverrouillage groupe (pour --status). */
function groupsStatus(): string {
  if (!existsSync(GROUPS_ALLOWLIST)) return "bloqués (allowlist INTROUVABLE — voir l'erreur ci-dessus)";
  const allow = parseGroupAllowlist(readFileSync(GROUPS_ALLOWLIST, "utf8"));
  if (allow.size === 0) return "TOUS déverrouillés (fichier vide — rétrocompat)";
  if (allow.has("*")) return "TOUS déverrouillés (*)";
  return `déverrouillés (scopé) : ${[...allow].join(", ")}`;
}

/** Hold d'envoi : lecture best-effort d'un signal externe (fichier, base, ce que tu veux). Illisible
 *  ⇒ pas de hold (on ne bloque jamais tout par erreur de lecture). Branche ta propre source ici. */
function holdActive(): boolean {
  const flag = process.env.WA_GUARD_HOLD_FILE ?? join(HOME, "data", "wa-guard-hold");
  return existsSync(flag);
}

const arg = process.argv[2];
if (arg === "--reset") {
  save([]);
  console.log("garde-fou WhatsApp : historique vidé.");
  process.exit(0);
}
if (arg === "--status") {
  const now = Date.now();
  const ev = load();
  const owner = process.env.WA_GUARD_OWNER || OWNER_CHAT;
  const inH = ev.filter((e) => e.ts > now - HOUR);
  const chatsH = new Set(inH.filter((e) => e.chat !== owner).map((e) => e.chat));
  const chatsD = new Set(ev.filter((e) => e.chat !== owner).map((e) => e.chat));
  console.log(
    [
      `hold        : ${holdActive() ? "ACTIF" : "non"}`,
      `groupes     : ${groupsStatus()}`,
      `5 min       : ${ev.filter((e) => e.ts > now - 5 * 60_000).length}/${DEFAULT_LIMITS.maxPer5min}`,
      `1 h         : ${inH.length}/${DEFAULT_LIMITS.maxPerHour}`,
      `destinataires (hors le principal) : ${chatsH.size}/${DEFAULT_LIMITS.maxChatsPerHour} sur 1 h · ${chatsD.size}/${DEFAULT_LIMITS.maxChatsPerDay} sur 24 h`,
    ].join("\n"),
  );
  process.exit(0);
}

// — mode hook —
const stdin = readFileSync(0, "utf8");
let evt: { tool_name?: string; tool_input?: Record<string, unknown> } = {};
try {
  evt = JSON.parse(stdin);
} catch {
  process.exit(0); // entrée illisible : on ne bloque pas les autres outils
}

const tool = evt.tool_name ?? "";
if (!isSendTool(tool)) process.exit(0);

const chat = chatOf(evt.tool_input);
const events = load();
const now = Date.now();
const d = decide(
  events,
  { tool, chat, hold: holdActive(), groupsUnlocked: groupsUnlockedFor(chat), owner: process.env.WA_GUARD_OWNER || OWNER_CHAT },
  DEFAULT_LIMITS,
  now,
);

if (d.allow) {
  events.push({ ts: now, chat, tool });
  save(events);
  process.exit(0); // silence = laisser passer (le flux de permission normal s'applique)
}

console.log(
  JSON.stringify({
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "deny",
      permissionDecisionReason: `[garde-fou WhatsApp] ${d.reason}`,
    },
  }),
);
process.exit(0);
