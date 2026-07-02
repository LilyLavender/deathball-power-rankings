// participant.name is blank when the player registered via their Challonge
// account instead of a custom name; username covers that case, falling back
// further to display_name for invited-but-unlinked participants. display_name
// bakes in a literal " (invitation pending)" suffix for unaccepted invites,
// which we strip since it's not part of the player's actual name.
//
// Shared by challonge/fetch_batch.js, challonge/regenerate_csvs.js, and
// players/aggregate_players.js — fix here once instead of in three places.
function resolveParticipantName(p) {
  const raw = p.name || p.username || p.display_name || '';
  return raw.replace(/ \(invitation pending\)$/, '');
}

module.exports = { resolveParticipantName };
