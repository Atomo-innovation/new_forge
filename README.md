# Atomo Forge (big)

Self-contained app: login + registration → master/slave (cluster-role) → user-role → full `/overview` dashboard (cameras + AI/detection).

## Run on another device

Requirements: Node.js 18+ (tested on Node 22).

```bash
cd big
npm install        # rebuilds the native better-sqlite3 module for this device
node server.js
```

Then open `http://localhost:3000`.

To change the port/host:

```bash
PORT=3000 HOST=0.0.0.0 node server.js
```

## Configuration

- `app-config.json` — sets `meshcentralUrl` (Atomic Center). Edit this for the target environment, or set `MESHCENTRAL_URL`.
- Optional env vars (defaults shown):
  - `BACKEND_API_URL=http://localhost:3001` — Python vision backend (live camera streams + AI).
  - `MEDIAMTX_HLS_URL=http://localhost:8888` — HLS relay.
  Live camera/AI data needs these services; without them the dashboard still renders.

## Important when copying to another device

Do **not** copy the `data/` folder — it holds this device's binding, session and
local SQLite DB. Delete it (or rely on `.gitignore`) so the new device starts
fresh; otherwise login may be locked to the original device's bound user.

```bash
rm -rf data
```

## Flow

1. `/login` (or `/signup`) — authenticate against Atomic Center (offline login supported once bound).
2. `/device-registration` — one-time device onboarding.
3. `/cluster-role` — choose Master / Slave / Standalone.
4. `/user-role` — pick the dashboard role (skipped for Standalone).
5. `/overview` — the main dashboard.
# Forge_Final
# new_forge
# new_forge
