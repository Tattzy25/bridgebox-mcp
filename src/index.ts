import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import express from "express";
import { z } from "zod";

// ─────────────────────────────────────────────
// CONFIG — One Upstash Search database. That's it.
// ─────────────────────────────────────────────

const SEARCH_URL = process.env.UPSTASH_SEARCH_REST_URL!;
const SEARCH_TOKEN = process.env.UPSTASH_SEARCH_REST_TOKEN!;
const CATALOG_INDEX = "SKILLZILLA";
const bridgeboxIndex = (userId: string) => `bridgebox-${userId}`;

// ─────────────────────────────────────────────
// UPSTASH SEARCH — search, fetch, range, upsert, delete
// ─────────────────────────────────────────────

interface SkillDoc {
  id: string;
  content: Record<string, unknown>;
  metadata: Record<string, unknown>;
  score?: number;
}

async function searchIndex(index: string, query: string, limit = 10): Promise<SkillDoc[]> {
  const res = await fetch(`${SEARCH_URL}/search/${index}`, {
    method: "POST",
    headers: { Authorization: `Bearer ${SEARCH_TOKEN}`, "Content-Type": "application/json" },
    body: JSON.stringify({ query, limit }),
  });
  return res.ok ? ((await res.json()) as SkillDoc[]) : [];
}

async function fetchDocs(index: string, ids: string[]): Promise<SkillDoc[]> {
  const res = await fetch(`${SEARCH_URL}/fetch/${index}`, {
    method: "POST",
    headers: { Authorization: `Bearer ${SEARCH_TOKEN}`, "Content-Type": "application/json" },
    body: JSON.stringify({ ids }),
  });
  return res.ok ? ((await res.json()) as SkillDoc[]) : [];
}

async function rangeDocs(index: string, cursor = "0", limit = 50): Promise<{ nextCursor: string; documents: SkillDoc[] }> {
  const res = await fetch(`${SEARCH_URL}/range/${index}`, {
    method: "POST",
    headers: { Authorization: `Bearer ${SEARCH_TOKEN}`, "Content-Type": "application/json" },
    body: JSON.stringify({ cursor, limit }),
  });
  return res.ok ? ((await res.json()) as { nextCursor: string; documents: SkillDoc[] }) : { nextCursor: "", documents: [] };
}

async function upsertDoc(index: string, doc: { id: string; content: Record<string, unknown>; metadata: Record<string, unknown> }): Promise<boolean> {
  const res = await fetch(`${SEARCH_URL}/upsert/${index}`, {
    method: "POST",
    headers: { Authorization: `Bearer ${SEARCH_TOKEN}`, "Content-Type": "application/json" },
    body: JSON.stringify(doc),
  });
  return res.ok;
}

async function deleteDocs(index: string, ids: string[]): Promise<boolean> {
  const res = await fetch(`${SEARCH_URL}/delete/${index}`, {
    method: "POST",
    headers: { Authorization: `Bearer ${SEARCH_TOKEN}`, "Content-Type": "application/json" },
    body: JSON.stringify({ ids }),
  });
  return res.ok;
}

// ─────────────────────────────────────────────
// MCP SERVER — 6 tools per user
// ─────────────────────────────────────────────

