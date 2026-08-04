# Garde-fou d'envoi WhatsApp — cadence, groupes, et le principe du read-only

`harness/src/wa-guard.ts` + `harness/bin/wa-guard.ts` implémentent un hook PreToolUse branché sur
les outils d'envoi WhatsApp. Trois idées à retenir si tu adaptes ce mécanisme à ton propre canal
de messagerie.

## 1. Un garde-fou mécanique, pas comportemental

Une rafale de messages envoyés d'un coup — surtout vers plusieurs destinataires distincts — est
exactement le signal que les plateformes de messagerie traitent comme du spam, jusqu'au
bannissement du numéro. Se dire « je ferai attention » ne suffit pas : un agent qui raisonne peut
se tromper, halluciner une urgence, ou simplement mal évaluer une rafale légitime au moment de
l'envoi.

D'où un garde-fou qui **ne dépend pas du jugement de l'agent à l'instant T** : il vit dans un hook
qui intercepte l'appel d'outil AVANT qu'il ne parte, et refuse silencieusement (ou avec une raison
explicite) si la cadence, le fan-out (nombre de destinataires distincts) ou l'état du canal ne le
permettent pas. Voir `decide()` dans `src/wa-guard.ts` pour le détail des règles.

## 2. Groupes verrouillés par défaut

Écrire dans un groupe multiplie le risque : plusieurs destinataires humains voient le message d'un
coup, et une bévue y est visible par tout le monde en même temps. Le principe retenu : **un groupe
est verrouillé tant qu'il n'a pas été explicitement ajouté à une allowlist versionnée** (commitée
dans le dépôt, jamais un simple fichier local). Déverrouiller un groupe est donc une décision
traçable, prise une fois, pas un geste ambiant.

## 3. Le principe read-only-by-design (et pourquoi il compte)

Un compagnon qui a accès à ton compte personnel WhatsApp (pour LIRE tes messages — utile pour rester
informé, transcrire tes vocaux, etc.) ne devrait **jamais** avoir de chemin technique direct pour
ENVOYER en ton nom sur ce canal-là. Ce n'est pas une histoire de confiance dans le jugement de
l'agent : c'est un choix de conception qui rend l'erreur *structurellement impossible*, pas juste
peu probable.

Concrètement, ce module refuse systématiquement tout appel d'outil d'envoi qui passe par le canal
« humain » (celui utilisé pour lire, pas pour parler) — voir la règle 0 de `decide()`. Le seul canal
qui envoie normalement est le canal dédié de l'agent (son propre numéro, sa propre voix).

**Pourquoi c'est important.** Parler à la place d'un humain — même avec les meilleures intentions —
peut avoir des conséquences qu'une IA n'est pas en mesure d'évaluer complètement : un mot mal choisi
dans une relation professionnelle, un engagement pris sans que la personne le sache, une réponse à
un message qu'elle voulait garder pour elle. Si un jour tu as un vrai besoin d'impersonation
(répondre au nom de l'humain sur son propre canal, dans un cas précis et exceptionnel), la règle à
tenir est simple : **une validation humaine explicite, à chaque fois, jamais automatique.** Le
contenu exact du message doit être soumis, et l'envoi ne part qu'après un accord donné pour CET
envoi précis — pas un accord général donné une fois qui autoriserait tous les suivants. Ce dépôt ne
prescrit pas de flux concret pour ça (la manière de demander/recevoir l'accord dépend entièrement de
ton architecture) : retiens juste le principe, et construis ton propre circuit de validation en
gardant ce garde-fou en place comme filet — il continuera de refuser tout envoi direct même si ton
circuit de validation a un bug.
