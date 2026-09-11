// ============================================================
// AI NANDI - OFFLINE VOICE INTERVIEWER
// ============================================================

const $ = (id) => document.getElementById(id);

const ui = {
  startForm: $("startForm"),
  startButton: $("startButton"),
  setupView: $("setupView"),
  chatView: $("chatView"),

  githubUrl: $("githubUrl"),
  resume: $("resume"),

  candidateName: $("candidateName"),

  setupError: $("setupError"),
  chatError: $("chatError"),

  messages: $("messages"),

  restartButton: $("restartButton"),
  replayButton: $("replayButton"),
  stopAudioButton: $("stopAudioButton"),

  voiceStatus: $("voiceStatus"),
  transcript: $("transcript"),

  startSpeakingButton: $("startSpeakingButton"),
  stopSpeakingButton: $("stopSpeakingButton"),

  continueButton: $("continueButton"),
  clearButton: $("clearButton"),
  sendAnswerButton: $("sendAnswerButton")
};


// ============================================================
// BROWSER VOICE SUPPORT
// ============================================================

const Recognition =
  window.SpeechRecognition ||
  window.webkitSpeechRecognition;

const synth = window.speechSynthesis;

const supported = Boolean(
  Recognition &&
  synth &&
  window.SpeechSynthesisUtterance
);

const LANGUAGE = "en-US";


// ============================================================
// SESSION
// ============================================================

let session = {
  profile: null,
  conversation: []
};

let busy = false;

let activeRecognition = null;

let recognitionStopping = false;

let finalTranscript = "";

let interimTranscript = "";

let lastInterviewerText = "";

let speaking = false;

let currentUtterance = null;

let speechGeneration = 0;


// ============================================================
// STATUS
// ============================================================

function setStatus(text) {
  if (ui.voiceStatus) {
    ui.voiceStatus.textContent = text;
  }
}


// ============================================================
// CONTROLS
// ============================================================

function updateControls() {
  const activeSession = Boolean(session.profile);
  const micActive = Boolean(activeRecognition);

  ui.startButton.disabled = !supported || busy;

  ui.githubUrl.disabled = busy;
  ui.resume.disabled = busy;

  ui.startSpeakingButton.disabled =
    !supported ||
    !activeSession ||
    busy ||
    speaking ||
    micActive;

  ui.stopSpeakingButton.disabled =
    !micActive ||
    recognitionStopping;

  ui.clearButton.disabled =
    busy ||
    micActive ||
    !finalTranscript.trim();

  ui.sendAnswerButton.disabled =
    !activeSession ||
    busy ||
    speaking ||
    micActive ||
    !finalTranscript.trim();

  ui.sendAnswerButton.textContent =
    busy && activeSession
      ? "Interviewer is thinking..."
      : "Send answer →";

  ui.replayButton.disabled =
    !lastInterviewerText ||
    busy ||
    micActive ||
    speaking;

  ui.stopAudioButton.disabled = !speaking;

  ui.startSpeakingButton.textContent =
    micActive
      ? "🎙 Microphone active..."
      : finalTranscript
        ? "🎙 Continue speaking"
        : "🎙 Start speaking";
}


// ============================================================
// TRANSCRIPT
// ============================================================

function renderTranscript() {
  ui.transcript.replaceChildren();

  if (!finalTranscript && !interimTranscript) {
    const placeholder = document.createElement("span");

    placeholder.textContent =
      "Your spoken answer will appear here.";

    placeholder.style.opacity = "0.45";

    ui.transcript.appendChild(placeholder);
  } else {
    const finalPart = document.createElement("span");

    finalPart.textContent = finalTranscript;

    const interimPart = document.createElement("span");

    interimPart.style.opacity = "0.5";

    interimPart.textContent =
      interimTranscript
        ? ` ${interimTranscript}`
        : "";

    ui.transcript.append(
      finalPart,
      interimPart
    );
  }

  ui.transcript.scrollTop =
    ui.transcript.scrollHeight;

  updateControls();
}


