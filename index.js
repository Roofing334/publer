const PORT = Number(process.env.PORT || 3000);
const PUBLER_API_BASE = process.env.PUBLER_API_BASE || "https://app.publer.com/api/v1";
const PUBLER_API_KEY = process.env.PUBLER_API_KEY;
const MCP_AUTH_TOKEN = process.env.MCP_AUTH_TOKEN;
const DEFAULT_WORKSPACE_ID = process.env.PUBLER_WORKSPACE_ID;

const serverInfo = {
  name: "sands-publer-mcp",
  version: "1.0.0",
};

const toolDefinitions = [
  {
    name: "list_workspaces",
    description: "List Publer workspaces available to the configured Publer API key.",
    inputSchema: {
      type: "object",
      properties: {},
      additionalProperties: false,
    },
  },
  {
    name: "list_accounts",
    description: "List social accounts connected to a Publer workspace.",
    inputSchema: {
      type: "object",
      properties: {
        workspace_id: { type: "string", description: "Publer workspace ID. Defaults to PUBLER_WORKSPACE_ID when configured." },
      },
      additionalProperties: false,
    },
  },
  {
    name: "list_posts",
    description: "List Publer posts by state, account, date range, query, post type, or creator.",
    inputSchema: {
      type: "object",
      properties: {
        workspace_id: { type: "string", description: "Publer workspace ID. Defaults to PUBLER_WORKSPACE_ID when configured." },
        state: { type: "string", description: "Post state such as scheduled, published, draft, failed, or all." },
        from: { type: "string", description: "ISO date or datetime for start of range." },
        to: { type: "string", description: "ISO date or datetime for end of range." },
        page: { type: "integer", description: "Page number." },
        account_ids: { type: "array", items: { type: "string" }, description: "Publer account IDs to filter by." },
        query: { type: "string", description: "Full-text post search." },
        postType: { type: "string", description: "Post type such as status, link, photo, video, reel, story, carousel, article." },
        member_id: { type: "string", description: "Workspace member ID." },
      },
      additionalProperties: false,
    },
  },
  {
    name: "create_draft_post",
    description: "Create a Publer draft post through /posts/schedule. Defaults bulk.state to draft when not provided.",
    inputSchema: {
      type: "object",
      required: ["bulk"],
      properties: {
        workspace_id: { type: "string", description: "Publer workspace ID. Defaults to PUBLER_WORKSPACE_ID when configured." },
        bulk: { type: "object", description: "Publer bulk payload. Include posts, networks, and accounts." },
      },
      additionalProperties: false,
    },
  },
  {
    name: "schedule_post",
    description: "Schedule an approved Publer post through /posts/schedule. Requires confirmed=true.",
    inputSchema: {
      type: "object",
      required: ["bulk", "confirmed"],
      properties: {
        workspace_id: { type: "string", description: "Publer workspace ID. Defaults to PUBLER_WORKSPACE_ID when configured." },
        bulk: { type: "object", description: "Publer bulk payload with state scheduled and scheduled_at values on accounts." },
        confirmed: { type: "boolean", description: "Must be true after final copy, accounts, media, and schedule time are approved." },
      },
      additionalProperties: false,
    },
  },
  {
    name: "publish_now",
    description: "Immediately publish an approved Publer post through /posts/schedule/publish. Requires confirmed=true.",
    inputSchema: {
      type: "object",
      required: ["bulk", "confirmed"],
      properties: {
        workspace_id: { type: "string", description: "Publer workspace ID. Defaults to PUBLER_WORKSPACE_ID when configured." },
        bulk: { type: "object", description: "Publer bulk payload with posts, networks, and accounts." },
        confirmed: { type: "boolean", description: "Must be true after final copy, accounts, and media are approved for immediate publishing." },
      },
      additionalProperties: false,
    },
  },
  {
    name: "get_job_status",
    description: "Check Publer async job status after creating, scheduling, or publishing posts.",
    inputSchema: {
      type: "object",
      required: ["job_id"],
      properties: {
        workspace_id: { type: "string", description: "Publer workspace ID. Defaults to PUBLER_WORKSPACE_ID when configured." },
        job_id: { type: "string", description: "Publer job ID returned by a create/schedule/publish request." },
      },
      additionalProperties: false,
    },
  },
];

function jsonResponse(res, status, body) {
  const payload = body === undefined ? "" : JSON.stringify(body);
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "content-type, authorization, x-mcp-auth",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  });
  res.end(payload);
}

function unauthorized(res) {
  jsonResponse(res, 401, { error: "Unauthorized" });
}

function isAuthorized(req) {
  if (!MCP_AUTH_TOKEN) return true;
  const auth = req.headers.authorization || "";
  const xAuth = req.headers["x-mcp-auth"] || "";
  return auth === `Bearer ${MCP_AUTH_TOKEN}` || xAuth === MCP_AUTH_TOKEN;
}

function parseBody(req) {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", (chunk) => {
      data += chunk;
      if (data.length > 2_000_000) {
        reject(new Error("Request body too large"));
        req.destroy();
      }
    });
    req.on("end", () => {
      if (!data) return resolve({});
      try {
        resolve(JSON.parse(data));
      } catch (error) {
        reject(new Error("Invalid JSON body"));
      }
    });
    req.on("error", reject);
  });
}

function requireApiKey() {
  if (!PUBLER_API_KEY) {
    throw new Error("PUBLER_API_KEY is not configured on the server.");
  }
}

function workspaceIdFrom(args = {}) {
  return args.workspace_id || DEFAULT_WORKSPACE_ID;
}

