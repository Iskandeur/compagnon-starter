/**
 * Voix clonée (ElevenLabs v3) — répondre en note vocale, avec SA voix, sans se faire réécrire.
 *
 * Le pattern : quand on demande une réponse « en vocal », le compagnon ne parle pas avec une voix
 * de synthèse générique, il parle avec la voix de son humain (clone instantané fait dans l'UI
 * ElevenLabs à partir de quelques échantillons). Trois choses cassent si on les improvise, et ce
 * module tient les trois :
 *
 *  1. **Le format audio.** WhatsApp n'accepte une note vocale (PTT) qu'en Opus dans un conteneur
 *     Ogg. `output_format=opus_48000_64` sort exactement ça — donc aucun ffmpeg dans la chaîne,
 *     aucune conversion, aucun binaire à installer sur le serveur. Vérifié sur les octets : le
 *     fichier commence par `OggS`, 48 kHz mono.
 *  2. **Le ton.** v3 n'a PAS de paramètre de ton. La direction d'acteur se fait avec des balises
 *     inline dans le texte (`[warm]`, `[sighs]`, `[amused]`, `[serious]`) — elles sont *jouées*,
 *     jamais lues à voix haute. On fait donc écrire ces balises par une passe LLM avant la
 *     synthèse.
 *  3. **Le garde-fou, et c'est LE point.** Une passe LLM à qui on demande « ajoute des balises »
 *     répond parfois autre chose : elle reformule, elle traduit, elle raccourcit, ou elle
 *     re-répond à la question. Avec une voix clonée, le résultat est un enregistrement de quelqu'un
 *     disant une phrase qu'il n'a jamais dite. Une consigne de prompt ne suffit pas :
 *     `sameSpokenWords()` retire les balises et compare les mots restants (accents et casse
 *     neutralisés) au texte d'origine. Si un seul mot a bougé, on jette l'enrichissement et on
 *     parle le texte brut. Un filtre tient, une consigne ne tient pas.
 *
 * Zéro dépendance : `fetch` natif, injectable pour les tests.
 */

/** Ce que l'API attend. `voiceId` vient de la config, jamais d'une recherche : une clé restreinte
 *  à « Text to Speech » ne peut même pas lister les voix, et c'est très bien ainsi. */
export interface TtsRequest {
  text: string;
  model_id: string;
  voice_settings?: { stability?: number; similarity_boost?: number };
}

export interface TtsOptions {
  /** Identifiant de la voix ElevenLabs (le clone). */
  voiceId: string;
  /** `eleven_v3` par défaut — il fonctionne sur l'endpoint /v1/text-to-speech ordinaire, y compris
   *  sur un clone instantané (vérifié ; la doc ne le dit pas clairement). */
  modelId?: string;
  /** Opus 48 kHz 64 kbps : le contrat PTT de WhatsApp, sans conversion. */
  outputFormat?: string;
}

const DEFAULT_MODEL = "eleven_v3";
const DEFAULT_FORMAT = "opus_48000_64";

/** URL + corps de la requête, sans rien envoyer. PUR → testable sans réseau ni clé. */
export function buildTtsRequest(text: string, opts: TtsOptions): { url: string; body: TtsRequest } {
  const format = opts.outputFormat ?? DEFAULT_FORMAT;
  return {
    url: `https://api.elevenlabs.io/v1/text-to-speech/${encodeURIComponent(opts.voiceId)}?output_format=${encodeURIComponent(format)}`,
    body: { text, model_id: opts.modelId ?? DEFAULT_MODEL },
  };
}

/** Les balises v3 sont des directives de jeu, pas du texte : `[sighs] Bon.` se prononce « Bon ». */
const TAG = /\[[^\]\n]{1,40}\]/g;

/** Retire les balises. PUR → testable. */
export function stripAudioTags(text: string): string {
  return text.replace(TAG, " ").replace(/\s+/g, " ").trim();
}

