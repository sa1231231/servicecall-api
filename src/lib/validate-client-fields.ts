// Server-side validation for client-mutating routes (update-agent, settings PATCH).
// Mirrors the dashboard UI checks so a raw HTTP POST can't bypass them.
//
// All validators return null on success or a human-readable error string.
// `validateClientFieldUpdates` walks the patch payload and aggregates errors.

const PHONE_RE = /^\+1\d{10}$/;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export const FIELD_LIMITS = {
  display_name: 120,
  notification_greeting: 1600,
  webhook_url: 500,
  google_review_url: 500,
  stripe_payment_url: 500,
  contact_name: 200,
  contact_email: 200,
  contact_phone: 32,
  contact_timezone: 64,
  contact_notes: 4000,
  review_sms_message: 1600,
  payment_sms_message: 1600,
  portal_sms_message: 1600,
  setup_instruction_label: 80,
  setup_instruction_message: 1600,
};

function isValidUrl(v: string): boolean {
  try {
    const u = new URL(v);
    return u.protocol === "https:" || u.protocol === "http:";
  } catch {
    return false;
  }
}

function checkPhoneArray(label: string, val: unknown, errors: string[]): void {
  if (val === null || val === undefined) return;
  if (!Array.isArray(val)) {
    errors.push(`${label} must be an array of E.164 phone numbers`);
    return;
  }
  for (const n of val) {
    if (typeof n !== "string" || !PHONE_RE.test(n.trim())) {
      errors.push(`${label}: "${String(n)}" is not E.164 (e.g. +15551234567)`);
    }
  }
}

function checkEmailArray(label: string, val: unknown, errors: string[]): void {
  if (val === null || val === undefined) return;
  if (!Array.isArray(val)) {
    errors.push(`${label} must be an array of email addresses`);
    return;
  }
  for (const e of val) {
    if (typeof e !== "string" || !EMAIL_RE.test(e.trim())) {
      errors.push(`${label}: "${String(e)}" is not a valid email`);
    }
  }
}

function checkPhone(label: string, val: unknown, errors: string[]): void {
  if (val === null || val === undefined || val === "") return;
  if (typeof val !== "string" || !PHONE_RE.test(val.trim())) {
    errors.push(`${label}: "${String(val)}" is not E.164 (e.g. +15551234567)`);
  }
}

function checkEmail(label: string, val: unknown, errors: string[]): void {
  if (val === null || val === undefined || val === "") return;
  if (typeof val !== "string" || !EMAIL_RE.test(val.trim())) {
    errors.push(`${label}: "${String(val)}" is not a valid email`);
  }
}

function checkUrl(label: string, val: unknown, errors: string[]): void {
  if (val === null || val === undefined || val === "") return;
  if (typeof val !== "string" || !isValidUrl(val.trim())) {
    errors.push(`${label}: must start with https:// or http://`);
  }
}

function checkLength(label: string, val: unknown, max: number, errors: string[]): void {
  if (val === null || val === undefined) return;
  if (typeof val === "string" && val.length > max) {
    errors.push(`${label}: exceeds ${max}-character limit (got ${val.length})`);
  }
}

