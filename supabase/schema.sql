-- ═══════════════════════════════════════════════════════════════
--  GlobalJam Studio — Schema de Supabase (PostgreSQL)
--  Ejecuta esto en el SQL Editor de tu proyecto Supabase
-- ═══════════════════════════════════════════════════════════════

-- Extensión para UUIDs
CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- ─── SALAS ────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.rooms (
  id           TEXT PRIMARY KEY,
  name         TEXT NOT NULL,
  created_at   TIMESTAMPTZ DEFAULT NOW(),
  last_active  TIMESTAMPTZ DEFAULT NOW(),
  user_count   INTEGER DEFAULT 0
);

-- Activar Realtime para rooms (para que la lista se actualice en vivo)
ALTER PUBLICATION supabase_realtime ADD TABLE public.rooms;

-- ─── MENSAJES DE CHAT ─────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.chat_messages (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  room_id     TEXT NOT NULL REFERENCES public.rooms(id) ON DELETE CASCADE,
  user_name   TEXT NOT NULL,
  user_color  TEXT,
  text        TEXT NOT NULL CHECK (char_length(text) <= 500),
  created_at  TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_chat_room_time ON public.chat_messages (room_id, created_at DESC);

-- ─── EVENTOS MIDI (log histórico) ─────────────────────────────────
CREATE TABLE IF NOT EXISTS public.midi_events (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  room_id     TEXT NOT NULL REFERENCES public.rooms(id) ON DELETE CASCADE,
  user_name   TEXT,
  event_data  JSONB,
  created_at  TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_midi_room ON public.midi_events (room_id, created_at DESC);

-- ─── SESIONES (historial de jams) ─────────────────────────────────
CREATE TABLE IF NOT EXISTS public.sessions (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  room_id           TEXT NOT NULL,
  room_name         TEXT,
  started_at        TIMESTAMPTZ DEFAULT NOW(),
  ended_at          TIMESTAMPTZ,
  peak_users        INTEGER DEFAULT 0,
  total_midi_events INTEGER DEFAULT 0,
  total_messages    INTEGER DEFAULT 0,
  notes             TEXT
);

-- ─── PERFILES DE USUARIO (opcionales, para usuarios recurrentes) ──
CREATE TABLE IF NOT EXISTS public.user_profiles (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  display_name TEXT NOT NULL,
  instrument  TEXT,
  color       TEXT,
  join_count  INTEGER DEFAULT 0,
  created_at  TIMESTAMPTZ DEFAULT NOW()
);

-- ─── ROW LEVEL SECURITY ───────────────────────────────────────────
-- Acceso anónimo completo (protegido en producción con auth si se requiere)
ALTER TABLE public.rooms         ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.chat_messages ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.midi_events   ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.sessions      ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.user_profiles ENABLE ROW LEVEL SECURITY;

-- Políticas permisivas para uso anónimo (anon key es pública pero protegida por RLS)
CREATE POLICY "rooms_public_read"    ON public.rooms         FOR SELECT USING (true);
CREATE POLICY "rooms_public_insert"  ON public.rooms         FOR INSERT WITH CHECK (true);
CREATE POLICY "rooms_public_update"  ON public.rooms         FOR UPDATE USING (true);

CREATE POLICY "chat_public_read"     ON public.chat_messages FOR SELECT USING (true);
CREATE POLICY "chat_public_insert"   ON public.chat_messages FOR INSERT WITH CHECK (char_length(text) <= 500);

CREATE POLICY "midi_public_read"     ON public.midi_events   FOR SELECT USING (true);
CREATE POLICY "midi_public_insert"   ON public.midi_events   FOR INSERT WITH CHECK (true);

CREATE POLICY "sessions_public_read" ON public.sessions      FOR SELECT USING (true);
CREATE POLICY "sessions_public_all"  ON public.sessions      FOR ALL   USING (true);

CREATE POLICY "profiles_public_read" ON public.user_profiles FOR SELECT USING (true);
CREATE POLICY "profiles_public_all"  ON public.user_profiles FOR ALL   USING (true);

-- ─── FUNCIÓN: Decrementar contador de sala ─────────────────────────
CREATE OR REPLACE FUNCTION public.decrement_room_users(room_id TEXT)
RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  UPDATE public.rooms
  SET user_count = GREATEST(0, user_count - 1),
      last_active = NOW()
  WHERE id = room_id;
END;
$$;

-- ─── FUNCIÓN: Limpiar salas inactivas (>2 horas, vacías) ──────────
CREATE OR REPLACE FUNCTION public.cleanup_inactive_rooms()
RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  -- Registrar sesiones terminadas
  INSERT INTO public.sessions (room_id, room_name, ended_at, peak_users)
  SELECT id, name, NOW(), user_count
  FROM public.rooms
  WHERE last_active < NOW() - INTERVAL '2 hours'
    AND user_count = 0;

  -- Eliminar salas inactivas vacías
  DELETE FROM public.rooms
  WHERE last_active < NOW() - INTERVAL '2 hours'
    AND user_count = 0;
END;
$$;

-- ─── Trigger: actualizar last_active cuando hay mensajes ──────────
CREATE OR REPLACE FUNCTION public.touch_room_activity()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  UPDATE public.rooms SET last_active = NOW() WHERE id = NEW.room_id;
  RETURN NEW;
END;
$$;

CREATE TRIGGER trg_chat_touch_room
  AFTER INSERT ON public.chat_messages
  FOR EACH ROW EXECUTE FUNCTION public.touch_room_activity();

-- ─── Datos de ejemplo (opcional) ──────────────────────────────────
-- INSERT INTO public.rooms (id, name) VALUES ('DEMO01', 'Sala de demostración');
