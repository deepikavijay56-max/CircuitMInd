const express = require('express');
const cors = require('cors');
const path = require('path');
const rateLimit = require('express-rate-limit');
const { GoogleGenerativeAI } = require('@google/generative-ai');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3000;

// Rate limiting: 10 requests per IP per 15 minutes
const circuitLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    error: "Too many circuit design requests from this IP. Please wait 15 minutes before generating another circuit."
  }
});

app.use(cors());
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// Gemini AI Client Setup
const apiKey = process.env.GEMINI_API_KEY;
const genAI = apiKey ? new GoogleGenerativeAI(apiKey) : null;

// Preferred Flash models in order of priority
const FLASH_MODELS = [
  process.env.GEMINI_MODEL || 'gemini-3.6-flash',
  'gemini-3.5-flash-lite',
  'gemini-2.5-flash-lite-preview-06-17'
].filter(Boolean);

// Helper: Trims text for Gemini AI prompt token limits (< 800 words)
// without restricting or truncating what the user typed or sees in the UI
function trimPromptForGemini(text, maxWords = 800) {
  if (!text || typeof text !== 'string') return '';
  const words = text.trim().split(/\s+/);
  if (words.length > maxWords) {
    return words.slice(0, maxWords).join(' ');
  }
  return text.trim();
}

// Resilient helper to call Gemini with retry & model fallback
async function generateCircuitFromGemini(prompt) {
  let lastError;

  for (const modelName of FLASH_MODELS) {
    for (let attempt = 1; attempt <= 2; attempt++) {
      try {
        const model = genAI.getGenerativeModel({
          model: modelName,
          generationConfig: {
            responseMimeType: "application/json"
          }
        });

        const result = await model.generateContent(prompt);
        const response = await result.response;
        return response.text().trim();
      } catch (err) {
        lastError = err;
        console.warn(`Attempt ${attempt} for model ${modelName} failed: ${err.message}`);
        // If service is busy (503), back off briefly before retrying or switching models
        if (err.status === 503 || (err.message && err.message.includes('503'))) {
          await new Promise((resolve) => setTimeout(resolve, 1500));
        } else {
          // If error is not 503 (e.g. 400 or 404), break inner retry and try next candidate
          break;
        }
      }
    }
  }

  throw lastError;
}

// Route: POST /api/generate-circuit (with rate limiting)
app.post('/api/generate-circuit', circuitLimiter, async (req, res) => {
  const { idea, skill, budget, power } = req.body || {};

  // Validation: Idea must be at least 15 characters, no maximum limit
  if (!idea || typeof idea !== 'string' || idea.trim().length < 15) {
    return res.status(400).json({
      error: "Project idea must be at least 15 characters long."
    });
  }

  // Ensure Gemini API key is configured
  if (!apiKey || !genAI) {
    console.error("GEMINI_API_KEY is not configured in .env");
    return res.status(500).json({
      error: "GEMINI_API_KEY is missing or not configured. Please set GEMINI_API_KEY in your .env file."
    });
  }

  // Prepare prompt with trimmed idea for token safety
  const promptIdea = trimPromptForGemini(idea, 800);

  const prompt = `You are a senior embedded hardware engineer in India. Design a complete,
buildable electronic circuit for this project.

PROJECT IDEA: ${promptIdea}
BUILDER EXPERIENCE: ${skill || 'Beginner'}
BUDGET: ${budget || 'Under ₹1,000'}
POWER: ${power || 'Let system decide'}

Use real, commonly available parts (ESP32, Arduino Uno/Nano, HC-SR04, DHT22,
relay modules, etc.). Give real pin names. Prices in Indian Rupees.
Reply with ONLY a JSON object, no markdown fences, no preamble, matching
this exact schema:
{"title":"","summary":"2-3 sentences","blocks":[{"name":"","role":""}],
"block_diagram":"ASCII block diagram using +--+ boxes and --> arrows, max 70 chars wide",
"components":[{"name":"part with exact model","qty":"","purpose":"","price":"₹X"}],
"total_cost":"₹X approx",
"connections":[{"from":"Component pin","to":"Component pin","note":"wire colour or caution"}],
"calculations":["resistor/current/power calculations with actual numbers and formulas"],
"steps":["build step"],
"safety":["risk and how to avoid it"],
"testing":["test step with expected reading"],
"next_steps":["how to improve or productise"]}
At least 6 components and 10 connections where the project allows.`;

  try {
    let responseText = await generateCircuitFromGemini(prompt);

    // Strip ```json and ``` fences if present
    if (responseText.startsWith('```')) {
      responseText = responseText.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/i, '').trim();
    }

    let parsedData;
    try {
      parsedData = JSON.parse(responseText);
    } catch (parseErr) {
      console.error("JSON parsing error on model response:", parseErr, "Raw response:", responseText);
      return res.status(500).json({
        error: "Failed to parse the circuit design from AI response. Please try again."
      });
    }

    // Ensure all required schema fields exist (with safe defaults if any are missing)
    const sanitizedResponse = {
      title: parsedData.title || "Custom Circuit Design",
      summary: parsedData.summary || "",
      blocks: Array.isArray(parsedData.blocks) ? parsedData.blocks : [],
      block_diagram: parsedData.block_diagram || "",
      components: Array.isArray(parsedData.components) ? parsedData.components : [],
      total_cost: parsedData.total_cost || "N/A",
      connections: Array.isArray(parsedData.connections) ? parsedData.connections : [],
      calculations: Array.isArray(parsedData.calculations) ? parsedData.calculations : [],
      steps: Array.isArray(parsedData.steps) ? parsedData.steps : [],
      safety: Array.isArray(parsedData.safety) ? parsedData.safety : [],
      testing: Array.isArray(parsedData.testing) ? parsedData.testing : [],
      next_steps: Array.isArray(parsedData.next_steps) ? parsedData.next_steps : []
    };

    return res.json(sanitizedResponse);
  } catch (apiErr) {
    console.error("Gemini API error:", apiErr);
    return res.status(500).json({
      error: `Gemini API Error: ${apiErr.message || "Failed to communicate with AI model"}`
    });
  }
});

// Health check endpoint for monitoring / Render deployment
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', service: 'CircuitMind' });
});

// Fallback to index.html for SPA routing
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`CircuitMind server running with Gemini AI on port ${PORT}`);
});