// ============================================================
// CHAT MESSAGE
// ============================================================

function addMessage(role, content) {
  const message = document.createElement("div");

  message.className =
    `message ${role}`;

  const label = document.createElement("span");

  label.className = "message-label";

  label.textContent =
    role === "assistant"
      ? "INTERVIEWER"
      : "YOU · SPOKEN ANSWER";

  const body = document.createElement("p");

  body.textContent = content;

  message.append(label, body);

  ui.messages.appendChild(message);

  ui.messages.scrollTop =
    ui.messages.scrollHeight;
}


// ============================================================
// STOP SPEECH
// ============================================================

function stopSpeech() {
  speechGeneration++;

  speaking = false;

  currentUtterance = null;

  if (synth) {
    synth.cancel();
  }

  updateControls();
}


// ============================================================
// SPLIT LONG SPEECH INTO SMALL CHUNKS
// ============================================================

function speechChunks(text) {
  const chunks = [];

  let chunk = "";

  for (const word of text.trim().split(/\s+/)) {
    if (
      chunk &&
      chunk.length + word.length + 1 > 180
    ) {
      chunks.push(chunk);
      chunk = "";
    }

    chunk += `${chunk ? " " : ""}${word}`;
  }

  if (chunk) {
    chunks.push(chunk);
  }

  return chunks;
}


// ============================================================
// TEXT TO SPEECH
// ============================================================

function speakInterviewer(text) {
  if (!supported || !text || !text.trim()) {
    return;
  }

  if (activeRecognition) {
    return;
  }

  stopSpeech();

  const token = speechGeneration;

  const chunks = speechChunks(text);

  if (!chunks.length) {
    return;
  }

  const voices = synth.getVoices();

  const englishVoice =
    voices.find(
      (voice) =>
        voice.lang.toLowerCase() ===
        LANGUAGE.toLowerCase()
    ) ||
    voices.find(
      (voice) =>
        /^en[-_]/i.test(voice.lang)
    );

  speaking = true;

  setStatus("Interviewer speaking...");

  updateControls();

  function play(index) {
    if (token !== speechGeneration) {
      return;
    }

    if (index >= chunks.length) {
      speaking = false;

      currentUtterance = null;

      setStatus(
        "Your turn. Click Start speaking."
      );

      updateControls();

      return;
    }

    const utterance =
      new SpeechSynthesisUtterance(
        chunks[index]
      );

    currentUtterance = utterance;

    utterance.lang = LANGUAGE;

    utterance.rate = 0.95;

    utterance.pitch = 1;

    if (englishVoice) {
      utterance.voice = englishVoice;
    }

    utterance.onstart = () => {
      if (token !== speechGeneration) {
        return;
      }

      setStatus(
        "Interviewer speaking · microphone off"
      );
    };

    utterance.onend = () => {
      if (token !== speechGeneration) {
        return;
      }

      play(index + 1);
    };

    utterance.onerror = () => {
      if (token !== speechGeneration) {
        return;
      }

      speaking = false;

      currentUtterance = null;

      setStatus(
        "Audio stopped. Click Hear question again."
      );

      updateControls();
    };

    try {
      synth.resume();

      synth.speak(utterance);
    } catch (error) {
      console.error(error);

      speaking = false;

      updateControls();
    }
  }

  play(0);
}


// ============================================================
// SPEECH RECOGNITION
// ============================================================

