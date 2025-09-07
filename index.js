// Import necessary modules
const express = require('express');
const http = require('http');
const path = require('path');
const { WebSocketServer } = require('ws');
const { Writable } = require('stream');
const fs = require('fs'); // Added fs module for file existence checks
require('dotenv').config();

// Import Google Cloud services
const speech = require('@google-cloud/speech').v1p1beta1;
const { GoogleGenerativeAI } = require('@google/generative-ai');
const textToSpeech = require('@google-cloud/text-to-speech');

// --- CONFIGURATION ---
const PORT = process.env.PORT || 8080;

// Validate required environment variables
const requiredEnvVars = ['GEMINI_API_KEY', 'SYSTEM_PROMPT'];
const missingEnvVars = requiredEnvVars.filter(varName => !process.env[varName]);
if (missingEnvVars.length > 0) {
    console.error(`❌ Missing required environment variables: ${missingEnvVars.join(', ')}`);
    process.exit(1);
}

// --- API CLIENT INITIALIZATION ---
console.log("🛠️  Initializing API clients...");

try {
    // Initialize Google Cloud Speech-to-Text
    const speechKeyPath = path.join(__dirname, 'fabled-etching-470016-q6-0b70c56c1d8c.json');
    if (!fs.existsSync(speechKeyPath)) {
        throw new Error(`Speech-to-Text key file not found at: ${speechKeyPath}`);
    }
    const speechClient = new speech.SpeechClient({ keyFilename: speechKeyPath });

    // Initialize Google Generative AI
    const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

    // Initialize Google Cloud Text-to-Speech
    const ttsKeyPath = path.join(__dirname, 'tts_key.json');
    if (!fs.existsSync(ttsKeyPath)) {
        throw new Error(`TTS key file not found at: ${ttsKeyPath}`);
    }
    const ttsClient = new textToSpeech.TextToSpeechClient({ keyFilename: ttsKeyPath });

    // Initialize the Gemini model
    const geminiModel = genAI.getGenerativeModel({
        model: "gemini-2.5-flash",
        systemInstruction: process.env.SYSTEM_PROMPT,
    });

    console.log("✅ API clients initialized successfully.");

    // --- SERVER SETUP ---
    const app = express();
    app.use(express.static(path.join(__dirname, 'public')));
    const server = http.createServer(app);
    const wss = new WebSocketServer({ server });

    // Speech recognition request configuration
    const request = {
        config: {
            encoding: 'LINEAR16',
            sampleRateHertz: 16000,
            languageCode: 'en-US',
            enableAutomaticPunctuation: true,
            model: 'latest_long',
        },
        interimResults: false,
    };

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
            
            const ttsRequest = {
                input: { text: fullText },
                voice: { languageCode: 'te-IN', name: 'te-IN-Chirp3-HD-Achernar' },
                audioConfig: { audioEncoding: 'LINEAR16', sampleRateHertz: 24000 },
            };

            const [response] = await ttsClient.synthesizeSpeech(ttsRequest);
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
        
        let recognizeStream = null;
        const audioInput = [];
        
        // Create a writable stream to collect audio data
        const audioInputStream = new Writable({
            write(chunk, encoding, next) {
                if (recognizeStream) {
                    recognizeStream.write(chunk);
                } else {
                    audioInput.push(chunk);
                }
                next();
            },
            final(callback) {
                if (recognizeStream) {
                    recognizeStream.end();
                }
                callback();
            }
        });

        ws.on('message', (data) => {
            if (data instanceof Buffer) {
                if (!recognizeStream) {
                    // Start a new recognition stream
                    recognizeStream = speechClient
                        .streamingRecognize(request)
                        .on('data', (data) => {
                            const transcript = data.results[0]?.alternatives[0]?.transcript;
                            if (transcript && data.results[0].isFinal) {
                                processTextAndSpeak(transcript, ws);
                            }
                        })
                        .on('error', (err) => {
                            console.error('🔥 Google Speech-to-Text error:', err);
                        })
                        .on('end', () => {
                            recognizeStream = null;
                        });
                    
                    // Process any buffered audio
                    audioInput.forEach(chunk => recognizeStream.write(chunk));
                    audioInput.length = 0;
                }
                audioInputStream.write(data);
            }
        });

        ws.on('close', () => {
            console.log('🔌 Client disconnected.');
            if (recognizeStream) {
                recognizeStream.end();
                recognizeStream = null;
            }
        });

        ws.on('error', (err) => {
            console.error('🔥 WebSocket error:', err);
            if (recognizeStream) {
                recognizeStream.end();
                recognizeStream = null;
            }
        });
    });

    // --- START SERVER ---
    server.listen(PORT, () => {
        console.log(`🚀 Server is listening on http://localhost:${PORT}`);
    });

} catch (error) {
    console.error('❌ Failed to initialize services:', error.message);
    process.exit(1);
}