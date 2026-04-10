# BridgeBox MCP Server

Personal MCP toolbox for Bridgit-AI users. Pure Upstash Search — no Redis, no extra databases.

## Architecture

```
One Upstash Search database:
  └── Index: SKILLZILLA          ← the marketplace catalog (all skills)
  └── Index: bridgebox-avi8k     ← Avi's personal toolbox
  └── Index: bridgebox-user123   ← another user's toolbox
  └── Index: bridgebox-...       ← created automatically per user
```

Each user gets their own Search index. Indexes are created automatically on first upsert. Skills are copied from the catalog into the user's index when they click "Add to BridgeBox."

## 6 MCP Tools Per User

| Tool | What It Does |
|------|-------------|
| `bridgebox_list_skills` | List all skills in your BridgeBox (paginated) |
| `bridgebox_load_skill` | Load a skill by code — returns full system instruction |
| `bridgebox_search_catalog` | Search the Bridgit-AI marketplace |
| `bridgebox_add_skill` | Add a catalog skill to your BridgeBox |
| `bridgebox_remove_skill` | Remove a skill from your BridgeBox |
| `bridgebox_search_my_skills` | Search within your own BridgeBox only |

## Deploy to Railway

### 1. Push to GitHub

```bash
git init
git add .
git commit -m "bridgebox mcp server"
git remote add origin https://github.com/Tattzy25/bridgebox-mcp-server.git
git push -u origin main
```

### 2. Deploy on Railway

Railway → New Project → Deploy from GitHub → select the repo.

### 3. Set Environment Variables

```
UPSTASH_SEARCH_REST_URL=https://profound-dove-30416-gcp-usc1-search.upstash.io
UPSTASH_SEARCH_REST_TOKEN=your_token
PORT=3001
```

That's it. Two env vars. No Redis URL, no Redis token.

### 4. Custom Domain

Railway Settings → Custom Domain → `mcp.bridgit-ai.com`

Cloudflare DNS → CNAME:
- Name: `mcp`
- Target: your-railway-url.up.railway.app
- Proxy: OFF

### 5. Test

```bash
curl https://mcp.bridgit-ai.com/health

curl -X POST https://mcp.bridgit-ai.com/u/avi8k \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}}'
```

## Dashboard Integration

### When user clicks "Add to BridgeBox"

```typescript
// Upsert the skill into the user's personal Search index
const res = await fetch(`${UPSTASH_SEARCH_URL}/upsert/bridgebox-${userId}`, {
  method: "POST",
  headers: {
    Authorization: `Bearer ${UPSTASH_SEARCH_TOKEN}`,
    "Content-Type": "application/json",
  },
  body: JSON.stringify({
    id: skillCode,        // e.g. "SZ-PRM-001"
    content: skillContent, // searchable fields
    metadata: skillMeta,   // full system instruction, hidden
  }),
});
```

### Display MCP URL on BridgeBox page

```tsx
<div className="flex items-center gap-2">
  <code className="text-sm">https://mcp.bridgit-ai.com/u/{userId}</code>
  <button onClick={() => navigator.clipboard.writeText(url)}>Copy</button>
</div>
```

## How Users Connect

### Claude Desktop / Claude Code
```json
{
  "mcpServers": {
    "bridgebox": {
      "url": "https://mcp.bridgit-ai.com/u/avi8k"
    }
  }
}
```

### Cursor
Settings → MCP → Add → `https://mcp.bridgit-ai.com/u/avi8k`

### ChatGPT / Any MCP Client
POST `https://mcp.bridgit-ai.com/u/{userId}` with JSON-RPC 2.0

## The Flow

```
User browses bridgit-ai.com
    ↓
Clicks "Add to BridgeBox" on a skill tile
    ↓
Skill upserted into index: bridgebox-{userId}
    ↓
User copies their MCP URL: mcp.bridgit-ai.com/u/{userId}
    ↓
Pastes into Claude/Cursor/ChatGPT
    ↓
AI calls bridgebox_list_skills → sees their skills
AI calls bridgebox_load_skill → gets full system instruction
AI applies the skill → user gets elite output
```
