---
name: onboarding-to-config
description: Convert a verification call transcript (plus optional website context) into a minimal JSON config for Service Call Saver agent creation. Output is just business name, FAQ knowledge base, and template name — the template handles all routing paths, data points, and dispatch defaults. Use this skill whenever the user provides a transcript or vertical hint (e.g., HVAC company in Cairo IL) and wants to onboard a client. Triggers include "build a config for this client," "process this verification call," "turn this into an agent config," "onboard this client," or "create a Service Call Saver config." Works for any service vertical that has a matching template — currently HVAC. Does NOT generate routing paths, data points, or dispatch info — those are handled at the template level.
---

# Onboarding To Config

Convert a verification call transcript (or vertical hint) into a minimal JSON config: business name, FAQ knowledge base, template name. That JSON gets passed to the Service Call Saver API, which uses the template to instantiate the full agent.

## Core Principle

Templates handle the complex stuff (routing paths, data points, branching logic, dispatch defaults, end-of-path behavior). This skill's only job is:

1. Identify the right template
2. Extract the business name
3. Build a clean, minimal FAQ Knowledge Base

No more form-filling, no more path engineering, no more JSON schema gymnastics. The skill is a focused extraction tool.

## Output Shape

```json
{
  "businessName": "string",
  "faqKnowledgeBase": "string (multi-line markdown)",
  "templateName": "string (must match an existing template)"
}
```

That's it.

## Available Templates

Currently (as of this skill version):

- **`hvac`** — Residential HVAC: heating, cooling, repair, maintenance, install consultations

Add to this list as new templates are created. If the user says a vertical that doesn't match any template, surface that and ask the user to either pick the closest available template, or stop and build the template first.

## When To Use

Trigger on any of these:
- User pastes a transcript and asks to build a config / onboard a client
- User uploads a transcript file (.txt, .md, .docx) and references a verification call with a business owner
- User says "process this verification call," "turn this into a Service Call Saver config," "onboard [business name]"
- User provides a vertical hint (e.g., "HVAC company in Cairo IL") and asks for a starter config — even without a transcript, generate a draft and clearly mark it as such

Optional context the user may also provide:
- Business website URL — scrape for supplementary info (transcript still wins on conflicts)
- Industry/vertical hint (helps pick the right template)
- BBB profile or similar low-signal source (use for basic identity confirmation only)

Do NOT trigger for:
- Custom path requests ("build a non-template config with these custom paths") — that's handled at template-creation time, not here
- Form-filling requests directly — there's no longer a UI-fill skill
- General document summarization

## Pipeline

### Step 1: Read All Inputs

Read the transcript fully if provided. If a website URL was provided, scrape with `web_fetch`. If only a vertical hint, work with that. **Transcript always overrides website on conflicts.**

If the user provides nothing usable (no transcript, no vertical, no website), ask for at minimum a vertical hint and a business name.

### Step 2: Pick The Template

Match the business to a template. If clear (e.g., "HVAC company" → `hvac`), use it. If ambiguous or no match, surface the gap to the user:

> "I don't see a template for [vertical] yet. The closest match is [closest]. Want me to use that, or stop here?"

Don't invent template names. The user controls the template list.

### Step 3: Extract Business Name

Output the short, agent-greeting form of the business name. If the owner gave both a legal name and a "what we go by" name, use the latter.

### Step 4: Build The FAQ Knowledge Base

Apply the FAQ minimization rules in `references/faq-rules.md`. The output is a multi-line markdown string with strict subsection structure.

### Step 5: Output The JSON

In chat, output:

```json
{
  "businessName": "[name]",
  "faqKnowledgeBase": "[markdown string with \\n line breaks]",
  "templateName": "[template]"
}
```

If the user requested API delivery (e.g., "POST this to the API at [endpoint]"), do that after outputting the JSON in chat for review. Otherwise, stop after chat output.

### Step 6: Flag Anything The Template Won't Handle

If the transcript revealed routing logic that doesn't fit the chosen template (e.g., HVAC business with a unique "fleet maintenance" path the standard HVAC template doesn't cover), note it briefly:

> "Note: owner mentioned [X] which the `hvac` template doesn't handle. You'll want to add that custom path during the editing stage after import."

Don't try to engineer around it. The user handles edits.

## What This Skill Does NOT Do

- Generate routing paths, data points, branches, or dispatch overrides
- Fill the form via Chrome browser automation
- Construct full agent JSON with paths array
- Pick template names that don't exist
- Generate API endpoint code or auth headers

The old `retell-agent-generator` skill is deprecated. This skill replaces both that and the prior `onboarding-transcript-to-doc` skill.

## Important Rules

- **Output only the three required fields.** No paths, no data points, no client config, no closing prompts. The template handles those.
- **Apply FAQ minimization strictly.** See `references/faq-rules.md`.
- **Use the owner's terminology** when the business name has variants. Short greeting form wins.
- **Surface gaps, don't fabricate.** If the transcript is missing service area or hours, omit those subsections rather than inventing.
- **Mark drafts as drafts.** When the user provides only a vertical hint (no transcript), put a note at the top of the chat output: "DRAFT — based on vertical pattern only, owner hasn't confirmed."
- **Don't push to the API unless explicitly asked.** Default delivery is chat output for review.

## References

- `references/faq-rules.md` — FAQ Knowledge Base minimization rules and worked examples
- `references/templates.md` — Current template catalog and what each one handles