function startListening() {
  if (
    !supported ||
    busy ||
    speaking ||
    activeRecognition ||
    !session.profile
  ) {
    return;
  }

  ui.chatError.textContent = "";

  const recognition = new Recognition();

  const baseTranscript =
    finalTranscript;

  let hadError = false;

  recognition.lang = LANGUAGE;

  recognition.continuous = true;

  recognition.interimResults = true;

  recognition.maxAlternatives = 1;

  activeRecognition = recognition;

  recognitionStopping = false;

  setStatus(
    "Opening microphone..."
  );

  updateControls();


  recognition.onstart = () => {
    if (activeRecognition !== recognition) {
      return;
    }

    setStatus(
      "Listening in English. Click Stop microphone when finished."
    );
  };


  recognition.onresult = (event) => {
    if (activeRecognition !== recognition) {
      return;
    }

    const finals = [];

    const interims = [];

    for (
      let i = 0;
      i < event.results.length;
      i++
    ) {
      const result = event.results[i];

      const text =
        result[0].transcript.trim();

      if (!text) {
        continue;
      }

      if (result.isFinal) {
        finals.push(text);
      } else {
        interims.push(text);
      }
    }

    finalTranscript =
      [
        baseTranscript,
        ...finals
      ]
        .filter(Boolean)
        .join(" ");

    interimTranscript =
      interims.join(" ");

    renderTranscript();
  };


  recognition.onerror = (event) => {
    if (activeRecognition !== recognition) {
      return;
    }

    hadError = true;

    const errors = {
      "not-allowed":
        "Microphone permission was denied. Allow microphone access in Chrome.",

      "service-not-allowed":
        "Speech recognition is blocked by this browser.",

      "audio-capture":
        "No working microphone was found.",

      "network":
        "Speech recognition needs a network connection in Chrome.",

      "no-speech":
        "No speech detected. Try speaking again."
    };

    ui.chatError.textContent =
      errors[event.error] ||
      "Speech recognition failed. Try again.";

    finishListening();
  };


  function finishListening() {
    if (activeRecognition !== recognition) {
      return;
    }

    activeRecognition = null;

    recognitionStopping = false;

    interimTranscript = "";

    renderTranscript();

    if (!hadError && finalTranscript.trim()) {
      setStatus(
        "Microphone off. Review your answer and send it."
      );
    } else if (!finalTranscript.trim()) {
      setStatus(
        "Microphone off. Click Start speaking to try again."
      );
    }

    updateControls();
  }


  recognition.onend = finishListening;


  try {
    recognition.start();
  } catch (error) {
    console.error(error);

    activeRecognition = null;

    recognitionStopping = false;

    ui.chatError.textContent =
      "Could not start the microphone. Check Chrome permissions.";

    updateControls();
  }
}


// ============================================================
// STOP LISTENING
// ============================================================

function stopListening() {
  if (
    !activeRecognition ||
    recognitionStopping
  ) {
    return;
  }

  recognitionStopping = true;

  setStatus(
    "Finishing transcription..."
  );

  updateControls();

  try {
    activeRecognition.stop();
  } catch (error) {
    activeRecognition = null;

    recognitionStopping = false;

    interimTranscript = "";

    renderTranscript();

    setStatus(
      "Microphone off. Review your transcript."
    );
  }
}


// ============================================================
// LOCAL DEMO PROFILE
// ============================================================

function createDemoProfile() {
  return {
    source: "offline-demo",

    name: "Candidate",

    username: "",

    filename: "Demo Candidate",

    skills: [
      "JavaScript",
      "Python",
      "HTML",
      "CSS",
      "Node.js",
      "Express"
    ],

    projects: [
      {
        name: "AI Voice Interviewer",

        description:
          "A browser-based voice interviewer built using JavaScript, Node.js and Express."
      }
    ],

    text:
      "Software engineering student with experience in JavaScript, Python, HTML, CSS, Node.js and Express. Built an AI Voice Interviewer using browser speech recognition and speech synthesis."
  };
}


// ============================================================
// FIRST INTERVIEW QUESTION
// ============================================================

function getFirstQuestion() {
  return (
    "Hello! Welcome to your AI technical interview. " +
    "I have reviewed your software engineering background. " +
    "I will ask you practical questions about your projects, " +
    "technical skills and problem solving. " +
    "Let's begin. " +
    "Could you tell me about your AI Voice Interviewer project, " +
    "your role in building it, and the main result you achieved?"
  );
}


