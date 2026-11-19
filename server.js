const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const fs = require('fs');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static('public'));
app.use(express.json({ limit: '10mb' }));

const QUESTIONS_DIR = path.join(__dirname, 'questions');

if (!fs.existsSync(QUESTIONS_DIR)) {
  fs.mkdirSync(QUESTIONS_DIR);
}

function getAvailableQuestionSets() {
  try {
    return fs.readdirSync(QUESTIONS_DIR).filter(file => file.endsWith('.json'));
  } catch (err) {
    console.error('Error reading questions directory:', err);
    return [];
  }
}

function loadQuestionSet(filename) {
  try {
    const safeName = path.basename(filename);
    const filePath = path.join(QUESTIONS_DIR, safeName);
    const fileContent = fs.readFileSync(filePath, 'utf8');
    return JSON.parse(fileContent);
  } catch (err) {
    console.error(`Could not load ${filename}:`, err);
    return { rounds: [] };
  }
}

let availableSets = getAvailableQuestionSets();
let currentSetFilename = availableSets.length > 0 ? availableSets[0] : '';
let questionData = currentSetFilename ? loadQuestionSet(currentSetFilename) : { rounds: [] };

// --- REST API FOR QUESTION EDITOR ---

app.get('/api/question-sets', (req, res) => {
  availableSets = getAvailableQuestionSets();
  res.json({ sets: availableSets, current: currentSetFilename });
});

app.get('/api/questions/:filename', (req, res) => {
  const safeName = path.basename(req.params.filename);
  const filePath = path.join(QUESTIONS_DIR, safeName);
  if (!fs.existsSync(filePath)) {
    return res.status(404).json({ error: 'File not found' });
  }
  res.json(loadQuestionSet(safeName));
});

app.post('/api/questions/:filename', (req, res) => {
  let safeName = path.basename(req.params.filename).trim();
  if (!safeName.endsWith('.json')) {
    safeName += '.json';
  }
  safeName = safeName.replace(/[^a-zA-Z0-9._-]/g, '_');

  const filePath = path.join(QUESTIONS_DIR, safeName);
  try {
    fs.writeFileSync(filePath, JSON.stringify(req.body, null, 2), 'utf8');
    availableSets = getAvailableQuestionSets();

    if (safeName === currentSetFilename || !currentSetFilename) {
      currentSetFilename = safeName;
      questionData = req.body;
      io.emit('question-bank', questionData);
    }

    io.emit('question-sets-list', { sets: availableSets, current: currentSetFilename });
    res.json({ success: true, filename: safeName });
  } catch (err) {
    console.error('Failed to save question file:', err);
    res.status(500).json({ error: 'Failed to save file' });
  }
});

// --- GAME STATE & SOCKET.IO ---

let players = [];
const PIN_COLORS = ['#ef4444', '#3b82f6', '#22c55e', '#f59e0b', '#ec4899', '#06b6d4', '#a855f7', '#f97316'];

let buzzerActive = false;
let firstBuzzer = null;
let buzzerPrompt = '';

let secretActive = false;
let secretPrompt = '';
let submissions = {};

let individualActive = false;
let targetPlayerId = null;
let targetPlayerName = '';
let individualPrompt = '';
let individualImage1 = '';
let individualImage2 = '';

// Highbrow / Lowbrow State
let highbrowLowbrowActive = false;
let hlTier = 'highbrow';
let hlHighbrowPrompt = '';
let hlLowbrowPrompt = '';

// Where is Kazakhstan? (Map Round) State
let mapActive = false;
let mapPrompt = '';
let mapImage = '';
let mapTargetX = 50;
let mapTargetY = 50;
let mapGuesses = {};
let mapPinsRevealed = false;
let mapAnswerRevealed = false;

// Vowel Movement State
let vowelMovementActive = false;
let vmWords = [];
let vmOriginalWords = [];
let vmRevealedCount = 1;
let vmAnswerRevealed = false;

let scoresVisible = false;
let currentAnswer = '';
let currentRoundName = '';
let roundNameVisible = false;
let currentImage1 = '';
let currentImage2 = '';

function clearAllRoundStates() {
  buzzerActive = false;
  firstBuzzer = null;
  buzzerPrompt = '';
  secretActive = false;
  secretPrompt = '';
  individualActive = false;
  targetPlayerId = null;
  targetPlayerName = '';
  individualPrompt = '';
  individualImage1 = '';
  individualImage2 = '';
  highbrowLowbrowActive = false;
  hlTier = 'highbrow';
  hlHighbrowPrompt = '';
  hlLowbrowPrompt = '';
  mapActive = false;
  mapPrompt = '';
  mapImage = '';
  mapGuesses = {};
  mapPinsRevealed = false;
  mapAnswerRevealed = false;
  vowelMovementActive = false;
  vmWords = [];
  vmOriginalWords = [];
  vmRevealedCount = 1;
  vmAnswerRevealed = false;
  currentImage1 = '';
  currentImage2 = '';
  submissions = {};
}

