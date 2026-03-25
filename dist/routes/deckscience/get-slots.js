import { config } from "../../config.js";
const CALENDAR_ID = "xxCyQ9oSNEGdgFjIpMlC";
const TIMEZONE = "America/Chicago";
const BASE_URL = "https://services.leadconnectorhq.com";
function formatDateLabel(date) {
    return new Intl.DateTimeFormat("en-US", {
        weekday: "long",
        month: "long",
        day: "numeric",
        timeZone: TIMEZONE,
    }).format(date);
}
function formatTimeLabel(date) {
    return new Intl.DateTimeFormat("en-US", {
        hour: "numeric",
        minute: "2-digit",
        hour12: true,
        timeZone: TIMEZONE,
    }).format(date);
}
function getStartAndEndTimestamps() {
    const now = new Date();
    const chicagoNow = new Date(now.toLocaleString("en-US", { timeZone: TIMEZONE }));
    const start = new Date(chicagoNow);
    start.setDate(start.getDate() + 1);
    start.setHours(8, 0, 0, 0);
    const end = new Date(start);
    end.setDate(end.getDate() + 21);
    return {
        startDate: start.getTime(),
        endDate: end.getTime(),
        startISO: start.toISOString(),
        endISO: end.toISOString(),
    };
}
export async function getSlotsHandler(req, res) {
    console.log("deckscience-get-slots: received request");
    try {
        const { startDate, endDate, startISO, endISO } = getStartAndEndTimestamps();
        console.log("deckscience-get-slots: computed date range", {
            startDate,
            endDate,
            startISO,
            endISO,
        });
        const url = new URL(`${BASE_URL}/calendars/${CALENDAR_ID}/free-slots`);
        url.searchParams.set("startDate", String(startDate));
        url.searchParams.set("endDate", String(endDate));
        url.searchParams.set("timezone", TIMEZONE);
        console.log("deckscience-get-slots: calling GHL", { url: url.toString() });
        const ghlRes = await fetch(url.toString(), {
            headers: {
                Authorization: `Bearer ${config.GHL_API_KEY}`,
                Version: "2021-04-15",
                Accept: "application/json",
            },
        });
        console.log("deckscience-get-slots: GHL responded", {
            status: ghlRes.status,
            ok: ghlRes.ok,
        });
        const raw = await ghlRes.json();
        if (!ghlRes.ok) {
            console.error("deckscience-get-slots: GHL error response", raw);
            res.status(ghlRes.status).json(raw);
            return;
        }
        console.log("RAW GHL RESPONSE:", raw);
        const available_slots = [];
        for (const [dateKey, value] of Object.entries(raw)) {
            if (dateKey === "traceId")
                continue;
            const daySlots = value?.slots ?? [];
            if (!Array.isArray(daySlots) || daySlots.length === 0)
                continue;
            const times = daySlots.map((isoString) => {
                const dateObj = new Date(isoString);
                return {
                    display: formatTimeLabel(dateObj),
                    iso: isoString,
                };
            });
            const formattedDate = formatDateLabel(new Date(daySlots[0]));
            available_slots.push({
                date: formattedDate,
                times,
            });
        }
        console.log("deckscience-get-slots: parsed availability", {
            total_days: available_slots.length,
        });
        res.status(200).json({ available_slots });
    }
    catch (err) {
        console.error("deckscience-get-slots: internal error", err);
        res.status(500).json({ error: "Internal server error" });
    }
}
