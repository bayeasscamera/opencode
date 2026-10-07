# Amélioration de l'application — Lot 1 (bugs, performance, expérience)

> Cible : l'application de bureau **« OpenCode Asse »** — `packages/desktop` (Electron) et
> `packages/app` (interface SolidJS qu'elle réutilise).
> Périmètre validé : **Lot 1** (correctifs sûrs et testables). Le démarrage du sidecar (P1/U3) et le
> découpage des écrans (P2) restent hors de ce lot.

## Ce que l'audit initial annonçait — et que j'ai retiré

Trois de mes constats de cadrage étaient **faux** après vérification dans le code. Je les retire
plutôt que de livrer du travail inutile :

| Constat annoncé                          | Réalité vérifiée                                                                                  |
| ---------------------------------------- | ------------------------------------------------------------------------------------------------- |
| B2 — `layout.tsx` : timers non nettoyés  | **Faux.** `layout.tsx:210-217` nettoie `sortNowTimeout`, `sortNowInterval`, `sizet`, `peekt`      |
| B3 — `draft-store.ts` : flush non annulé | **Faux.** `flush()` annule le timer (`draft-store.ts:40-41`) et `close()` appelle `flush()` (:78) |
| — `app/utils/draft-store.ts` : 13 fuites | **Faux.** Ce sont des écouteurs IndexedDB à portée requête, résolus à chaque opération            |
| U1 — `titlebar.tsx:656` viole l'i18n     | **Vrai mais non corrigé ici.** Voir « Écarté volontairement »                                     |

## Correctifs livrés

### 1. Chevauchement des sondes de santé (performance, consommation)

- **Zone** : `packages/app/src/utils/server-health.ts`.
- **Défaut** : `pollMs = 10_000` alors que `checkServerHealth` autorise **30 s** par requête
  (`defaultTimeoutMs`) plus 2 tentatives. Contre un serveur injoignable, chaque tick de 10 s lançait
  une nouvelle requête de 30 s pendant que les précédentes étaient encore en vol : les requêtes
  s'empilaient sans limite.
- **Changements** : intervalle porté à **45 s** (au-dessus du pire cas d'une passe), garde de
  ré-entrance (`running`) pour qu'une passe ne puisse jamais en recouvrir une autre, et **backoff
  progressif** des tentatives (`200ms × 2^n` au lieu de 100 ms fixe).
- **Résultat attendu** : une seule passe en vol à tout instant ; sur un serveur éteint, passage de
  requêtes empilées à **2 requêtes par passe** (mesuré par test) ; plus de rafale de trois requêtes
  espacées de 100 ms sur un serveur en cours de démarrage.

### 2. Veille en fenêtre masquée (consommation de ressources)

- **Zone** : `packages/app/src/utils/server-health.ts`.
- **Défaut** : la boucle sondait indéfiniment, y compris fenêtre réduite ou masquée, où **rien
  n'affiche le résultat** — cela maintenait le processus (et le sidecar) éveillés pour rien.
- **Changement** : la sonde ne s'exécute plus que lorsque `document.visibilityState === "visible"`,
  via `makeEventListener(document, "visibilitychange", tick)` (utilitaire déjà employé par
  `layout.tsx`). Le retour au premier plan déclenche un rafraîchissement immédiat.
- **Résultat attendu** : plus aucune requête réseau en arrière-plan ; l'indicateur est à jour dès
  que la fenêtre redevient visible.

### 3. Cache de santé non borné (fuite mémoire)

- **Zone** : `packages/app/src/utils/server-health.ts`.
- **Défaut** : `healthCache` (clé = URL + identifiants + `fetch`) n'était **jamais purgé** : une
  entrée par serveur distinct utilisé, pour toute la durée de vie du processus.
- **Changement** : borne à **8 entrées** avec éviction du plus ancien (la ré-insertion déplace la clé
  en fin d'ordre d'itération de la `Map`, ce qui suffit à un comportement LRU).
- **Résultat attendu** : mémoire stable après rotation sur de nombreux serveurs.

### 4. Délai de démarrage du sidecar configurable (temps de chargement, diagnostic)

- **Zone** : `packages/desktop/src/main/server.ts`.
- **Défaut** : `SIDECAR_START_STALL_TIMEOUT` figé à **60 s** ; sur machine lente (démarrage à froid,
  analyse antivirus), l'échec se présentait comme un « le serveur n'a pas démarré » opaque et **non
  paramétrable** (documenté en §8 d'`APERCU.md`).
- **Changement** : lecture de `OPENCODE_SIDECAR_STARTUP_TIMEOUT_MS`, avec repli à 60 s et **rejet des
  valeurs non finies ou négatives**.
- **Résultat attendu** : un environnement lent peut allonger la fenêtre sans recompiler ; la cause
  devient diagnosticable sans code.

### 5. Test de non-régression

- **Zone** : `packages/app/src/utils/server-health.test.ts`.
- **Ajout** : un serveur qui **répond** `{ healthy: false }` n'est **pas** réessayé — la réponse est
  autoritaire, la passe coûte une seule requête et aucun délai. Seuls les serveurs injoignables le
  sont. Ce test a d'ailleurs corrigé une de mes hypothèses (j'attendais 2 requêtes, le code en fait
  bien 1).

## Écarté volontairement (et pourquoi)

- **`titlebar.tsx:656` — `aria-label="Toggle debug tools"` en dur** : c'est une **vraie** violation de
  la règle i18n d'`AGENTS.md` (app _et_ desktop). Non corrigée ici car le test
  `packages/app/src/i18n/parity.test.ts` exige que **les 61 locales** définissent **chaque** clé
  anglaise : toute clé nouvelle impose 61 traductions, et les consignes du dépôt **interdisent de
  traduire « de mémoire »** (elles exigent des corpus de référence : CLDR, guides Microsoft/Apple,
  Pontoon…). À traiter comme un chantier i18n dédié, sinon la CI casse.
- **P1/U3 (parallélisation du démarrage, retour visuel pendant les 60 s)** : demanderait de builder le
  sidecar pour être vérifié, et touche le chemin critique de lancement.
- **P2 (découpage de `layout.tsx` 2444 l. et `session.tsx` 2391 l.)** : refonte structurelle, à
  mesurer avec un benchmark de production avant/après (règle explicite d'`AGENTS.md` pour la session
  et la timeline).

## Vérifications

```
typecheck app + desktop   →  2 / 2 tâches
tests app (unit+browser)  →  725 pass / 0 fail  puis  41 pass / 0 fail
tests desktop             →  71 pass / 1 skip / 0 fail
server-health.test.ts     →  10 pass / 0 fail  (dont le nouveau cas)
bun run lint              →  0 erreur
```
