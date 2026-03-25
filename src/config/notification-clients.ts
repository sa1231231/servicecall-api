export interface ClientNotificationConfig {
  client_id: string;
  name: string;
  dispatch_numbers: string[];
  dispatch_email: string | null;
  dispatch_cc: string | null;
}

export const notificationClients: Record<string, ClientNotificationConfig> = {
  "pro-v": {
    client_id: "pro-v",
    name: "Pro-V Contracting",
    dispatch_numbers: ["+19517608403", "+16193007267"],
    dispatch_email: "info@provcontracting.com",
    dispatch_cc: "dispatch@provcontracting.com",
  },
  "american-masonry": {
    client_id: "american-masonry",
    name: "American Masonry",
    dispatch_numbers: ["+12487472867"],
    dispatch_email: "ken@provcontracting.com",
    dispatch_cc: null,
  },
  test: {
    client_id: "test",
    name: "Test Client",
    dispatch_numbers: ["+13017872841"],
    dispatch_email: "samasra93@gmail.com",
    dispatch_cc: null,
  },
};
