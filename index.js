import { createServer } from "node:http";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";

const PORT = Number(process.env.PORT || 3000);
const MCP_PATH = "/mcp";
const PUBLER_API_BASE = process.env.PUBLER_API_BASE || "https://app.publer.com/api/v1";
const PUBLER_API_KEY = process.env.PUBLER_API_KEY;
const MCP_AUTH_TOKEN = process.env.MCP_AUTH_TOKEN;
const DEFAULT_WORKSPACE_ID = process.env.PUBLER_WORKSPACE_ID;

function json(res, status, body) {
  res.writeHead(status, {
    "content-type": "application/json",
    "access-control-allow-origin": "*",
    "access-control-allow-methods": "POST, GET, DELETE, OPTIONS",
    "access-control-allow-headers": "content-type, mcp-session-id, authorization, x-mcp-auth",
    "access-control-expose-headers": "Mcp-Session-Id",
  });
  res.end(body === undefined ? "" : JSON.stringify(body));
}

function isAuthorized(req) {
  if (!MCP_AUTH_TOKEN) return true;
  const auth = req.headers.authorization || "";
  const xAuth = req.headers["x-mcp-auth"] || "";
  return auth === `Bearer ${MCP_AUTH_TOKEN}` || xAuth === MCP_AUTH_TOKEN;
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

function textResult(data) {
  return {
    content: [
      {
        type: "text",
        text: typeof data === "string" ? data : JSON.stringify(data, null, 2),
      },
    ],
  };
}

function errorResult(error) {
  return {
    isError: true,
    content: [
      {
        type: "text",
        text: JSON.stringify({ error: error.message, details: error.details }, null, 2),
      },
    ],
  };
}

async function runSafely(handler) {
  try {
    return textResult(await handler());
  } catch (error) {
    return errorResult(error);
  }
}

const workspaceSchema = {
  workspace_id: z.string().optional().describe("Publer workspace ID. Defaults to PUBLER_WORKSPACE_ID when configured."),
};

const bulkSchema = z.record(z.any()).describe("Publer bulk payload. Include state, posts, networks, accounts, and scheduling fields as needed.");

function createPublerServer() {
  const server = new McpServer({
    name: "sands-publer-mcp",
    version: "1.0.0",
  });

  server.registerTool(
    "list_workspaces",
    {
      title: "List Publer workspaces",
      description: "List Publer workspaces available to the configured Publer API key.",
      inputSchema: {},
    },
    async () => runSafely(() => publerRequest({ method: "GET", path: "/workspaces" }))
  );

  server.registerTool(
    "list_accounts",
    {
      title: "List Publer accounts",
      description: "List social accounts connected to a Publer workspace.",
      inputSchema: workspaceSchema,
    },
    async (args) => runSafely(() => publerRequest({ method: "GET", path: "/accounts", workspaceId: requireWorkspace(args) }))
  );

  server.registerTool(
    "list_posts",
    {
      title: "List Publer posts",
      description: "List Publer posts by state, account, date range, query, post type, or creator.",
      inputSchema: {
        ...workspaceSchema,
        state: z.string().optional().describe("Post state such as scheduled, published, draft, failed, or all."),
        from: z.string().optional().describe("ISO date or datetime for start of range."),
        to: z.string().optional().describe("ISO date or datetime for end of range."),
        page: z.number().int().optional().describe("Page number."),
        account_ids: z.array(z.string()).optional().describe("Publer account IDs to filter by."),
        query: z.string().optional().describe("Full-text post search."),
        postType: z.string().optional().describe("Post type such as status, link, photo, video, reel, story, carousel, article."),
        member_id: z.string().optional().describe("Workspace member ID."),
      },
    },
    async (args) => runSafely(() => {
      const { workspace_id, ...filters } = args;
      return publerRequest({ method: "GET", path: "/posts", workspaceId: requireWorkspace({ workspace_id }), query: buildQuery(filters) });
    })
  );

  server.registerTool(
    "create_draft_post",
    {
      title: "Create Publer draft post",
      description: "Create a Publer draft post through /posts/schedule. Defaults bulk.state to draft when not provided.",
      inputSchema: {
        ...workspaceSchema,
        bulk: bulkSchema,
      },
    },
    async (args) => runSafely(() => {
      const bulk = { ...(args.bulk || {}) };
      if (!bulk.state) bulk.state = "draft";
      return publerRequest({ method: "POST", path: "/posts/schedule", workspaceId: requireWorkspace(args), body: { bulk } });
    })
  );

  server.registerTool(
    "schedule_post",
    {
      title: "Schedule Publer post",
      description: "Schedule an approved Publer post through /posts/schedule. Requires confirmed=true after final copy, accounts, media, and timing are approved.",
      inputSchema: {
        ...workspaceSchema,
        bulk: bulkSchema,
        confirmed: z.boolean().describe("Must be true after final content, accounts, media, and schedule time are approved."),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    async (args) => runSafely(() => {
      if (args.confirmed !== true) throw new Error("schedule_post requires confirmed=true after final content, accounts, media, and timing are approved.");
      return publerRequest({ method: "POST", path: "/posts/schedule", workspaceId: requireWorkspace(args), body: { bulk: args.bulk } });
    })
  );

  server.registerTool(
    "publish_now",
    {
      title: "Publish Publer post now",
      description: "Immediately publish an approved Publer post through /posts/schedule/publish. Requires confirmed=true after final copy, accounts, and media are approved.",
      inputSchema: {
        ...workspaceSchema,
        bulk: bulkSchema,
        confirmed: z.boolean().describe("Must be true after final content, accounts, and media are approved for immediate publishing."),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    async (args) => runSafely(() => {
      if (args.confirmed !== true) throw new Error("publish_now requires confirmed=true after final content, accounts, and media are approved for immediate publishing.");
      return publerRequest({ method: "POST", path: "/posts/schedule/publish", workspaceId: requireWorkspace(args), body: { bulk: args.bulk } });
    })
  );

  server.registerTool(
    "get_job_status",
    {
      title: "Get Publer job status",
      description: "Check Publer async job status after creating, scheduling, or publishing posts.",
      inputSchema: {
        ...workspaceSchema,
        job_id: z.string().describe("Publer job ID returned by a create/schedule/publish request."),
      },
    },
    async (args) => runSafely(() => publerRequest({ method: "GET", path: `/job_status/${encodeURIComponent(args.job_id)}`, workspaceId: requireWorkspace(args) }))
  );

  return server;
}

const httpServer = createServer(async (req, res) => {
  if (!req.url) {
    res.writeHead(400).end("Missing URL");
    return;
  }

  const url = new URL(req.url, `http://${req.headers.host ?? "localhost"}`);

  if (req.method === "OPTIONS" && url.pathname === MCP_PATH) {
    res.writeHead(204, {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "POST, GET, DELETE, OPTIONS",
      "Access-Control-Allow-Headers": "content-type, mcp-session-id, authorization, x-mcp-auth",
      "Access-Control-Expose-Headers": "Mcp-Session-Id",
    });
    res.end();
    return;
  }

  if (req.method === "GET" && (url.pathname === "/" || url.pathname === "/health")) {
    json(res, 200, {
      ok: true,
      server: { name: "sands-publer-mcp", version: "1.0.0" },
      publer_configured: Boolean(PUBLER_API_KEY),
      auth_required: Boolean(MCP_AUTH_TOKEN),
      endpoint: MCP_PATH,
    });
    return;
  }

  const MCP_METHODS = new Set(["POST", "GET", "DELETE"]);
  if (url.pathname === MCP_PATH && req.method && MCP_METHODS.has(req.method)) {
    if (!isAuthorized(req)) {
      res.writeHead(401, {
        "content-type": "application/json",
        "www-authenticate": "Bearer",
      });
      res.end(JSON.stringify({ error: "Unauthorized" }));
      return;
    }

    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Expose-Headers", "Mcp-Session-Id");

    const server = createPublerServer();
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
    });

    res.on("close", () => {
      transport.close();
      server.close();
    });

    try {
      await server.connect(transport);
      await transport.handleRequest(req, res);
    } catch (error) {
      console.error("Error handling MCP request:", error);
      if (!res.headersSent) {
        res.writeHead(500).end("Internal server error");
      }
    }
    return;
  }

  res.writeHead(404).end("Not Found");
});

httpServer.listen(PORT, "0.0.0.0", () => {
  console.log(`Sands Publer MCP server listening on http://0.0.0.0:${PORT}${MCP_PATH}`);
});
