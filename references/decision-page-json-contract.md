# Decision Page JSON Contract

Use this contract when `decisions/SKILL.md` should generate an interactive
standalone decision page instead of leading with the markdown packet fallback.

## Generator Command
```bash
npx tsx skills/decisions/scripts/generate-decision-page.ts --input <definition.json> --output <page.html>
```

The generator validates the definition first, then writes a standalone HTML artifact that:

- shows the full decision queue,
- keeps one active decision panel in focus,
- recomputes the full chosen-token set on every answer change,
- invalidates downstream answers when dependency conditions stop being true,
- copies all chosen tokens after every change,
- keeps a manual copy fallback visible,
- supports optional JSON snapshot download.

## Session Workflow

When the page is part of a real planning or decision session rather than an isolated prototype, use
the session helper so the generated page and later token-block sync share the same structured
definition:
```bash
npx tsx skills/decisions/scripts/decision-page-session.ts prepare --definition-file <definition.json> --output-dir <dir>
```

After the user pastes back the copied token block:
```bash
npx tsx skills/decisions/scripts/decision-page-session.ts summarize-token-block --definition-file <definition.json> --tokens-file <tokens.txt>
npx tsx skills/decisions/scripts/decision-page-session.ts sync-plan --definition-file <definition.json> --tokens-file <tokens.txt> --plan-file <plan.md> --execute
```

This keeps two artifacts aligned from the same canonical definition:

- the generated HTML page,
- the plan `Decision Register`.

## Top-Level Shape
```json
{
  "title": "Planning decisions",
  "eyebrow": "Planning And Decisions",
  "lede": "Short explanation of what the page is deciding.",
  "summaryCards": [
    { "title": "What this page is for", "body": "Short summary." }
  ],
  "storageKey": "decisions.example",
  "snapshotFileName": "decision-state.json",
  "decisions": []
}
```

## Definition Fields

- `title`: large page title.
- `eyebrow`: short uppercase context label.
- `lede`: introductory explanation.
- `summaryCards`: compact top-row summary cards.
- `storageKey`: localStorage key used by the generated page.
- `snapshotFileName`: optional filename for the downloaded JSON snapshot.
- `decisions`: ordered decision queue.

## Decision Shape
```json
{
  "id": "DECISION_PAGE_IMPLEMENTATION_SURFACE",
  "title": "What should own the first production decision page?",
  "statement": "Choose the first production implementation surface.",
  "blocker": true,
  "recommendationAlias": "GENERATED_HTML",
  "reasons": [
    "It proves the interaction model quickly.",
    "It keeps the first slice inspectable."
  ],
  "invalidationNote": "Changing the upstream handoff choice removes incompatible downstream answers.",
  "dependsOn": [],
  "options": []
}
```

### Decision Rules

- `id` must be unique.
- `recommendationAlias` must match one of the decision option aliases.
- `reasons` should explain why the choice matters now.
- `dependsOn` is optional. When present, it controls whether the decision is currently available.
- If a decision becomes unavailable after the user already answered it, the generated page removes
  that answer before exporting the next clipboard payload.

## Dependency Conditions

Supported operators:

- `equals`
- `notEquals`
- `oneOf`
- `notOneOf`

Examples:
```json
{
  "decisionId": "DECISION_DECISION_PAGE_TERMINAL_HANDOFF",
  "operator": "equals",
  "value": "CLIPBOARD_WITH_OPTIONAL_STATE"
}
```
```json
{
  "decisionId": "DECISION_DECISION_PAGE_TERMINAL_HANDOFF",
  "operator": "oneOf",
  "values": ["CLIPBOARD_ONLY", "CLIPBOARD_WITH_OPTIONAL_STATE"]
}
```

Rules:

- `decisionId` must reference another defined decision.
- `equals` and `notEquals` require `value`.
- `oneOf` and `notOneOf` require `values`.
- Referenced aliases must exist on the referenced decision.

## Option Shape
```json
{
  "alias": "GENERATED_HTML",
  "label": "Generated standalone HTML",
  "token": "CHOOSE_DECISION_DECISION_PAGE_IMPLEMENTATION_SURFACE_USE_GENERATED_STANDALONE_HTML",
  "description": "Use a generated standalone HTML artifact as the first production decision page.",
  "pros": [
    "Inspectable and easy to publish with a study or plan.",
    "Requires minimal runtime surface."
  ],
  "cons": [
    "Needs a generator contract.",
    "Not yet a long-lived application shell."
  ],
  "branchEffects": [
    "Keeps the first implementation artifact-oriented."
  ],
  "followUp": "If chosen, planning can implement immediately without deciding on a richer app shell."
}
```

### Option Rules

- `alias` is the short human-facing answer shown in the UI and summary block.
- `token` is the canonical persisted selector token.
- `pros` and `cons` should stay concise and scannable.
- `branchEffects` is optional and should explain invalidation or downstream-flow implications.
- `followUp` is optional and should explain what the workflow can do next.

## Clipboard Payload

The generated page copies the full current answer set after every change. The default payload shape
is:
```text
Chosen decisions

- GENERATED_HTML: What should own the first production decision page?
- SUMMARY_PLUS_TOKENS: What should the page copy by default?

TOKENS
CHOOSE_DECISION_...
CHOOSE_DECISION_...
```

This keeps short aliases visible for humans while preserving canonical tokens for workflow parsing.
