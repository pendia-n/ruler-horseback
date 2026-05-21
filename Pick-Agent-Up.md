# RulerHorseback Todo GUI — Desktop Todo App (Tauri + Rust + SQLite)

Live at: API worker at `https://rulerhorseback-api.pendia-community.workers.dev`

## What It Is

A **native desktop todo application** built with Tauri v2 (Rust backend + HTML/CSS/JS frontend). Features credit-based monetization: 50 free credits on registration, edits cost credits (1st free, 4cr edits 2-5, 10cr 6th+), deletes cost credits (10cr <7/week, 50cr 7+/week). Users purchase credit packs via a Cloudflare Worker storefront with Stripe.

## Tech Stack

| Layer | Technology |
|---|---|
| **Desktop** | Tauri v2 (Rust backend) |
| **Local DB** | SQLite via rusqlite |
| **Frontend** | Vanilla HTML/CSS/JS |
| **API Storefront** | Cloudflare Worker (Hono + D1) + Stripe |

## Key Features

- Todo CRUD with categories and color labels
- Credit-based monetization: edits/deletes cost credits
- 50 free credits on registration
- Stripe credit packs: $4/100cr, $10/300cr, $25/1000cr
- Upcoming todo list with live countdown
- View All Todos modal with search/filter (90% window)
- Overdue highlighting with completed toggle
- Local-first SQLite — no cloud dependency for core app
- Credit purchases go through a Cloudflare Worker API with D1
