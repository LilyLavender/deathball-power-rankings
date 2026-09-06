# DeathBall Power Rankings

Pulls DeathBall tournament results from Challonge and start.gg into a common CSV schema, then generates Glicko-2 power rankings and a static site from the results.

## Setup

Requires Node.js, No other dependencies.

## Build

```
.\regenerate_site.bat
```

Runs: `node data\players\aggregate_players.js` & `node data\players\player_graph.js`.

Rebuilds `index.html`/`index.css`/`index.js`, `players.csv`, and every `tournaments/<slug>.html` / `players/<slug>.html` page from the cached tournament data and the manual config files below. Use this after changing any generation logic or manual config, without re-fetching anything.

## Adding tournaments

1. Add new tournaments to the bottom of `tours-all-challonge.md` or `tours-all-startgg.md`.
2. Run:
```
.\add_tournaments.bat
```

This command fetches tournaments via their url from either service, asks some player-related questions via a text-based wizard, and then aggregates all new data. You may need to add additional data to the many `.json` files after adding a tournament.
