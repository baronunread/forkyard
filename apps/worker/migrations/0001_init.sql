-- Forkyard durable records. Live state (claims, overlaps, event log, sockets)
-- lives in the per-yard Durable Object; D1 holds what humans and agents query
-- across yards and what must outlive a DO.

CREATE TABLE yards (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  base_repo TEXT NOT NULL,
  default_branch TEXT NOT NULL,
  jurisdiction TEXT NOT NULL DEFAULT 'default',
  preview_url_template TEXT,
  budgets TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE tasks (
  yard_id TEXT NOT NULL REFERENCES yards(id),
  id TEXT NOT NULL,
  title TEXT NOT NULL,
  brief TEXT NOT NULL,
  status TEXT NOT NULL,
  base_commit TEXT NOT NULL,
  created_at TEXT NOT NULL,
  decided_at TEXT,
  PRIMARY KEY (yard_id, id)
);
CREATE INDEX tasks_status ON tasks (status, decided_at);

CREATE TABLE agents (
  yard_id TEXT NOT NULL,
  task_id TEXT NOT NULL,
  id TEXT NOT NULL,
  name TEXT NOT NULL,
  harness TEXT NOT NULL,
  role TEXT NOT NULL,
  color TEXT NOT NULL,
  initials TEXT NOT NULL,
  status TEXT NOT NULL,
  fork_name TEXT NOT NULL UNIQUE,
  fork_remote TEXT,
  head_commit TEXT,
  fork_ms REAL,
  created_at TEXT NOT NULL,
  fork_deleted_at TEXT,
  PRIMARY KEY (yard_id, task_id, id)
);
CREATE INDEX agents_live ON agents (fork_deleted_at);

CREATE TABLE api_keys (
  key_hash TEXT PRIMARY KEY,
  yard_id TEXT NOT NULL,
  task_id TEXT NOT NULL,
  agent_id TEXT NOT NULL,
  role TEXT NOT NULL,
  created_at TEXT NOT NULL,
  revoked_at TEXT
);

CREATE TABLE intents (
  id TEXT PRIMARY KEY,
  yard_id TEXT NOT NULL,
  task_id TEXT NOT NULL,
  agent_id TEXT NOT NULL,
  summary TEXT NOT NULL,
  why TEXT NOT NULL,
  details TEXT,
  commit_hash TEXT,
  source TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX intents_agent ON intents (yard_id, task_id, agent_id, created_at);

CREATE TABLE diffs (
  yard_id TEXT NOT NULL,
  task_id TEXT NOT NULL,
  agent_id TEXT NOT NULL,
  commit_hash TEXT NOT NULL,
  base_commit TEXT NOT NULL,
  files TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (yard_id, task_id, agent_id, commit_hash)
);

CREATE TABLE reviews (
  id TEXT PRIMARY KEY,
  yard_id TEXT NOT NULL,
  task_id TEXT NOT NULL,
  agent_id TEXT NOT NULL,
  commit_hash TEXT NOT NULL,
  score REAL NOT NULL,
  summary TEXT NOT NULL,
  checks TEXT NOT NULL,
  comments TEXT NOT NULL,
  reviewer TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX reviews_agent ON reviews (yard_id, task_id, agent_id, created_at);

CREATE TABLE decisions (
  id TEXT PRIMARY KEY,
  yard_id TEXT NOT NULL,
  task_id TEXT NOT NULL,
  mode TEXT NOT NULL,
  winner_agent_id TEXT,
  selections TEXT NOT NULL,
  result_commit TEXT NOT NULL,
  decided_by TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE bench_runs (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  label TEXT NOT NULL,
  mode TEXT NOT NULL,
  concurrency INTEGER NOT NULL,
  stats TEXT NOT NULL,
  created_at TEXT NOT NULL
);

-- Accounts: Better Auth (people sign in with GitHub or Google; agents get OAuth
-- tokens through the MCP plugin). Generated with better-auth/db/migration for
-- the plugins in src/better-auth.ts: jwt + @better-auth/mcp.

create table "user" ("id" text not null primary key, "name" text not null, "email" text not null unique, "emailVerified" integer not null, "image" text, "createdAt" date not null, "updatedAt" date not null);
create table "session" ("id" text not null primary key, "expiresAt" date not null, "token" text not null unique, "createdAt" date not null, "updatedAt" date not null, "ipAddress" text, "userAgent" text, "userId" text not null references "user" ("id") on delete cascade);
create table "account" ("id" text not null primary key, "accountId" text not null, "providerId" text not null, "userId" text not null references "user" ("id") on delete cascade, "accessToken" text, "refreshToken" text, "idToken" text, "accessTokenExpiresAt" date, "refreshTokenExpiresAt" date, "scope" text, "password" text, "createdAt" date not null, "updatedAt" date not null);
create table "verification" ("id" text not null primary key, "identifier" text not null, "value" text not null, "expiresAt" date not null, "createdAt" date not null, "updatedAt" date not null);
create table "jwks" ("id" text not null primary key, "publicKey" text not null, "privateKey" text not null, "createdAt" date not null, "expiresAt" date, "alg" text, "crv" text);
create table "oauthClient" ("id" text not null primary key, "clientId" text not null unique, "clientSecret" text, "clientDiscoveryId" text, "disabled" integer, "skipConsent" integer, "enableEndSession" integer, "subjectType" text, "scopes" text, "clientCredentialsScopes" text, "userId" text references "user" ("id") on delete cascade, "createdAt" date, "updatedAt" date, "name" text, "uri" text, "icon" text, "contacts" text, "tos" text, "policy" text, "softwareId" text, "softwareVersion" text, "softwareStatement" text, "redirectUris" text not null, "postLogoutRedirectUris" text, "backchannelLogoutUri" text, "backchannelLogoutSessionRequired" integer, "tokenEndpointAuthMethod" text, "applicationType" text, "jwks" text, "jwksUri" text, "grantTypes" text, "responseTypes" text, "requirePKCE" integer, "dpopBoundAccessTokens" integer, "referenceId" text, "metadata" text);
create table "oauthResource" ("id" text not null primary key, "identifier" text not null unique, "name" text not null, "accessTokenTtl" integer, "refreshTokenTtl" integer, "signingAlgorithm" text, "signingKeyId" text, "allowedScopes" text, "customClaims" text, "dpopBoundAccessTokensRequired" integer, "disabled" integer, "createdAt" date, "updatedAt" date, "policyVersion" integer, "metadata" text);
create table "oauthClientResource" ("id" text not null primary key, "clientId" text not null references "oauthClient" ("clientId") on delete cascade, "resourceId" text not null references "oauthResource" ("identifier") on delete cascade, "metadata" text, "createdAt" date);
create table "oauthRefreshToken" ("id" text not null primary key, "token" text not null unique, "clientId" text not null references "oauthClient" ("clientId") on delete cascade, "sessionId" text references "session" ("id") on delete set null, "userId" text not null references "user" ("id") on delete cascade, "referenceId" text, "authorizationCodeId" text, "resources" text, "requestedUserInfoClaims" text, "expiresAt" date not null, "createdAt" date not null, "revoked" date, "rotatedAt" date, "rotationReplayResponse" text, "rotationReplayExpiresAt" date, "authTime" date, "confirmation" text, "scopes" text not null);
create table "oauthAccessToken" ("id" text not null primary key, "token" text not null unique, "clientId" text not null references "oauthClient" ("clientId") on delete cascade, "sessionId" text references "session" ("id") on delete set null, "userId" text references "user" ("id") on delete cascade, "referenceId" text, "authorizationCodeId" text, "resources" text, "requestedUserInfoClaims" text, "refreshId" text references "oauthRefreshToken" ("id") on delete cascade, "expiresAt" date not null, "createdAt" date not null, "revoked" date, "confirmation" text, "scopes" text not null);
create table "oauthConsent" ("id" text not null primary key, "clientId" text not null references "oauthClient" ("clientId") on delete cascade, "userId" text references "user" ("id") on delete cascade, "referenceId" text, "resources" text, "requestedUserInfoClaims" text, "scopes" text not null, "createdAt" date not null, "updatedAt" date not null);
create table "oauthClientAssertion" ("id" text not null primary key, "expiresAt" date not null);
create index "session_userId_idx" on "session" ("userId");
create index "account_userId_idx" on "account" ("userId");
create index "verification_identifier_idx" on "verification" ("identifier");
create index "oauthClient_userId_idx" on "oauthClient" ("userId");
create index "oauthClientResource_clientId_idx" on "oauthClientResource" ("clientId");
create index "oauthClientResource_resourceId_idx" on "oauthClientResource" ("resourceId");
create index "oauthRefreshToken_clientId_idx" on "oauthRefreshToken" ("clientId");
create index "oauthRefreshToken_sessionId_idx" on "oauthRefreshToken" ("sessionId");
create index "oauthRefreshToken_userId_idx" on "oauthRefreshToken" ("userId");
create index "oauthRefreshToken_authorizationCodeId_idx" on "oauthRefreshToken" ("authorizationCodeId");
create index "oauthAccessToken_clientId_idx" on "oauthAccessToken" ("clientId");
create index "oauthAccessToken_sessionId_idx" on "oauthAccessToken" ("sessionId");
create index "oauthAccessToken_userId_idx" on "oauthAccessToken" ("userId");
create index "oauthAccessToken_authorizationCodeId_idx" on "oauthAccessToken" ("authorizationCodeId");
create index "oauthAccessToken_refreshId_idx" on "oauthAccessToken" ("refreshId");
create index "oauthConsent_clientId_idx" on "oauthConsent" ("clientId");
create index "oauthConsent_userId_idx" on "oauthConsent" ("userId");
create unique index "oauthClientResource_clientId_resourceId_uidx" on "oauthClientResource" ("clientId", "resourceId");

-- What a person picked on /connect for an agent client: "me" or yard/task/agent.
-- Read when the OAuth grant is made (it becomes the grant's reference id).
CREATE TABLE oauth_seat_choices (
  session_id TEXT NOT NULL,
  client_id TEXT NOT NULL,
  seat TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (session_id, client_id)
);

-- Yards belong to their members.
CREATE TABLE yard_members (
  yard_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  role TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (yard_id, user_id)
);
CREATE INDEX yard_members_user ON yard_members (user_id);
