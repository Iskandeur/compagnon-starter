#!/usr/bin/env node
/**
 * `portrait` — la plomberie du rituel mensuel « portrait du mois ».
 *
 *   node harness/bin/portrait.ts --prompt-file data/portrait-prompt.txt   # génère le mois courant
 *   node harness/bin/portrait.ts --prompt "..." --month 2026-07           # mois explicite
 *   node harness/bin/portrait.ts --prompt-file X --no-send                # génère et archive sans notifier
 *
 * Le script ne fait QUE la plomberie : construire le prompt, appeler une API de génération
 * d'image, archiver le résultat dans `data/portraits/AAAA-MM.png`, notifier (optionnel).
 *
 * L'ÂME du rituel — composer le prompt à partir du mois écoulé, choisir ce qui compte, écrire un
 * texte qui a du sens — reste le travail de l'agent, fait à la main (ou en conversation) au
 * réveil du 1er, AVANT de lancer ce script. Ce script ne réfléchit pas : il exécute.
 *
 * ⚠️ PIÈGE VÉCU (documenté ici pour ne pas perdre une soirée dessus) : une clé API « free tier »
 * peut accepter les requêtes SANS ERREUR CLAIRE mais avoir un quota de générations d'images de
 * ZÉRO en pratique — échec silencieux ou réponse vide, pas un message d'erreur explicite. Si
 * `generateImage` échoue de façon mystérieuse, vérifie D'ABORD que ta clé est une clé PAYANTE
 * avant de chercher un bug dans ce fichier.
 *
 * Variables d'env attendues :
 *   IMAGE_API_URL           — endpoint HTTP du provider d'images choisi.
 *   IMAGE_API_KEY           — sa clé (voir le piège ci-dessus).
 *   PORTRAIT_WEBHOOK_URL    — optionnel, POST de notification une fois l'image archivée.
 */
