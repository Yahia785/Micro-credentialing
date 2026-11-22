#!/usr/bin/env node
// Deletes imported A2 pilot data: the S3 objects and the table record. It is a DRY RUN unless --confirm is given.
//
//   node scripts/a2-import/delete.js --username fakeuser01                  what would be deleted for one GitHub username
//   node scripts/a2-import/delete.js --usernames fakeuser01,fakeuser02 --confirm
//   node scripts/a2-import/delete.js --usernames-file D:/a2-pilot-test/usernames.txt
//   node scripts/a2-import/delete.js --without-consent                      everyone whose consent is not "yes"
//
// --env dev (default) | production, or --table, --bucket, --region. Needs AWS credentials (yours) with s3:DeleteObject on a2-pilot/ and
// dynamodb:Query / Scan / DeleteItem on the table. S3 objects go first; a record whose objects could not be deleted is kept, so you can run it again.
const fs = require('fs');
const { makeStore } = require('./lib/store');
const { selectForDeletion, keysOf } = require('./lib/select-delete');
const { DEFAULT_BUCKET, DEFAULT_REGION, tableFor, normalizeUsername } = require('./lib/common');

function parseArgs(argv) {
  const args = { env: 'dev', region: DEFAULT_REGION, bucket: DEFAULT_BUCKET, usernames: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--confirm') args.confirm = true;
    else if (a === '--without-consent') args.withoutConsent = true;
    else if (a === '--username') { args.usernames.push(argv[i + 1]); i += 1; } else if (a === '--usernames') { args.usernames.push(...String(argv[i + 1]).split(',')); i += 1; } else if (a === '--usernames-file') { args.usernames.push(...fs.readFileSync(argv[i + 1], 'utf8').split(/\r?\n/).filter((l) => l.trim() && !l.startsWith('#'))); i += 1; } else if (['--env', '--table', '--bucket', '--region'].includes(a)) { args[a.slice(2)] = argv[i + 1]; i += 1; } else throw new Error(`unknown argument ${a}`);
  }
  args.usernames = args.usernames.map(normalizeUsername).filter(Boolean);
  return args;
}

/** Find the records, print them, and (with confirm) delete. `store` is injected for tests. */
async function run(args, store, log = console.log) {
  if ((args.usernames.length > 0) === Boolean(args.withoutConsent)) throw new Error('give usernames (--username, --usernames, --usernames-file) or --without-consent, not both and not neither');
  let items;
  if (args.withoutConsent) items = selectForDeletion({ items: await store.scanAll(), withoutConsent: true });
  else {
    const found = [];
    for (const username of args.usernames) found.push(...await store.findByUsername(username));
    items = selectForDeletion({ items: found, usernames: args.usernames });
  }
  const counts = { records: items.length, objects: items.reduce((n, i) => n + keysOf(i).length, 0), deletedRecords: 0, deletedObjects: 0, failures: 0, usernamesWithoutRecord: 0 };
  if (!args.withoutConsent) {
    const have = new Set(items.map((i) => normalizeUsername(i.githubUsername)));
    counts.usernamesWithoutRecord = args.usernames.filter((u) => !have.has(u)).length;
  }
  log(`${args.confirm ? 'DELETING' : 'DRY RUN (nothing is deleted; add --confirm)'}: table ${store.table}, bucket ${store.bucket}`);
  for (const item of items) {
    log(`  ${item.githubUsername}  importId ${item.importId}  consent ${item.consent || 'missing'}  objects ${keysOf(item).length}`);
    if (!args.confirm) continue;
    try {
      for (const key of keysOf(item)) { await store.deleteObject(key); counts.deletedObjects += 1; }
      await store.deleteRecord(item.importId);
      counts.deletedRecords += 1;
    } catch (error) {
      counts.failures += 1;
      log(`    FAILED: ${error.message}`);
    }
  }
  log(`\nrecords found ${counts.records}, S3 objects ${counts.objects}${args.confirm ? `, deleted records ${counts.deletedRecords}, deleted objects ${counts.deletedObjects}, failures ${counts.failures}` : ' (dry run)'}${counts.usernamesWithoutRecord ? `, usernames without a record ${counts.usernamesWithoutRecord}` : ''}`);
  return counts;
}

module.exports = { parseArgs, run };

if (require.main === module) {
  (async () => {
    const args = parseArgs(process.argv.slice(2));
    const store = makeStore({ table: args.table || tableFor(args.env), bucket: args.bucket, region: args.region });
    const counts = await run(args, store);
    if (counts.failures > 0) process.exit(1);
  })().catch((error) => { console.error(error.message); process.exit(1); });
}
