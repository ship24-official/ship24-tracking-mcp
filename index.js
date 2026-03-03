#!/usr/bin/env node
// ship24-tracking-mcp.js
// MCP server for shipment tracking (vendor-neutral, merchant-branded)

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

// ─────────────────────────────────────────────
// ENV CONFIG
// ─────────────────────────────────────────────
const API_KEY = process.env.SHIP24_API_KEY || "";
const BASE_URL = (process.env.SHIP24_BASE_URL || "https://api.ship24.com/public/v1").replace(/\/$/, "");
const PLAN_PER_SHIPMENT = process.env.PLAN_PER_SHIPMENT === "true";
const PLAN_PER_CALL = process.env.PLAN_PER_CALL === "true";
const COURIERS_CACHE_TTL_HOURS = parseFloat(process.env.COURIERS_CACHE_TTL_HOURS || "24");
const REQUEST_TIMEOUT_MS = parseInt(process.env.REQUEST_TIMEOUT_MS || "15000", 10);
const MAX_RETRIES = 2;
const VERSION = "1.0.0";

const IS_CONFIGURED = !!API_KEY && (PLAN_PER_SHIPMENT || PLAN_PER_CALL);

// ─────────────────────────────────────────────
// STATUS NORMALIZATION MAPPINGS
// ─────────────────────────────────────────────
const MILESTONE_DEFINITIONS = {
  information_received: {
    label: "Information Received",
    description: "The carrier has received shipment information but has not yet picked up the package.",
  },
  shipment_picked_up: {
    label: "Picked Up",
    description: "The package has been picked up by the carrier and is in their possession.",
  },
  in_transit: {
    label: "In Transit",
    description: "The package is on its way and moving through the carrier's network.",
  },
  out_for_delivery: {
    label: "Out for Delivery",
    description: "The package is with a delivery agent and will be delivered today.",
  },
  delivered: {
    label: "Delivered",
    description: "The package has been successfully delivered to the recipient.",
  },
  delivery_exception: {
    label: "Delivery Exception",
    description: "An issue occurred during delivery. Action may be required.",
  },
  returned_to_sender: {
    label: "Returned to Sender",
    description: "The package is being or has been returned to the original sender.",
  },
  available_for_pickup: {
    label: "Available for Pickup",
    description: "The package is waiting at a pickup location for the recipient to collect.",
  },
  waiting_for_collection: {
    label: "Waiting for Collection",
    description: "The package is held by the carrier awaiting collection.",
  },
  cancelled: {
    label: "Cancelled",
    description: "The shipment has been cancelled.",
  },
  not_yet_shipped: {
    label: "Not Yet Shipped",
    description: "The order has been created but the package has not been shipped yet.",
  },
};

const CATEGORY_DEFINITIONS = {
  data: "Shipment data has been received or updated.",
  transit: "The package is moving through the delivery network.",
  destination: "The package has arrived at or near the destination.",
  customs: "The package is going through customs clearance.",
  delivery: "Delivery-related activity.",
  exception: "An exception or issue has occurred.",
};

const STATUS_CODE_DEFINITIONS = {
  data_received: "Shipment data has been received by the carrier.",
  data_undefined: "Status is unclear or not yet defined.",
  information_received: "Shipping information has been submitted.",
  shipment_not_ready: "The shipment is not yet ready for pickup.",
  in_transit: "The package is in transit.",
  out_for_delivery: "The package is out for delivery today.",
  delivered: "Delivered successfully.",
  delivered_to_neighbor: "Delivered to a neighbor.",
  returned_to_sender: "Being returned to the sender.",
  failed_attempt: "A delivery attempt was made but was unsuccessful.",
  available_for_pickup: "Available at a pickup point.",
  waiting_for_collection: "Held by carrier for collection.",
  exception: "An exception or problem has occurred.",
  pending: "Status is pending.",
};

