# Sands Publer MCP

A small hosted MCP-style HTTP server for connecting Sands Roofing agents to the Publer API.

## What It Does

This service exposes Publer tools for:

- listing Publer workspaces
- listing connected social accounts
- listing draft, scheduled, published, and failed posts
- creating draft posts
- scheduling approved posts
- publishing approved posts immediately
- checking Publer async job status

Scheduling and publishing require `confirmed: true` so agents cannot publish public social content without explicit approval.

## Render Deployment

Create this as a Render **Web Service**.

Recommended settings:

- **Build Command:** `npm install`
- **Start Command:** `npm start`
- **Health Check Path:** `/health`
- **Node Version:** `24`

Render environment variables:

| Key | Required | Notes |
| --- | --- | --- |
| `PUBLER_API_KEY` | Yes | Publer API key. Keep secret. Do not commit it. |
| `MCP_AUTH_TOKEN` | Yes | Shared bearer token used to protect the MCP endpoint. |
| `PUBLER_WORKSPACE_ID` | Optional | Saves agents from passing workspace_id every time after discovery. |
| `PUBLER_API_BASE` | Optional | Defaults to `https://app.publer.com/api/v1`. |

## Endpoints

- `GET /health` - deployment health check and config status
- `POST /mcp` - JSON-RPC MCP endpoint

If `MCP_AUTH_TOKEN` is set, call `/mcp` with:

```http
Authorization: Bearer YOUR_MCP_AUTH_TOKEN
```

or:

```http
X-MCP-Auth: YOUR_MCP_AUTH_TOKEN
```

## Tools

- `list_workspaces`
- `list_accounts`
- `list_posts`
- `create_draft_post`
- `schedule_post`
- `publish_now`
- `get_job_status`

## First Test

After deploying, open:

```text
https://YOUR-RENDER-SERVICE.onrender.com/health
```

You should see `ok: true` and `publer_configured: true` after `PUBLER_API_KEY` is set.

Then connect your MCP client to:

```text
https://YOUR-RENDER-SERVICE.onrender.com/mcp
```

Use the `MCP_AUTH_TOKEN` as the bearer token.
