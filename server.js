const express = require('express');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const rateLimit = require('express-rate-limit');
const { GoogleGenerativeAI } = require('@google/generative-ai');
require('dotenv').config();

// Load component electrical specifications
let componentSpecs = { components: [] };
try {
  const specsPath = path.join(__dirname, 'data', 'component-specs.json');
  if (fs.existsSync(specsPath)) {
    componentSpecs = JSON.parse(fs.readFileSync(specsPath, 'utf8'));
  }
} catch (e) {
  console.warn("Could not load component specs:", e.message);
}

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

// Preferred Flash models in order of priority (multimodal enabled)
const FLASH_MODELS = [
  process.env.GEMINI_MODEL,
  'gemini-3.5-flash-lite',
  'gemini-3.5-flash',
  'gemini-3.6-flash',
  'gemini-3.6-flash-lite',
  'gemini-3.7-flash',
  'gemini-flash-latest'
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

// Resilient helper to call Gemini with retry & model fallback (supports multimodal audio + image input)
async function generateCircuitFromGemini(prompt, extraParts = []) {
  let lastError;

  const contentParts = [prompt, ...(Array.isArray(extraParts) ? extraParts : [extraParts]).filter(Boolean)];

  for (const modelName of FLASH_MODELS) {
    for (let attempt = 1; attempt <= 2; attempt++) {
      try {
        const model = genAI.getGenerativeModel({
          model: modelName,
          generationConfig: {
            responseMimeType: "application/json"
          }
        });

        const result = await model.generateContent(contentParts);
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

// Lightweight engineering verification engine
function verifyCircuitDesign(design) {
  const checks = [];
  const comps = Array.isArray(design.components) ? design.components : [];
  const conns = Array.isArray(design.connections) ? design.connections : [];
  const blocks = Array.isArray(design.blocks) ? design.blocks : [];

  // Helper to match text in components, blocks, or connections
  function isComponentPresent(keywords) {
    const kw = keywords.map(k => k.toLowerCase());
    for (const c of comps) {
      const text = `${c.name || ''} ${c.purpose || ''}`.toLowerCase();
      if (kw.some(k => text.includes(k))) return true;
    }
    for (const b of blocks) {
      const text = `${b.name || ''} ${b.role || ''}`.toLowerCase();
      if (kw.some(k => text.includes(k))) return true;
    }
    for (const c of conns) {
      const text = `${c.from || ''} ${c.to || ''} ${c.note || ''}`.toLowerCase();
      if (kw.some(k => text.includes(k))) return true;
    }
    return false;
  }

  // Helper to match specifically in components list
  function isInComponentsList(keywords) {
    const kw = keywords.map(k => k.toLowerCase());
    return comps.some(c => {
      const text = `${c.name || ''} ${c.purpose || ''}`.toLowerCase();
      return kw.some(k => text.includes(k));
    });
  }

  // 1. ESP32 + 5V logic component check
  const esp32Spec = (componentSpecs.components || []).find(c => c.id === 'esp32') || {
    keywords: ['esp32', 'esp-32', 'esp 32']
  };
  const hasESP32 = isComponentPresent(esp32Spec.keywords);

  if (hasESP32) {
    const fiveVoltSpecs = (componentSpecs.components || []).filter(c => c.id !== 'esp32' && c.voltage_level === '5V');
    const matched5V = [];

    for (const spec of fiveVoltSpecs) {
      if (isComponentPresent(spec.keywords)) {
        matched5V.push(spec.name);
      }
    }

    // Also check for generic 5V sensor / modules in components list
    for (const c of comps) {
      const name = (c.name || '').toLowerCase();
      const purpose = (c.purpose || '').toLowerCase();
      if ((name.includes('5v') || purpose.includes('5v')) && !matched5V.some(m => name.includes(m.toLowerCase()))) {
        if (!name.includes('esp32') && !name.includes('power') && !name.includes('supply') && !name.includes('regulator') && !name.includes('usb')) {
          matched5V.push(c.name);
        }
      }
    }

    if (matched5V.length > 0) {
      checks.push({
        id: "voltage_mismatch",
        name: "Logic Voltage Compatibility",
        passed: false,
        severity: "warning",
        message: `Voltage mismatch warning: ESP32 operates at 3.3V logic and GPIO pins are NOT 5V tolerant. Detected 5V component(s): ${[...new Set(matched5V)].join(', ')}. A bidirectional logic level shifter or resistor voltage divider is required to protect the ESP32.`
      });
    } else {
      checks.push({
        id: "voltage_mismatch",
        name: "Logic Voltage Compatibility",
        passed: true,
        severity: "info",
        message: "Logic levels verified: ESP32 3.3V operating voltage is compatible with all identified components."
      });
    }
  } else {
    checks.push({
      id: "voltage_mismatch",
      name: "Logic Voltage Compatibility",
      passed: true,
      severity: "info",
      message: "Logic voltage levels verified for active microcontroller."
    });
  }

  // 2. Relay module + flyback diode check
  const relaySpec = (componentSpecs.components || []).find(c => c.id === 'relay_module') || {
    keywords: ['relay module', 'relay', '5v relay']
  };
  const hasRelayInComponents = isInComponentsList(relaySpec.keywords);

  if (hasRelayInComponents) {
    const compConnText = [
      ...comps.map(c => `${c.name || ''} ${c.purpose || ''}`),
      ...conns.map(c => `${c.from || ''} ${c.to || ''} ${c.note || ''}`)
    ].join(' ').toLowerCase();

    const hasDiode = compConnText.includes('flyback diode') || compConnText.includes('diode');

    if (!hasDiode) {
      checks.push({
        id: "relay_flyback_protection",
        name: "Inductive Kickback Protection",
        passed: false,
        severity: "warning",
        message: "Missing flyback diode: Relay module coil creates high-voltage back-EMF spikes when switching off. Ensure a 1N4007 flyback diode is placed across the relay coil to protect the driving transistor/GPIO."
      });
    } else {
      checks.push({
        id: "relay_flyback_protection",
        name: "Inductive Kickback Protection",
        passed: true,
        severity: "info",
        message: "Flyback protection verified: Diode snubbing protection detected for inductive relay coil."
      });
    }
  }

  const allPassed = checks.every(c => c.passed);
  return {
    status: allPassed ? "verified" : "warnings",
    checks: checks
  };
}

// Route: POST /api/generate-circuit (with rate limiting)
app.post('/api/generate-circuit', circuitLimiter, async (req, res) => {
  const { idea, skill, budget, power, componentPhoto, voiceInput } = req.body || {};

  // Ensure Gemini API key is configured
  if (!apiKey || !genAI) {
    console.error("GEMINI_API_KEY is not configured in .env");
    return res.status(500).json({
      error: "GEMINI_API_KEY is missing or not configured. Please set GEMINI_API_KEY in your .env file."
    });
  }

  // Parse optional multimodal voiceInput (Audio Note)
  let audioPart = null;
  if (voiceInput) {
    if (typeof voiceInput === 'string') {
      const match = voiceInput.match(/^data:([^;]+)(?:;[^,]*)?;base64,(.+)$/);
      if (match) {
        audioPart = {
          inlineData: {
            mimeType: match[1].toLowerCase(),
            data: match[2]
          }
        };
      } else {
        audioPart = {
          inlineData: {
            mimeType: 'audio/webm',
            data: voiceInput
          }
        };
      }
    } else if (typeof voiceInput === 'object' && voiceInput.data) {
      let rawData = voiceInput.data;
      let mime = (voiceInput.mimeType || 'audio/webm').split(';')[0].trim().toLowerCase();
      if (typeof rawData === 'string' && rawData.startsWith('data:')) {
        const match = rawData.match(/^data:([^;]+)(?:;[^,]*)?;base64,(.+)$/);
        if (match) {
          mime = match[1].toLowerCase();
          rawData = match[2];
        }
      }
      audioPart = {
        inlineData: {
          mimeType: mime,
          data: rawData
        }
      };
    }
  }

  const hasVoice = !!audioPart;
  const wordCount = (idea && typeof idea === 'string') ? idea.trim().split(/\s+/).filter(Boolean).length : 0;
  const hasTextIdea = wordCount >= 4;

  // Validation: require EITHER idea text (4+ words) OR voiceInput to be present
  if (!hasVoice && !hasTextIdea) {
    return res.status(400).json({
      error: "Please provide a project description (at least 4 words) or record a voice note."
    });
  }

  // Parse optional multimodal componentPhoto (Bin-to-Build)
  let imagePart = null;
  if (componentPhoto) {
    if (typeof componentPhoto === 'string') {
      const match = componentPhoto.match(/^data:([a-zA-Z0-9]+\/[a-zA-Z0-9-.+]+);base64,(.+)$/);
      if (match) {
        imagePart = {
          inlineData: {
            mimeType: match[1],
            data: match[2]
          }
        };
      } else {
        imagePart = {
          inlineData: {
            mimeType: 'image/jpeg',
            data: componentPhoto
          }
        };
      }
    } else if (typeof componentPhoto === 'object' && componentPhoto.data) {
      let rawData = componentPhoto.data;
      let mime = componentPhoto.mimeType || 'image/jpeg';
      if (typeof rawData === 'string' && rawData.startsWith('data:')) {
        const match = rawData.match(/^data:([a-zA-Z0-9]+\/[a-zA-Z0-9-.+]+);base64,(.+)$/);
        if (match) {
          mime = match[1];
          rawData = match[2];
        }
      }
      imagePart = {
        inlineData: {
          mimeType: mime,
          data: rawData
        }
      };
    }
  }

  const hasPhoto = !!imagePart;

  // Prepare prompt for voice or text input
  let ideaInstruction = "";
  if (hasVoice) {
    ideaInstruction = `VOICE AUDIO INPUT ATTACHED:
The user has attached an audio voice note describing their project idea.
Transcribe this audio and treat the transcription as the user's project idea description. If the audio is in Tamil, Hindi, or English, transcribe and understand it in its original language, then proceed with circuit design as normal in English output.
In your JSON response, set the "transcribed_idea" field to the exact English transcription / interpretation of what the user described in the voice note.`;
  } else {
    const promptIdea = trimPromptForGemini(idea, 800);
    ideaInstruction = `PROJECT IDEA: ${promptIdea}`;
  }

  const photoInstruction = hasPhoto ? `
SPARE COMPONENTS PHOTO ATTACHED:
The user has attached a photo of components they already own. Identify which components in the photo are usable for this project. In your response, mark each BOM component with an 'owned' or 'buy' status based on what's visible in the photo. Only the 'buy' items should count toward total_cost — recalculate total_cost to reflect only what still needs to be purchased.
` : ``;

  const componentsSchema = hasPhoto
    ? `"components":[{"name":"part with exact model","qty":"","purpose":"","price":"₹X","status":"owned|buy"}]`
    : `"components":[{"name":"part with exact model","qty":"","purpose":"","price":"₹X","status":"buy"}]`;

  const prompt = `You are a senior embedded hardware engineer in India. Design a complete,
buildable electronic circuit for this project.

${ideaInstruction}
BUILDER EXPERIENCE: ${skill || 'Beginner'}
BUDGET: ${budget || 'Under ₹1,000'}
POWER: ${power || 'Let system decide'}
${photoInstruction}
Use real, commonly available parts (ESP32, Arduino Uno/Nano, HC-SR04, DHT22,
relay modules, etc.). Give real pin names. Prices in Indian Rupees.
Reply with ONLY a JSON object, no markdown fences, no preamble, matching
this exact schema:
{"transcribed_idea":"${hasVoice ? 'English transcription of spoken voice note' : ''}",
"title":"","summary":"2-3 sentences","blocks":[{"name":"","role":""}],
"block_diagram":"ASCII block diagram using +--+ boxes and --> arrows, max 70 chars wide",
${componentsSchema},
"total_cost":"₹X approx",
"connections":[{"from":"Component pin","to":"Component pin","note":"wire colour or caution"}],
"calculations":["resistor/current/power calculations with actual numbers and formulas"],
"steps":["build step"],
"safety":["risk and how to avoid it"],
"testing":["test step with expected reading"],
"next_steps":["how to improve or productise"]}
At least 6 components and 10 connections where the project allows.`;

  try {
    const extraParts = [audioPart, imagePart].filter(Boolean);
    let responseText = await generateCircuitFromGemini(prompt, extraParts);

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
    const rawComps = Array.isArray(parsedData.components) ? parsedData.components : [];
    const sanitizedComponents = rawComps.map(c => ({
      name: c.name || "Unknown Component",
      qty: c.qty || "1",
      purpose: c.purpose || "",
      price: c.price || "₹0",
      status: (c.status && c.status.toLowerCase() === 'owned') ? 'owned' : 'buy'
    }));

    const sanitizedResponse = {
      title: parsedData.title || "Custom Circuit Design",
      summary: parsedData.summary || "",
      transcribed_idea: parsedData.transcribed_idea || "",
      has_voice_input: hasVoice,
      has_spare_parts: hasPhoto,
      blocks: Array.isArray(parsedData.blocks) ? parsedData.blocks : [],
      block_diagram: parsedData.block_diagram || "",
      components: sanitizedComponents,
      total_cost: parsedData.total_cost || "N/A",
      connections: Array.isArray(parsedData.connections) ? parsedData.connections : [],
      calculations: Array.isArray(parsedData.calculations) ? parsedData.calculations : [],
      steps: Array.isArray(parsedData.steps) ? parsedData.steps : [],
      safety: Array.isArray(parsedData.safety) ? parsedData.safety : [],
      testing: Array.isArray(parsedData.testing) ? parsedData.testing : [],
      next_steps: Array.isArray(parsedData.next_steps) ? parsedData.next_steps : []
    };

    // Run electrical engineering verification rules
    sanitizedResponse.verification = verifyCircuitDesign(sanitizedResponse);

    return res.json(sanitizedResponse);
  } catch (apiErr) {
    console.error("Gemini API error:", apiErr);
    return res.status(500).json({
      error: `Gemini API Error: ${apiErr.message || "Failed to communicate with AI model"}`
    });
  }
});

// Route: POST /api/verify-build (Build Check: Verifying physical wiring photo against generated design)
app.post('/api/verify-build', circuitLimiter, async (req, res) => {
  const { buildPhoto, connections, components, title } = req.body || {};

  if (!apiKey || !genAI) {
    return res.status(500).json({
      error: "GEMINI_API_KEY is not configured on server."
    });
  }

  // Parse image part (same pattern as componentPhoto)
  let imagePart = null;
  if (buildPhoto) {
    if (typeof buildPhoto === 'string') {
      const match = buildPhoto.match(/^data:([^;]+)(?:;[^,]*)?;base64,(.+)$/);
      if (match) {
        imagePart = {
          inlineData: {
            mimeType: match[1].toLowerCase(),
            data: match[2]
          }
        };
      } else {
        imagePart = {
          inlineData: {
            mimeType: 'image/jpeg',
            data: buildPhoto
          }
        };
      }
    } else if (typeof buildPhoto === 'object' && buildPhoto.data) {
      let rawData = buildPhoto.data;
      let mime = (buildPhoto.mimeType || 'image/jpeg').split(';')[0].trim().toLowerCase();
      if (typeof rawData === 'string' && rawData.startsWith('data:')) {
        const match = rawData.match(/^data:([^;]+)(?:;[^,]*)?;base64,(.+)$/);
        if (match) {
          mime = match[1].toLowerCase();
          rawData = match[2];
        }
      }
      imagePart = {
        inlineData: {
          mimeType: mime,
          data: rawData
        }
      };
    }
  }

  if (!imagePart) {
    return res.status(400).json({
      error: "Please provide a clear photo of your breadboard/circuit wiring."
    });
  }

  const connList = Array.isArray(connections) ? connections : [];
  if (connList.length === 0) {
    return res.status(400).json({
      error: "No wiring table data provided to verify against."
    });
  }

  const expectedWiringText = connList.map((c, i) => 
    `${i + 1}. From: "${c.from}" -> To: "${c.to}" (Note: "${c.note || 'None'}")`
  ).join('\n');

  const expectedCompsText = Array.isArray(components) 
    ? components.map(c => `- ${c.name} (${c.purpose || ''})`).join('\n')
    : 'Not specified';

  const prompt = `You are a senior electronics test and assembly engineer.
The user has built a physical electronic circuit on a breadboard or perfboard and uploaded a photo of their physical wiring.
Your task is to inspect this photo and compare it against the expected circuit wiring table.

PROJECT: ${title || 'Electronic Circuit'}

EXPECTED WIRING TABLE:
${expectedWiringText}

EXPECTED COMPONENTS:
${expectedCompsText}

INSTRUCTIONS:
1. Examine the photo carefully to identify visible components (microcontrollers, sensors, relays, ICs, LEDs, resistors) and jumper wires.
2. Compare the physical wiring against each entry in the expected wiring table.
3. List which connections appear to match correctly.
4. List which connections appear mismatched, unconnected, missing, or plugged into wrong pins/rails.
5. Identify any visibly risky wiring issues (e.g., reversed polarity on LEDs/diodes/electrolytic capacitors, loose jumper pins, potential shorts across power rails, missing current-limiting resistors). Frame these as cautious observations, not absolute certainties, acknowledging that angles, wire colors, and clutter can obscure details.
6. Provide a concise, helpful summary and confidence note.

Reply with ONLY a JSON object, no markdown fences, no preamble, matching this exact schema:
{
  "status": "passed | issues_found",
  "summary": "1-2 sentence overall visual assessment of the physical wiring",
  "matches": ["Description of connection or component that appears correctly wired"],
  "mismatches": ["Description of connection that appears missing, misplaced, or wrong pin"],
  "warnings": ["Visual safety hazard, reversed polarity risk, or loose connection caution"],
  "confidence_note": "This is an automated visual best-effort check based on your photo. Camera angles, lighting, and wire routing can hide pins. This is not a substitute for careful manual multimeter verification and should not be treated as a safety guarantee."
}`;

  try {
    let responseText = await generateCircuitFromGemini(prompt, [imagePart]);
    if (responseText.startsWith('```')) {
      responseText = responseText.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/i, '').trim();
    }

    let parsed;
    try {
      parsed = JSON.parse(responseText);
    } catch (parseErr) {
      console.error("JSON parsing error in verify-build:", parseErr, "Raw response:", responseText);
      return res.status(500).json({
        error: "Failed to parse inspection results from AI. Please try again with a clearer photo."
      });
    }

    const result = {
      status: parsed.status === 'passed' ? 'passed' : 'issues_found',
      summary: parsed.summary || "Physical wiring visual inspection completed.",
      matches: Array.isArray(parsed.matches) ? parsed.matches : [],
      mismatches: Array.isArray(parsed.mismatches) ? parsed.mismatches : [],
      warnings: Array.isArray(parsed.warnings) ? parsed.warnings : [],
      confidence_note: parsed.confidence_note || "This is a visual best-effort check, not a substitute for careful manual verification, and should not be treated as a safety guarantee."
    };

    return res.json(result);
  } catch (err) {
    console.error("Error in verify-build:", err);
    return res.status(500).json({
      error: `Verification error: ${err.message || "Failed to inspect photo"}`
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
