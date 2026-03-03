# ship24-tracking-mcp

An MCP (Model Context Protocol) server for shipment tracking. Connect any MCP-compatible AI assistant to the Ship24 API to track parcels by tracking number — with real-time status, full event history, carrier detection, and location information.

## Requirements

- Node.js 18+
- A [Ship24 API key](https://ship24.com)
- Either a per-shipment or per-call Ship24 plan (or both)

## Installation

### Claude Desktop

Add to your `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "ship24-tracking": {
      "command": "npx",
      "args": ["ship24-tracking-mcp"],
      "env": {
        "SHIP24_API_KEY": "your_api_key_here",
        "PLAN_PER_SHIPMENT": "true",
        "PLAN_PER_CALL": "false"
      }
    }
  }
}
```

### Cursor / other MCP clients

```json
{
  "ship24-tracking": {
    "command": "npx",
    "args": ["ship24-tracking-mcp"],
    "env": {
      "SHIP24_API_KEY": "your_api_key_here",
      "PLAN_PER_SHIPMENT": "true",
      "PLAN_PER_CALL": "false"
    }
  }
}
```

## Configuration

| Variable | Required | Description |
|---|---|---|
| `SHIP24_API_KEY` | Yes | Your Ship24 API key |
| `PLAN_PER_SHIPMENT` | One must be `true` | Enable the Trackers endpoint (per-shipment plan) |
| `PLAN_PER_CALL` | One must be `true` | Enable the Tracking Search endpoint (per-call plan) |
| `SHIP24_BASE_URL` | No | Override API base URL (default: `https://api.ship24.com/public/v1`) |
| `REQUEST_TIMEOUT_MS` | No | HTTP timeout in ms (default: `15000`) |
| `COURIERS_CACHE_TTL_HOURS` | No | Couriers list cache duration in hours (default: `24`) |

## Tools

### `trackShipment`

Track a shipment by tracking number. Returns the current status, most recent location, and full event timeline.

**Parameters:**
- `trackingNumber` *(required)* — The shipment tracking number
- `courierName` *(optional)* — Carrier name (e.g. DHL, FedEx, UPS, USPS). Recommended when known.
- `destinationPostCode` *(optional)* — Destination ZIP or postal code
- `destinationCountryCode` *(optional)* — Destination country (ISO alpha-2 or alpha-3)

### `serviceStatus`

Check whether the tracking service is configured and operational.

## License

MIT © [Ship24](https://ship24.com)
