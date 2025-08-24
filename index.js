// Import necessary modules
const express = require('express');
const http = require('http');
const path = require('path');
const { WebSocketServer } = require('ws');
require('dotenv').config();

// Import AI service clients
const { DeepgramClient, LiveTranscriptionEvents } = require('@deepgram/sdk');
const { GoogleGenerativeAI } = require('@google/generative-ai');
const textToSpeech = require('@google-cloud/text-to-speech');

// --- CONFIGURATION ---
const PORT = process.env.PORT || 8080;

// --- API CLIENT INITIALIZATION ---
console.log("🛠️  Initializing API clients...");
const deepgramClient = new DeepgramClient(process.env.DEEPGRAM_API_KEY);
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
const ttsClient = new textToSpeech.TextToSpeechClient({
    keyFilename: process.env.GOOGLE_APPLICATION_CREDENTIALS
});

// Initialize the Gemini model with the system prompt from the .env file
const geminiModel = genAI.getGenerativeModel({
    model: "gemini-1.5-flash-latest",
    systemInstruction: process.env.SYSTEM_PROMPT,
});

console.log("✅ API clients initialized.");

// --- SERVER SETUP ---
const app = express();
app.use(express.static(path.join(__dirname, 'public')));
const server = http.createServer(app);
const wss = new WebSocketServer({ server });

// Main function to process text and generate audio
const processTextAndSpeak = async (text, ws) => {
    try {
        console.log(`\n🎤 User said: "${text}"`);
        if (!text || text.trim().length === 0) {
            console.log("⏩ Received empty text, skipping.");
            return;
        }

        console.log("🧠 Calling Gemini and collecting full response...");
        const result = await geminiModel.generateContent(text);
        const fullText = result.response.text();
        console.log("✅ Gemini's Full Response (Telugu):\n---", fullText, "\n---");
        
        if (!fullText.trim()) {
            console.log("⏩ Gemini returned empty text, skipping TTS.");
            return;
        }

        console.log("🔊 Calling Google Cloud TTS with Telugu voice...");
        
        // --- MODIFICATION: Updated voice agent to Telugu ---
        const request = {
            input: { text: fullText },
            voice: { languageCode: 'te-IN', name: 'te-IN-Chirp3-HD-Achernar' },
            audioConfig: { audioEncoding: 'LINEAR16', sampleRateHertz: 24000 },
        };
        // --------------------------------------------------

        const [response] = await ttsClient.synthesizeSpeech(request);
        const audioContent = response.audioContent;
        
        console.log("📢 Sending audio back to client...");
        const base64Audio = audioContent.toString('base64');
        if (ws.readyState === ws.OPEN) {
            ws.send(JSON.stringify({ type: 'audio', data: base64Audio }));
            ws.send(JSON.stringify({ type: 'audio_complete' }));
        }
        console.log("✅ Finished sending audio response.");

    } catch (error) {
        console.error("🔥 An error occurred in processTextAndSpeak:", error);
        if (ws.readyState === ws.OPEN) {
            ws.send(JSON.stringify({ type: 'error', message: error.message }));
        }
    }
};

// --- WEBSOCKET CONNECTION HANDLING ---
wss.on('connection', (ws) => {
    console.log('\n🔌 Client connected.');
    const deepgramLive = deepgramClient.listen.live({
        model: 'nova-2', language: 'en-US', smart_format: true,
        encoding: 'linear16', sample_rate: 16000,
        endpointing: 300, interim_results: false,
    });

    deepgramLive.on(LiveTranscriptionEvents.Open, () => console.log('✅ Deepgram connection opened.'));
    deepgramLive.on(LiveTranscriptionEvents.Error, (err) => console.error('🔥 Deepgram error:', err));
    deepgramLive.on(LiveTranscriptionEvents.Close, () => console.log('🚪 Deepgram connection closed.'));
    deepgramLive.on(LiveTranscriptionEvents.Transcript, (data) => {
        const transcript = data.channel.alternatives[0].transcript;
        if (transcript && data.speech_final) {
            processTextAndSpeak(transcript, ws);
        }
    });

    ws.on('message', (data) => {
        if (deepgramLive.getReadyState() === 1) deepgramLive.send(data);
    });
    ws.on('close', () => {
        console.log('🔌 Client disconnected.');
        if (deepgramLive.getReadyState() === 1) deepgramLive.finish();
    });
    ws.on('error', (err) => console.error('🔥 WebSocket error:', err));
});

// --- START SERVER ---
server.listen(PORT, () => {
    console.log(`🚀 Server is listening on http://localhost:${PORT}`);
});