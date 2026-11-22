// Shared pieces of the A2 pilot import and delete scripts. No I/O here.
const path = require('path');
const { createRequire } = require('module');

/** The four functions of Assignment 02 that interviews can ask about. mode is the backup. */
const FUNCTIONS = ['reverseList', 'splitString', 'playCraps', 'mode'];
const PRIMARY = ['reverseList', 'splitString', 'playCraps'];
/** The driver (scripts/eval/a2/driver/main.cpp) leaves a function out when this macro is defined. */
const NO_MACRO = { reverseList: 'A2_NO_REVERSELIST', splitString: 'A2_NO_SPLITSTRING', playCraps: 'A2_NO_PLAYCRAPS', mode: 'A2_NO_MODE' };

const DEFAULT_BUCKET = 'micro-credentialing-recordings';
const S3_PREFIX = 'a2-pilot';
const DEFAULT_REGION = 'us-east-1';

/** Table name of the environment, as in backend/template.yaml. */
const tableFor = (environment) => `ImportedSubmissions-${environment}`;

/** Where the student's files go in S3. The path holds the random importId only, never the GitHub username. */
const s3KeysFor = (importId) => ({ header: `${S3_PREFIX}/${importId}/functions.h`, source: `${S3_PREFIX}/${importId}/functions.cpp` });

/** GitHub usernames are case-insensitive: they are stored and looked up in lower case. */
const normalizeUsername = (name) => String(name || '').trim().toLowerCase();

/** The AWS SDK lives in the shared layer folder; scripts load it from there. */
const sharedRequire = createRequire(path.join(__dirname, '../../../shared/nodejs/package.json'));

module.exports = { FUNCTIONS, PRIMARY, NO_MACRO, DEFAULT_BUCKET, S3_PREFIX, DEFAULT_REGION, tableFor, s3KeysFor, normalizeUsername, sharedRequire };
