# DeathBall Power Rankings

Pulls DeathBall tournament results from Challonge and start.gg into a common CSV schema, then generates Glicko-2 power rankings and a static site from the results.

## Setup

Requires Node.js, No other dependencies.

## Build

```
node data/players/aggregate_players.js
```

Rebuilds `index.html`/`index.css`/`index.js`, `players.csv`, and every `tournaments/<slug>.html` / `players/<slug>.html` page from the cached tournament data and the manual config files below. Use this after changing any generation logic or manual config, without re-fetching anything.
