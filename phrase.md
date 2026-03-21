# Rulerhorseback Monetization Implementation Plan

## Overview
Implementation of credit-based monetization system with delete/edit costs, completion status, categories/tags, search/filter, and UI/UX improvements.

## Phase 1: Credit System with Monetization (Current Focus)

### Database Schema Changes
**File**: `migrations/002_add_credits.sql`
```sql
-- Add credits to users
ALTER TABLE users ADD COLUMN credits INT DEFAULT 50;
ALTER TABLE users ADD COLUMN last_deletion_at TIMESTAMP NULL;

-- Credit transactions table
CREATE TABLE credit_transactions (
    id INT AUTO_INCREMENT PRIMARY KEY,
    user_id INT NOT NULL,
    amount INT NOT NULL, -- positive for purchase, negative for spend
    reason ENUM('delete', 'edit', 'purchase') NOT NULL,
    reference_id INT NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (user_id) REFERENCES users(user_id) ON DELETE CASCADE
);

-- Index for performance
CREATE INDEX idx_credit_transactions_user_created ON credit_transactions(user_id, created_at);
```

### Pricing Model (scaled by 10)
- **Initial Credits**: 50 units (5 credits)
- **Delete Cost**: 10 units (1 credit) for first 7 weekly deletes, 50 units (5 credits) thereafter
- **Edit Cost**: 
  - First edit: Free (0 units)
  - Edits 2-5: 4 units (0.4 credits) each
  - Edits 6+: 100 units (10 credits) each
- **Weekly Reset**: UTC-based from account creation timestamp
- **Banner Logic**: Appears when ≥7 deletions in current week + deletion within last 24 hours. Auto-hides after 5s, reappears on login if conditions persist.

### Backend Implementation Plan

#### 1. New Module: `src-tauri/src/credits.rs`
```rust
// Core functions to implement:
pub fn get_user_credits(user_id: u32) -> Result<i32, String>
pub fn add_credits(user_id: u32, amount: i32, reason: &str, reference_id: Option<u32>) -> Result<(), String>
pub fn deduct_credits(user_id: u32, amount: i32, reason: &str, reference_id: Option<u32>) -> Result<(), String>
pub fn get_weekly_deletions(user_id: u32, created_at: DateTime<Utc>) -> Result<i32, String>
pub fn get_deletion_stats(user_id: u32) -> Result<(i32, Option<DateTime<Utc>>), String>
```

#### 2. Update `src-tauri/src/todos.rs`
- **New `delete_todo` command**:
  - Validate todo ownership
  - Compute weekly deletions using UTC week logic
  - Determine cost based on weekly count
  - Check sufficient credits
  - Deduct credits, log transaction, delete todo
  
- **Update `update_todo` command**:
  - Fetch current `edit_count`
  - Determine cost tier
  - Deduct credits, log transaction
  - Increment `edit_count`, update todo

- **New `purchase_credits` command**:
  - Mock purchase adding 1000 units (100 credits)

#### 3. Update `src-tauri/src/lib.rs`
- Add new Tauri command handlers

### Frontend Implementation Plan

#### 1. Update `ui/app.js`
- Add credit balance state and display
- Fetch credits on load and after each transaction
- **Delete button**: Show cost in tooltip, disable if insufficient credits
- **Edit modal**: Display edit cost based on current `edit_count`
- **Banner notification**: 
  ```javascript
  async function checkBannerConditions(userId) {
    const stats = await invoke('get_deletion_stats', { userId });
    if (stats.weeklyCount >= 7 && stats.lastDeletionWithin24h) {
      showBanner();
    }
  }
  ```
- **Purchase credits button**: Call purchase endpoint
- **Error handling**: Show user-friendly messages

#### 2. Update `ui/style.css`
- Credit balance styling
- Banner notification styling
- Purchase button styling

### Implementation Order
1. ✅ Create migration file `002_add_credits.sql`
2. ✅ Create `credits.rs` module with core functions
3. ✅ Update `todos.rs` with delete and edit monetization
4. ✅ Update `lib.rs` with new command handlers
5. ✅ Update frontend credit display and interactions
6. ✅ Implement banner notification system
7. ✅ Test complete credit flow

### File Structure
```
rulerhorseback/
├── migrations/
│   ├── 001_initial.sql
│   └── 002_add_credits.sql  # NEW
├── src-tauri/src/
│   ├── auth.rs
│   ├── db.rs
│   ├── todos.rs
│   ├── credits.rs          # NEW
│   ├── lib.rs
│   └── main.rs
├── ui/
│   ├── index.html
│   ├── app.js
│   └── style.css
└── phrase.md                # This file
```

## Phase 2: Additional Features (Future)
- [ ] Completion status field and UI toggle
- [ ] Categories/tags feature
- [ ] Search/filter functionality

## Phase 3: UI/UX Improvements (Future)
- [ ] Enhanced mobile responsiveness
- [ ] Dark mode support

## Next Steps
1. Run migration to update database schema
2. Implement `credits.rs` module
3. Update delete and edit endpoints
4. Update frontend
5. Test complete flow
6. Move to Phase 2 features

## Technical Notes
- All timestamps use UTC
- Credit system uses integer scaling (10 units = 1 credit)
- Weekly reset based on account creation timestamp
- Banner logic uses 24-hour window for reappearance
- Edit count increments on any edit (title, description, deadline)

---
*Created: 2026-03-22*
*Status: Ready for implementation*