import Twilio from "twilio";
import Retell from "retell-sdk";
import { config } from "../config.js";

const twilioClient = Twilio(config.TWILIO_ACCOUNT_SID, config.TWILIO_AUTH_TOKEN);
const retell = new Retell({ apiKey: config.RETELL_API_KEY });

const DEFAULT_AREA_CODE = 815;

interface ProvisionOptions {
  agentId: string;
  clientName: string;
  dispatchCallNumber?: string;
  areaCode?: number;
}

interface ProvisionResult {
  phoneNumber: string;
  phoneNumberSid: string;
}

export function extractAreaCode(phoneNumber: string): number {
  // E.164 US format: +1AAANNNNNNN
  const digits = phoneNumber.replace(/\D/g, "");
  // Strip leading 1 if present
  const national = digits.startsWith("1") && digits.length === 11
    ? digits.slice(1)
    : digits;
  return parseInt(national.slice(0, 3), 10);
}

export async function provisionPhoneNumber(
  options: ProvisionOptions,
): Promise<ProvisionResult> {
  const { agentId, clientName, dispatchCallNumber } = options;
  const areaCode = options.areaCode
    ?? (dispatchCallNumber ? extractAreaCode(dispatchCallNumber) : DEFAULT_AREA_CODE);

  console.log(`[provision] starting for "${clientName}" (area code ${areaCode})`);

  // 1. Search for available local number
  const available = await twilioClient.availablePhoneNumbers("US").local.list({
    areaCode,
    limit: 1,
  });

  if (available.length === 0) {
    throw new Error(`No available phone numbers in area code ${areaCode}`);
  }

  const targetNumber = available[0].phoneNumber;
  console.log(`[provision] found available number: ${targetNumber}`);

  // 2. Purchase the number with emergency address
  const purchased = await twilioClient.incomingPhoneNumbers.create({
    phoneNumber: targetNumber,
    emergencyAddressSid: config.TWILIO_EMERGENCY_ADDRESS_SID || undefined,
  });

  const phoneNumberSid = purchased.sid;
  console.log(`[provision] purchased: ${targetNumber} (sid=${phoneNumberSid})`);

  // 3. Add to SIP trunk
  if (config.TWILIO_TRUNK_SID) {
    await twilioClient.trunking.v1
      .trunks(config.TWILIO_TRUNK_SID)
      .phoneNumbers.create({ phoneNumberSid });
    console.log(`[provision] added to SIP trunk ${config.TWILIO_TRUNK_SID}`);
  }

  // 4. Add to Messaging Service (linked to A2P campaign)
  if (config.TWILIO_MESSAGING_SERVICE_SID) {
    await twilioClient.messaging.v1
      .services(config.TWILIO_MESSAGING_SERVICE_SID)
      .phoneNumbers.create({ phoneNumberSid });
    console.log(`[provision] added to messaging service ${config.TWILIO_MESSAGING_SERVICE_SID}`);
  }

  // 5. Get trunk termination URI for Retell import
  let terminationUri = "";
  if (config.TWILIO_TRUNK_SID) {
    const trunk = await twilioClient.trunking.v1
      .trunks(config.TWILIO_TRUNK_SID)
      .fetch();
    terminationUri = `${trunk.domainName}`;
    console.log(`[provision] trunk termination URI: ${terminationUri}`);
  }

  // 6. Import into Retell with agent binding + BYOC outbound auth.
  // Without auth_username/password, Retell can't route warm transfer outbound
  // through the Twilio trunk and falls back to its default carrier.
  if (terminationUri) {
    const authUsername = config.RETELL_SIP_TRUNK_AUTH_USERNAME || undefined;
    const authPassword = config.RETELL_SIP_TRUNK_AUTH_PASSWORD || undefined;
    if (!authUsername || !authPassword) {
      console.warn(
        `[provision] warning: RETELL_SIP_TRUNK_AUTH_USERNAME/PASSWORD not set — warm transfer through BYOC trunk will not work for ${targetNumber} until credentials are added in Retell's dashboard.`,
      );
    }
    await retell.phoneNumber.import({
      phone_number: targetNumber,
      termination_uri: terminationUri,
      sip_trunk_auth_username: authUsername,
      sip_trunk_auth_password: authPassword,
      inbound_agents: [{ agent_id: agentId, weight: 1 }],
      nickname: clientName,
      inbound_webhook_url: "https://servicecall-api-production.up.railway.app/retell/pre-hook",
    });
    console.log(`[provision] imported into Retell with agent ${agentId} (BYOC auth=${authUsername ? "set" : "missing"})`);
  }

  console.log(`[provision] complete for "${clientName}": ${targetNumber}`);

  return { phoneNumber: targetNumber, phoneNumberSid };
}
