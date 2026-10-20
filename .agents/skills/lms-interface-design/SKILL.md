---
name: lms-interface-design
description: Design and review principles for the micro-credentialing platform's academic, LMS-style interface (student assessments, proctored code editor, credentials, instructor review tools). Use this skill whenever building, restyling, or reviewing any UI in frontend/ — components, pages, layouts, forms, tables, badges, empty/loading/error states, or copy/microcopy — even if the task only says "style this", "clean up this page", or "build a component". Also use it when choosing colors, typography, spacing, or deciding how status, progress, or errors are shown.
---

# LMS Interface Design

This platform is where students take proctored programming assessments and earn blockchain
credentials, and where instructors review submissions. People use it while being evaluated.
Every design choice should lower stress and cognitive load, and make the next step obvious.

Target feel: **calm, academic, trustworthy, highly readable.** Think of a well-kept university
LMS (Canvas-like structure) with more polish. Not a marketing site, not a startup landing page,
not a game.

## Before you design anything

1. Read `frontend/CLAUDE.md`. Its rules (CSS Modules + tokens, no Tailwind, excluded files,
   build/lint checks) always win over this skill.
2. Read `src/styles/tokens.css` and use only those tokens. If a token is missing or a token value
   conflicts with these principles (for example, low contrast or an overly saturated primary),
   do not hardcode a workaround. Propose the token change and explain why.
3. Check `src/components/ui/` for an existing component before creating a new one.

## Core principles

### 1. Focus over decoration
- One primary action per screen or panel. Everything else is secondary or ghost.
- No decorative elements: no gradients, glassmorphism, background illustrations,
  hero sections, or ornamental icons.
- During an assessment, the UI recedes: the problem, the editor, and the submit action are the
  only things competing for attention.

### 2. No distracting motion
- No animations for decoration or delight: no bouncing, sliding panels, confetti, parallax,
  skeleton shimmer, or pulsing elements.
- Allowed: instant state changes, or simple color/opacity transitions of at most 150ms on hover
  and focus.
- Always honor `prefers-reduced-motion: reduce` by removing transitions entirely.
- Loading indicators should be static text or a simple spinner, never an attention-grabbing effect.

### 3. Status is always explicit
Students must always know where they stand. Every assessment and submission shows its status
with **text plus color**, never color alone:

| Status        | Meaning                                   | Semantic tone |
|---------------|-------------------------------------------|---------------|
| Not started   | Available, no attempt yet                 | neutral       |
| Under review  | Submitted, waiting for instructor         | info          |
| Approved      | Passed review                             | success       |
| Credentialed  | Credential issued                         | success       |
| Rejected      | Did not pass review                       | danger        |

Use the exact status values the codebase already uses; this table describes meaning and tone.
Where a status implies a next step (for example, rejected), show that step in plain text next to it.

### 4. Readability first
- Body text is at least 16px, line-height about 1.5, and long text is capped at about 70
  characters per line (`max-width: 70ch`).
- Use the type scale from tokens; don't invent sizes. Use a maximum of 3 heading levels on a page.
- Problem descriptions and rubrics are reading material: generous spacing between paragraphs,
  clear headings, lists for requirements.
- Code always uses the monospace token, in a bordered block with enough padding and horizontal
  scroll instead of wrapping.

### 5. Familiar LMS structure
Students already know Canvas. Reuse its mental model instead of inventing new patterns:
- A persistent left sidebar for main navigation; a header with the user and sign-out.
- A page title at the top of every page, with an optional one-line description under it.
- Lists of assessments as cards or rows showing: title, short description, difficulty,
  status, and one clear action.
- Instructor views can be denser (tables, filters), but still scannable: aligned columns,
  consistent row height, sticky header for long tables.

### 6. Color with restraint
- Neutral surfaces (white or near-white cards on a light gray page) make up most of the screen.
- The brand primary color is for primary actions, active navigation, and links only.
- Semantic colors (success, warning, danger, info) are for status and messages only, never
  for decoration.
- Every text/background pair meets WCAG AA (4.5:1 for normal text, 3:1 for large text and
  UI boundaries).

### 7. Every state is designed
Every component or page that loads data needs all of these, designed deliberately:
- **Loading:** a spinner or short "Loading assessments…" text in the space the content will occupy.
- **Empty:** EmptyState with a title, one sentence explaining why it's empty, and the next action
  if there is one. Different messages for students and admins where relevant.
- **Error:** Alert (danger) in plain language, what the user can do, and a retry action when
  possible. Never show raw error objects or stack traces.
- **Disabled:** visibly disabled, and where the reason isn't obvious, a short hint explaining why.

### 8. Calm, clear microcopy
- Plain, direct, respectful language. Address the student as "you".
- Buttons are verbs that say what happens: "Start assessment", "Submit solution", "Approve and
  issue credential". Avoid "OK", "Go", "Click here".
- Proctoring and academic integrity messages are neutral and factual, not threatening.
  Good: "Your camera and screen will be recorded until you submit." Avoid: "Cheating will be
  detected."
- Errors explain what happened and what to do next, without blaming the user.
- No emoji in UI text. Replace existing emoji in labels when restyling a component.

### 9. Destructive and high-stakes actions
- Deleting, rejecting, and submitting an assessment require confirmation that names the
  consequence ("Submit your solution? You can't edit it after submitting.").
- Destructive buttons use the danger variant and are never the default-focused button.
- Keep destructive actions visually separated from the primary action.

### 10. Accessibility is a baseline, not a pass
- Semantic HTML first: `button` for actions, `a` for navigation, real `label` elements, landmarks
  (`header`, `nav`, `main`).
- Every interactive element is reachable and usable by keyboard, with a clearly visible
  `:focus-visible` outline from the tokens.
- Form fields: label above the field, hint below it, error below it linked with
  `aria-describedby`, and `aria-invalid` when in error.
- Icon-only buttons have an `aria-label`. Status changes that appear without a page change
  are announced (for example, `role="status"`).

## Component-level guidance

See `references/components.md` for specific guidance on buttons, cards, badges, forms, alerts,
empty states, page headers, tables, and the assessment layout. Read it when building or
restyling any of those.

## Review checklist

Before finishing any UI task, check:
- [ ] Only tokens used; no hex colors or raw px spacing in component code.
- [ ] One clear primary action per screen or panel.
- [ ] No decorative motion; transitions at most 150ms; reduced-motion respected.
- [ ] Status shown with text plus color.
- [ ] Loading, empty, error, and disabled states all handled.
- [ ] Text contrast meets WCAG AA; body text at least 16px.
- [ ] Keyboard navigation and visible focus work.
- [ ] Button labels are specific verbs; no emoji in UI text.
- [ ] Destructive actions confirmed and visually separated.

In your summary, list any checklist item you could not meet and why.