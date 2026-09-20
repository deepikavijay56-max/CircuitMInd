# Tasks: CircuitMind

## Objective
A web app where a user with no electronics background describes a project
idea in plain English and receives a complete, buildable circuit design.

## Tech Stack
- Backend: Node.js + Express
- Frontend: Plain HTML/CSS/JS (single page)
- AI: Google Gemini API via @google/generative-ai SDK
- Env vars via dotenv
- [x] Integrate real Google Gemini AI API:
  - [x] Install `@google/generative-ai` & `express-rate-limit`
  - [x] Read `GEMINI_API_KEY` from `.env` via `dotenv`
  - [x] Dynamic hardware engineer prompt with JSON schema enforcement
  - [x] Model resilience with automatic fallback and retry (`gemini-3.8-flash`, `gemini-3.6-flash`, `gemini-flash-latest`)
  - [x] IP rate limiting (10 req / 15 min)
  - [x] Strip markdown code fences and handle parse errors
  - [x] Live end-to-end browser test verifying real AI circuit generation steps

## Requirements
1. Frontend collects: idea (textarea), skill level, budget, power source
2. Frontend calls backend POST /api/generate-circuit
3. Backend calls Gemini, returns structured JSON
4. Frontend renders: block diagram, BOM table, wiring table, calculations,
   safety warnings, testing plan, next steps

## Roadmap
- [ ] Scaffold Express backend with /api/generate-circuit endpoint
- [ ] Scaffold frontend (index.html, styles, script)
- [ ] Wire mock JSON response first (no real API call yet)
- [ ] Test full UI locally with mock data
- [ ] Swap mock data for real Gemini API call
- [ ] Add error handling and rate limiting
- [ ] Prepare .env.example and .gitignore
- [ ] Deployment config for Render (backend) and Vercel (frontend)