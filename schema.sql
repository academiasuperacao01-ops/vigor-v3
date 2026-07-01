-- ============================================================
-- VIGOR — Schema do banco de dados (v2)
-- Compatível com SQLite (uso local/dev) e portável para PostgreSQL
-- ============================================================

CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  email TEXT UNIQUE NOT NULL,
  password_hash TEXT,
  password_salt TEXT,
  whatsapp TEXT,
  cpf TEXT,
  birthdate TEXT,
  google_id TEXT UNIQUE,
  role TEXT NOT NULL CHECK(role IN ('personal','aluno')),
  status TEXT NOT NULL DEFAULT 'trial' CHECK(status IN ('trial','pro','inativo')),
  active INTEGER NOT NULL DEFAULT 1,
  personal_id TEXT REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Perfil estendido do personal (dados de negócio: whatsapp de contato, chave PIX, link Mercado Pago)
CREATE TABLE IF NOT EXISTS personal_profiles (
  user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  business_name TEXT,
  whatsapp TEXT,
  pix_key TEXT,
  mercadopago_link TEXT
);

CREATE TABLE IF NOT EXISTS password_reset_tokens (
  token TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at TEXT NOT NULL,
  used INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS student_profiles (
  user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  objetivo TEXT,
  restricao TEXT,
  anamnese_date TEXT,
  adherence INTEGER DEFAULT 0,
  initials TEXT
);

-- Catálogo de planos comerciais do personal (reutilizáveis, aparecem como opções para o aluno)
CREATE TABLE IF NOT EXISTS plan_catalog (
  id TEXT PRIMARY KEY,
  personal_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  price TEXT,
  duration_days INTEGER,
  description TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS plans (
  id TEXT PRIMARY KEY,
  student_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  catalog_id TEXT REFERENCES plan_catalog(id),
  name TEXT NOT NULL,
  price TEXT,
  validity TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Biblioteca de exercícios (do sistema + criados pelo personal)
CREATE TABLE IF NOT EXISTS exercise_library (
  id TEXT PRIMARY KEY,
  personal_id TEXT REFERENCES users(id) ON DELETE CASCADE, -- NULL = biblioteca padrão do sistema
  muscle_group TEXT NOT NULL,
  name TEXT NOT NULL,
  video_url TEXT,
  notes TEXT,
  is_custom INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS workouts (
  id TEXT PRIMARY KEY,
  student_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  workout_key TEXT NOT NULL,
  name TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(student_id, workout_key)
);

CREATE TABLE IF NOT EXISTS exercises (
  id TEXT PRIMARY KEY,
  workout_id TEXT NOT NULL REFERENCES workouts(id) ON DELETE CASCADE,
  library_id TEXT REFERENCES exercise_library(id),
  name TEXT NOT NULL,
  series INTEGER,
  reps INTEGER,
  carga TEXT,
  done INTEGER NOT NULL DEFAULT 0,
  position INTEGER NOT NULL DEFAULT 0,
  notes TEXT,
  tip TEXT
);

-- Registro de execução: quando o aluno conclui um exercício, com RPE e carga usada
CREATE TABLE IF NOT EXISTS exercise_logs (
  id TEXT PRIMARY KEY,
  exercise_id TEXT NOT NULL REFERENCES exercises(id) ON DELETE CASCADE,
  student_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  date TEXT NOT NULL,
  carga_usada TEXT,
  reps_realizadas INTEGER,
  rpe INTEGER, -- percepção de esforço 0-10
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS weekly_plan (
  student_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  day_key TEXT NOT NULL CHECK(day_key IN ('seg','ter','qua','qui','sex','sab','dom')),
  workout_key TEXT NOT NULL DEFAULT 'rest',
  PRIMARY KEY (student_id, day_key)
);

CREATE TABLE IF NOT EXISTS assessments (
  id TEXT PRIMARY KEY,
  student_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  tipo TEXT NOT NULL CHECK(tipo IN ('Antropometria','Adipometria','Perimetria','Bioimpedância','Autoavaliação')),
  protocolo TEXT, -- '3dobras' | '5dobras' | '7dobras' (Adipometria)
  date TEXT NOT NULL,
  fields_json TEXT NOT NULL,
  computed_json TEXT NOT NULL,
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS messages (
  id TEXT PRIMARY KEY,
  student_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  from_role TEXT NOT NULL CHECK(from_role IN ('personal','aluno')),
  text TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS alerts (
  id TEXT PRIMARY KEY,
  student_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  type TEXT NOT NULL,
  text TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS ai_suggestions (
  id TEXT PRIMARY KEY,
  student_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  exercise_id TEXT REFERENCES exercises(id),
  text TEXT NOT NULL,
  suggested_load REAL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS audit_log (
  id TEXT PRIMARY KEY,
  actor_id TEXT,
  actor_role TEXT,
  action TEXT NOT NULL,
  entity TEXT NOT NULL,
  entity_id TEXT,
  detail TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS sessions (
  token TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);
CREATE INDEX IF NOT EXISTS idx_users_personal ON users(personal_id);
CREATE INDEX IF NOT EXISTS idx_assessments_student ON assessments(student_id, tipo);
CREATE INDEX IF NOT EXISTS idx_messages_student ON messages(student_id);
CREATE INDEX IF NOT EXISTS idx_audit_entity ON audit_log(entity, entity_id);
CREATE INDEX IF NOT EXISTS idx_exlib_personal ON exercise_library(personal_id, muscle_group);
CREATE INDEX IF NOT EXISTS idx_exlogs_exercise ON exercise_logs(exercise_id, student_id);

