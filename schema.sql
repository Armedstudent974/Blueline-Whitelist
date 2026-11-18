CREATE TABLE IF NOT EXISTS guilds (
  id TEXT PRIMARY KEY,
  name TEXT,
  icon TEXT,
  active INTEGER DEFAULT 1,
  joined_at INTEGER
);
CREATE TABLE IF NOT EXISTS guild_config (
  guild_id TEXT PRIMARY KEY,
  approver_roles TEXT DEFAULT '[]',
  staff_roles TEXT DEFAULT '[]',
  webhook_url TEXT,
  review_channel_id TEXT,
  cooldown_hours INTEGER DEFAULT 48,
  updated_at INTEGER
);
CREATE TABLE IF NOT EXISTS app_types (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  guild_id TEXT NOT NULL,
  name TEXT NOT NULL,
  description TEXT,
  questions TEXT DEFAULT '[]',
  enabled INTEGER DEFAULT 1,
  accept_role_id TEXT,
  button_style INTEGER DEFAULT 1,
  created_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_app_types_guild ON app_types(guild_id);
CREATE TABLE IF NOT EXISTS panels (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  guild_id TEXT NOT NULL,
  channel_id TEXT,
  message_id TEXT,
  title TEXT,
  description TEXT,
  color TEXT DEFAULT '#5865F2',
  image_url TEXT,
  app_type_ids TEXT DEFAULT '[]',
  created_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_panels_guild ON panels(guild_id);
CREATE TABLE IF NOT EXISTS sessions (
  user_id TEXT PRIMARY KEY,
  guild_id TEXT NOT NULL,
  app_type_id INTEGER NOT NULL,
  answers TEXT DEFAULT '[]',
  step INTEGER DEFAULT 0,
  editing INTEGER,
  started_at INTEGER
);
CREATE TABLE IF NOT EXISTS applications (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  guild_id TEXT NOT NULL,
  app_type_id INTEGER,
  app_name TEXT,
  user_id TEXT NOT NULL,
  username TEXT,
  avatar_url TEXT,
  answers TEXT,
  status TEXT DEFAULT 'submitted',
  deny_reason TEXT,
  reviewer_id TEXT,
  reviewer_name TEXT,
  cooldown_reset INTEGER DEFAULT 0,
  review_channel_id TEXT,
  review_message_id TEXT,
  created_at INTEGER,
  decided_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_apps_guild_status ON applications(guild_id, status);
CREATE INDEX IF NOT EXISTS idx_apps_user ON applications(guild_id, user_id, app_type_id);
CREATE TABLE IF NOT EXISTS logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  guild_id TEXT,
  application_id INTEGER,
  action TEXT,
  actor_id TEXT,
  actor_name TEXT,
  target_id TEXT,
  detail TEXT,
  created_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_logs_guild ON logs(guild_id, created_at);
CREATE TABLE IF NOT EXISTS web_sessions (
  token TEXT PRIMARY KEY,
  user_id TEXT,
  username TEXT,
  avatar TEXT,
  access_token TEXT,
  guilds_cache TEXT,
  guilds_cached_at INTEGER,
  expires_at INTEGER
);
CREATE TABLE IF NOT EXISTS kv (
  k TEXT PRIMARY KEY,
  v TEXT
);
