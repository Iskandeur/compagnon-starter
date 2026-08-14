/**
 * usage-topics — catégorise l'usage d'un compagnon (table `session_log`) par SUJET, à partir du
 * champ `summary` (texte libre). Pourquoi pas `scope`/`source` : ces colonnes disent COMMENT un
 * tour est arrivé (canal, job, veille…), jamais DE QUOI il parle — seul `summary` porte le sujet.
 *
 * `EXAMPLE_TOPIC_RULES` est un POINT DE DÉPART, pas une taxonomie universelle : les sujets d'un
 * compagnon dépendent entièrement de ce pour quoi son humain l'utilise. Relis un échantillon de
 * tes propres résumés réels (`select summary from session_log order by last_seen`) avant d'écrire
 * tes règles — ne devine pas des mots-clés à l'aveugle.
 */

export interface TopicRule {
  key: string;
  label: string;
  test: RegExp;
}

/** Ordre = priorité : la première règle qui matche gagne — range du plus spécifique au plus
 *  générique. Piège classique : une règle large (ex. "tout ce qui commence par job #") peut
 *  avaler des cas qu'une règle plus précise (ex. un sous-projet nommé) devrait attraper avant. */
export const EXAMPLE_TOPIC_RULES: TopicRule[] = [
  { key: "veille", label: "Veilles / surveillance récurrente", test: /^\[?veille\b/i },
  {
    key: "infra",
    label: "Corps / infra (déploiement, redémarrages)",
    test: /redémarr|restart|systemctl|docker|déploi/i,
  },
  { key: "dev", label: "Projets logiciels (jobs de dev)", test: /^\[?job #\d+/i },
  { key: "agenda", label: "Agenda / organisation", test: /calendrier|rendez-vous|planning|\btâche/i },
  { key: "perso", label: "Vie perso", test: /famille|anniversaire|\bsanté\b/i },
];

/** Catégorie retenue quand aucune règle ne matche — le résiduel : échanges qui ne rentrent dans
 *  aucune case ci-dessus (questions, humeur, vie quotidienne diffuse). */
export const FALLBACK_TOPIC: TopicRule = {
  key: "conversation",
  label: "Conversation directe / échange",
  test: /.*/,
};

const NO_SUMMARY_TOPIC: TopicRule = { key: "sans_resume", label: "Sans résumé", test: /.*/ };

export function categorizeSummary(
  summary: string | null | undefined,
  rules: TopicRule[] = EXAMPLE_TOPIC_RULES,
): TopicRule {
  if (!summary || !summary.trim()) return NO_SUMMARY_TOPIC;
  for (const rule of rules) {
    if (rule.test.test(summary)) return rule;
  }
  return FALLBACK_TOPIC;
}

export interface TopicBreakdownEntry {
  key: string;
  label: string;
  count: number;
  pct: number;
}

/** Compte + pourcentage par catégorie, triés du plus fréquent au moins fréquent. */
export function computeTopicBreakdown(
  summaries: Array<string | null | undefined>,
  rules: TopicRule[] = EXAMPLE_TOPIC_RULES,
): TopicBreakdownEntry[] {
  const counts = new Map<string, { label: string; count: number }>();
  for (const summary of summaries) {
    const rule = categorizeSummary(summary, rules);
    const entry = counts.get(rule.key);
    if (entry) entry.count++;
    else counts.set(rule.key, { label: rule.label, count: 1 });
  }
  const total = summaries.length;
  return [...counts.entries()]
    .map(([key, { label, count }]) => ({ key, label, count, pct: total ? (count / total) * 100 : 0 }))
    .sort((a, b) => b.count - a.count);
}
