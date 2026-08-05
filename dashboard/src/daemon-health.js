import { config } from "./config.js";

/** Sonde la route GET /health déjà exposée par harness/src/gateway.ts (serveur webhook du
 *  daemon, port 8787 sur l'hôte). Pas d'accès process/`/proc` requis → pas de privilège
 *  supplémentaire pour ce conteneur (pas de `--pid=host`). Timeout court : un daemon down ne
 *  doit pas faire pendre le dashboard. */
export async function probeDaemon(timeoutMs = 2000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(config.daemonHealthUrl, { signal: controller.signal });
    return { up: res.ok, checkedAt: Date.now() };
  } catch (e) {
    return { up: false, checkedAt: Date.now(), error: e.message };
  } finally {
    clearTimeout(timer);
  }
}