function createBridgeBoxServer(userId: string): McpServer {
  const server = new McpServer({ name: "bridgebox-mcp-server", version: "1.0.0" });
  const idx = bridgeboxIndex(userId);

  // 1. List skills in BridgeBox
  server.registerTool("bridgebox_list_skills", {
    title: "List My Skills",
    description: "List all skills in your BridgeBox with pagination.",
    inputSchema: {
      cursor: z.string().default("0").describe("Pagination cursor"),
      limit: z.number().int().min(1).max(50).default(20).describe("Skills per page"),
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  }, async ({ cursor, limit }: { cursor: string; limit: number }) => {
    const result = await rangeDocs(idx, cursor, limit);
    if (!result.documents.length) return { content: [{ type: "text" as const, text: "Your BridgeBox is empty. Visit bridgit-ai.com to add skills." }] };
    return { content: [{ type: "text" as const, text: JSON.stringify({ userId, skills: result.documents.map(d => ({ id: d.id, ...d.content })), nextCursor: result.nextCursor, hasMore: result.nextCursor !== "" }, null, 2) }] };
  });

  // 2. Load a specific skill
  server.registerTool("bridgebox_load_skill", {
    title: "Load Skill",
    description: "Load the full skill from your BridgeBox — system instruction, framework, everything.",
    inputSchema: { skill_code: z.string().min(1).describe("Skill code (e.g. SZ-PRM-001)") },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  }, async ({ skill_code }: { skill_code: string }) => {
    const results = await fetchDocs(idx, [skill_code]);
    if (!results.length) return { content: [{ type: "text" as const, text: `"${skill_code}" not in your BridgeBox. Use bridgebox_add_skill to add it.` }] };
    const s = results[0];
    return { content: [{ type: "text" as const, text: JSON.stringify({ id: s.id, ...s.content, ...s.metadata }, null, 2) }] };
  });

  // 3. Search the catalog
  server.registerTool("bridgebox_search_catalog", {
    title: "Search Catalog",
    description: "Search the Bridgit-AI skill marketplace. Find new skills to add to your BridgeBox.",
    inputSchema: {
      query: z.string().min(1).describe("Search query"),
      limit: z.number().int().min(1).max(20).default(5).describe("Max results"),
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  }, async ({ query, limit }: { query: string; limit: number }) => {
    const results = await searchIndex(CATALOG_INDEX, query, limit);
    if (!results.length) return { content: [{ type: "text" as const, text: `No skills found for "${query}".` }] };
    const owned = new Set((await rangeDocs(idx, "0", 100)).documents.map(d => d.id));
    return { content: [{ type: "text" as const, text: JSON.stringify({ query, results: results.map(s => ({ id: s.id, ...s.content, score: s.score, inBridgeBox: owned.has(s.id) })) }, null, 2) }] };
  });

  // 4. Add skill to BridgeBox
  server.registerTool("bridgebox_add_skill", {
    title: "Add Skill",
    description: "Copy a skill from the catalog into your BridgeBox. Available via MCP instantly.",
    inputSchema: { skill_code: z.string().min(1).describe("Skill code to add") },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  }, async ({ skill_code }: { skill_code: string }) => {
    let docs = await fetchDocs(CATALOG_INDEX, [skill_code]);
    if (!docs.length) docs = await searchIndex(CATALOG_INDEX, skill_code, 1);
    if (!docs.length) return { content: [{ type: "text" as const, text: `"${skill_code}" not found in catalog.` }] };
    const s = docs[0];
    const ok = await upsertDoc(idx, { id: s.id, content: s.content, metadata: s.metadata });
    return { content: [{ type: "text" as const, text: ok ? `Added "${s.id}" to your BridgeBox.` : "Failed to add. Try again." }] };
  });

  // 5. Remove skill from BridgeBox
  server.registerTool("bridgebox_remove_skill", {
    title: "Remove Skill",
    description: "Remove a skill from your BridgeBox. It stays in the catalog — add it back anytime.",
    inputSchema: { skill_code: z.string().min(1).describe("Skill code to remove") },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
  }, async ({ skill_code }: { skill_code: string }) => {
    const ok = await deleteDocs(idx, [skill_code]);
    return { content: [{ type: "text" as const, text: ok ? `Removed "${skill_code}".` : "Failed to remove." }] };
  });

  // 6. Search within your own BridgeBox
  server.registerTool("bridgebox_search_my_skills", {
    title: "Search My Skills",
    description: "Search only within your BridgeBox — not the full catalog.",
    inputSchema: {
      query: z.string().min(1).describe("Search query"),
      limit: z.number().int().min(1).max(20).default(5).describe("Max results"),
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  }, async ({ query, limit }: { query: string; limit: number }) => {
    const results = await searchIndex(idx, query, limit);
    if (!results.length) return { content: [{ type: "text" as const, text: `No matches for "${query}" in your BridgeBox.` }] };
    return { content: [{ type: "text" as const, text: JSON.stringify({ query, results: results.map(s => ({ id: s.id, ...s.content, score: s.score })) }, null, 2) }] };
  });

  return server;
}

// ─────────────────────────────────────────────
// EXPRESS — Streamable HTTP Transport
// ─────────────────────────────────────────────

const app = express();
app.use(express.json());

app.get("/health", (_req, res) => {
  res.json({ status: "ok", service: "bridgebox-mcp-server" });
});

app.post("/u/:userId", async (req, res) => {
  const { userId } = req.params;
  if (!userId || userId.length < 2) { res.status(400).json({ error: "Invalid user ID" }); return; }
  try {
    const server = createBridgeBoxServer(userId);
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    res.on("close", () => transport.close());
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  } catch (error) {
    console.error(`MCP error for ${userId}:`, error);
    res.status(500).json({ error: "Internal server error" });
  }
});

const port = parseInt(process.env.PORT || "3001");
app.listen(port, () => {
  console.error(`BridgeBox MCP running on :${port}`);
  console.error(`Catalog: ${CATALOG_INDEX} | User indexes: bridgebox-{userId}`);
});
