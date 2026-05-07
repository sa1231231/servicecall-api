# Templates Catalog

The user maintains a set of templates in the Service Call Saver API. Each template defines:
- Routing paths and transition conditions
- Data points per path (with branches if applicable)
- Per-path dispatch defaults
- End-of-Path mode per path
- Intro classifier instructions
- Agent guardrails
- Closing prompts
- All the structural stuff this skill no longer generates

This skill picks a template by name and outputs only the business-specific overrides (business name + FAQ).

## Available Templates

### `hvac`
**Vertical:** Residential HVAC
**Use for:** Heating and cooling businesses doing residential repair, maintenance, and new install consultations
**Typical paths the template handles:** Service Call (existing unit issue or maintenance), New Install Consultation (new system or replacement)
**Typical data points:** name, phone, address, problem description (service path only), scheduling
**End-of-Path mode:** typically transfer with callback fallback
**When NOT to use:** commercial-only HVAC, fleet HVAC, refrigeration-only, ductwork-only specialty shops — those would need their own templates

## Adding To This List

When the user creates a new template:
1. Add a new entry here with the template name (matching the API)
2. Note the vertical it handles
3. List typical paths the template assumes (so the skill can flag mismatches)
4. Note any obvious "do not use this for" cases

The user should update this file whenever they add a template. The skill reads this file to know what's available.

## Template Mismatch Handling

If the business doesn't fit any template:

1. Check for closest match — sometimes a residential HVAC template can stretch to cover a generic residential service business with similar routing patterns
2. Surface the mismatch to the user — show them the available templates and ask which to use, or whether to stop
3. NEVER invent a template name. NEVER use a template the user hasn't told you exists.

If the business has a routing path the chosen template doesn't cover (e.g., HVAC business that also does plumbing — the `hvac` template won't have a plumbing path), do NOT try to engineer it into the FAQ or as a custom field. Flag it in chat:

> "Heads up: owner mentioned [X] which the `hvac` template doesn't include. You'll want to add that path during the editing stage after import."

The user handles edits at the template/agent level, not in the FAQ.

## Selecting A Template

Heuristics:
- Owner says "HVAC" / "heating and cooling" / "AC repair" / "furnace install" → `hvac`
- BBB profile categorizes the business as "Air Conditioning Contractor" → likely `hvac`
- Generic "service business" with vehicle dispatch and emergency calls → check available templates, ask user

When unsure, ask the user explicitly:

> "Available templates: `hvac`. This business looks like [vertical]. Closest match is [template] — confirm or override?"

Do not guess silently.
