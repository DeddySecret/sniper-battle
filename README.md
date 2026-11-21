# Sniper Battle 3D

## Development branch
New account, lobby and map-selection work is being developed on `feature/full-lobby-accounts`. The production `main` branch has not been changed.

## Current implementation
- Nickname + password registration and login (nickname is the in-game display name).
- Nicknames are 3–15 characters and unique (case-insensitive).
- Passwords are stored as salted scrypt hashes, never as plaintext.
- A signed 30-day login token is stored in the browser.
- Players must authenticate and join a lobby before the game server accepts movement or shots.
- Lobby creator selects one of six maps; private rooms can use a password.
- Room capacity is 15 players.
- Space jumps, with jump height synchronized to other players.
- PostgreSQL stores user accounts.

## Render environment
The web service needs:
- `DATABASE_URL`: Render PostgreSQL Internal Database URL (keep it secret).
- `AUTH_SECRET`: optional long random secret for signing login tokens. If omitted, the server derives the signing key from `DATABASE_URL`.

Never commit database URLs, passwords, or signing secrets to GitHub.

## Important next steps
- Run a full browser and multiplayer test against a staging deployment before merging.
- Current room state is held in server memory; rooms disappear on server restart.
- Map themes have distinct visual landmarks, but map-specific collision/layout tuning and additional gameplay polish still need testing.
- Daily coins, shop, cosmetics, stats persistence, sound/settings and developer overlay are not implemented yet.
