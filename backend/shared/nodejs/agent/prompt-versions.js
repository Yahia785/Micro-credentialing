/** The Host prompt versions the interview engine knows. Kept in its own file so config validation can use it without loading the model client. */
const PROMPT_VERSIONS = Object.freeze(['host.v1', 'host.v2', 'host.v3', 'host.v4', 'host.v4.1', 'host.v5', 'host.v6']);

module.exports = { PROMPT_VERSIONS };