/** Suite de mots réellement prononcés, normalisée : accents retirés, casse et ponctuation
 *  neutralisées. C'est la forme sur laquelle on compare — pas la chaîne brute, sinon une virgule
 *  déplacée ferait échouer un enrichissement parfaitement honnête. PUR → testable. */
export function spokenWords(text: string): string[] {
  return stripAudioTags(text)
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .split(" ")
    .filter((w) => w.length > 0);
}

/** L'enrichissement dit-il EXACTEMENT la même chose que l'original ? PUR → testable.
 *  Retourne false dès qu'un mot a été ajouté, retiré, traduit ou remplacé. */
export function sameSpokenWords(original: string, enriched: string): boolean {
  const a = spokenWords(original);
  const b = spokenWords(enriched);
  return a.length === b.length && a.every((w, i) => w === b[i]);
}

/** Le texte à synthétiser : l'enrichi s'il est fidèle, l'original sinon. C'est la seule fonction
 *  que le runtime doit appeler — elle rend le mauvais chemin impossible à oublier. PUR. */
export function safeEnrichedText(original: string, enriched: string | null | undefined): string {
  if (!enriched) return original;
  return sameSpokenWords(original, enriched) ? enriched : original;
}

/**
 * LE PIÈGE QUI NE SE VOIT PAS À LA RELECTURE : la boucle de rétroaction.
 *
 * Dès que le compagnon parle, sa propre note vocale redescend dans le fil. Un transcripteur
 * branché sur ce fil la transcrit, le texte transcrit ressemble à un message entrant, et le
 * compagnon **se répond à lui-même**. Vécu en production le 2026-08-10 : la boucle ne s'est
 * arrêtée qu'au premier tour, par chance, parce que cette réponse-là était du texte.
 *
 * Le garde-fou est une liste d'identifiants à ignorer, et elle a DEUX pièges :
 *  - il faut les DEUX BOUTS du fil (celui de l'humain ET celui du compagnon) : une liste qui n'a
 *    jamais vu passer de trafic dans un sens paraît complète jusqu'au jour où ça circule ;
 *  - sur les connecteurs WhatsApp modernes, un même compte a deux formes d'identifiant
 *    (`...@c.us` et `...@lid`) : il faut les deux, sinon la garde est simplement absente.
 *
 * PUR → testable.
 */
export function isOwnVoiceEcho(
  ev: { chatId?: string; author?: string; fromMe?: boolean },
  ownIds: Iterable<string>,
): boolean {
  const known = new Set<string>();
  for (const id of ownIds) {
    const bare = id.split("@")[0];
    known.add(id);
    known.add(`${bare}@c.us`);
    known.add(`${bare}@lid`);
  }
  if (ev.fromMe) return true;
  return [ev.author, ev.chatId].some((id) => !!id && known.has(id));
}

/** Synthèse réelle. Rend les octets audio (Ogg/Opus) prêts à être postés en note vocale.
 *  `fetchImpl` est injectable : les tests ne touchent jamais le réseau. */
export async function synthesizeVoice(
  text: string,
  opts: TtsOptions & { apiKey: string; fetchImpl?: typeof fetch },
): Promise<Uint8Array> {
  const { url, body } = buildTtsRequest(text, opts);
  const doFetch = opts.fetchImpl ?? fetch;
  const res = await doFetch(url, {
    method: "POST",
    headers: { "xi-api-key": opts.apiKey, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`ElevenLabs ${res.status}: ${(await res.text()).slice(0, 300)}`);
  return new Uint8Array(await res.arrayBuffer());
}

/** Un Ogg commence par le motif de capture `OggS`. Sert de vérification au premier branchement :
 *  si ce n'est pas un Ogg, WhatsApp refusera la note vocale ou la postera en fichier joint. */
export function looksLikeOggOpus(bytes: Uint8Array): boolean {
  return bytes.length >= 4 && bytes[0] === 0x4f && bytes[1] === 0x67 && bytes[2] === 0x67 && bytes[3] === 0x53;
}
