# Amélioration de l'application — Lot 2 (temps de chargement, retour visuel)

> Cible : `packages/desktop` (Electron). Suite du Lot 1.

## Le défaut principal, vérifié

Dans `packages/desktop/src/main/index.ts`, la fenêtre était créée **après**
`yield* Fiber.await(loadingTask)` (`:411` → `restoreMainWindows()` en `:422`), et cette tâche
englobe le démarrage du sidecar **et** l'attente de santé (jusqu'à 30 s). L'application restait donc
sans aucune fenêtre visible pendant tout le démarrage — c'est exactement le « l'app peut sembler
bloquée » documenté en §8 d'`APERCU.md`.

Le plus absurde : le renderer **possède déjà** son écran d'attente
(`LoadingSplash`, `packages/desktop/src/renderer/index.tsx:326-332`) et résout le serveur par IPC
(`window.api.awaitInitialization()`, `:349`). Ce splash ne pouvait jamais s'afficher, faute de
fenêtre.

## Changements livrés

### 1. Afficher la fenêtre avant que le sidecar soit prêt

- **Zone** : `packages/desktop/src/main/index.ts`.
- **Changement** : `restoreMainWindows()` + `createMenu()` sont déplacés **avant**
  `Fiber.await(loadingTask)`. Les gestionnaires `window-all-closed` et `activate` sont enregistrés
  dans le même ordre relatif qu'avant, pour ne rien changer à leur sémantique.
- **Pourquoi c'est sûr** : `createMainWindow` ne dépend pas du serveur — il charge `index.html`
  (protocole renderer enregistré en `:274`, handlers IPC en `:285`, tous deux bien avant), et le
  renderer attend les identifiants par `awaitInitialization`. Si le sidecar échoue,
  `forwardInitializationFailure` rejette le `Deferred`, le renderer marque l'erreur
  (`localServerStartup`) et l'utilisateur obtient une **page d'erreur localisée**
  (`error.page.description.localServerStartup`, déjà traduite dans les 61 locales) au lieu d'une
  absence de fenêtre.
- **Résultat attendu** : premier affichage dès qu'Electron est prêt et les services enregistrés, au
  lieu d'après le démarrage du sidecar et sa vérification de santé. En pratique, l'attente de santé
  (jusqu'à 30 s, avec repli 30 s en cas d'échec) **ne conditionne plus l'affichage** : elle se
  déroule désormais pendant que l'utilisateur voit l'écran de chargement.

### 2. Sortir le net log du chemin critique

- **Zone** : `packages/desktop/src/main/index.ts`.
- **Défaut** : `startNetLog()` était **attendu** (`yield* Effect.promise(...)`) juste avant le fork
  de la tâche de chargement, donc avant le démarrage du sidecar. C'est un outil de diagnostic, il
  n'a aucune raison de retarder ce dont l'utilisateur a besoin.
- **Changement** : `Effect.forkChild` — le net log démarre en parallèle ; les erreurs restent
  journalisées par le même `catch`.
- **Résultat attendu** : le spawn du sidecar démarre sans attendre l'ouverture du fichier de log.

### 3. Délai de démarrage rendu testable

- **Zone** : nouveau `packages/desktop/src/main/startup-timeout.ts` + `server.ts`.
- **Raison** : la lecture de `OPENCODE_SIDECAR_STARTUP_TIMEOUT_MS` ajoutée au Lot 1 vivait dans
  `server.ts`, qui importe `electron` au niveau module et n'est donc **pas testable** sous `bun test`.
  Le calcul est extrait dans un module pur, comme le font déjà `window-registry.ts`,
  `shell-env.ts` ou `external-url.ts`.
- **Résultat attendu** : la règle de repli est verrouillée par un test — une valeur absente, nulle,
  négative ou non finie **ne peut pas** désactiver le garde-fou.

### 4. Documentation

- **Zone** : `APERCU.md` §8.
- La ligne « Timeout de démarrage … l'app peut sembler bloquée » décrivait le comportement corrigé ;
  elle est remplacée par le comportement réel et la variable d'environnement.

## Ce que je n'ai pas pu mesurer (et pourquoi)

Le gain de temps de chargement **n'a pas été chronométré de bout en bout** : cela exigerait de builder
le sidecar puis de lancer Electron, ce que cet environnement ne permet pas (et le `AGENTS.md` de
`packages/app` interdit de redémarrer l'application ou le serveur). Le changement est donc vérifié
**par construction** (ordre des opérations et absence de dépendance de la fenêtre envers le sidecar),
par le typecheck, les tests unitaires et le lint — pas par une mesure de temps réel.

De même, le temps de chargement ressenti dépend surtout du sidecar lui-même (moteur, base, watchers),
qui relève d'un autre chantier.

## Vérifications

```
typecheck app + desktop   →  2 / 2 tâches
tests desktop             →  74 pass / 1 skip / 0 fail   (dont 3 nouveaux sur le délai)
tests app (unit+browser)  →  725 pass / 0 fail  puis  41 pass / 0 fail
bun run lint              →  0 erreur
```

## Reste ouvert (Lot 3, non demandé)

- Paralléliser `cleanupStoreFiles` et `migrate` avec le démarrage du sidecar (gain de quelques
  centaines de ms, à mesurer avant/après).
- Découpage des écrans les plus lourds (`layout.tsx` 2444 l., `session.tsx` 2391 l.) : refonte
  structurelle exigeant un benchmark de production avant/après.
- `aria-label="Toggle debug tools"` en dur (`titlebar.tsx:656`) : impose 61 traductions, chantier i18n
  dédié.
