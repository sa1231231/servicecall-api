---
name: onboarding-to-config
description: Convert an inbound lead (typically just a name and phone number) into a minimal JSON config for Service Call Saver agent creation. Output is just business name, FAQ knowledge base, and template name — the template handles all routing paths, data points, and dispatch defaults. The skill identifies the business by web-searching the phone number first, then cross-references with the name and any other supplied context (website, notes). Use this skill whenever the user provides lead data and wants to onboard a client. Triggers include "build a config for this client," "onboard this lead," "turn this into an agent config," "create a Service Call Saver config." A transcript may occasionally be supplied but is no longer the primary input — most leads come in cold from lead forms with just contact info. Works for any service vertical that has a matching template — currently HVAC. Does NOT generate routing paths, data points, or dispatch info — those are handled at the template level.
---

# Onboarding To Config

Convert an inbound lead — typically just a name and phone number — into a minimal JSON config: business name, FAQ knowledge base, template name. That JSON gets passed to the Service Call Saver API, which uses the template to instantiate the full agent.

## Core Principle

Templates handle the complex stuff (routing paths, data points, branching logic, dispatch defaults, end-of-path behavior). This skill's only job is:

1. **Identify the business** from minimal lead data (usually just a phone number)
2. Pick the right template
3. Extract the business name in greeting-form
4. Build a clean, minimal FAQ Knowledge Base from publicly available info

No more form-filling, no more path engineering, no more JSON schema gymnastics.

## Primary Input: Lead Form Data

The dominant input shape is a lead form row from Facebook Ads or a similar capture surface:

- **Name** (often the owner or the business — could be either)
- **Phone number** (the strongest identifier — see below)
- Optional: website, notes, vertical hint

**There is usually no transcript.** Pre-call onboarding is the new norm — we build the agent before the first conversation with the prospect. Don't wait for or assume a transcript exists.

If a transcript IS provided (rare), it overrides anything found via search. Otherwise, search is the source of truth.

## Phone-Number-First Discovery

The phone number is the most reliable identifier. Always start there.

### Step 1: Search the phone number

Use the `web_search` tool to look up the phone number. A typical query: `"+19739781542"` or `"973-978-1542 business"`. Phone numbers are deduplicated across the web — if a business uses that line, it'll appear in directory listings, Google Maps, Yelp, BBB, the business's own website, etc.

You're looking for:
- Business name (canonical, as it appears on Google Maps / their site)
- Vertical / what they do (matches a template)
- Service area / location
- Any FAQ-relevant facts: hours, services, pricing notes, after-hours behavior, payment methods, scheduling style

### Step 2: Cross-reference

If the lead's `name` field doesn't match what the search returned (e.g., lead name is "Mario Mina" but the phone resolves to "Super Mario Auto Repair & Towing"), trust the phone-number-derived name — that's the business identity. The lead-form name is often the owner or whoever filled out the form, not the business itself.

If multiple businesses come up for the same number (rare — usually means an answering service or a dead number), pick the one with the strongest signal (verified Google Business Profile > Yelp listing > scraped directory entry). Note the ambiguity in the FAQ if relevant.

### Step 3: Fall back gracefully

If the phone search returns nothing (number is too new, unlisted, or only appears on the lead form itself):

- Try the name + likely location, e.g., `"Mario Mina HVAC New Jersey"` based on the area code's region
- Try the website if one was provided
- If still nothing, output the JSON with what you have. Set `businessName` to the lead's name and `templateName` to "" (empty). Put a clear note at the top of the FAQ:

  > "DRAFT — could not identify the business via search. Operator should hand-fill this before promoting."

Always emit the JSON envelope even when discovery fails — the operator can edit and promote from there.

## Output Shape

```json
{
  "businessName": "string",
  "faqKnowledgeBase": "string (multi-line markdown)",
  "templateName": "string (must match an existing template, or empty if unsure)"
}
```

That's it.

## Available Templates

Currently (as of this skill version):

- **`hvac`** — Residential HVAC: heating, cooling, repair, maintenance, install consultations

Add to this list as new templates are created. If the resolved business doesn't match any template, set `templateName` to "" and surface the gap inside the FAQ as a note. Don't invent template names.

## When To Use

Trigger on any of these:
- User pastes a lead row (name + phone) and asks to build a config / onboard a client
- User says "process this lead," "onboard [business name]," "create a Service Call Saver config"
- User pastes a transcript (rare) and asks to onboard
- User provides a vertical hint and asks for a starter config

Optional context the user may also provide:
- Business website URL — fetch with `web_fetch` for supplementary info if available
- Notes / vertical hint — useful for verifying the search hit
- Transcript — overrides search on conflicts (still rare)

Do NOT trigger for:
- Custom path requests ("build a non-template config with these custom paths") — that's handled at template-creation time, not here
- General document summarization
- Phone-number lookup without intent to onboard

## Pipeline

### Step 1: Search by phone number

Always the first step when a phone number is in the lead. Use `web_search` with the number in quotes. Capture the canonical business name, vertical, location, hours, services.

### Step 2: Cross-reference and pick the template

Match the business to a template based on the search-derived vertical. If unclear, leave `templateName` blank.

### Step 3: Extract business name

Use the search-derived name in greeting-form (short, the way the agent should say it on the phone). E.g., "Super Mario Auto Repair & Towing" → either keep as-is or shorten to "Super Mario Auto" if that's how they answer the phone.

### Step 4: Build the FAQ Knowledge Base

Apply the FAQ minimization rules in `references/faq-rules.md`. Use the search-derived facts: hours, services, service area, payment, scheduling. Don't invent facts that didn't appear in the search results.

### Step 5: Output the JSON

In chat, output ONLY the JSON envelope:

```json
{
  "businessName": "[name]",
  "faqKnowledgeBase": "[markdown string with \\n line breaks]",
  "templateName": "[template]"
}
```

No prose, no markdown fencing, no extra commentary — just the JSON. The dashboard parses this directly.

### Step 6: Flag gaps inside the FAQ

If the search revealed routing logic that doesn't fit the chosen template, or you couldn't determine the template, embed a short note inside the FAQ string:

> "Note: business mentions [X] which the `hvac` template doesn't cover. Operator should review."

Or:

> "DRAFT — discovery found [...]. Operator should verify before promoting."

Don't try to engineer around gaps. The operator handles edits in the dashboard.

## What This Skill Does NOT Do

- Generate routing paths, data points, branches, or dispatch overrides
- Construct full agent JSON with paths array
- Pick template names that don't exist
- Make up facts that aren't in search results

## Important Rules

- **Phone number is the primary identifier.** Always search it first.
- **Trust the search-derived business name** over the lead-form `name` field when they conflict — the lead form often has the owner's personal name, not the business.
- **Output only the three required fields.** No paths, no data points, no client config, no closing prompts. The template handles those.
- **Apply FAQ minimization strictly.** See `references/faq-rules.md`.
- **Surface gaps, don't fabricate.** If the search couldn't find hours or service area, omit those subsections rather than inventing.
- **Always emit the JSON.** Even when discovery fails or the template is unknown, return the envelope with whatever you have and a "DRAFT" note in the FAQ. Don't ask clarifying questions; let the operator edit.
- **No prose around the JSON.** The dashboard parses the model output directly.

## References

- `references/faq-rules.md` — FAQ Knowledge Base minimization rules and worked examples
- `references/templates.md` — Current template catalog and what each one handles
