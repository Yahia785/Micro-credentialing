# Component guidance

Specific guidance for the components in `src/components/ui/` and common page patterns.
All values come from `src/styles/tokens.css`.

## Button
- Variants: primary (one per area), secondary (bordered, neutral), danger (destructive only),
  ghost (low-emphasis actions like "Cancel" or toolbar actions).
- Height is consistent across variants at the same size; sm is for dense tables and toolbars.
- Loading state: keep the button's width stable, show a small spinner plus the label
  ("Submitting…"), and disable it to prevent double submission.
- Disabled buttons stay readable (reduced contrast, not invisible) and use `cursor: not-allowed`.

## Card
- White surface, 1px border from tokens, small radius, at most a subtle small shadow.
- Interactive cards: hover changes border color or shadow slightly (no movement or scaling).
  The whole card should not be a click target if it also contains buttons; put the action in
  a button instead.
- Consistent inner padding; header, body, and footer separated by spacing, not heavy lines.

## Badge, DifficultyBadge, StatusBadge
- Small, subtle background with darker text of the same tone (the "subtle" + "text-on-subtle"
  token pair), not solid bright fills.
- Always a text label; an icon is optional and never replaces the text.
- Difficulty: easy / medium / hard map to success / warning / danger tones, with the word
  written out.

## Forms (FormField, Input, Textarea, Select)
- Label above the field, in medium weight. Mark required fields with "(required)" text, not
  just an asterisk.
- Hint text below the field in secondary text color; error text below it in danger color,
  replacing or following the hint.
- Fields are full width inside their container unless the content is naturally short
  (for example, a score out of 100).
- Group related fields with a heading; don't put more than one field per row except for
  short pairs.
- Show validation errors after the user leaves a field or submits, not on every keystroke.

## Alert
- Used for page- or section-level messages (errors, success after an action, important info).
- Subtle background, left border or icon in the tone color, a short title when useful,
  then one or two sentences.
- Errors include what to do next and a retry action when possible.

## EmptyState
- Centered in the content area, with generous vertical space.
- Structure: optional simple icon, title ("No assessments yet"), one sentence of explanation,
  optional action button.
- Students and admins get different wording when their next step differs.

## PageHeader
- Page title (the largest heading on the page), optional one-line description in secondary
  text, optional actions aligned right (for example, "Add problem" for admins).
- Consistent spacing below it on every page.

## Tables (instructor views)
- Left-align text, right-align numbers, and keep column widths stable.
- Sticky header for long tables; zebra striping or row dividers, not both.
- Row actions on the right, as small secondary or ghost buttons.
- Filters sit above the table in one row; show the active filters and a "Clear filters" action.

## Assessment and code editor layout (reference for later phases)
- Problem description on the left, editor on the right, output below the editor.
- The description panel uses reading typography (see the readability principle).
- A persistent, calm indicator shows that proctoring is active (for example, "Recording"
  with a small static dot), not a flashing or pulsing element.
- The submit action is clearly visible but separated from editor controls, and it always asks
  for confirmation.