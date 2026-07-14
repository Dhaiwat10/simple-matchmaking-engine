CREATE TYPE match_completion_reason AS ENUM ('WIN', 'DRAW', 'CANCELLED');

ALTER TABLE matches
  ADD COLUMN board char(9) NOT NULL DEFAULT '.........',
  ADD COLUMN next_player_id uuid NULL REFERENCES players(id),
  ADD COLUMN winner_player_id uuid NULL REFERENCES players(id),
  ADD COLUMN completion_reason match_completion_reason NULL,
  ADD CONSTRAINT matches_board_shape_check CHECK (board ~ '^[XO.]{9}$');

UPDATE matches
SET next_player_id = participants.player_id
FROM match_participants AS participants
WHERE matches.id = participants.match_id
  AND participants.slot = 1
  AND matches.status = 'OPEN';

UPDATE matches
SET completion_reason = 'DRAW'
WHERE status = 'COMPLETED';

UPDATE matches
SET completion_reason = 'CANCELLED'
WHERE status = 'CANCELLED';

ALTER TABLE matches
  ADD CONSTRAINT matches_open_game_state_check CHECK (
    (status = 'OPEN' AND ended_at IS NULL AND next_player_id IS NOT NULL AND winner_player_id IS NULL AND completion_reason IS NULL)
    OR (status = 'COMPLETED' AND ended_at IS NOT NULL AND next_player_id IS NULL AND completion_reason IN ('WIN', 'DRAW'))
    OR (status = 'CANCELLED' AND ended_at IS NOT NULL AND next_player_id IS NULL AND winner_player_id IS NULL AND completion_reason = 'CANCELLED')
  ),
  ADD CONSTRAINT matches_winner_completion_check CHECK (
    (completion_reason = 'WIN' AND winner_player_id IS NOT NULL)
    OR (completion_reason IS DISTINCT FROM 'WIN' AND winner_player_id IS NULL)
  );

CREATE TABLE match_moves (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  match_id uuid NOT NULL REFERENCES matches(id),
  player_id uuid NOT NULL REFERENCES players(id),
  move_number smallint NOT NULL,
  position smallint NOT NULL,
  mark char(1) NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT match_moves_number_unique UNIQUE (match_id, move_number),
  CONSTRAINT match_moves_position_unique UNIQUE (match_id, position),
  CONSTRAINT match_moves_position_check CHECK (position BETWEEN 0 AND 8),
  CONSTRAINT match_moves_mark_check CHECK (mark IN ('X', 'O'))
);
