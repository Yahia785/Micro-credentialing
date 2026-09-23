# Frontend conventions

This file governs work under `frontend/`. It reflects the ongoing routing/layout/design-system
rework (see project plan for the milestone list); update it as later milestones land.

## Styling

- Use CSS Modules (`Name.module.css`) alongside the tokens defined in `src/styles/tokens.css`.
- No hex colors and no raw px spacing values in components — use `var(--color-...)`,
  `var(--space-...)`, `var(--radius-...)`, etc.
- Do not add new inline `style={{}}` objects except for genuinely dynamic values that can't be
  expressed in CSS (e.g. a computed width/height, a progress percentage).
- `src/styles/tokens.css` and `src/styles/base.css` are imported once, in `main.tsx`. Don't
  re-import them elsewhere.

## Structure

- Reusable UI components live in `src/components/ui/` (introduced in milestone 2) — check there
  before creating a new component.
- Pages live in `src/pages/`. Routes and the app shell/layout live in `src/app/` (both introduced
  in milestone 4).
- API calls go through `src/api/*`. Components must not call `fetch`/`axios` directly in new code.


## Files excluded from the rework

These are scheduled for a rebuild and should not be restyled or restructured unless a task
explicitly asks for it:

- `src/components/CodeEditor.tsx`
- `src/components/EmbeddedEnvironment.tsx`
- `src/components/proctoring/*`
- `src/components/AdminReviewsTab.tsx`

## Before finishing any task

Run from `frontend/`:

```
npm run build
npm run lint
```

- `npm run build` must pass fully (both `tsc -b` and `vite build`). It passed cleanly as of
  Sep 2026, so any build failure is new and must be fixed.
- Lint baseline (Sep 2026): 63 problems (60 errors, 3 warnings), all pre-existing. A task must
  not increase this count. Fixing existing lint errors is out of scope unless asked. If your
  change touches a file with pre-existing lint errors, leave them and mention them in your summary.
  
Fix new errors introduced by your change. Pre-existing errors/warnings unrelated to your change
don't need to be fixed, but call them out separately.