function requireWorkspace(args = {}) {
  const workspaceId = workspaceIdFrom(args);
  if (!workspaceId) {
    throw new Error("workspace_id is required unless PUBLER_WORKSPACE_ID is configured.");
  }
  return workspaceId;
}

function buildQuery(params = {}) {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null || value === "") continue;
    if (Array.isArray(value)) {
      for (const item of value) search.append(`${key}[]`, item);
    } else {
      search.append(key, String(value));
    }
  }
  const query = search.toString();
  return query ? `?${query}` : "";
}

async function publerRequest({ method, path, workspaceId, query, body }) {
  requireApiKey();
  const headers = {
    Authorization: `Bearer-API ${PUBLER_API_KEY}`,
    Accept: "application/json",
  };
  if (workspaceId) headers["Publer-Workspace-Id"] = workspaceId;
  if (body !== undefined) headers["Content-Type"] = "application/json";

  const response = await fetch(`${PUBLER_API_BASE}${path}${query || ""}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });

  const text = await response.text();
  let data;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = text;
  }

  if (!response.ok) {
    const error = new Error(`Publer API returned ${response.status}`);
    error.details = data;
    throw error;
  }

  return data;
}

async function callTool(name, args = {}) {
  switch (name) {
    case "list_workspaces":
      return publerRequest({ method: "GET", path: "/workspaces" });

    case "list_accounts":
      return publerRequest({ method: "GET", path: "/accounts", workspaceId: requireWorkspace(args) });

    case "list_posts": {
      const { workspace_id, ...filters } = args;
      return publerRequest({ method: "GET", path: "/posts", workspaceId: requireWorkspace({ workspace_id }), query: buildQuery(filters) });
    }

    case "create_draft_post": {
      const bulk = { ...(args.bulk || {}) };
      if (!bulk.state) bulk.state = "draft";
      return publerRequest({ method: "POST", path: "/posts/schedule", workspaceId: requireWorkspace(args), body: { bulk } });
    }

    case "schedule_post":
      if (args.confirmed !== true) throw new Error("schedule_post requires confirmed=true after final content, accounts, media, and timing are approved.");
      return publerRequest({ method: "POST", path: "/posts/schedule", workspaceId: requireWorkspace(args), body: { bulk: args.bulk } });

    case "publish_now":
      if (args.confirmed !== true) throw new Error("publish_now requires confirmed=true after final content, accounts, and media are approved for immediate publishing.");
      return publerRequest({ method: "POST", path: "/posts/schedule/publish", workspaceId: requireWorkspace(args), body: { bulk: args.bulk } });

    case "get_job_status":
      return publerRequest({ method: "GET", path: `/job_status/${encodeURIComponent(args.job_id)}`, workspaceId: requireWorkspace(args) });

    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}

function rpcResult(id, result) {
  return { jsonrpc: "2.0", id, result };
}

function rpcError(id, code, message, data) {
  return { jsonrpc: "2.0", id, error: { code, message, ...(data === undefined ? {} : { data }) } };
}

async function handleRpc(message) {
  const { id, method, params = {} } = message || {};

  if (!method) return rpcError(id ?? null, -32600, "Invalid JSON-RPC request");

  if (method === "initialize") {
    return rpcResult(id, {
      protocolVersion: params.protocolVersion || "2024-11-05",
      capabilities: { tools: {} },
      serverInfo,
      instructions: "Use Publer tools for Sands Roofing social account discovery, post drafts, scheduled posts, immediate publishing after approval, and job status checks.",
    });
  }

  if (method === "notifications/initialized") {
    return undefined;
  }

  if (method === "tools/list") {
    return rpcResult(id, { tools: toolDefinitions });
  }

  if (method === "tools/call") {
    try {
      const toolName = params.name;
      const args = params.arguments || {};
      const data = await callTool(toolName, args);
      return rpcResult(id, {
        content: [
          {
            type: "text",
            text: JSON.stringify(data, null, 2),
          },
        ],
      });
    } catch (error) {
      return rpcResult(id, {
        isError: true,
        content: [
          {
            type: "text",
            text: JSON.stringify({ error: error.message, details: error.details }, null, 2),
          },
        ],
      });
    }
  }

  return rpcError(id, -32601, `Method not found: ${method}`);
}

async function handleRequest(req, res) {
  if (req.method === "OPTIONS") {
    return jsonResponse(res, 204);
  }

  if (req.method === "GET" && (req.url === "/" || req.url === "/health")) {
    return jsonResponse(res, 200, {
      ok: true,
      server: serverInfo,
      publer_configured: Boolean(PUBLER_API_KEY),
      auth_required: Boolean(MCP_AUTH_TOKEN),
      endpoints: ["POST /mcp"],
    });
  }

  if (req.method !== "POST" || req.url !== "/mcp") {
    return jsonResponse(res, 404, { error: "Not found. Use POST /mcp for MCP JSON-RPC." });
  }

  if (!isAuthorized(req)) return unauthorized(res);

  try {
    const body = await parseBody(req);
    if (Array.isArray(body)) {
      const responses = (await Promise.all(body.map(handleRpc))).filter(Boolean);
      return responses.length ? jsonResponse(res, 200, responses) : jsonResponse(res, 204);
    }

    const response = await handleRpc(body);
    return response ? jsonResponse(res, 200, response) : jsonResponse(res, 204);
  } catch (error) {
    return jsonResponse(res, 400, rpcError(null, -32700, error.message));
  }
}

import("node:http").then(({ createServer }) => {
  createServer(handleRequest).listen(PORT, "0.0.0.0", () => {
    console.log(`Sands Publer MCP server listening on port ${PORT}`);
  });
});