// ─────────────────────────────────────────────
// HTTP HELPER
// ─────────────────────────────────────────────
async function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function apiRequest(method, path, body = null, attempt = 0) {
  const url = `${BASE_URL}${path}`;
  const headers = {
    "Authorization": `Bearer ${API_KEY}`,
    "Content-Type": "application/json",
    "Accept": "application/json",
  };

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  let res;
  try {
    res = await fetch(url, {
      method,
      headers,
      body: body ? JSON.stringify(body) : undefined,
      signal: controller.signal,
    });
  } catch (err) {
    clearTimeout(timer);
    if (err.name === "AbortError") {
      throw { code: "timeout", message: "Request timed out.", retryable: true };
    }
    throw { code: "network_error", message: "Network error.", retryable: true };
  }
  clearTimeout(timer);

  // Retry-After / 429
  if (res.status === 429 && attempt < MAX_RETRIES) {
    const retryAfter = parseInt(res.headers.get("Retry-After") || "2", 10);
    await sleep(retryAfter * 1000 * Math.pow(2, attempt));
    return apiRequest(method, path, body, attempt + 1);
  }

  // 5xx retry
  if (res.status >= 500 && attempt < MAX_RETRIES) {
    await sleep(1000 * Math.pow(2, attempt));
    return apiRequest(method, path, body, attempt + 1);
  }

  let json;
  try {
    json = await res.json();
  } catch {
    throw { code: "parse_error", message: "Could not parse server response.", retryable: false };
  }

  if (!res.ok) {
    const errs = json?.errors || [];
    const firstCode = errs[0]?.code || `http_${res.status}`;
    const firstMsg = errs[0]?.message || res.statusText;
    throw { code: firstCode, message: firstMsg, raw: errs, status: res.status };
  }

  return json;
}

// ─────────────────────────────────────────────
// COURIERS CACHE
// ─────────────────────────────────────────────
let couriersCache = null;
let couriersCacheAt = 0;

async function getCouriers() {
  const now = Date.now();
  const ttlMs = COURIERS_CACHE_TTL_HOURS * 3600 * 1000;
  if (couriersCache && now - couriersCacheAt < ttlMs) {
    return couriersCache;
  }
  try {
    const data = await apiRequest("GET", "/couriers");
    couriersCache = data?.data?.couriers || [];
    couriersCacheAt = now;
    return couriersCache;
  } catch {
    return couriersCache || [];
  }
}

function normalizeName(s) {
  return (s || "").toLowerCase().replace(/[^a-z0-9]/g, "");
}

async function resolveCourierName(courierName) {
  if (!courierName) return { matched: null, ambiguous: false, deprecated: false };
  const couriers = await getCouriers();
  const needle = normalizeName(courierName);

  const allMatches = couriers.filter((c) => {
    const normName = normalizeName(c.name || "");
    const normCode = normalizeName(c.courierCode || "");
    return normName.includes(needle) || normCode.includes(needle);
  });

  const activeMatches = allMatches.filter((c) => !c.is_deprecated);

  if (activeMatches.length === 0) {
    // Only deprecated matches?
    if (allMatches.length > 0) return { matched: null, ambiguous: false, deprecated: true };
    return { matched: null, ambiguous: false, deprecated: false };
  }

  if (activeMatches.length === 1) {
    return { matched: activeMatches[0], ambiguous: false, deprecated: false };
  }

  // Multiple matches — try to find the single best candidate before giving up:

  // 1. Exact name match (e.g. user said "GLS" → courier named exactly "GLS")
  const exactName = activeMatches.filter((c) => normalizeName(c.name || "") === needle);
  if (exactName.length === 1) return { matched: exactName[0], ambiguous: false, deprecated: false };

  // 2. Exact courierCode match (e.g. "gls" matches courierCode "gls")
  const exactCode = activeMatches.filter((c) => normalizeName(c.courierCode || "") === needle);
  if (exactCode.length === 1) return { matched: exactCode[0], ambiguous: false, deprecated: false };

  // 3. Name starts with needle AND is shortest (most generic entry wins)
  //    e.g. "GLS" preferred over "GLS Italy", "GLS France" etc.
  const startsWith = activeMatches.filter((c) => normalizeName(c.name || "").startsWith(needle));
  if (startsWith.length >= 1) {
    // Pick the shortest name — it's the most generic/parent carrier
    const shortest = startsWith.sort((a, b) => (a.name || "").length - (b.name || "").length)[0];
    // Only auto-select if it's meaningfully shorter than the others (avoids false confidence)
    const secondShortest = startsWith.sort((a, b) => (a.name || "").length - (b.name || "").length)[1];
    if (!secondShortest || shortest.name.length < secondShortest.name.length) {
      return { matched: shortest, ambiguous: false, deprecated: false };
    }
  }

  // 4. CourierCode starts with needle and is shortest
  const codeStartsWith = activeMatches.filter((c) => normalizeName(c.courierCode || "").startsWith(needle));
  if (codeStartsWith.length >= 1) {
    const shortest = codeStartsWith.sort((a, b) => (a.courierCode || "").length - (b.courierCode || "").length)[0];
    const secondShortest = codeStartsWith.sort((a, b) => (a.courierCode || "").length - (b.courierCode || "").length)[1];
    if (!secondShortest || shortest.courierCode.length < secondShortest.courierCode.length) {
      return { matched: shortest, ambiguous: false, deprecated: false };
    }
  }

  // Truly ambiguous — return top options (commercial names only, no codes)
  return {
    matched: null,
    ambiguous: true,
    options: activeMatches
      .sort((a, b) => (a.name || "").localeCompare(b.name || ""))
      .slice(0, 6)
      .map((c) => c.name),
  };
}

