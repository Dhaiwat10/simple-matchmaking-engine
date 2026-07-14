CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TYPE queue_entry_state AS ENUM ('QUEUED', 'MATCHED', 'CANCELLED');
CREATE TYPE match_status AS ENUM ('OPEN', 'COMPLETED', 'CANCELLED');

CREATE TABLE matches (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  status match_status NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  ended_at timestamptz NULL
);

CREATE TABLE players (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  active_match_id uuid NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE players
  ADD CONSTRAINT players_active_match_id_fkey
  FOREIGN KEY (active_match_id) REFERENCES matches(id);

CREATE TABLE queue_entries (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  player_id uuid NOT NULL REFERENCES players(id),
  state queue_entry_state NOT NULL,
  match_id uuid NULL REFERENCES matches(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  resolved_at timestamptz NULL,
  CONSTRAINT queue_entries_state_shape_check CHECK (
    (state = 'QUEUED' AND match_id IS NULL AND resolved_at IS NULL)
    OR (state = 'MATCHED' AND match_id IS NOT NULL AND resolved_at IS NOT NULL)
    OR (state = 'CANCELLED' AND match_id IS NULL AND resolved_at IS NOT NULL)
  )
);

CREATE TABLE match_participants (
  match_id uuid NOT NULL REFERENCES matches(id),
  player_id uuid NOT NULL REFERENCES players(id),
  slot smallint NOT NULL,
  PRIMARY KEY (match_id, player_id),
  CONSTRAINT match_participants_slot_unique UNIQUE (match_id, slot),
  CONSTRAINT match_participants_slot_check CHECK (slot IN (1, 2))
);

CREATE UNIQUE INDEX queue_entries_one_queued_per_player
  ON queue_entries (player_id)
  WHERE state = 'QUEUED';

CREATE INDEX queue_entries_fifo_candidates
  ON queue_entries (state, created_at, id);
