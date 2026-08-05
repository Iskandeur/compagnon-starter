/**
 * Liens GitHub vers les dépôts liés à ton compagnon. Pas d'appel API GitHub live ici — une vraie
 * intégration avec stats en direct serait un chantier séparé, hors scope pour ce panneau
 * (liens + description courte suffisent).
 *
 * Ces deux entrées-ci sont STATIQUES (ton repo principal et ton éventuel repo public ne bougent
 * pas au jour le jour) — remplace les URLs ci-dessous par les tiennes. Ne committe jamais un vrai
 * chemin/token ici, seulement des URLs GitHub publiques ou le nom de ton propre repo privé (le nom
 * d'un repo n'est pas un secret en soi, contrairement à son contenu).
 *
 * Les **knowledge repos**, eux, sont lus DYNAMIQUEMENT depuis `knowledge/registry.json` —
 * cf. `src/knowledge-repos.js`, assemblé dans la route `GET /api/github`.
 */
export const GITHUB_LINKS = {
  main: {
    label: "Repo principal",
    url: "https://github.com/<toi>/<ton-repo-principal>",
    visibility: "privé",
    description: "Âme + corps de ton compagnon — identité, mémoire, protocoles, harnais. Ce dépôt même.",
  },
  public: {
    label: "Repo public / portfolio",
    url: "https://github.com/<toi>/<ton-repo-public>",
    visibility: "public",
    description: "Si tu en as un : un fork/dérivé public que tu montres, un starter, etc.",
  },
  knowledgeNote:
    "Dépôts privés dédiés, un par domaine : ton compagnon les clone dans knowledge/<nom>/ " +
    "(git-ignorés du dépôt principal) et les charge à la demande selon le sujet. Liste et domaines " +
    "lus en direct depuis knowledge/registry.json — seules les MÉTADONNÉES sont exposées ici, " +
    "jamais le contenu.",
};
