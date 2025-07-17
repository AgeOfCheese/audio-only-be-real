// Firebase Cloud Functions for Stitch App
const functions = require('firebase-functions');
const admin = require('firebase-admin');
const { Storage } = require('@google-cloud/storage');
const speech = require('@google-cloud/speech');
const { v4: uuidv4 } = require('uuid');
const OpenAI = require('openai');

// Initialize Firebase Admin
admin.initializeApp();
const db = admin.firestore();
const storage = new Storage();
const speechClient = new speech.SpeechClient();

// Initialize OpenAI
const openai = new OpenAI({
  apiKey: functions.config().openai.key
});

// Firestore Collections
const PROMPTS_COLLECTION = 'daily_prompts';
const RESPONSES_COLLECTION = 'audio_responses';
const MODERATION_COLLECTION = 'moderation_queue';

// Sample daily questions
const questionPool = [
  "What's a sound you can hear right now?",
  "If your mood was a color, what would it be?",
  "Share one small thing that made you smile today.",
  "What's a worry you can let go of, just for a moment?",
  "What does the air feel like where you are?",
  "Record a single word that describes your day.",
  "What's a texture you can feel right now?",
  "If you could send a message to your past self, what would it be?",
  "What's something you're grateful for in this moment?",
  "Describe the light around you right now.",
  "What's a feeling you're carrying today?",
  "If your energy was a weather pattern, what would it be?",
  "What's something you learned about yourself recently?",
  "Share a sound that brings you peace.",
  "What's a simple pleasure you enjoyed today?"
];

// Utility Functions
const getCurrentDateString = () => {
  return new Date().toISOString().split('T')[0];
};

const generateDailyPrompt = async () => {
  const today = getCurrentDateString();
  const promptRef = db.collection(PROMPTS_COLLECTION).doc(today);
  
  try {
    const doc = await promptRef.get();
    if (doc.exists) {
      return doc.data();
    }

    const randomQuestion = questionPool[Math.floor(Math.random() * questionPool.length)];
    const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000);
    
    const newPrompt = {
      id: today,
      question: randomQuestion,
      date: today,
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
      expiresAt: expiresAt
    };

    await promptRef.set(newPrompt);
    return newPrompt;

  } catch (error) {
    console.error('Error generating daily prompt:', error);
    throw error;
  }
};

// AI Moderation Pipeline
const moderateAudioContent = async (transcriptionText) => {
  try {
    // Step 1: Basic content filtering
    const flaggedWords = [
      'suicide', 'kill myself', 'end it all', 'can\'t go on',
      'hate', 'violence', 'bomb', 'attack', 'murder'
    ];
    
    const hasRiskyContent = flaggedWords.some(word => 
      transcriptionText.toLowerCase().includes(word.toLowerCase())
    );

    // Step 2: PII Detection
    const piiPatterns = [
      /\b\d{3}-\d{3}-\d{4}\b/, // Phone numbers
      /\b\d{3}-\d{2}-\d{4}\b/, // SSN
      /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Z|a-z]{2,}\b/, // Email
      /\b\d{1,5}\s\w+\s(street|st|avenue|ave|road|rd|lane|ln|drive|dr|court|ct|place|pl)\b/i // Address
    ];
    
    const hasPII = piiPatterns.some(pattern => pattern.test(transcriptionText));

    // Step 3: OpenAI moderation
    let aiModeration = null;
    if (functions.config().openai && functions.config().openai.key) {
      try {
        const moderationResponse = await openai.moderations.create({
          input: transcriptionText,
        });
        aiModeration = moderationResponse.results[0];
      } catch (error) {
        console.error('OpenAI moderation error:', error);
      }
    }

    // Step 4: Self-harm detection
    const selfHarmIndicators = [
      'kill myself', 'end my life', 'suicide', 'can\'t go on',
      'nobody cares', 'better off dead', 'end it all'
    ];
    
    const hasSelfHarmContent = selfHarmIndicators.some(indicator => 
      transcriptionText.toLowerCase().includes(indicator.toLowerCase())
    );

    // Decision logic
    const moderationResult = {
      approved: true,
      flags: [],
      escalated: false,
      reason: null
    };

    if (hasPII) {
      moderationResult.approved = false;
      moderationResult.flags.push('PII_DETECTED');
      moderationResult.reason = 'Personal information detected';
    }

    if (hasRiskyContent || (aiModeration && aiModeration.flagged)) {
      moderationResult.approved = false;
      moderationResult.flags.push('HARMFUL_CONTENT');
      moderationResult.reason = 'Content violates community guidelines';
    }

    if (hasSelfHarmContent) {
      moderationResult.escalated = true;
      moderationResult.flags.push('SELF_HARM_RISK');
    }

    return moderationResult;

  } catch (error) {
    console.error('Moderation error:', error);
    return {
      approved: false,
      flags: ['MODERATION_ERROR'],
      escalated: false,
      reason: 'Unable to process content'
    };
  }
};

