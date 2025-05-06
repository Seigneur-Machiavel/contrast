# Guide de style de code Contrast

> **Version française**

## Sommaire
1. [Principes généraux](#principes-généraux)
2. [Bonnes pratiques](#bonnes-pratiques)
3. [Règles spécifiques Contrast](#règles-spécifiques-contrast)
4. [Commentaires et JsDoc](#commentaires-et-jsdoc)

---

## 1. Principes généraux
- **Lisibilité avant tout** : Le code doit être compréhensible rapidement par un humain.
- **Pertinence locale** : Le style peut s’adapter au contexte local d’un fichier ou d’une fonction.
- **Simplicité** : Préférer les constructions simples, éviter les surcharges de syntaxe.
- **Commentaires utiles** : Les commentaires doivent expliquer l’intention, pas paraphraser le code.

## 2. Bonnes pratiques
- Utiliser des noms explicites et descriptifs pour variables/fonctions (longs si besoin).
- Préciser systématiquement les types dans le jsdoc pour les objets complexes (même sans TypeScript).
- Agréger/manipuler les données avec tableaux et objets natifs (éviter Map/Set sauf nécessité).
- Préférer boucles et conditions compactes sans accolades pour les corps d’une seule ligne.
- Utiliser early return/continue pour éviter le nesting inutile.
- Les messages de log doivent être en anglais, explicites, et peuvent utiliser des helpers pour le formatage.

## 3. Règles spécifiques Contrast
- **Variables de classe** : toujours en haut de la classe, avant toute méthode.
- **Méthodes privées** : préfixer avec `#` (ex : `#maMethode()`), et privilégier l’encapsulation locale.
- **Organisation** : structurer le code pour la maintenabilité et l’évolutivité.
- **Pas de nesting profond** : gérer le flow depuis les niveaux supérieurs dès que possible.

## 4. Commentaires et JsDoc
- **JsDoc** : doit être compact, juste au-dessus de la méthode/fonction, en anglais.
  - Documenter uniquement les `@param` (et `@returns` si non évident pour l’IDE).
  - Exemple :
    ```js
    /** Download snapshot file
     * @param {string} hash
     * @param {string} fileName
     * @param {Uint8Array|Buffer} buffer */
    async saveSnapshotFile(hash, fileName, buffer) { ... }
    ```
- Les commentaires doivent être utiles, jamais redondants avec le code.
- Ne jamais réaffecter une variable sans raison valable : préférer l'immutabilité ou la mise à jour directe.
- Les commentaires doivent uniquement expliquer la logique métier ou l'intention, jamais paraphraser le code.
- Toujours utiliser les fonctions fléchées pour les callbacks (notamment dans les logs).
- Pas de lignes vides inutiles à l'intérieur des méthodes.
- Utiliser des méthodes privées locales (préfixées par #) dès que c'est logique pour l'encapsulation et la lisibilité.
- Tout le code, les noms et les commentaires doivent être en anglais (pas de français dans le code).

## Exemples et cas pratiques

### Boucles, blocs et nesting
- Si le corps d’une boucle ou d’un `if` ne contient qu’une seule instruction, les accolades peuvent être omises pour alléger le code :

```js
for (const h of Object.keys(hashes))
    if (!existing.has(h)) delete hashes[h];
```

- Pour les instructions très courtes, un one-liner est accepté :

```js
for (const h of Object.keys(hashes)) if (!existing.has(h)) delete hashes[h];
```

- **Évite le nesting inutile** : inverse la condition et utilise un early break/return pour éviter les blocs imbriqués, sauf si le nesting apporte une clarté locale évidente.

**Avant (nesting inutile)**
```js
switch (type) {
  case 'foo':
    if (cond) {
      doSomething();
    }
    break;
}
```
**Après (nesting évité)**
```js
switch (type) {
  case 'foo':
    if (!cond) break;
    doSomething();
    break;
}
```

### Espaces et indentation
- Indentation de 1 tabulation (`\t`).
- Espaces autour des opérateurs pour la lisibilité.
- Pas de règles strictes sur les sauts de ligne : aérer où c’est utile.

### Fonctions et classes
- Les signatures de fonctions sont compactes, les types précisés en JsDoc si pertinent.
- Les méthodes privées commencent par `#` si besoin.

### Imports
- Toujours regrouper les imports en haut de fichier, dans un ordre logique (libs, utilitaires, locaux).

### Formatage JSDoc
- Les commentaires JSDoc doivent être rédigés en anglais, jamais en français.
- Préférer un commentaire sur une seule ligne si la description est très courte : /** description @param ... */
- Si la description est plus longue, utiliser un format multi-ligne compact :
/** Description
 * @param ...
 * @param ... */
  (Le '*/' doit être à la fin de la dernière ligne, jamais seul sur une ligne.)
- Ne pas utiliser @returns sauf nécessité absolue ; le type de retour doit être inféré par l’IDE.

### Accolades et one-liners
- Supprimer les accolades inutiles pour les if/for/while d'une seule ligne.
- Utiliser les one-liners quand cela améliore la lisibilité et la clarté.
- Éviter le nesting superflu, inverser les conditions et utiliser un return/continue anticipé dès que possible.
- Si un bloc catch ne fait que loguer, l’écrire sur une seule ligne pour plus de compacité.

### Points-virgules
- Toujours terminer chaque instruction par un point-virgule pour la lisibilité et la cohérence.

---

Ce style est flexible et peut évoluer selon les besoins du projet ou des contributeurs. L’important est de garder le code agréable à lire et à relire.
