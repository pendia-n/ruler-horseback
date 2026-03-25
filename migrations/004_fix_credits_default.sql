USE snakedesk;

-- Ensure credits default is 50
ALTER TABLE users ALTER COLUMN credits SET DEFAULT 50;

-- Fix any existing users who have 0 credits (they should have 50 try-out credits)
UPDATE users SET credits = 50 WHERE credits = 0;