// Speech-to-text conversion using Google Cloud Speech
const transcribeAudio = async (audioBuffer) => {
  try {
    const audioBytes = audioBuffer.toString('base64');
    
    const request = {
      audio: {
        content: audioBytes,
      },
      config: {
        encoding: 'WEBM_OPUS',
        sampleRateHertz: 48000,
        languageCode: 'en-US',
        enableAutomaticPunctuation: true,
      },
    };

    const [response] = await speechClient.recognize(request);
    const transcription = response.results
      .map(result => result.alternatives[0].transcript)
      .join('\n');

    return transcription || '';

  } catch (error) {
    console.error('Transcription error:', error);
    return '';
  }
};

// Cloud Functions

// Get current daily prompt
exports.getCurrentPrompt = functions.https.onRequest(async (req, res) => {
  // Enable CORS
  res.set('Access-Control-Allow-Origin', '*');
  res.set('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.set('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    res.status(200).send('');
    return;
  }

  try {
    const prompt = await generateDailyPrompt();
    res.json({
      id: prompt.id,
      question: prompt.question,
      date: prompt.date,
      expiresAt: prompt.expiresAt.toISOString()
    });
  } catch (error) {
    console.error('Error getting current prompt:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Submit audio response
exports.submitResponse = functions.https.onRequest(async (req, res) => {
  // Enable CORS
  res.set('Access-Control-Allow-Origin', '*');
  res.set('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.set('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    res.status(200).send('');
    return;
  }

  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Method not allowed' });
    return;
  }

  try {
    const { promptId, audioData, duration } = req.body;
    
    if (!promptId || !audioData) {
      res.status(400).json({ error: 'Missing required fields' });
      return;
    }

    // Validate prompt exists and is current
    const promptRef = db.collection(PROMPTS_COLLECTION).doc(promptId);
    const promptDoc = await promptRef.get();
    
    if (!promptDoc.exists) {
      res.status(404).json({ error: 'Prompt not found' });
      return;
    }

    const prompt = promptDoc.data();
    if (new Date() > prompt.expiresAt.toDate()) {
      res.status(400).json({ error: 'Prompt has expired' });
      return;
    }

    // Decode audio data
    const audioBuffer = Buffer.from(audioData, 'base64');
    
    // Transcribe audio
    const transcription = await transcribeAudio(audioBuffer);
    
    // Moderate content
    const moderationResult = await moderateAudioContent(transcription);
    
    if (!moderationResult.approved) {
      // Log rejected content for analysis
      await db.collection(MODERATION_COLLECTION).add({
        promptId,
        transcription,
        moderationResult,
        timestamp: admin.firestore.FieldValue.serverTimestamp()
      });

      res.status(400).json({ 
        error: 'Content not approved',
        reason: moderationResult.reason,
        escalated: moderationResult.escalated
      });
      return;
    }

    // Store the response
    const responseId = uuidv4();
    const responseData = {
      id: responseId,
      promptId,
      audioData,
      transcription,
      duration: duration || 5,
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
      flags: moderationResult.flags,
      escalated: moderationResult.escalated
    };

    await db.collection(RESPONSES_COLLECTION).doc(responseId).set(responseData);

    res.json({ 
      success: true, 
      responseId,
      escalated: moderationResult.escalated
    });

  } catch (error) {
    console.error('Error submitting response:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Get random audio response
exports.getRandomResponse = functions.https.onRequest(async (req, res) => {
  // Enable CORS
  res.set('Access-Control-Allow-Origin', '*');
  res.set('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.set('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    res.status(200).send('');
    return;
  }

  try {
    const { promptId } = req.query;
    
    if (!promptId) {
      res.status(400).json({ error: 'promptId is required' });
      return;
    }

    // Get all responses for this prompt
    const responsesSnapshot = await db.collection(RESPONSES_COLLECTION)
      .where('promptId', '==', promptId)
      .get();

    if (responsesSnapshot.empty) {
      res.status(404).json({ error: 'No responses available' });
      return;
    }

    // Select random response
    const responses = responsesSnapshot.docs;
    const randomDoc = responses[Math.floor(Math.random() * responses.length)];
    const randomResponse = randomDoc.data();

    res.json({
      id: randomResponse.id,
      audioData: randomResponse.audioData,
      duration: randomResponse.duration,
      createdAt: randomResponse.createdAt.toDate().toISOString()
    });

  } catch (error) {
    console.error('Error getting random response:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Get crisis resources
exports.getCrisisResources = functions.https.onRequest(async (req, res) => {
  // Enable CORS
  res.set('Access-Control-Allow-Origin', '*');
  res.set('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.set('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    res.status(200).send('');
    return;
  }

  res.json({
    resources: [
      {
        name: "988 Suicide & Crisis Lifeline",
        phone: "988",
        text: "Text HOME to 741741",
        website: "https://988lifeline.org"
      },
      {
        name: "Crisis Text Line",
        text: "Text HOME to 741741",
        website: "https://www.crisistextline.org"
      },
      {
        name: "International Association for Suicide Prevention",
        website: "https://www.iasp.info/resources/Crisis_Centres"
      }
    ]
  });
});

// Scheduled function to generate daily prompts
exports.generateDailyPrompt = functions.pubsub.schedule('0 12 * * *')
  .timeZone('America/New_York')
  .onRun(async (context) => {
    try {
      console.log('Generating new daily prompt...');
      await generateDailyPrompt();
      console.log('Daily prompt generated successfully');
    } catch (error) {
      console.error('Error generating daily prompt:', error);
    }
  });

// Scheduled function to clean up expired content
exports.cleanupExpiredContent = functions.pubsub.schedule('0 0 * * *')
  .timeZone('America/New_York')
  .onRun(async (context) => {
    try {
      console.log('Cleaning up expired content...');
      const now = new Date();
      
      // Get expired prompts
      const expiredPromptsSnapshot = await db.collection(PROMPTS_COLLECTION)
        .where('expiresAt', '<=', now)
        .get();

      const batch = db.batch();
      
      // Delete expired prompts
      expiredPromptsSnapshot.docs.forEach(doc => {
        batch.delete(doc.ref);
      });

      // Delete associated responses
      for (const promptDoc of expiredPromptsSnapshot.docs) {
        const responsesSnapshot = await db.collection(RESPONSES_COLLECTION)
          .where('promptId', '==', promptDoc.id)
          .get();
        
        responsesSnapshot.docs.forEach(responseDoc => {
          batch.delete(responseDoc.ref);
        });
      }

      await batch.commit();
      console.log(`Cleaned up ${expiredPromptsSnapshot.docs.length} expired prompts`);
      
    } catch (error) {
      console.error('Error cleaning up expired content:', error);
    }
  });

// Firestore trigger for escalated responses
exports.handleEscalatedResponse = functions.firestore
  .document('audio_responses/{responseId}')
  .onCreate(async (snap, context) => {
    const response = snap.data();
    
    if (response.escalated) {
      console.log('Escalated response detected:', context.params.responseId);
      
      // Log for admin review
      await db.collection('escalated_responses').add({
        responseId: context.params.responseId,
        promptId: response.promptId,
        transcription: response.transcription,
        flags: response.flags,
        timestamp: admin.firestore.FieldValue.serverTimestamp()
      });
      
      // In production, you might:
      // - Send alerts to moderation team
      // - Trigger automated crisis intervention
      // - Log for further analysis
    }
  });

// Admin function to get stats
exports.getStats = functions.https.onRequest(async (req, res) => {
  // Enable CORS
  res.set('Access-Control-Allow-Origin', '*');
  res.set('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.set('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    res.status(200).send('');
    return;
  }

  try {
    const today = getCurrentDateString();
    const todayPromptsSnapshot = await db.collection(PROMPTS_COLLECTION).doc(today).get();
    const todayResponsesSnapshot = await db.collection(RESPONSES_COLLECTION)
      .where('promptId', '==', today)
      .get();

    const totalPromptsSnapshot = await db.collection(PROMPTS_COLLECTION).get();

    res.json({
      totalPrompts: totalPromptsSnapshot.size,
      currentPrompt: todayPromptsSnapshot.exists ? todayPromptsSnapshot.data().question : 'None',
      responsesToday: todayResponsesSnapshot.size,
      totalUsers: todayResponsesSnapshot.size // Simple approximation
    });

  } catch (error) {
    console.error('Error getting stats:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});