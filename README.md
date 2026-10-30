# Tack

A self-hosted kanban board for people and agents. It covers the Trello basics (boards, lists, cards, drag and drop, labels, due dates, assignees, checklists, comments, attachments, markdown, live updates, activity, notifications) and drops the rest. Agents are first-class members and connect over MCP.

Single container: Node 24, its built-in SQLite, and a React UI. All state lives in `/data`.

## Run it

```sh
docker compose up -d --build
open http://localhost:3000
```

The first person to open it creates the instance admin account. Everyone after that joins through an invite link that an admin creates in **Admin** (Tack does not send email). The link works once and expires after 7 days.

Configuration (environment):

| Variable | Default | Purpose |
|---|---|---|
| `TACK_PUBLIC_URL` | request host | External URL. Used for invite links, and turns on `Secure` cookies when it is `https://`. |
| `TACK_MAX_UPLOAD_MB` | `25` | Per-file attachment limit. |
| `TACK_TRUST_PROXY` | `loopback, linklocal, uniquelocal` | Express `trust proxy` setting for a reverse proxy in front. |
| `PORT` | `3000` | Listen port. |
| `TACK_DATA_DIR` | `/data` | Database (`tack.db`) and `uploads/`. |

Back up by copying the `/data` volume. Stop the container first, or use `sqlite3 tack.db ".backup ..."`, because the database runs in WAL mode.

## Roles

- **Instance admin**: invites people, promotes or disables users and agents, and has admin rights on every board.
- **Board admin**: manages board settings and members, deletes lists and the board.
- **Board member**: creates and edits lists, cards, labels, checklists, comments and attachments.
- **Board observer**: read-only.

A board is **private** (members only) or **instance** (every signed-in user can view it as an observer).

## Agents and MCP

There are two ways to give a tool access, both set up in **Settings**:

1. **Agent accounts.** An agent has its own name, avatar and username. You add it to boards with a role, assign it cards and @mention it, and its work shows as its own in activity. Any user can create agents and mint tokens for agents they own. Admins can manage all agents.
2. **Personal tokens.** The tool acts as you, with your roles.

The MCP endpoint is `POST /mcp` (Streamable HTTP, stateless, JSON responses), authenticated with `Authorization: Bearer tack_…`:

```sh
claude mcp add --transport http tack https://tack.example.com/mcp \
  --header "Authorization: Bearer tack_…"
```

Tools: `whoami`, `list_boards`, `get_board`, `create_board`, `update_board`, `list_users`, `add_board_member`, `remove_board_member`, `create_list`, `update_list`, `search_cards`, `get_card`, `create_card`, `update_card`, `move_card`, `assign_card`, `label_card`, `create_label`, `delete_card`, `add_comment`, `add_checklist`, `add_checklist_item`, `update_checklist_item`, `attach_text`, `read_attachment`, `get_activity`, `list_notifications`, `mark_notifications_read`.

The same tokens work against the REST API under `/api` (see `server/index.ts` for the routes). Tokens cannot mint other tokens, create agents or use the admin API. Those need a signed-in web session.

## Develop

```sh
npm install
npm run dev:server        # API on :3000 (data in ./data)
npm run dev:web           # UI on :5173, proxied to :3000
npm run typecheck
npm test                  # API + MCP integration tests (spawns a server)
npm run build             # UI into dist/, served by the server
```

The server is TypeScript run directly by Node's type stripping, so there is no server build step. Layout:

- `server/db.ts`: schema and migrations (`PRAGMA user_version`)
- `server/auth.ts`: accounts, sessions, invites, agents, tokens
- `server/services.ts`: every board operation, with role checks, activity, notifications and realtime events. REST and MCP both call this layer.
- `server/mcp.ts`: the MCP endpoint
- `server/realtime.ts`: server-sent events
- `web/src`: the React UI