// ─────────────────────────────────────────────
// STATUS NORMALIZATION
// ─────────────────────────────────────────────
function explainMilestone(milestone) {
  if (!milestone) return undefined;
  const def = MILESTONE_DEFINITIONS[milestone];
  return def ? def.description : undefined;
}

function normalizeEvent(ev) {
  const milestone = ev?.statusMilestone;
  const category = ev?.statusCategory;
  const code = ev?.statusCode;

  // Location can be a structured object OR a plain string depending on courier
  // Also check ev.location and ev.address as fallbacks
  const rawLoc = ev?.location ?? ev?.address ?? undefined;
  const location = normalizeLocation(rawLoc);

  return {
    occurrenceDatetime: ev?.occurrenceDatetime || undefined,
    infoReceivedDatetime: ev?.infoReceivedDatetime || undefined,
    location,
    statusMilestone: milestone || undefined,
    statusCategory: category || undefined,
    statusCode: code || undefined,
    milestoneExplanation: explainMilestone(milestone),
    // "status" is the raw courier text; prefer it over statusText
    statusText: ev?.status || ev?.statusText || undefined,
  };
}

function normalizeLocation(loc) {
  if (!loc) return undefined;

  // Ship24 sometimes returns location as a plain string
  if (typeof loc === "string") {
    const trimmed = loc.trim();
    return trimmed ? { raw: trimmed } : undefined;
  }

  // Ship24 structured location: city, state, postCode, countryCode
  // "name" is a raw location string some couriers provide (e.g. "PARIS - FRANCE")
  const city = loc.city || undefined;
  const state = loc.state || undefined;
  const postCode = loc.postCode || undefined;
  const countryCode = loc.countryCode || undefined;
  const rawFromName = loc.name || undefined;

  const structuredRaw = [city, state, postCode, countryCode].filter(Boolean).join(", ");
  const raw = structuredRaw || rawFromName || undefined;

  if (!city && !state && !postCode && !countryCode && !raw) return undefined;

  return { city, state, postCode, countryCode, raw };
}

function sanitizeApiError(code, message) {
  // Map vendor-specific error codes to neutral messages
  const map = {
    no_active_subscription: { code: "service_unavailable", message: "Tracking service is not available at this time.", retryable: false },
    quota_limit_reached: { code: "temporarily_unavailable", message: "Tracking is temporarily unavailable. Please try again later.", retryable: true },
    tracker_not_found: { code: "not_found", message: "No tracking information found yet. The shipment may be too new or the number may be incorrect.", retryable: false },
    parcel_not_found: { code: "not_found", message: "No tracking information found yet. The shipment may be too new or the number may be incorrect.", retryable: false },
    timeout: { code: "timeout", message: "The tracking service took too long to respond. Please try again.", retryable: true },
    network_error: { code: "network_error", message: "Could not connect to the tracking service. Please try again.", retryable: true },
  };
  if (map[code]) return map[code];
  return { code: "tracking_error", message: "An error occurred while retrieving tracking information.", retryable: false };
}

// ─────────────────────────────────────────────
// PER-SHIPMENT MODE
// ─────────────────────────────────────────────
async function fetchPerShipment(trackingNumber) {
  const masked = maskTracking(trackingNumber);
  try {
    const data = await apiRequest("GET", `/trackers/search/${encodeURIComponent(trackingNumber)}/results`);
    const trackers = data?.data?.trackings || [];
    return { ok: true, trackers };
  } catch (err) {
    const sanitized = sanitizeApiError(err.code, err.message);
    return { ok: false, error: sanitized };
  }
}


