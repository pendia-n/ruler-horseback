-- Add credits to users
ALTER TABLE users ADD COLUMN credits INT DEFAULT 50;
-- Ensure existing default is 50
ALTER TABLE users ALTER COLUMN credits SET DEFAULT 50;
ALTER TABLE users ADD COLUMN last_deletion_at TIMESTAMP NULL;

-- Credit transactions table
CREATE TABLE credit_transactions (
    id INT AUTO_INCREMENT PRIMARY KEY,
    user_id INT NOT NULL,
    amount INT NOT NULL,
    reason ENUM('delete', 'edit', 'purchase') NOT NULL,
    reference_id INT NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (user_id) REFERENCES users(user_id) ON DELETE CASCADE
);

-- Index for performance
CREATE INDEX idx_credit_transactions_user_created ON credit_transactions(user_id, created_at);
