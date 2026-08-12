## Ce qui a été retiré ou changé par rapport au dashboard d'origine

- **Panneau Sensors retiré entièrement.** Il dépendait d'un registre de pré-filtres zéro-token
  (`harness/src/sensors/index.ts`) qui n'a pas d'équivalent dans le harnais de ce starter — aucun
  des modules listés dans `harness/README.md` n'implémente ce pattern. Plutôt que de porter du code
  qui ne pourrait jamais s'activer nulle part, il a été coupé (route `/api/sensors`, `src/sensors-registry.js`,
  colonnes `sensor`/décompte d'évaluations dans `src/db.js`, section HTML/CSS associée — le dernier
  résidu, `src/sensors-registry.{js,test.js}`, a traîné en code mort jusqu'au nettoyage du 12/08). Si
  ce pattern est porté séparément un jour, ce panneau peut revenir.