// ─────────────────────────────────────────────
// PER-CALL MODE
// ─────────────────────────────────────────────
async function fetchPerCall(trackingNumber, courierCode, destinationPostCode, destinationCountryCode) {
  const body = {
    trackingNumber,
    ...(courierCode ? { courierCode } : {}),
    ...(destinationPostCode ? { destinationPostCode } : {}),
    ...(destinationCountryCode ? { destinationCountryCode } : {}),
  };
  try {
    const data = await apiRequest("POST", "/tracking/search", body);
    const trackings = data?.data?.trackings || [];
    return { ok: true, trackings };
  } catch (err) {
    const sanitized = sanitizeApiError(err.code, err.message);
    return { ok: false, error: sanitized };
  }
}

async function checkCourierRequirements(courierCode) {
  const couriers = await getCouriers();
  const courier = couriers.find((c) => c.courierCode === courierCode);
  if (!courier) return null;
  return {
    requiresPostCode: !!courier.is_destination_postcode_required,
    requiresCountry: !!courier.is_destination_country_code_required,
    requiresAccount: !!courier.is_courier_account_required,
  };
}

function buildNeedsMoreInfo(missingFields, language) {
  const questions = [];
  const hints = [];
  if (missingFields.includes("courierName")) {
    questions.push("Which carrier is handling your shipment?");
    hints.push("For example: DHL, FedEx, UPS, USPS, DPD");
  }
  if (missingFields.includes("destinationPostCode")) {
    questions.push("What is the destination ZIP or postal code?");
  }
  if (missingFields.includes("destinationCountryCode")) {
    questions.push("What country is the package being delivered to?");
  }
  const questionToAsk = questions.join(" ") || "Could you provide more details about your shipment?";
  return { requiredFields: missingFields, questionToAsk, hints: hints.length ? hints : undefined };
}

// ─────────────────────────────────────────────
// RESPONSE BUILDER
// ─────────────────────────────────────────────
function buildResponseFromTrackers(trackers, modeUsed) {
  if (!trackers || trackers.length === 0) {
    return null;
  }
  // Use first tracker with most events
  const tracker = [...trackers].sort((a, b) => (b.events?.length || 0) - (a.events?.length || 0))[0];
  const events = (tracker?.events || []).map(normalizeEvent);
  const latestEvent = events[events.length - 1] || {};
  // Ship24 carrier name: tracker.shipment.courier (per-shipment) or tracker.courier (per-call)
  const carrierName =
    tracker?.shipment?.courier?.name ||
    tracker?.courier?.name ||
    tracker?.shipment?.carrier?.name ||
    tracker?.carrier?.name ||
    undefined;
  const trackingNumber = tracker?.trackingNumber || tracker?.shipment?.trackingNumber || tracker?.tracker?.trackingNumber || undefined;

  // Location resolution priority:
  // 1. Last event location (most recent known position)
  // 2. Shipment-level location fields (lastLocation, destination)
  const shipmentLocation =
    normalizeLocation(tracker?.shipment?.lastLocation) ||
    normalizeLocation(tracker?.lastLocation) ||
    normalizeLocation(tracker?.shipment?.destination) ||
    normalizeLocation(tracker?.destination) ||
    undefined;

  const currentLocation = latestEvent.location || shipmentLocation;

  // Enrich last event location if missing but shipment-level location exists
  const enrichedEvents = events.map((ev, i) => {
    if (!ev.location && i === events.length - 1 && shipmentLocation) {
      return { ...ev, location: shipmentLocation };
    }
    return ev;
  });

  return {
    trackingNumber,
    carrier: { name: carrierName },
    current: {
      statusMilestone: latestEvent.statusMilestone,
      statusCategory: latestEvent.statusCategory,
      statusCode: latestEvent.statusCode,
      milestoneExplanation: latestEvent.milestoneExplanation,
      statusText: latestEvent.statusText,
      occurrenceDatetime: latestEvent.occurrenceDatetime,
      location: currentLocation,
    },
    events: enrichedEvents,
  };
}

function maskTracking(tn) {
  if (!tn || tn.length <= 4) return "****";
  return "*".repeat(tn.length - 4) + tn.slice(-4);
}

// ─────────────────────────────────────────────
// MCP SERVER
// ─────────────────────────────────────────────
const server = new McpServer({
  name: "shipment-tracking",
  version: VERSION,
});