function broadcastInactiveStates(except = '') {
  if (except !== 'buzzer') io.emit('buzzer-state', { active: false, winner: null, prompt: '', answer: '', image1: '', image2: '' });
  if (except !== 'secret') io.emit('secret-state', { active: false, prompt: '', submitted: false, answer: '', image1: '', image2: '' });
  if (except !== 'individual') io.emit('individual-state', { active: false, targetId: null, targetName: '', prompt: '', image1: '', image2: '', answer: '' });
  if (except !== 'hl') io.emit('highbrow-lowbrow-state', { active: false });
  if (except !== 'map') io.emit('map-state', { active: false });
  if (except !== 'vm') io.emit('vowel-movement-state', { active: false });
}

function getMapResults() {
  return Object.values(mapGuesses).map(g => {
    const dx = g.x - mapTargetX;
    const dy = g.y - mapTargetY;
    const distance = Math.sqrt(dx * dx + dy * dy);
    return {
      ...g,
      distance: Number(distance.toFixed(2))
    };
  }).sort((a, b) => a.distance - b.distance);
}

function getVMStatePayload() {
  return {
    active: vowelMovementActive,
    words: vmWords.slice(0, vmRevealedCount),
    totalWords: vmWords.length,
    revealedCount: vmRevealedCount,
    buzzerActive: buzzerActive,
    winner: firstBuzzer ? firstBuzzer.name : null,
    winnerId: firstBuzzer ? firstBuzzer.id : null,
    answerRevealed: vmAnswerRevealed,
    answer: vmAnswerRevealed ? currentAnswer : '',
    originalWords: vmAnswerRevealed ? vmOriginalWords : []
  };
}