import { parseArgs } from "node:util";
import { readFileSync, writeFileSync, mkdirSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const JOURNAL_DIR = join(REPO_ROOT, "journal");
const PORTRAITS_DIR = join(REPO_ROOT, "data", "portraits");

const { values } = parseArgs({
  options: {
    prompt: { type: "string" },
    "prompt-file": { type: "string" },
    month: { type: "string" },
    "no-send": { type: "boolean", default: false },
  },
});

/** Mois calendaire courant, au format AAAA-MM. Pas de fuseau horaire en dur : ce starter tourne
 *  où tu veux — si l'heure locale compte pour toi, lance avec `TZ=... node harness/bin/portrait.ts`. */
function currentMonth(): string {
  return new Date().toISOString().slice(0, 7);
}

const month = values.month ?? currentMonth();
if (!/^\d{4}-\d{2}$/.test(month)) {
  console.error(`--month attendu au format AAAA-MM (reçu: ${month})`);
  process.exit(2);
}

/**
 * Construit le prompt d'image.
 *
 * Chemin recommandé — c'est L'ÂME du rituel : --prompt / --prompt-file, un texte RÉDIGÉ par
 * l'agent après avoir relu son mois et choisi ce qu'il en retient. C'est ce travail-là qui fait
 * que le portrait raconte CE mois précis et pas un mois générique.
 *
 * Fallback dégradé : si aucun prompt explicite n'est fourni, on concatène brut les entrées
 * `journal/AAAA-MM-*.md` du mois. Ça permet de tester la plomberie, mais ça donne un prompt
 * « liste de courses », pas un portrait pensé — n'utilise ce mode que pour un essai technique.
 */
function buildPrompt(): string {
  if (values["prompt-file"]) return readFileSync(values["prompt-file"], "utf8").trim();
  if (values.prompt) return values.prompt.trim();

  let entries: string[] = [];
  try {
    entries = readdirSync(JOURNAL_DIR, { withFileTypes: true })
      .filter((f) => f.isFile() && f.name.startsWith(`${month}-`) && f.name.endsWith(".md"))
      .map((f) => f.name)
      .sort();
  } catch {
    entries = [];
  }

  if (entries.length === 0) {
    console.error(
      `Pas de --prompt fourni et aucune entrée journal/${month}-*.md trouvée. ` +
        `Rédige d'abord le prompt du mois (l'âme du rituel), puis relance avec --prompt-file.`,
    );
    process.exit(2);
  }

  console.error(
    `Attention : pas de --prompt fourni, fallback sur la concaténation brute de ${entries.length} ` +
      `entrée(s) journal — ce n'est PAS le rituel complet, juste un test de plomberie.`,
  );
  return entries.map((name) => readFileSync(join(JOURNAL_DIR, name), "utf8")).join("\n\n---\n\n").trim();
}

const prompt = buildPrompt();
if (!prompt) {
  console.error("Prompt vide — rien à envoyer à l'API image.");
  process.exit(2);
}

/**
 * Appelle une API de génération d'image générique — branche le provider de ton choix derrière
 * IMAGE_API_URL / IMAGE_API_KEY. Le format de requête ci-dessous ({ prompt }) et l'extraction de
 * la réponse sont volontairement génériques : adapte-les au provider réellement utilisé.
 *
 * Exemple concret (celui de la version originale de ce script) : l'API Gemini
 * `generateContent` attend un corps `{ contents: [{ parts: [{ text: prompt }] }] }` et renvoie
 * l'image en base64 dans `candidates[0].content.parts[].inlineData.data`. L'extraction ci-dessous
 * sait déjà lire ce format-là, en plus de deux autres formats courants — mais si ton provider
 * répond avec une forme différente, adapte `base64 = ...` en conséquence.
 */
async function generateImage(promptText: string): Promise<Buffer> {
  const apiUrl = process.env.IMAGE_API_URL;
  const apiKey = process.env.IMAGE_API_KEY;
  if (!apiUrl || !apiKey) {
    console.error("IMAGE_API_URL et/ou IMAGE_API_KEY absent(s) de l'environnement.");
    process.exit(1);
  }

  const res = await fetch(apiUrl, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({ prompt: promptText }),
  });
  const body: any = await res.json().catch(() => ({}));
  if (!res.ok) {
    console.error(`API image ${res.status} : ${JSON.stringify(body).slice(0, 400)}`);
    console.error("Échec sans raison claire ? Vérifie D'ABORD le tier de ta clé (free tier = souvent quota 0).");
    process.exit(1);
  }

  // Formats de réponse courants, dans l'ordre où on les essaie :
  //  - { image: "<base64>" }
  //  - { data: [{ b64_json: "<base64>" }] }                          (forme façon API "images")
  //  - { candidates: [{ content: { parts: [{ inlineData: {...} }] } }] }  (forme façon Gemini)
  const base64: string | undefined =
    body.image ??
    body.data?.[0]?.b64_json ??
    body.candidates?.[0]?.content?.parts?.find((p: any) => p?.inlineData?.data)?.inlineData?.data;

  if (!base64) {
    // Le modèle a peut-être répondu en texte (refus, etc.) plutôt qu'en image — on remonte ce
    // qu'on a plutôt qu'un échec muet.
    console.error(`Pas d'image reconnaissable dans la réponse : ${JSON.stringify(body).slice(0, 400)}`);
    process.exit(1);
  }
  return Buffer.from(base64, "base64");
}

const bytes = await generateImage(prompt);

mkdirSync(PORTRAITS_DIR, { recursive: true });
const imagePath = join(PORTRAITS_DIR, `${month}.png`);
writeFileSync(imagePath, bytes);
// Le prompt est archivé à côté de l'image : dans un an, savoir POURQUOI ce portrait ressemble à ça.
writeFileSync(join(PORTRAITS_DIR, `${month}.prompt.txt`), prompt + "\n");
console.log(`Portrait archivé : ${imagePath} (${Math.round(bytes.length / 1024)} Ko)`);

if (values["no-send"]) process.exit(0);

// Notification : générique et optionnelle. Ce starter ne code aucun canal précis (WhatsApp,
// Telegram, email...) — branche le tien. Si PORTRAIT_WEBHOOK_URL est défini, on POST un petit
// JSON de notification ; sinon on rappelle juste où trouver l'image.
const webhookUrl = process.env.PORTRAIT_WEBHOOK_URL;
if (webhookUrl) {
  const notifyRes = await fetch(webhookUrl, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ month, path: imagePath }),
  });
  console.log(notifyRes.ok ? "Notification envoyée." : `Notification échouée (${notifyRes.status}).`);
} else {
  console.log("Aucun PORTRAIT_WEBHOOK_URL configuré — envoie l'image toi-même via ton canal habituel.");
}