// Tool: serviceStatus
server.tool(
  "serviceStatus",
  "Returns the current status and configuration of the shipment tracking service.",
  {},
  async () => {
    const result = {
      configured: IS_CONFIGURED,
      modesEnabled: {
        perShipment: PLAN_PER_SHIPMENT,
        perCall: PLAN_PER_CALL,
      },
      version: VERSION,
      time: new Date().toISOString(),
      notes: IS_CONFIGURED
        ? "Tracking service is operational."
        : "Tracking service is not configured. Please contact the site administrator.",
    };
    return {
      content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
    };
  }
);

// Tool: trackShipment
if (IS_CONFIGURED) {
  server.tool(
    "trackShipment",
    "Look up the current status and full event history of a shipment by tracking number.",
    {
      trackingNumber: z.string().describe("The shipment tracking number."),
      courierName: z.string().optional().describe("The carrier/courier commercial name (e.g., DHL, FedEx, UPS)."),
      destinationPostCode: z.string().optional().describe("Destination ZIP or postal code."),
      destinationCountryCode: z.string().optional().describe("Destination country code (ISO alpha-2 or alpha-3)."),
      language: z.string().optional().default("en").describe("Language for helper text (default: en)."),
    },
    async ({ trackingNumber, courierName, destinationPostCode, destinationCountryCode, language = "en" }) => {
      const response = {
        ok: false,
        modeUsed: null,
        trackingNumber,
        carrier: {},
        current: {},
        events: [],
      };

      // Resolve courier if provided
      let resolvedCourier = null;
      if (courierName) {
        const resolved = await resolveCourierName(courierName);
        if (resolved.ambiguous) {
          response.ok = false;
          response.needsMoreInfo = {
            requiredFields: ["courierName"],
            questionToAsk: `Multiple carriers match that name. Could you be more specific? ${resolved.options?.slice(0, 4).join(", ")}`,
          };
          return { content: [{ type: "text", text: JSON.stringify(response, null, 2) }] };
        }
        if (resolved.matched) {
          resolvedCourier = resolved.matched;
        }
        // deprecated or not found → proceed without courier
      }

      const courierCode = resolvedCourier?.courierCode || undefined;

      // ─── PER-SHIPMENT FIRST ───
      if (PLAN_PER_SHIPMENT) {
        const result = await fetchPerShipment(trackingNumber);

        if (result.ok && result.trackers?.length > 0) {
          const built = buildResponseFromTrackers(result.trackers, "per_shipment");
          if (built) {
            Object.assign(response, built, { ok: true, modeUsed: "per_shipment" });
            response.meta = {
              returnedTrackersCount: result.trackers.length,
            };
            return { content: [{ type: "text", text: JSON.stringify(response, null, 2) }] };
          }
          // Fall through to per-call
        } else if (!result.ok && !PLAN_PER_CALL) {
          // Only per-shipment available and it failed — return error
          response.ok = false;
          response.errors = [result.error];
          return { content: [{ type: "text", text: JSON.stringify(response, null, 2) }] };
        }
        // If per-shipment returned no trackers and per-call is available → fall through
      }

      // ─── PER-CALL ───
      if (PLAN_PER_CALL) {
        // If courier is known, check its specific requirements upfront
        if (courierCode) {
          const reqs = await checkCourierRequirements(courierCode);
          if (reqs) {
            const missing = [];
            if (reqs.requiresPostCode && !destinationPostCode) missing.push("destinationPostCode");
            if (reqs.requiresCountry && !destinationCountryCode) missing.push("destinationCountryCode");
            if (reqs.requiresAccount) missing.push("courierAccountNumber");
            if (missing.length > 0) {
              response.ok = false;
              response.needsMoreInfo = buildNeedsMoreInfo(missing, language);
              return { content: [{ type: "text", text: JSON.stringify(response, null, 2) }] };
            }
          }
        }

        const result = await fetchPerCall(trackingNumber, courierCode, destinationPostCode, destinationCountryCode);

        if (result.ok && result.trackings?.length > 0) {
          // Check if any tracking actually has events
          const hasAnyEvents = result.trackings.some((t) => (t.events?.length || 0) > 0);

          if (hasAnyEvents) {
            const built = buildResponseFromTrackers(result.trackings, "per_call");
            if (built) {
              Object.assign(response, built, { ok: true, modeUsed: "per_call" });
              return { content: [{ type: "text", text: JSON.stringify(response, null, 2) }] };
            }
          }

          // Trackings returned but all empty events — likely needs more info
          if (!courierName || !destinationPostCode) {
            const missing = [];
            if (!courierName) missing.push("courierName");
            if (!destinationPostCode) missing.push("destinationPostCode");
            response.ok = false;
            response.needsMoreInfo = buildNeedsMoreInfo(missing, language);
            return { content: [{ type: "text", text: JSON.stringify(response, null, 2) }] };
          }
        }

        if (!result.ok) {
          response.ok = false;
          response.errors = [result.error];
          // On any failure without full context, ask for more info
          if (!courierName || !destinationPostCode) {
            const missing = [];
            if (!courierName) missing.push("courierName");
            if (!destinationPostCode) missing.push("destinationPostCode");
            response.needsMoreInfo = buildNeedsMoreInfo(missing, language);
          }
          return { content: [{ type: "text", text: JSON.stringify(response, null, 2) }] };
        }

        // Per-call returned completely empty — ask for more info
        const missing = [];
        if (!courierName) missing.push("courierName");
        if (!destinationPostCode) missing.push("destinationPostCode");
        response.ok = false;
        if (missing.length > 0) {
          response.needsMoreInfo = buildNeedsMoreInfo(missing, language);
        } else {
          response.errors = [{ code: "not_found", message: "No tracking information found. Please verify the tracking number is correct.", retryable: false }];
        }
        return { content: [{ type: "text", text: JSON.stringify(response, null, 2) }] };
      }

      // Should not reach here
      response.ok = false;
      response.errors = [{ code: "service_unavailable", message: "No tracking mode is available.", retryable: false }];
      return { content: [{ type: "text", text: JSON.stringify(response, null, 2) }] };
    }
  );
} else {
  // Not configured — register a stub trackShipment that explains the situation
  server.tool(
    "trackShipment",
    "Look up shipment tracking information.",
    {
      trackingNumber: z.string().describe("The shipment tracking number."),
    },
    async () => {
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({
              ok: false,
              errors: [{ code: "not_configured", message: "Tracking service is not configured. Please contact the site administrator.", retryable: false }],
            }, null, 2),
          },
        ],
      };
    }
  );
}

