USE snakedesk;

-- Add completed field to todos
ALTER TABLE todos ADD COLUMN completed TINYINT(1) DEFAULT 0;

-- Add category_id field to todos
ALTER TABLE todos ADD COLUMN category_id INT NULL;

-- Categories table
CREATE TABLE IF NOT EXISTS categories (
    id INT AUTO_INCREMENT PRIMARY KEY,
    user_id INT NOT NULL,
    name VARCHAR(100) NOT NULL,
    color VARCHAR(7) DEFAULT '#6366f1',
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (user_id) REFERENCES users(user_id) ON DELETE CASCADE,
    UNIQUE KEY unique_user_category (user_id, name)
);

-- Index for category queries
CREATE INDEX idx_todos_category ON todos(category_id);
CREATE INDEX idx_todos_completed ON todos(completed);
