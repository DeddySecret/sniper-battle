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
- No developer-overlay password is needed. The Tactical Overlay is a permanent account unlock purchasable by any player in the in-game shop for 5,000 coins.

Never commit database URLs, passwords, or signing secrets to GitHub.

## Important next steps
- Run a full browser and multiplayer test against a staging deployment before merging.
- Current room state is held in server memory; rooms disappear on server restart.
- Map themes have distinct visual landmarks, but map-specific collision/layout tuning and additional gameplay polish still need testing.
- Coin rewards: one coin per five kills and one coin per five minutes of online activity, capped at 28 time-based coins per rolling 24-hour window.
- Cosmetic shop with purchases and equipped appearance, persisted in PostgreSQL.
- ESC settings, generated sound effects, mouse inversion, and a shop-unlocked Tactical Overlay (ESP, skeleton, health, names, weapon, radar and FOV circle).
- Full browser and multiplayer testing is still required before merging. The Tactical Overlay is saved permanently to the player account after purchase.