// ─────────────────────────────────────────────
// START SERVER
// ─────────────────────────────────────────────
const transport = new StdioServerTransport();
await server.connect(transport);

/*
═══════════════════════════════════════════════════════════════════
HOW TO RUN — ship24-tracking-mcp.js
═══════════════════════════════════════════════════════════════════

REQUIREMENTS
  Node.js >= 18.0.0  (uses global fetch + ESM)

INSTALL DEPENDENCIES
  npm install @modelcontextprotocol/sdk zod

ENVIRONMENT VARIABLES
  Required:
    SHIP24_API_KEY=your_api_key_here

  Plan selection (at least one must be "true"):
    PLAN_PER_SHIPMENT=true      # Use Trackers endpoints (per-shipment plan)
    PLAN_PER_CALL=true          # Use Tracking Search endpoint (per-call plan)

  Optional:
    SHIP24_BASE_URL=https://api.ship24.com/public/v1
    COURIERS_CACHE_TTL_HOURS=24       # How long to cache the couriers list
    REQUEST_TIMEOUT_MS=15000          # HTTP request timeout in milliseconds

EXAMPLE — run directly
  SHIP24_API_KEY=sk_xxx PLAN_PER_SHIPMENT=true PLAN_PER_CALL=true node ship24-tracking-mcp.js

EXAMPLE — Claude Desktop config snippet (claude_desktop_config.json)
  {
    "mcpServers": {
      "shipment-tracking": {
        "command": "node",
        "args": ["/absolute/path/to/ship24-tracking-mcp.js"],
        "env": {
          "SHIP24_API_KEY": "your_api_key_here",
          "PLAN_PER_SHIPMENT": "true",
          "PLAN_PER_CALL": "true"
        }
      }
    }
  }

TOOLS EXPOSED
  serviceStatus    — Returns configuration/health info
  trackShipment    — Primary tracking tool for the chatbot

NOTES
  - End-users never see vendor names (Ship24, courierCode, etc.)
  - API key is never logged or surfaced in tool output
  - Tracking numbers are masked in any internal logs (last 4 digits only)
  - Courier requirements are checked before per-call requests
  - Per-shipment results are used first when both modes are enabled;
    falls back to per-call only if per-shipment returns no trackers
═══════════════════════════════════════════════════════════════════
*/