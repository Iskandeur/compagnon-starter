# Voix clonée (ElevenLabs v3) — parler avec SA voix sans se faire réécrire

## Le pattern

Quand on demande à son compagnon de répondre « en vocal », la réponse ne part pas avec une voix de
synthèse générique : elle part avec la voix de son humain, clonée. Un clone instantané se fait dans
l'UI ElevenLabs à partir de quelques échantillons, et il s'utilise ensuite comme n'importe quelle
autre voix.

C'est la fonctionnalité la plus facile à brancher de travers, parce que les trois choses qui la
font marcher ne sont dans aucun tutoriel.

## 1. Le format audio : zéro conversion

WhatsApp ne reconnaît une **note vocale** (PTT, la bulle avec la forme d'onde) que si le fichier est
de l'**Opus dans un conteneur Ogg**. Tout le reste part en pièce jointe, ou est refusé.

`output_format=opus_48000_64` rend exactement ça. Vérifié sur les octets : le fichier commence par
`OggS`, 48 kHz mono. Donc **pas de ffmpeg dans la chaîne**, aucun binaire à installer sur le
serveur, aucune conversion intermédiaire. Si votre client de messagerie a un drapeau du genre
`convert`, laissez-le à `false` : il n'y a rien à convertir.

`eleven_v3` fonctionne sur l'endpoint ordinaire `/v1/text-to-speech/{voice_id}`, y compris sur un
clone instantané. La clé API peut être restreinte à **Text to Speech et rien d'autre** — elle ne
pourra alors même pas lister les voix, ce qui est la bonne posture : l'identifiant de la voix vit
dans la configuration, pas dans une recherche à l'exécution.

## 2. Le ton : ce sont des balises, pas un paramètre

v3 n'a **pas** de paramètre de ton. La direction se donne avec des balises inline dans le texte :

```
[sighs] Bon, mauvaise nouvelle. [serious] Le proprio a dit non.
```

Elles sont **jouées**, jamais lues à voix haute (vérifié en re-transcrivant la sortie : pas un seul
crochet ne revient). Comme le texte de la réponse est écrit par le modèle sans penser au son, on
ajoute les balises dans une **passe séparée** : une petite requête LLM qui reçoit la réponse finale
et rend la même réponse balisée.

Mesuré sur trois tons : une bonne nouvelle attrape `[reassuring]`, un refus attrape `[sighs]` puis
`[tired]`, une ligne de statut factuelle attrape une balise et s'arrête. La passe fait le travail.

## 3. Le garde-fou, et c'est le vrai sujet

Une passe LLM à qui on demande « ajoute juste des balises » fait parfois autre chose : elle
reformule, elle traduit, elle raccourcit, ou elle re-répond à la question. Sur une voix générique
c'est un défaut. **Sur une voix clonée, c'est un enregistrement de quelqu'un disant une phrase qu'il
n'a jamais dite.**

Une consigne de prompt ne tient pas ça. Un filtre, oui :

```ts
export function sameSpokenWords(original: string, enriched: string): boolean {
  const a = spokenWords(original);   // balises retirées, accents et casse neutralisés
  const b = spokenWords(enriched);
  return a.length === b.length && a.every((w, i) => w === b[i]);
}

export function safeEnrichedText(original: string, enriched: string | null | undefined): string {
  if (!enriched) return original;
  return sameSpokenWords(original, enriched) ? enriched : original;   // dans le doute, le brut
}
```

On compare les **mots prononcés**, pas la chaîne brute : une virgule déplacée ne doit pas jeter un
enrichissement honnête, un mot changé doit le jeter à coup sûr. Le runtime n'appelle que
`safeEnrichedText()`, ce qui rend le mauvais chemin impossible à oublier.

## 4. Le piège qui ne se voit pas à la relecture : la boucle

Dès que le compagnon parle, **sa propre note vocale redescend dans le fil**. Si un transcripteur est
branché sur ce fil (le patron courant : transcrire les vocaux entrants pour que l'agent les lise),
il transcrit aussi celui-là, la transcription ressemble à un message entrant, et le compagnon **se
répond à lui-même**.

Vécu en production le 2026-08-10, au tout premier vocal envoyé. La boucle s'est arrêtée au premier
tour **par chance** : cette réponse-là était du texte. Une deuxième réponse vocale et elle tournait.

La garde est une liste d'identifiants à ignorer, et elle a deux trous, à fermer séparément :

- **il faut les deux bouts du fil.** La liste ne contenait que les identifiants de l'humain, jamais
  ceux du compagnon — inoffensif tant que rien n'était jamais venu de son côté. Une liste qui n'a vu
  passer du trafic que dans un sens paraît complète jusqu'au jour où ça circule dans l'autre.
- **il faut les deux formes d'identifiant.** Sur les connecteurs WhatsApp modernes, un même compte
  apparaît en `...@c.us` et en `...@lid` selon la session qui l'observe. Avec une seule des deux, la
  garde est simplement absente, sans message d'erreur.

Rien dans le code ne dit « le compagnon parle », donc personne n'a de raison de se demander ce qui
se passe quand il parle. Il a fallu envoyer un vrai vocal pour le voir.

## Le module

[`harness/src/lib/voice-clone.ts`](../src/lib/voice-clone.ts) — fonctions pures
(`buildTtsRequest`, `stripAudioTags`, `spokenWords`, `sameSpokenWords`, `safeEnrichedText`,
`isOwnVoiceEcho`, `looksLikeOggOpus`) plus `synthesizeVoice()` avec `fetch` injectable. Zéro
dépendance, tests dans `voice-clone.test.ts` :

```bash
cd harness && node --test
```

Branchement minimal dans un runtime existant :

```ts
if (isOwnVoiceEcho(ev, OWN_IDS)) return;                    // avant tout traitement
const spoken = safeEnrichedText(reply, await addTags(reply));
const ogg = await synthesizeVoice(spoken, { voiceId: VOICE_ID, apiKey: KEY });
await sendVoiceNote(chatId, ogg);                           // convert: false
```

## Pièges annexes

- **Ne proposez la voix clonée qu'à la personne clonée.** Une note vocale avec sa voix, obtenue par
  quelqu'un d'autre, est un faux qui circule. La règle est côté code (le chemin n'est offert au
  modèle que si l'expéditeur est vérifié), pas côté prompt.
- **La langue n'a besoin d'aucun code.** La réponse est déjà écrite dans la langue de la
  conversation, la synthèse ne fait que la lire. Rien à détecter, rien à configurer — bon à savoir
  avant de construire un sélecteur de langue qui n'a pas de travail.
- **Si la synthèse échoue, envoyez le texte.** Une réponse muette parce qu'un fournisseur tousse est
  pire qu'une réponse au mauvais format.
