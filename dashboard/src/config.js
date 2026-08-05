import { randomBytes } from "node:crypto";

export const config = {
  port: Number(process.env.PORT ?? 8080),
  // Chemins montés en LECTURE SEULE (bind mounts ro) dans le conteneur — jamais écrits.
  dbPath: process.env.DASHBOARD_DB_PATH ?? "/data/compagnon.sqlite",
  repoPath: process.env.DASHBOARD_REPO_PATH ?? "/repo",
  // Sonde de vie du daemon (route GET /health — voir harness/README.md pour l'exposer côté harnais).
  daemonHealthUrl: process.env.DASHBOARD_DAEMON_HEALTH_URL ?? "http://host.docker.internal:8787/health",
  // Route de réglage du daemon (POST /settings, Bearer). Vide = panneau réglages en lecture seule.
  settingsUrl: process.env.DASHBOARD_SETTINGS_URL ?? "http://host.docker.internal:8787/settings",
  settingsToken: process.env.DASHBOARD_SETTINGS_TOKEN ?? "",
  // Gate PIN : cookie signé HMAC, sans état serveur. Vide = gate désactivée (jamais le cas en
  // déploiement public).
  accessPin: process.env.ACCESS_PIN ?? "",
  accessSessionSecret: process.env.ACCESS_SESSION_SECRET ?? randomBytes(32).toString("hex"),
  // Identifiant interne (chat_id) d'un groupe multi-agents nommé — sert uniquement à lire les clés
  // settings scopées à ce groupe (ex. réglages modèle par groupe). Jamais renvoyé par l'API. Vide =
  // le panneau affiche "inherit" pour cette portée (aucune clé ne matchera), pas une erreur.
  groupChatId: process.env.GROUP_CHAT_ID ?? "",
};
