const { normalizeUsername } = require('./common');

/**
 * Which records to delete. Exactly one mode:
 *   usernames: ['a', 'b']  every record of those GitHub usernames (case-insensitive)
 *   withoutConsent: true   every record whose consent is not "yes" (so "unknown", "no" and a missing value all count)
 * Returns the matching items. A record with consent "yes" is never selected by withoutConsent; a username match ignores consent.
 */
function selectForDeletion({ items, usernames, withoutConsent }) {
  const modes = [Array.isArray(usernames) && usernames.length > 0, Boolean(withoutConsent)].filter(Boolean).length;
  if (modes !== 1) throw new Error('choose exactly one of: usernames, withoutConsent');
  if (withoutConsent) return (items || []).filter((item) => item.consent !== 'yes');
  const wanted = new Set(usernames.map(normalizeUsername));
  return (items || []).filter((item) => wanted.has(normalizeUsername(item.githubUsername)));
}

/** The S3 keys of a record (header and source), without duplicates; none for a record that has no files. */
const keysOf = (item) => [...new Set(item.s3Keys ? [item.s3Keys.header, item.s3Keys.source].filter(Boolean) : [])];

module.exports = { selectForDeletion, keysOf };
