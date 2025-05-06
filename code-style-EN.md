# Contrast Code Style Guide

> **English version**

## Table of Contents
1. [General Principles](#general-principles)
2. [Best Practices](#best-practices)
3. [Contrast-Specific Rules](#contrast-specific-rules)
4. [Comments and JsDoc](#comments-and-jsdoc)
5. [Practical Examples](#practical-examples)
6. [Semicolons](#semicolons)

---

## 1. General Principles
- **Readability first**: Code must be quickly understandable by a human.
- **Local relevance**: Style can adapt to the local context of a file or function.
- **Simplicity**: Prefer simple constructions, avoid syntactic overload.
- **Useful comments**: Comments should explain intent, never paraphrase the code.

## 2. Best Practices
- Use explicit and descriptive names for variables/functions (long names if needed).
- Always specify types in jsdoc for complex objects (even without TypeScript).
- Aggregate/manipulate data with native arrays and objects (avoid Map/Set unless really needed).
- Prefer compact loops and conditions without braces for single-line bodies.
- Use early return/continue to avoid unnecessary nesting.
- Log messages must be in English, explicit, and may use helpers for formatting.
- Never reassign a variable without a good reason: prefer immutability or direct update.
- Comments should only explain business logic or intent, never paraphrase the code.
- Always use arrow functions for callbacks (especially in logs).
- No unnecessary blank lines inside methods.
- Use local private methods (prefixed by #) whenever logical for encapsulation and readability.
- All code, names, and comments must be in English (no French in code).

## 3. Contrast-Specific Rules
- **Class variables**: always at the top of the class, before any method.
- **Private methods**: prefix with `#` (e.g. `#myMethod()`), and favor local encapsulation.
- **Organization**: structure code for maintainability and future-proofing.
- **No deep nesting**: manage flow from higher levels whenever possible.

## 4. Comments and JsDoc
- **JsDoc**: must be compact, directly above the method/function, in English.
  - Only document `@param` (and `@returns` if not obvious to the IDE).
  - Example:
    ```js
    /** Download snapshot file
     * @param {string} hash
     * @param {string} fileName
     * @param {Uint8Array|Buffer} buffer */
    async saveSnapshotFile(hash, fileName, buffer) { ... }
    ```
- Comments must be useful, never redundant with the code.

## 5. Practical Examples

### Loops, blocks, and nesting
- If the body of a loop or `if` only contains a single statement, braces can be omitted to lighten the code:

```js
for (const h of Object.keys(hashes))
    if (!existing.has(h)) delete hashes[h];
```

- For very short instructions, a one-liner is accepted:

```js
for (const h of Object.keys(hashes)) if (!existing.has(h)) delete hashes[h];
```

- **Avoid unnecessary nesting**: invert the condition and use an early break/return to avoid nested blocks, unless nesting brings clear local clarity.

**Before (unnecessary nesting)**
```js
switch (type) {
  case 'foo':
    if (cond) {
      doSomething();
    }
    break;
}
```
**After (nesting avoided)**
```js
switch (type) {
  case 'foo':
    if (!cond) break;
    doSomething();
    break;
}
```
- Avoid superfluous nesting, invert conditions, and use early return/continue whenever possible.
- If a catch block only logs, write it on a single line for compactness.

### Semicolons
- Always end every statement with a semicolon for readability and consistency.
