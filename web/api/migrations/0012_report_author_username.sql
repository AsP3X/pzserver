-- In-game /report does not require a website account. Keep the author name
-- on the row itself, and allow user_id to be empty when nobody has signed
-- up under that character yet.
ALTER TABLE player_reports
    ADD COLUMN author_username text;

UPDATE player_reports AS r
   SET author_username = u.username
  FROM users AS u
 WHERE u.id = r.user_id
   AND r.author_username IS NULL;

UPDATE player_reports
   SET author_username = 'unknown'
 WHERE author_username IS NULL;

ALTER TABLE player_reports
    ALTER COLUMN author_username SET NOT NULL;

ALTER TABLE player_reports
    ALTER COLUMN user_id DROP NOT NULL;