/** Validate a partial client-doc update. Returns [] if all checks pass. */
export function validateClientFieldUpdates(updates: Record<string, unknown>): string[] {
  const errors: string[] = [];

  if ("dispatch_text_numbers" in updates) {
    checkPhoneArray("dispatch_text_numbers", updates.dispatch_text_numbers, errors);
  }
  if ("dispatch_email" in updates) {
    checkEmailArray("dispatch_email", updates.dispatch_email, errors);
  }
  if ("dispatch_call_number" in updates) {
    checkPhone("dispatch_call_number", updates.dispatch_call_number, errors);
  }
  if ("contact_phone" in updates) {
    checkPhone("contact_phone", updates.contact_phone, errors);
  }
  if ("contact_email" in updates) {
    checkEmail("contact_email", updates.contact_email, errors);
  }
  if ("webhook_url" in updates) {
    checkUrl("webhook_url", updates.webhook_url, errors);
  }
  if ("dispatch_call_overrides" in updates) {
    const v = updates.dispatch_call_overrides;
    if (v !== null && v !== undefined) {
      if (typeof v !== "object" || Array.isArray(v)) {
        errors.push("dispatch_call_overrides must be a {fromNumber: dispatchNumber} object or null");
      } else {
        for (const [from, to] of Object.entries(v as Record<string, unknown>)) {
          if (!PHONE_RE.test(from)) errors.push(`dispatch_call_overrides: "${from}" is not E.164`);
          if (typeof to !== "string" || !PHONE_RE.test(to)) errors.push(`dispatch_call_overrides: target "${String(to)}" is not E.164`);
        }
      }
    }
  }

  // Length caps for free-text fields.
  checkLength("display_name", updates.display_name, FIELD_LIMITS.display_name, errors);
  checkLength("notification_greeting", updates.notification_greeting, FIELD_LIMITS.notification_greeting, errors);
  checkLength("contact_name", updates.contact_name, FIELD_LIMITS.contact_name, errors);
  checkLength("contact_email", updates.contact_email, FIELD_LIMITS.contact_email, errors);
  checkLength("contact_phone", updates.contact_phone, FIELD_LIMITS.contact_phone, errors);
  checkLength("contact_timezone", updates.contact_timezone, FIELD_LIMITS.contact_timezone, errors);
  checkLength("contact_notes", updates.contact_notes, FIELD_LIMITS.contact_notes, errors);
  checkLength("webhook_url", updates.webhook_url, FIELD_LIMITS.webhook_url, errors);

  return errors;
}

/** Validate global settings PATCH payload. */
export function validateGlobalSettingsUpdates(updates: Record<string, unknown>): string[] {
  const errors: string[] = [];

  if ("google_review_url" in updates) {
    checkUrl("google_review_url", updates.google_review_url, errors);
    checkLength("google_review_url", updates.google_review_url, FIELD_LIMITS.google_review_url, errors);
  }
  if ("stripe_payment_url" in updates) {
    checkUrl("stripe_payment_url", updates.stripe_payment_url, errors);
    checkLength("stripe_payment_url", updates.stripe_payment_url, FIELD_LIMITS.stripe_payment_url, errors);
  }
  if ("owner_email" in updates) checkEmail("owner_email", updates.owner_email, errors);
  if ("owner_phone" in updates) checkPhone("owner_phone", updates.owner_phone, errors);

  if ("free_trial_days" in updates) {
    const v = updates.free_trial_days;
    if (typeof v !== "number" || !Number.isFinite(v) || v < 0 || v > 365) {
      errors.push("free_trial_days must be a number between 0 and 365");
    }
  }

  checkLength("review_sms_message", updates.review_sms_message, FIELD_LIMITS.review_sms_message, errors);
  checkLength("payment_sms_message", updates.payment_sms_message, FIELD_LIMITS.payment_sms_message, errors);
  checkLength("portal_sms_message", updates.portal_sms_message, FIELD_LIMITS.portal_sms_message, errors);

  if ("setup_instructions" in updates) {
    const v = updates.setup_instructions;
    if (v !== null && v !== undefined) {
      if (!Array.isArray(v)) {
        errors.push("setup_instructions must be an array");
      } else {
        v.forEach((entry, idx) => {
          if (!entry || typeof entry !== "object") {
            errors.push(`setup_instructions[${idx}]: must be an object`);
            return;
          }
          const e = entry as { id?: unknown; label?: unknown; message?: unknown };
          if (typeof e.label !== "string" || e.label.trim() === "") {
            errors.push(`setup_instructions[${idx}]: label is required`);
          }
          checkLength(`setup_instructions[${idx}].label`, e.label, FIELD_LIMITS.setup_instruction_label, errors);
          checkLength(`setup_instructions[${idx}].message`, e.message, FIELD_LIMITS.setup_instruction_message, errors);
        });
      }
    }
  }

  return errors;
}