// ============================================================
// OFFLINE FOLLOW-UP QUESTIONS
// ============================================================

const offlineQuestions = [
  "Interesting. What was the biggest technical challenge you faced while building that project, and how did you solve it?",

  "Good answer. Why did you choose JavaScript and Node.js for this project instead of another technology stack?",

  "Let's go deeper. How does browser speech recognition work in your application?",

  "Suppose the speech recognition suddenly stops working during an interview. How would you debug that problem?",

  "Now let's test your problem solving. If you had one more week to improve this project, what would you change and why?",

  "Final technical question. How would you scale this application if thousands of candidates started using it?"
];

let offlineQuestionIndex = 0;


// ============================================================
// API REQUEST
// ============================================================

async function apiRequest(path, options = {}) {
  const controller =
    new AbortController();

  const timeout =
    setTimeout(
      () => controller.abort(),
      10000
    );

  try {
    const response =
      await fetch(path, {
        ...options,
        signal: controller.signal
      });

    const data =
      await response.json();

    if (!response.ok) {
      throw new Error(
        data.error ||
        "Server request failed."
      );
    }

    return data;

  } finally {
    clearTimeout(timeout);
  }
}


// ============================================================
// START INTERVIEW
// ============================================================

ui.startForm.addEventListener(
  "submit",
  async (event) => {
    event.preventDefault();

    if (busy) {
      return;
    }

    ui.setupError.textContent = "";

    busy = true;

    ui.startButton.disabled = true;

    ui.startButton.textContent =
      "Starting interview...";


    // --------------------------------------------------------
    // EMERGENCY OFFLINE DEMO MODE
    // --------------------------------------------------------
    // This starts immediately.
    // No GitHub API.
    // No OpenAI API.
    // No server dependency.
    // --------------------------------------------------------

    session.profile =
      createDemoProfile();

    const firstQuestion =
      getFirstQuestion();

    session.conversation = [
      {
        role: "assistant",
        content: firstQuestion
      }
    ];

    offlineQuestionIndex = 0;

    ui.candidateName.textContent =
      "Candidate";


    // Switch screen immediately

    ui.setupView.classList.add(
      "hidden"
    );

    ui.chatView.classList.remove(
      "hidden"
    );


    // Clear previous messages

    ui.messages.replaceChildren();


    // Show interviewer message

    addMessage(
      "assistant",
      firstQuestion
    );


    lastInterviewerText =
      firstQuestion;


    busy = false;

    updateControls();


    // --------------------------------------------------------
    // START AI VOICE
    // --------------------------------------------------------

    setTimeout(() => {
      speakInterviewer(
        firstQuestion
      );
    }, 250);
  }
);


// ============================================================
// SEND ANSWER
// ============================================================

ui.sendAnswerButton.addEventListener(
  "click",
  async () => {

    const answer =
      finalTranscript.trim();

    if (
      !answer ||
      busy ||
      speaking ||
      activeRecognition ||
      !session.profile
    ) {
      return;
    }

    ui.chatError.textContent = "";

    busy = true;

    setStatus(
      "Interviewer is reviewing your answer..."
    );

    updateControls();


    // --------------------------------------------------------
    // TRY REAL SERVER FIRST
    // --------------------------------------------------------

    try {

      const data =
        await apiRequest(
          "/api/answer",
          {
            method: "POST",

            headers: {
              "Content-Type":
                "application/json"
            },

            body: JSON.stringify({
              profile:
                session.profile,

              conversation:
                session.conversation,

              answer
            })
          }
        );


      if (
        data &&
        Array.isArray(
          data.conversation
        ) &&
        data.conversation.length
      ) {

        session.conversation =
          data.conversation;

        addMessage(
          "user",
          answer
        );

        const interviewerMessage =
          data.conversation[
            data.conversation.length - 1
          ].content;

        addMessage(
          "assistant",
          interviewerMessage
        );

        lastInterviewerText =
          interviewerMessage;

        finalTranscript = "";

        interimTranscript = "";

        renderTranscript();

        busy = false;

        updateControls();

        speakInterviewer(
          interviewerMessage
        );

        return;
      }

      throw new Error(
        "Invalid server response."
      );

    } catch (error) {

      console.warn(
        "Server unavailable. Using offline demo.",
        error
      );

      // ------------------------------------------------------
      // OFFLINE FALLBACK
      // ------------------------------------------------------

      addMessage(
        "user",
        answer
      );

      const question =
        offlineQuestions[
          offlineQuestionIndex %
          offlineQuestions.length
        ];

      offlineQuestionIndex++;

      session.conversation.push(
        {
          role: "user",
          content: answer
        },
        {
          role: "assistant",
          content: question
        }
      );

      addMessage(
        "assistant",
        question
      );

      lastInterviewerText =
        question;

      finalTranscript = "";

      interimTranscript = "";

      renderTranscript();

      busy = false;

      updateControls();

      speakInterviewer(
        question
      );
    }
  }
);


