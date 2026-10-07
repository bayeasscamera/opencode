# Correctifs P1 (dettes identifiées, faible risque)

> Suite de l'audit structurel et des Lots 1 et 2. Objets 6 à 8 de la liste priorisée.

## 6. `typecheck` sur toutes les PR — corrigé

- **Zone** : `.github/workflows/typecheck.yml`.
- **Défaut** : le déclencheur `pull_request: branches: [dev]` filtre la **branche de base**. Une PR
  ouverte vers une autre branche n'était donc **jamais typée** — le filet le plus large du dépôt ne
  s'appliquait qu'à un seul cas de figure.
- **Changement** : suppression du filtre, `pull_request` couvre désormais toutes les bases. Le
  déclencheur `push` reste limité à `dev` (volontaire).
- **Résultat attendu** : toute PR est typée, quelle que soit sa cible.

## 7. Dépendances hors catalogue — traité de façon sélective

L'audit annonçait « 20 dépendances en range flottant ». La vérification montre que **le chiffre était
trompeur** : la majorité ne sont pas des défauts.

| Cas                                                                                                                                                             | Constat                                                                                                                                 | Décision                                                                                                                                          |
| --------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| `solid-js ^1.9.0`, `@solidjs/meta ^0.29.0` (`packages/ui`)                                                                                                      | Ce sont des **`peerDependencies`** : une plage y est le **contrat de compatibilité** attendu d'un consommateur, pas une version à figer | **Non modifié** — convertir en `catalog:` resserrerait le contrat et pourrait casser des consommateurs                                            |
| `semver ^7.6.3` (core, opencode, script)                                                                                                                        | Le catalogue déclare `semver 7.7.4` mais **personne ne l'utilise** (`0` usage de `catalog:`), et le lock résout 7.8.x                   | **Non modifié** — aligner serait un **downgrade** ; l'entrée de catalogue est en fait **obsolète** (à supprimer ou rafraîchir, décision d'équipe) |
| `@types/semver ^7.5.8` (opencode, script)                                                                                                                       | Dépendance **dev**, type uniquement ; le lock résout déjà la version du catalogue (7.7.1)                                               | **Corrigé** → `catalog:`. Gain : suppression d'une incohérence déclarative **sans aucun changement de résolution**                                |
| `electron-log ^5`, `electron-window-state ^5.0.3`, `electron-vite ^5`, `typescript ~5.6.2` (desktop), `aws4fetch ^1.0.20`, `@slack/bolt ^3.17.1`, 7 × storybook | Aucune entrée de catalogue : dépendances à **usage unique**. Le catalogue n'a pas à les héberger                                        | **Non modifiés** — ce ne sont pas des violations                                                                                                  |

**Preuve pour `@types/semver`** : `bun install` rapporte `Checked 2406 installs across 2697
packages (no changes)` et le diff de `bun.lock` fait **2 lignes** (les deux déclarations), sans
changement de version résolue.

Le point restant (`typescript ~5.6.2` desktop vs catalogue 5.8.2) est **volontairement non touché** :
le typecheck de `packages/desktop` passe par `tsgo`, donc **aucune vérification automatique ne
couvrirait** un changement de version de `typescript`. Modifier sans pouvoir mesurer serait imprudent.

## 8. Patches — documentés

- **Zone** : nouveau `patches/README.md`.
- **Constat** : les 19 patches déclarés dans `patchedDependencies` n'avaient **aucune justification
  écrite**.
- **Contenu livré** : inventaire vérifiable (paquet, fichiers, lignes ajoutées/retirées, contact avec
  `dist/`), ce qui est **établi par lecture du diff** pour 3 patches sensibles
  (`effect` → identifiant OpenAPI du champ SSE ; `@modelcontextprotocol/sdk` → expiration de session
  et surcharges `callTool` ; `@ai-sdk/openai` → retrait de `serviceTier`), et une section explicitant
  que **la raison des 15 autres reste à écrire par leur auteur** plutôt que d'inventer.
- **Fragilité mise en évidence** : **14 patches sur 19** modifient du `dist/`, dont **6 uniquement du
  `dist/`** — ceux-là peuvent être perdus silencieusement lors d'une montée de version ou d'une
  reconstruction.
- **Correction d'une recommandation antérieure** : `patches/install-korean-ime-fix.sh` **n'est pas**
  un patch `bun` (c'est un installateur communautaire conservé depuis l'amont, lié à l'issue
  #14371). Le déplacer serait une décision d'équipe, pas un correctif — le README le documente.

## Blocage constaté sur le P0 (à traiter par vous)

Le `push` est **impossible en l'état** :

```
remote: Permission to anomalyco/opencode.git denied to bayeasscamera.
fatal: unable to access 'https://github.com/anomalyco/opencode.git/': The requested URL returned error: 403
```

Le remote `origin` pointe vers le dépôt **amont** (`anomalyco/opencode`), sur lequel vous n'avez pas
de droit d'écriture, et aucune branche distante `security-hardening` n'existe. Remède :

```sh
# 1. créer un fork sur GitHub, puis :
git remote add fork git@github.com:<votre-compte>/opencode.git
git push -u fork security-hardening
# 2. ouvrir la PR depuis le fork vers anomalyco/opencode:dev
```
