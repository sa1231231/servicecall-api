import { escapeHtml } from "./escape-html.js";
// ── Builder ──────────────────────────────────────────────────────────────────
export function buildNotificationMessages(input) {
    const { clientConfig, allVars, callerNumber } = input;
    // Resolve message type
    const typeKey = clientConfig.resolve_type(allVars);
    const messageType = clientConfig.message_types[typeKey] ??
        clientConfig.message_types[clientConfig.default_message_type];
    if (!messageType) {
        return {
            ok: false,
            reason: "no_message_type",
            details: `No message type found for key="${typeKey}" or default="${clientConfig.default_message_type}"`,
        };
    }
    // Extract field values
    const fieldValues = {};
    for (const field of messageType.fields) {
        let value = allVars[field.key] ?? "";
        if (clientConfig.phone_fallback_to_caller &&
            field.key === "phone_number" &&
            (!value || value === "Not Mentioned")) {
            value = callerNumber ?? "";
        }
        fieldValues[field.key] = value;
    }
    // Check required fields
    const failedRequired = messageType.fields.filter((f) => {
        if (!f.required)
            return false;
        const val = fieldValues[f.key] ?? "";
        if (f.required === true) {
            return !val || val === "Not Mentioned";
        }
        const allowed = Array.isArray(f.required.equals)
            ? f.required.equals
            : [f.required.equals];
        return !allowed.includes(val);
    });
    if (failedRequired.length > 0) {
        return {
            ok: false,
            reason: "failed_required",
            details: `Required field check failed: ${failedRequired.map((f) => f.key).join(", ")}`,
        };
    }
    // Skip if no meaningful data collected (phone_number excluded — it defaults to caller)
    const meaningfulFields = messageType.fields.filter((f) => f.key !== "phone_number" && fieldValues[f.key] && fieldValues[f.key] !== "Not Mentioned");
    if (meaningfulFields.length === 0) {
        return {
            ok: false,
            reason: "empty_call",
            details: "No meaningful data collected",
        };
    }
    // Filter visible fields
    const visibleFields = messageType.fields
        .filter((f) => f.show !== false)
        .filter((f) => {
        if (f.show_when) {
            const dep = fieldValues[f.show_when.field] ?? "";
            const allowed = Array.isArray(f.show_when.equals) ? f.show_when.equals : [f.show_when.equals];
            if (!allowed.includes(dep))
                return false;
        }
        return true;
    })
        .map((f) => {
        let val = fieldValues[f.key];
        if (f.format === "yes_no")
            val = val === "true" ? "Yes" : "No";
        return { label: f.label, value: val };
    })
        .filter((f) => f.value)
        .filter((f) => !clientConfig.hide_not_mentioned || f.value !== "Not Mentioned");
    // Build plain-text field lines (for SMS)
    const fieldLines = visibleFields.map((f) => `${f.label}: ${f.value}`).join("\n");
    // Build HTML field lines (for email)
    const fieldLinesHtml = visibleFields
        .map((f) => `<strong>${escapeHtml(f.label)}:</strong> ${escapeHtml(f.value)}`)
        .join("<br>");
    // Build message bodies
    const effectiveName = allVars.business_name || clientConfig.name;
    const greeting = clientConfig.notification_greeting
        ? clientConfig.notification_greeting.replace(/\{\{business_name\}\}/g, effectiveName)
        : `Hi ${effectiveName}, you have a new call!`;
    const urgentSuffix = messageType.additional_text
        ? `\n\n${messageType.additional_text}`
        : "";
    const urgentSuffixHtml = messageType.additional_text
        ? `<br><br>${escapeHtml(messageType.additional_text)}`
        : "";
    const smsMessage = `${greeting}\n\n${messageType.label}\n\n${fieldLines}${urgentSuffix}\n\n— Service Call Saver`;
    const emailBody = `${greeting}\n\n${messageType.label}\n\n${fieldLines}${urgentSuffix}\n\n—\nSent by Service Call Saver\nservicecallsaver.com`;
    const emailHtml = `<p>${escapeHtml(greeting)}</p><p><strong>${escapeHtml(messageType.label)}</strong></p><p>${fieldLinesHtml}</p>${urgentSuffixHtml}<br><br><p>—<br>Sent by Service Call Saver<br>servicecallsaver.com</p>`;
    const emailSubject = renderTemplate(messageType.subject_template, fieldValues);
    return {
        ok: true,
        payload: { typeKey, messageType, fieldValues, visibleFields, smsMessage, emailBody, emailHtml, emailSubject },
    };
}
// ── Helpers ──────────────────────────────────────────────────────────────────
export function renderTemplate(template, values) {
    return template.replace(/\{\{(\w+)\}\}/g, (_, key) => values[key] ?? "");
}