// ============================================================
// START / CONTINUE SPEAKING
// ============================================================

ui.startSpeakingButton.addEventListener(
  "click",
  () => {
    startListening();
  }
);


// ============================================================
// STOP MICROPHONE
// ============================================================

ui.stopSpeakingButton.addEventListener(
  "click",
  () => {
    stopListening();
  }
);


// ============================================================
// CONTINUE SPEAKING
// ============================================================

ui.continueButton.addEventListener(
  "click",
  () => {
    if (!busy && !speaking) {
      startListening();
    }
  }
);


// ============================================================
// CLEAR TRANSCRIPT
// ============================================================

ui.clearButton.addEventListener(
  "click",
  () => {

    if (
      busy ||
      activeRecognition
    ) {
      return;
    }

    finalTranscript = "";

    interimTranscript = "";

    ui.chatError.textContent = "";

    renderTranscript();
  }
);


// ============================================================
// REPLAY QUESTION
// ============================================================

ui.replayButton.addEventListener(
  "click",
  () => {

    if (
      busy ||
      activeRecognition ||
      speaking ||
      !lastInterviewerText
    ) {
      return;
    }

    ui.chatError.textContent = "";

    speakInterviewer(
      lastInterviewerText
    );
  }
);


// ============================================================
// STOP AUDIO
// ============================================================

ui.stopAudioButton.addEventListener(
  "click",
  () => {

    stopSpeech();

    setStatus(
      "Audio stopped. Click Hear question again."
    );

    updateControls();
  }
);


// ============================================================
// RESTART
// ============================================================

ui.restartButton.addEventListener(
  "click",
  () => {

    stopSpeech();

    if (activeRecognition) {
      try {
        activeRecognition.abort();
      } catch {}
    }

    activeRecognition = null;

    recognitionStopping = false;

    session = {
      profile: null,
      conversation: []
    };

    finalTranscript = "";

    interimTranscript = "";

    lastInterviewerText = "";

    offlineQuestionIndex = 0;

    busy = false;

    ui.messages.replaceChildren();

    ui.startForm.reset();

    ui.setupError.textContent = "";

    ui.chatError.textContent = "";

    ui.setupView.classList.remove(
      "hidden"
    );

    ui.chatView.classList.add(
      "hidden"
    );

    setStatus("Ready.");

    renderTranscript();

    updateControls();
  }
);


// ============================================================
// INITIALIZE
// ============================================================

if (!supported) {

  ui.setupError.textContent =
    "Voice APIs are unavailable. Please use an up-to-date desktop Chrome browser.";

  setStatus(
    "Voice features unavailable."
  );

} else {

  setStatus("Ready.");

  // Chrome sometimes loads voices asynchronously

  synth.getVoices();

  synth.onvoiceschanged = () => {
    synth.getVoices();
  };
}


renderTranscript();

updateControls();