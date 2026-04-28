import type { ClientNotificationConfig } from "../config/notification-clients.js";

export function resolveDispatch(
  clientConfig: ClientNotificationConfig,
  typeKey: string,
) {
  const override = clientConfig.dispatch_by_type?.[typeKey];
  return {
    text_numbers: override?.dispatch_text_numbers ?? clientConfig.dispatch_text_numbers,
    email: override?.dispatch_email ?? clientConfig.dispatch_email,
    cc: override?.dispatch_cc !== undefined ? override.dispatch_cc : clientConfig.dispatch_cc,
    call_number: override?.dispatch_call_number !== undefined
      ? override.dispatch_call_number
      : clientConfig.dispatch_call_number,
  };
}
