import { describe, it, expect } from "vitest";
import {
  notificationClients,
  agentIdToClient,
} from "../notification-clients.js";

describe("notificationClients", () => {
  it("has dispatch_email as arrays or null", () => {
    for (const [key, client] of Object.entries(notificationClients)) {
      if (client.dispatch_email !== null) {
        expect(Array.isArray(client.dispatch_email), `${key}.dispatch_email should be an array`).toBe(true);
        expect(client.dispatch_email.length, `${key}.dispatch_email should not be empty`).toBeGreaterThan(0);
      }
    }
  });

  it("has dispatch_text_numbers as non-empty arrays for active clients", () => {
    for (const [key, client] of Object.entries(notificationClients)) {
      expect(Array.isArray(client.dispatch_text_numbers), `${key}.dispatch_text_numbers should be an array`).toBe(true);
    }
  });

  it("maps agent_ids to clients correctly", () => {
    for (const [, client] of Object.entries(notificationClients)) {
      for (const agentId of client.agent_ids) {
        expect(agentIdToClient[agentId]).toBe(client);
      }
    }
  });

  it("has valid resolve_type returning existing message types", () => {
    for (const [key, client] of Object.entries(notificationClients)) {
      const result = client.resolve_type({});
      expect(
        result in client.message_types,
        `${key}.resolve_type({}) returned "${result}" which is not in message_types`,
      ).toBe(true);
    }
  });

  it("each message type has at least one field", () => {
    for (const [key, client] of Object.entries(notificationClients)) {
      for (const [typeKey, msgType] of Object.entries(client.message_types)) {
        expect(
          msgType.fields.length,
          `${key}.message_types.${typeKey} has no fields`,
        ).toBeGreaterThan(0);
      }
    }
  });

  it("default_message_type exists in message_types", () => {
    for (const [key, client] of Object.entries(notificationClients)) {
      expect(
        client.default_message_type in client.message_types,
        `${key}.default_message_type "${client.default_message_type}" not found`,
      ).toBe(true);
    }
  });

  it("required fields have valid structure", () => {
    for (const [key, client] of Object.entries(notificationClients)) {
      for (const [typeKey, msgType] of Object.entries(client.message_types)) {
        for (const field of msgType.fields) {
          if (field.required && field.required !== true) {
            const eq = field.required.equals;
            expect(
              typeof eq === "string" || Array.isArray(eq),
              `${key}.${typeKey}.${field.key}: required.equals must be string or string[]`,
            ).toBe(true);
          }
        }
      }
    }
  });

  it("show property is boolean when set", () => {
    for (const [key, client] of Object.entries(notificationClients)) {
      for (const [typeKey, msgType] of Object.entries(client.message_types)) {
        for (const field of msgType.fields) {
          if (field.show !== undefined) {
            expect(
              typeof field.show,
              `${key}.${typeKey}.${field.key}: show must be boolean`,
            ).toBe("boolean");
          }
        }
      }
    }
  });
});
