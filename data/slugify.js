// Shared filesystem-safe slug generator, used anywhere a tournament/player
// name or date needs to become part of a file path (CSV filenames, tournament
// page slugs, player page slugs).
//
// Windows reserves these device names for any file whose base name matches,
// regardless of extension (CON.html still resolves to the console device for
// native Win32 APIs like git.exe) — Node's fs can create such a file via its
// own path handling, but git and other Win32 tools then fail to open it.
const WINDOWS_RESERVED_NAMES = new Set([
  'con', 'prn', 'aux', 'nul',
  'com1', 'com2', 'com3', 'com4', 'com5', 'com6', 'com7', 'com8', 'com9',
  'lpt1', 'lpt2', 'lpt3', 'lpt4', 'lpt5', 'lpt6', 'lpt7', 'lpt8', 'lpt9',
]);

function slugify(s) {
  const slug = (s || '').trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  return WINDOWS_RESERVED_NAMES.has(slug) ? `${slug}-player` : slug;
}

module.exports = { slugify };
