# Mue

**Donnez-lui votre COBOL. Il l'explique, le réécrit en Java, et prouve que les deux donnent les mêmes résultats sur des milliers d'opérations.**

<p align="center"><img src="docs/demo.gif" alt="Mue Studio : comprendre un programme COBOL, le convertir en Java, trouver un écart d'arrondi, le corriger et prouver l'équivalence" width="920"></p>

Mue est une boîte à outils open source (AGPL-3.0) pour migrer du COBOL vers Java avec des preuves :

1. **Comprendre** : analyse des programmes, copies et JCL, carte du système, règles métier avec leur ligne d'origine.
2. **Convertir** : Java lisible (`BigDecimal`, noms métier, une méthode par paragraphe, correspondance des lignes).
3. **Vérifier** : les mêmes cas (générés, cas limites, demi-centimes ciblés, ou vos propres données enregistrées) passent dans un interpréteur COBOL de référence et dans le Java ; chaque écart est remonté jusqu'à l'instruction fautive.

Tout tourne en local, sans clé ni appel réseau.

## Démarrage

```bash
git clone https://github.com/<owner>/mue.git && cd mue
npm install
npm run mue -- verify examples/banking --rounding HALF_EVEN
```

Interface web locale : `npm run studio` (http://localhost:3000).

## L'exemple CALCINT

Avec la convention Java `HALF_EVEN`, le calcul d'intérêts `CALCINT` donne **38 écarts sur 2 400 cas**, tous à la ligne 46 : le `ROUNDED` du COBOL arrondit le demi-centime vers le haut (`275,005` → `275,01`), `HALF_EVEN` vers le chiffre pair (`275,00`). Les 2 340 cas aléatoires n'en trouvent aucun : ce sont les cas ciblés sur les demi-centimes qui les révèlent. Après la correction (`--fix CALCINT=HALF_UP`) : **2 400 / 2 400 identiques**.

Ce n'est pas une preuve formelle mais du test différentiel reproductible (graine déterministe). Limites actuelles : le COBOL est exécuté par l'interpréteur de Mue (modèle IBM `ARITH(EXTEND)`), et le Java par un modèle `BigDecimal` de la même représentation intermédiaire, pas encore sur une JVM.

Le sous-ensemble COBOL pris en charge, l'architecture, la feuille de route et le comparatif sont détaillés dans le [README anglais](README.md).

## Licence

[AGPL-3.0-only](LICENSE). Une licence commerciale est possible : contactez les mainteneurs.
