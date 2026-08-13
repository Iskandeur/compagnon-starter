# Coordonner plusieurs lanes — `ListAgents` / `SendMessage`

## Le principe

Un compagnon qui vit dans un daemon peut avoir plusieurs exécutions « vivantes » en parallèle — une
par groupe/canal/tâche entrante (une **lane**). Ces lanes ne partagent PAS leur contexte de
conversation entre elles automatiquement : seulement la même working directory git (donc la même
`memoire/`, mais pas le fil de raisonnement en cours de l'autre). Sans mécanisme dédié, deux lanes
peuvent traiter la même demande en double sans jamais le savoir — l'une répond à un message pendant
qu'une autre, réveillée sur un scope voisin, s'apprête à faire exactement la même chose.

## La mécanique

Deux outils Claude Code, pas du code maison à maintenir :

- **`ListAgents`** liste les lanes actuellement joignables (nom du type `<agent>-<scope>`), qu'il
  s'agisse de sous-agents lancés dans le réveil courant ou d'autres sessions locales/cloud encore
  actives.
- **`SendMessage`** envoie un message à une lane précise, identifiée par son nom (ou son id). La
  lane ciblée reprend avec tout son contexte, exactement comme un réveil normal — pas de résumé à
  reconstruire, pas de contexte perdu.

## Cas d'usage type

**Avant d'agir sur une demande qui pourrait déjà être en cours de traitement ailleurs** (un scope ou
un sujet partagé entre plusieurs canaux/réveils) : appeler `ListAgents`. Si une lane pertinente
tourne encore, `SendMessage` vers elle plutôt que deviner ou dupliquer le travail. Une réponse du
type « aucun agent joignable » signifie que rien n'est en cours — l'action peut être prise
normalement, sans plus attendre.

Ça sert aussi à **réveiller une session qui dort**, par exemple après un arrêt sur quota épuisé :
plutôt que d'attendre un évènement externe, une autre lane (ou un réveil programmé, cf.
[`self-scheduling.md`](./self-scheduling.md)) peut lui envoyer directement l'intention à reprendre.

## Limite

Ces deux outils ne remplacent pas un vrai partage de contexte automatique : ils demandent de
**savoir qu'une autre lane existe** (et son nom) pour la contacter. `ListAgents` expose ce qui est
joignable au moment de l'appel — pas de découverte proactive de « qui travaille sur quoi » au-delà
de ça. Pour une vraie file d'attente partagée entre lanes, il faudrait un état persisté commun
(ex. une table `data/` versionnée par scope) — hors du périmètre de ces deux outils.
