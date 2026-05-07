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

## Pre-Search Context Is The Source Of Truth

Every prompt for this skill arrives with a **"Pre-search context (Brave Search results)"** block. Our backend runs Brave web searches against the lead's phone number (in three formats) plus the name and website before invoking the model. The block contains the raw hits — title, URL, description.

**Read those results first.** They're the authoritative discovery output for this lead. Do not rely on internal knowledge of phone-number-to-business mappings; you don't have it. The pre-search block does.

### Picking the right hit

1. **Phone-number queries are the strongest signal.** If a query like `"973-978-1542"` or `"(973) 978-1542"` returned a business listing, that's the business — even if the description is a snippet from Yelp/Google/BBB rather than the canonical site.
2. **Cross-reference the name.** The lead's `name` field is often the owner or a partial business name. If the phone-matched listing says "Super Mario Auto Repair & Towing" and the lead `name` is "Mario Mina", trust the listing — the form was filled out by the owner.
3. **Use name + location queries as a backup.** If phone-number queries returned no results, look at the `[name] business` query results. A hit in the right area code (973 = NJ, 415 = SF, etc.) with a plausibly-related name is a usable match — just flag the verification gap inside the FAQ.
4. **Trust verified-listing signals.** Yelp / Google Business Profile / BBB / the business's own website > random directory aggregators. Pick the strongest source when multiple disagree.

### When to use DRAFT

Reserve the DRAFT path **only when every pre-search query came back empty**. If at least one query produced a relevant hit, commit to that business in the JSON — even if some details (hours, full address) need verification, just note the gaps in the FAQ. DRAFT is for "we found nothing"; partial info is not DRAFT.

If the pre-search block is missing entirely (rare — would indicate a backend bug), output a DRAFT with the lead-form `name` as `businessName` and `templateName: ""`.

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

### Step 1: Read the pre-search context

Always the first step. Look at every query result block in the "Pre-search context" section. Identify the strongest hit (phone-number-matched > name+area-code-matched > website-matched). Capture: canonical business name, vertical, location, hours, services, payment style.

### Step 2: Pick the template

Match the resolved business to a template based on the vertical Brave returned. If the vertical doesn't fit any template in the catalog, set `templateName` to "" (empty) and let the operator pick.

### Step 3: Extract business name

Use the listing-derived name in greeting-form (short, the way the agent should say it on the phone). "Super Mario Auto Repair & Towing Truck Services" → "Super Mario Auto Repair" if the listing's tagline / website confirms that's how they answer.

### Step 4: Build the FAQ Knowledge Base

Apply the FAQ minimization rules in `references/faq-rules.md`. Use facts pulled from the pre-search hits: hours, services, service area, payment notes, scheduling style. Don't invent facts that aren't in the listings.

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

If a hit revealed routing logic that doesn't fit the chosen template, or you couldn't determine the template, embed a short note inside the FAQ string:

> "Note: business mentions [X] which the `hvac` template doesn't cover. Operator should review."

If pre-search was completely empty across every query:

> "DRAFT — Brave pre-search returned no results for this lead. Operator should hand-fill before promoting."

Don't try to engineer around gaps. The operator handles edits in the dashboard.

## What This Skill Does NOT Do

- Generate routing paths, data points, branches, or dispatch overrides
- Construct full agent JSON with paths array
- Pick template names that don't exist
- Make up facts that aren't in search results

## Important Rules

- **The pre-search context is the source of truth.** Read it before deciding anything. Don't rely on internal knowledge of phone-number → business mappings.
- **Trust the listing-derived business name** over the lead-form `name` field when they conflict — the form often has the owner's personal name, not the business.
- **Commit to a hit when one exists.** If at least one pre-search query returned a relevant business, use it. Reserve DRAFT for the case where every query came back empty.
- **Output only the three required fields.** No paths, no data points, no client config, no closing prompts. The template handles those.
- **Apply FAQ minimization strictly.** See `references/faq-rules.md`.
- **Surface gaps, don't fabricate.** If the listings didn't show hours or service area, omit those subsections rather than inventing.
- **Always emit the JSON.** Even when discovery fails or the template is unknown, return the envelope with whatever you have and a "DRAFT" note in the FAQ. Don't ask clarifying questions; let the operator edit.
- **No prose around the JSON.** The dashboard parses the model output directly.

## References

- `references/faq-rules.md` — FAQ Knowledge Base minimization rules and worked examples
- `references/templates.md` — Current template catalog and what each one handles