io.on('connection', (socket) => {
  console.log(`User connected: ${socket.id}`);

  availableSets = getAvailableQuestionSets();

  socket.emit('update-players', players);
  socket.emit('scores-visibility', scoresVisible);
  socket.emit('question-sets-list', { sets: availableSets, current: currentSetFilename });
  socket.emit('question-bank', questionData);
  socket.emit('round-name-state', { visible: roundNameVisible, name: currentRoundName });
  socket.emit('buzzer-state', { 
    active: buzzerActive && !vowelMovementActive, 
    winner: !vowelMovementActive && firstBuzzer ? firstBuzzer.name : null, 
    prompt: buzzerPrompt,
    answer: currentAnswer,
    image1: currentImage1,
    image2: currentImage2
  });
  socket.emit('secret-state', { 
    active: secretActive, 
    prompt: secretPrompt, 
    submitted: !!submissions[socket.id],
    answer: currentAnswer,
    image1: currentImage1,
    image2: currentImage2
  });
  socket.emit('individual-state', {
    active: individualActive,
    targetId: targetPlayerId,
    targetName: targetPlayerName,
    prompt: individualPrompt,
    image1: individualImage1,
    image2: individualImage2,
    answer: currentAnswer
  });
  socket.emit('highbrow-lowbrow-state', {
    active: highbrowLowbrowActive,
    tier: hlTier,
    targetId: targetPlayerId,
    targetName: targetPlayerName,
    prompt: hlTier === 'highbrow' ? hlHighbrowPrompt : hlLowbrowPrompt
  });
  socket.emit('map-state', {
    active: mapActive,
    prompt: mapPrompt,
    mapImage: mapImage,
    pinsRevealed: mapPinsRevealed,
    answerRevealed: mapAnswerRevealed,
    targetX: mapAnswerRevealed ? mapTargetX : null,
    targetY: mapAnswerRevealed ? mapTargetY : null,
    answer: mapAnswerRevealed ? currentAnswer : '',
    guesses: mapPinsRevealed ? getMapResults() : []
  });
  socket.emit('vowel-movement-state', getVMStatePayload());
  socket.emit('submissions-update', getSubmissionsSummary());

  socket.on('select-question-set', (filename) => {
    availableSets = getAvailableQuestionSets();
    if (availableSets.includes(filename)) {
      currentSetFilename = filename;
      questionData = loadQuestionSet(filename);
      io.emit('question-sets-list', { sets: availableSets, current: currentSetFilename });
      io.emit('question-bank', questionData);
    }
  });

  socket.on('join-game', (name) => {
    const cleanName = (name || '').trim();
    if (!cleanName) return;
    const existingPlayer = players.find(p => p.name.toLowerCase() === cleanName.toLowerCase());

    if (existingPlayer) {
      existingPlayer.id = socket.id;
      if (targetPlayerName && targetPlayerName.toLowerCase() === cleanName.toLowerCase()) {
        targetPlayerId = socket.id;
      }
      if (firstBuzzer && firstBuzzer.name.toLowerCase() === cleanName.toLowerCase()) {
        firstBuzzer.id = socket.id;
      }
      if (mapGuesses[existingPlayer.name]) {
        mapGuesses[existingPlayer.name].id = socket.id;
      }
    } else {
      const color = PIN_COLORS[players.length % PIN_COLORS.length];
      players.push({ id: socket.id, name: cleanName, score: 0, color });
    }

    io.emit('update-players', players);
    io.emit('submissions-update', getSubmissionsSummary());
    if (mapActive) {
      io.emit('map-submissions-update', getMapSubmissionsSummary());
    }
  });

  socket.on('open-buzzer-question', ({ prompt, answer, roundName, image1, image2 }) => {
    clearAllRoundStates();
    buzzerActive = true;
    buzzerPrompt = (prompt || '').trim();
    currentAnswer = (answer || '').trim();
    currentRoundName = (roundName || '').trim();
    roundNameVisible = true;
    currentImage1 = image1 || '';
    currentImage2 = image2 || '';
    
    io.emit('round-name-state', { visible: roundNameVisible, name: currentRoundName });
    broadcastInactiveStates('buzzer');
    io.emit('buzzer-state', { 
      active: true, 
      winner: null, 
      prompt: buzzerPrompt, 
      answer: '', 
      image1: currentImage1, 
      image2: currentImage2 
    });
    io.emit('answers-revealed', null);
  });

  socket.on('show-round-name-only', (roundName) => {
    clearAllRoundStates();
    currentRoundName = (roundName || '').trim();
    roundNameVisible = true;
    currentAnswer = '';

    io.emit('round-name-state', { visible: true, name: currentRoundName });
    broadcastInactiveStates();
    io.emit('scores-visibility', false);
    io.emit('answers-revealed', null);
  });

  socket.on('reset-buzzers', () => {
    clearAllRoundStates();
    currentAnswer = '';

    io.emit('round-name-state', { visible: false, name: '' });
    broadcastInactiveStates();
    io.emit('answers-revealed', null);
    io.emit('submissions-update', getSubmissionsSummary());
  });

  socket.on('player-buzz', () => {
    if (buzzerActive && !firstBuzzer) {
      const player = players.find(p => p.id === socket.id);
      if (player) {
        firstBuzzer = player;
        buzzerActive = false;

        if (vowelMovementActive) {
          io.emit('vowel-movement-state', getVMStatePayload());
        } else {
          io.emit('buzzer-state', { 
            active: false, 
            winner: player.name, 
            prompt: buzzerPrompt, 
            answer: '', 
            image1: currentImage1, 
            image2: currentImage2 
          });
        }
      }
    }
  });

  // --- VOWEL MOVEMENT EVENTS ---

  socket.on('open-vowel-movement', ({ words, originalWords, answer, roundName }) => {
    const cleanWords = (words || []).map(w => String(w).trim()).filter(Boolean);
    if (cleanWords.length === 0) return;

    clearAllRoundStates();
    vowelMovementActive = true;
    buzzerActive = true;
    firstBuzzer = null;
    vmWords = cleanWords;
    vmOriginalWords = (originalWords || []).map(w => String(w).trim());
    vmRevealedCount = 1;
    vmAnswerRevealed = false;
    currentAnswer = (answer || '').trim();
    currentRoundName = (roundName || 'Vowel Movement').trim();
    roundNameVisible = true;
    scoresVisible = false;

    io.emit('round-name-state', { visible: roundNameVisible, name: currentRoundName });
    io.emit('scores-visibility', false);
    broadcastInactiveStates('vm');
    io.emit('answers-revealed', null);
    io.emit('vowel-movement-state', getVMStatePayload());
  });

  socket.on('next-vowel-word', () => {
    if (!vowelMovementActive) return;
    if (vmRevealedCount < vmWords.length) {
      vmRevealedCount += 1;
    }
    firstBuzzer = null;
    buzzerActive = true;
    io.emit('vowel-movement-state', getVMStatePayload());
  });

  socket.on('reopen-vm-buzzer', () => {
    if (!vowelMovementActive) return;
    firstBuzzer = null;
    buzzerActive = true;
    io.emit('vowel-movement-state', getVMStatePayload());
  });

  socket.on('reveal-vm-answer', () => {
    if (!vowelMovementActive) return;
    vmRevealedCount = vmWords.length;
    vmAnswerRevealed = true;
    buzzerActive = false;
    io.emit('vowel-movement-state', getVMStatePayload());
  });

  // --- SECRET, INDIVIDUAL, HIGHBROW/LOWBROW, MAP ---

  socket.on('start-secret-question', ({ prompt, answer, roundName, image1, image2 }) => {
    clearAllRoundStates();
    secretActive = true;
    secretPrompt = (prompt || '').trim();
    currentAnswer = (answer || '').trim();
    currentRoundName = (roundName || '').trim();
    roundNameVisible = true;
    currentImage1 = image1 || '';
    currentImage2 = image2 || '';
    scoresVisible = false;
    
    io.emit('round-name-state', { visible: roundNameVisible, name: currentRoundName });
    io.emit('scores-visibility', false);
    broadcastInactiveStates('secret');
    io.emit('secret-state', { 
      active: true, 
      prompt: secretPrompt, 
      submitted: false, 
      answer: '', 
      image1: currentImage1, 
      image2: currentImage2 
    });
    io.emit('answers-revealed', null);
    io.emit('submissions-update', getSubmissionsSummary());
  });

  socket.on('open-individual-question', ({ prompt, answer, roundName, image1, image2, playerId }) => {
    const player = players.find(p => p.id === playerId);
    if (!player) return;

    clearAllRoundStates();
    individualActive = true;
    targetPlayerId = player.id;
    targetPlayerName = player.name;
    individualPrompt = (prompt || '').trim();
    currentAnswer = (answer || '').trim();
    currentRoundName = (roundName || '').trim();
    roundNameVisible = true;
    individualImage1 = image1 || '';
    individualImage2 = image2 || '';
    scoresVisible = false;

    io.emit('round-name-state', { visible: roundNameVisible, name: currentRoundName });
    io.emit('scores-visibility', false);
    broadcastInactiveStates('individual');
    io.emit('answers-revealed', null);
    
    io.emit('individual-state', {
      active: true,
      targetId: targetPlayerId,
      targetName: targetPlayerName,
      prompt: individualPrompt,
      image1: individualImage1,
      image2: individualImage2,
      answer: ''
    });
  });

  socket.on('open-highbrow-lowbrow', ({ highbrow, lowbrow, answer, roundName, playerId }) => {
    const player = players.find(p => p.id === playerId);
    if (!player) return;

    clearAllRoundStates();
    highbrowLowbrowActive = true;
    hlTier = 'highbrow';
    targetPlayerId = player.id;
    targetPlayerName = player.name;
    hlHighbrowPrompt = (highbrow || '').trim();
    hlLowbrowPrompt = (lowbrow || '').trim();
    currentAnswer = (answer || '').trim();
    currentRoundName = (roundName || 'Highbrow / Lowbrow').trim();
    roundNameVisible = true;
    scoresVisible = false;

    io.emit('round-name-state', { visible: roundNameVisible, name: currentRoundName });
    io.emit('scores-visibility', false);
    broadcastInactiveStates('hl');
    io.emit('answers-revealed', null);

    io.emit('highbrow-lowbrow-state', {
      active: true,
      tier: 'highbrow',
      targetId: targetPlayerId,
      targetName: targetPlayerName,
      prompt: hlHighbrowPrompt
    });
  });

  socket.on('switch-to-lowbrow', () => {
    if (!highbrowLowbrowActive) return;
    hlTier = 'lowbrow';
    io.emit('highbrow-lowbrow-state', {
      active: true,
      tier: 'lowbrow',
      targetId: targetPlayerId,
      targetName: targetPlayerName,
      prompt: hlLowbrowPrompt
    });
  });

  socket.on('open-map-question', ({ prompt, mapImage: img, targetX, targetY, answer, roundName }) => {
    clearAllRoundStates();
    mapActive = true;
    mapPrompt = (prompt || '').trim();
    mapImage = (img || '').trim();
    mapTargetX = Number(targetX) || 50;
    mapTargetY = Number(targetY) || 50;
    currentAnswer = (answer || '').trim();
    currentRoundName = (roundName || 'Where is Kazakhstan?').trim();
    roundNameVisible = true;
    scoresVisible = false;

    io.emit('round-name-state', { visible: roundNameVisible, name: currentRoundName });
    io.emit('scores-visibility', false);
    broadcastInactiveStates('map');
    io.emit('answers-revealed', null);

    io.emit('map-state', {
      active: true,
      prompt: mapPrompt,
      mapImage: mapImage,
      pinsRevealed: false,
      answerRevealed: false,
      targetX: null,
      targetY: null,
      answer: '',
      guesses: []
    });
    io.emit('map-submissions-update', getMapSubmissionsSummary());
  });

  socket.on('submit-map-guess', ({ x, y }) => {
    if (!mapActive || mapPinsRevealed) return;
    const player = players.find(p => p.id === socket.id);
    if (!player) return;

    mapGuesses[player.name] = {
      id: player.id,
      name: player.name,
      color: player.color,
      x: Number(x),
      y: Number(y)
    };

    socket.emit('map-guess-confirmed', { x: Number(x), y: Number(y) });
    io.emit('map-submissions-update', getMapSubmissionsSummary());
  });

  socket.on('reveal-map-pins', () => {
    if (!mapActive) return;
    mapPinsRevealed = true;
    io.emit('map-state', {
      active: true,
      prompt: mapPrompt,
      mapImage: mapImage,
      pinsRevealed: true,
      answerRevealed: mapAnswerRevealed,
      targetX: mapAnswerRevealed ? mapTargetX : null,
      targetY: mapAnswerRevealed ? mapTargetY : null,
      answer: mapAnswerRevealed ? currentAnswer : '',
      guesses: getMapResults()
    });
  });

  socket.on('reveal-map-answer', () => {
    if (!mapActive) return;
    mapPinsRevealed = true;
    mapAnswerRevealed = true;
    io.emit('map-state', {
      active: true,
      prompt: mapPrompt,
      mapImage: mapImage,
      pinsRevealed: true,
      answerRevealed: true,
      targetX: mapTargetX,
      targetY: mapTargetY,
      answer: currentAnswer,
      guesses: getMapResults()
    });
  });

  socket.on('submit-answer', (answer) => {
    if (secretActive && answer && answer.trim() !== '') {
      submissions[socket.id] = answer.trim();
      socket.emit('secret-state', { 
        active: true, 
        prompt: secretPrompt, 
        submitted: true, 
        answer: '', 
        image1: currentImage1, 
        image2: currentImage2 
      });
      io.emit('submissions-update', getSubmissionsSummary());
    }
  });

  socket.on('reveal-answers', () => {
    const revealedData = players.map(p => ({
      name: p.name,
      answer: submissions[p.id] || 'No answer submitted'
    }));
    io.emit('answers-revealed', revealedData);
  });

  socket.on('show-correct-answer', () => {
    io.emit('correct-answer-reveal', currentAnswer);
  });

  socket.on('toggle-scores', (visible) => {
    scoresVisible = Boolean(visible);
    io.emit('scores-visibility', scoresVisible);
  });

  socket.on('toggle-round-name', (visible) => {
    roundNameVisible = Boolean(visible);
    io.emit('round-name-state', { visible: roundNameVisible, name: currentRoundName });
  });

  socket.on('update-score', ({ playerId, delta }) => {
    const player = players.find(p => p.id === playerId);
    if (player) {
      player.score += delta;
      io.emit('update-players', players);
    }
  });

  socket.on('reset-scores', () => {
    players.forEach(p => p.score = 0);
    io.emit('update-players', players);
  });

  socket.on('disconnect', () => {
    console.log(`User socket disconnected: ${socket.id}`);
  });
});

function getSubmissionsSummary() {
  const totalPlayers = players.length;
  const submittedCount = players.filter(p => submissions[p.id]).length;
  const allLocked = totalPlayers > 0 && submittedCount === totalPlayers;

  return {
    allLocked: allLocked,
    submissions: players.map(p => ({
      id: p.id,
      name: p.name,
      hasSubmitted: !!submissions[p.id]
    }))
  };
}

function getMapSubmissionsSummary() {
  const totalPlayers = players.length;
  const submittedCount = players.filter(p => mapGuesses[p.name]).length;
  const allLocked = totalPlayers > 0 && submittedCount === totalPlayers;

  return {
    allLocked,
    submissions: players.map(p => ({
      id: p.id,
      name: p.name,
      color: p.color,
      hasSubmitted: !!mapGuesses[p.name]
    }))
  };
}

const PORT = 3000;
server.listen(PORT, '0.0.0.0', () => {
  console.log(`House of Games running at http://localhost:${PORT}`);
});