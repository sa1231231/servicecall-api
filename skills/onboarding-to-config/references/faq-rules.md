# FAQ Knowledge Base Rules

The FAQ block is the only substantive content the skill generates. Everything else (paths, data points, dispatch) is handled by the template. Get the FAQ right.

## Strict Inclusion Rules

**INCLUDE in FAQ:**
- Address (callers occasionally ask)
- General-purpose contact email if the owner provided one (different from dispatch)
- Service area (caller-facing)
- Hours of operation if the owner mentioned them
- Services offered (caller-facing — what callers can ask about)
- Pricing posture (does the agent quote on the phone? what to say if it doesn't?)
- Decline rules (only if the owner explicitly named them)
- Any operational detail the owner specifically said the agent should know (e.g., "we have a $89 diagnostic fee," "we offer free estimates," "we accept financing")

**EXCLUDE from FAQ:**
- Tenure / years in business — caller doesn't ask, agent doesn't change behavior (UNLESS the business markets it as part of their identity, e.g., "fourth generation family business")
- Main phone number — caller already has it (they called)
- Team breakdown / employee counts / role counts — internal trivia
- Volume claims ("we serve 10,000 customers a year") — marketing fluff
- Brand tone descriptions — not FAQ content, that's prompt-tuning
- Information that's redundant with another subsection
- Anything the template will handle (routing logic, intro classifier, agent guardrails — these live in the template, NOT in the FAQ this skill generates)

## Required Subsection Structure

Use this exact structure. Omit any subsection that has no real content.

```
## Company Info
[Address. Optional: general contact email, hours.]

## Service Area
[Cities, counties, regions covered.]

## Services Offered
[Grouped service list using owner's terminology, with turnaround time hints if given.]

## Pricing & Payment
[Pricing posture. If "do not quote on the phone" is the rule, state plainly with the deflection script. Mention any free estimate / diagnostic fee / financing if owner specified.]

## Decline Rules
[ONLY if owner explicitly named decline rules. Otherwise OMIT entirely.]
```

## Subsections to NEVER Include

These are handled by the template, NOT by this skill:

- **Intro Classifier** — template handles routing logic
- **Agent Guardrails** — template handles behavioral rules (live transfer, callback fallback, etc.)
- **FAQ Q&A** — only add if there's genuinely a caller question that ISN'T already answered by the subsections above. In practice, almost never needed.

If the owner mentioned operational rules (e.g., "we don't do live transfers, always callback"), do NOT put those in the FAQ — they're template-level decisions. If the chosen template doesn't match the owner's preference, flag that to the user in chat (separate from the JSON output).

## Style Rules

- Plain prose, no markdown bold/italic inside the FAQ string
- Use only `##` subsection markers
- Concise — every line earns its place
- Use the owner's terminology where they have a specific way of saying things
- Multi-line — newlines between subsections, between paragraphs within a subsection

## Worked Example: HVAC

For an HVAC business with the typical residential profile:

```
## Company Info
Moss's Heating and Cooling has been serving the Cairo, IL area for 35+ years. Locally owned, family-operated. Licensed, bonded, and insured.

## Service Area
Cairo, IL and surrounding region within roughly 30 miles. Including Mound City, Mounds, Tamms, Olive Branch, and parts of southern Alexander County and Pulaski County.

## Hours
Monday through Friday, 8 AM to 5 PM. Saturday by appointment. Closed Sundays. After-hours emergency service available for active maintenance plan members.

## Services Offered
Residential heating and cooling:
- Repair and diagnostics for AC units, furnaces, heat pumps, ductless mini-splits
- Annual maintenance and tune-ups (spring AC, fall furnace)
- New system installation and replacement
- Indoor air quality (humidifiers, dehumidifiers, air purifiers)
- Thermostat installation including smart thermostats
- Duct cleaning and sealing
- Free in-home estimates for new installs

We service all major brands including Carrier, Trane, Lennox, Goodman, Rheem, York, American Standard, and Bryant.

## Pricing & Payment
Do not quote prices on the phone. Tell the caller a technician will provide pricing during the consultation.

Service call diagnostic fee is $89, waived if the customer proceeds with the recommended repair.

We accept cash, check, all major credit cards, and offer financing options for new installs.

## Maintenance Plans
Annual Comfort Club membership: $189/year covers two tune-ups (spring + fall), priority scheduling, no overtime fees on after-hours calls, and 15% off repairs.
```

What's NOT in this block:
- No tenure-counting subsection (the "35+ years" mention is in Company Info as a one-liner, not its own header)
- No team breakdown
- No agent guardrails
- No intro classifier
- No FAQ Q&A — everything a caller would ask is answered above
- No volume claims

## Sparse Profiles

When the source is just a vertical hint (no transcript, minimal website), the FAQ can be very short:

```
## Company Info
Residential heating and cooling service.

## Service Area
[area].

## Services Offered
HVAC repair, maintenance, and installation for residential homes.

## Pricing & Payment
Do not quote prices on the phone. Tell the caller a technician will provide pricing during the consultation.
```

Don't pad. The owner will fill in detail later.

## Output Format Notes

When the FAQ is part of the JSON output:
- Use `\n` for newlines (escape for valid JSON)
- Wrap the entire string in double quotes
- Escape any internal double quotes as `\"`

Example JSON snippet:
```json
"faqKnowledgeBase": "## Company Info\nMoss's Heating and Cooling...\n\n## Service Area\nCairo, IL..."
```
